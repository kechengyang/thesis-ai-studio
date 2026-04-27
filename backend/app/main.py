from __future__ import annotations

import csv
import json
import os
import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel


TOOL_ROOT = Path(__file__).resolve().parents[2]
SETTINGS_PATH = TOOL_ROOT / "settings.json"
ENV_PATH = TOOL_ROOT / ".env"
STATE_PATH = TOOL_ROOT / ".runtime" / "state.json"
PROJECTS_ROOT = Path(os.environ.get("THESIS_PROJECTS_ROOT", "/Users/anqizhang/work/thesis")).expanduser()
LEGACY_WORKSPACE = TOOL_ROOT / "workspace"
DEFAULT_PROJECT_ID = "thesis-draft"
PROJECT_FOLDERS = ["data", "sources", "figures", "templates", "outputs", "memory"]

DEFAULT_SETTINGS = {
    "model": "gpt-5.5",
    "reasoning": "medium",
    "reference_doc": "templates/reference.docx",
    "export_dir": "outputs",
}

DEFAULT_PAPER = """---
title: "Working Paper Title"
author: "Author Name"
format:
  docx:
    toc: true
bibliography: references.bib
---

# Abstract

Write your abstract here. Select any paragraph and ask the AI panel to revise, expand, or check the logic.

# Introduction

Introduce the research background, research question, and contribution.

# Methods

Describe the research design, data sources, and analytical strategy.

# Results

Present the main findings. Figures can be placed in the `figures/` folder and referenced with Quarto syntax.

# Discussion

Interpret the findings, discuss limitations, and connect the argument to the literature.

# References
"""


class DocumentUpdate(BaseModel):
    content: str


class SettingsUpdate(BaseModel):
    api_key: Optional[str] = None
    model: Optional[str] = None
    reasoning: Optional[str] = None
    reference_doc: Optional[str] = None
    export_dir: Optional[str] = None


class SuggestRequest(BaseModel):
    instruction: str
    selected_text: str
    document: Optional[str] = None


class ApplyRequest(BaseModel):
    original_segment: str
    replacement: str
    suggestion_id: Optional[str] = None


class RejectRequest(BaseModel):
    original_segment: str
    suggestion: Optional[dict[str, Any]] = None
    suggestion_id: Optional[str] = None


class ProjectCreate(BaseModel):
    name: Optional[str] = None


class ProjectOpen(BaseModel):
    project_id: str


app = FastAPI(title="Quarto AI Paper Studio", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5183",
        "http://127.0.0.1:5183",
    ],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip().lower()).strip("-._")
    return slug[:80] or DEFAULT_PROJECT_ID


def ensure_settings() -> None:
    if not SETTINGS_PATH.exists():
        SETTINGS_PATH.write_text(json.dumps(DEFAULT_SETTINGS, indent=2), encoding="utf-8")


def read_state() -> dict[str, Any]:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def write_state(state: dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def safe_project_path(project_id: str) -> Path:
    project_path = (PROJECTS_ROOT / slugify(project_id)).resolve()
    root = PROJECTS_ROOT.resolve()
    try:
        project_path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="项目名称不安全，请换一个名称。") from exc
    return project_path


def paper_path(project_id: Optional[str] = None) -> Path:
    return workspace_path(project_id) / "paper.qmd"


def source_index_path(project_id: Optional[str] = None) -> Path:
    return workspace_path(project_id) / "sources" / "sources_index.json"


def memory_dir(project_id: Optional[str] = None) -> Path:
    return workspace_path(project_id) / "memory"


def memory_path(name: str, project_id: Optional[str] = None) -> Path:
    return memory_dir(project_id) / name


def existing_projects() -> list[dict[str, Any]]:
    PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
    projects = []
    for path in sorted(PROJECTS_ROOT.iterdir()):
        if not path.is_dir() or path.name.startswith("."):
            continue
        paper = path / "paper.qmd"
        modified_source = paper if paper.exists() else path
        projects.append(
            {
                "id": path.name,
                "name": path.name.replace("-", " ").title(),
                "path": str(path),
                "paper_exists": paper.exists(),
                "modified_at": datetime.fromtimestamp(modified_source.stat().st_mtime).isoformat(timespec="seconds"),
            }
        )
    return projects


def copy_legacy_materials(destination: Path) -> None:
    if not LEGACY_WORKSPACE.exists():
        return
    for folder in PROJECT_FOLDERS:
        source_dir = LEGACY_WORKSPACE / folder
        target_dir = destination / folder
        if not source_dir.exists() or not source_dir.is_dir():
            continue
        for source_file in source_dir.iterdir():
            if not source_file.is_file() or source_file.name == ".gitkeep":
                continue
            target_file = target_dir / source_file.name
            if not target_file.exists():
                shutil.copy2(source_file, target_file)


def repair_source_index(project: Path) -> None:
    index_path = project / "sources" / "sources_index.json"
    try:
        existing = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    except json.JSONDecodeError:
        existing = []
    if existing:
        return
    entries = []
    candidate_texts = list((project / "sources").glob("*.txt")) if (project / "sources").exists() else []
    data_dir = project / "data"
    if data_dir.exists():
        for data_file in sorted(data_dir.iterdir()):
            if not data_file.is_file() or data_file.name == ".DS_Store":
                continue
            if data_file.suffix.lower() not in [".csv", ".xlsx", ".xlsm"]:
                continue
            text_file = project / "sources" / f"data-{data_file.stem}.txt"
            if not text_file.exists():
                try:
                    text_file.write_text(extract_text(data_file), encoding="utf-8")
                except HTTPException:
                    continue
            candidate_texts.append(text_file)
    if not candidate_texts:
        return
    for text_path in sorted(set(candidate_texts)):
        source_dir = text_path.parent
        originals = [
            path
            for path in source_dir.iterdir()
            if path.is_file()
            and path.stem == text_path.stem
            and path.name != text_path.name
            and path.suffix.lower() in [".pdf", ".docx", ".csv", ".xlsx", ".xlsm"]
        ]
        if text_path.name.startswith("data-"):
            data_name = text_path.name.removeprefix("data-").removesuffix(".txt")
            originals = [
                path
                for path in data_dir.iterdir()
                if path.is_file() and path.stem == data_name and path.suffix.lower() in [".csv", ".xlsx", ".xlsm"]
            ]
        filename = originals[0].name if originals else text_path.name
        text = text_path.read_text(encoding="utf-8", errors="ignore")
        entries.append(
            {
                "filename": filename,
                "text_file": text_path.name,
                "characters": len(text),
                "imported_at": datetime.fromtimestamp(text_path.stat().st_mtime).isoformat(timespec="seconds"),
            }
        )
    if entries:
        index_path.write_text(json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")


def ensure_memory_files(project: Path) -> None:
    memory = project / "memory"
    memory.mkdir(parents=True, exist_ok=True)
    for filename in ["conversations.jsonl", "changes.jsonl"]:
        path = memory / filename
        if not path.exists():
            path.write_text("", encoding="utf-8")
    summary = memory / "summary.md"
    if not summary.exists():
        summary.write_text(
            "# Project Memory\n\n"
            "This file is maintained by the local AI paper studio. It summarizes AI interactions and accepted edits for this project.\n",
            encoding="utf-8",
        )


def ensure_project(project_id: Optional[str] = None, title: Optional[str] = None, seed_legacy: bool = False) -> Path:
    ensure_settings()
    PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
    resolved_id = slugify(project_id or DEFAULT_PROJECT_ID)
    project = safe_project_path(resolved_id)
    for folder in PROJECT_FOLDERS:
        (project / folder).mkdir(parents=True, exist_ok=True)
    if not (project / "paper.qmd").exists():
        paper = DEFAULT_PAPER
        if title:
            paper = paper.replace('title: "Working Paper Title"', f'title: "{title}"')
        (project / "paper.qmd").write_text(paper, encoding="utf-8")
    if not (project / "references.bib").exists():
        (project / "references.bib").write_text("", encoding="utf-8")
    if not (project / "sources" / "sources_index.json").exists():
        (project / "sources" / "sources_index.json").write_text("[]", encoding="utf-8")
    if seed_legacy:
        copy_legacy_materials(project)
    repair_source_index(project)
    ensure_memory_files(project)
    return project


def active_project_id() -> str:
    state = read_state()
    candidate = slugify(state.get("active_project", DEFAULT_PROJECT_ID))
    if safe_project_path(candidate).exists():
        return candidate
    projects = existing_projects()
    if projects:
        selected = projects[0]["id"]
    else:
        selected = DEFAULT_PROJECT_ID
        ensure_project(selected, title="Thesis Draft", seed_legacy=True)
    write_state({"active_project": selected})
    return selected


def set_active_project(project_id: str) -> None:
    project_id = slugify(project_id)
    if not safe_project_path(project_id).exists():
        raise HTTPException(status_code=404, detail="没有找到这个论文项目。")
    ensure_project(project_id, title=project_id.replace("-", " ").title())
    write_state({"active_project": project_id})


def workspace_path(project_id: Optional[str] = None) -> Path:
    project_id = slugify(project_id or active_project_id())
    ensure_project(project_id)
    return safe_project_path(project_id)


def ensure_workspace() -> None:
    project_id = active_project_id()
    ensure_project(project_id)


def load_env_file() -> dict[str, str]:
    values: dict[str, str] = {}
    if not ENV_PATH.exists():
        return values
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        if not line or line.strip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def read_settings() -> dict[str, Any]:
    ensure_settings()
    try:
        loaded = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        loaded = {}
    return {**DEFAULT_SETTINGS, **loaded}


def save_settings(settings: dict[str, Any]) -> None:
    safe = {k: v for k, v in settings.items() if k in DEFAULT_SETTINGS}
    SETTINGS_PATH.write_text(json.dumps(safe, indent=2, ensure_ascii=False), encoding="utf-8")


def save_api_key(api_key: str) -> None:
    lines = []
    found = False
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            if line.startswith("OPENAI_API_KEY="):
                lines.append(f"OPENAI_API_KEY={api_key}")
                found = True
            else:
                lines.append(line)
    if not found:
        lines.append(f"OPENAI_API_KEY={api_key}")
    ENV_PATH.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def masked_api_key() -> str:
    key = os.environ.get("OPENAI_API_KEY") or load_env_file().get("OPENAI_API_KEY", "")
    if len(key) < 8:
        return ""
    return f"{key[:3]}...{key[-4:]}"


def outline_from_document(content: str) -> list[dict[str, Any]]:
    outline = []
    for line in content.splitlines():
        match = re.match(r"^(#{1,6})\s+(.+)$", line.strip())
        if match:
            outline.append({"level": len(match.group(1)), "title": match.group(2)})
    return outline


def read_source_index(project_id: Optional[str] = None) -> list[dict[str, Any]]:
    ensure_workspace()
    index_path = source_index_path(project_id)
    try:
        return json.loads(index_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def write_source_index(items: list[dict[str, Any]], project_id: Optional[str] = None) -> None:
    source_index_path(project_id).write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")


def file_size_label(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def list_project_files(project: Path) -> list[dict[str, Any]]:
    categories = [
        ("Manuscript", [project / "paper.qmd", project / "references.bib"]),
        (
            "Project Root",
            sorted(
                path
                for path in project.iterdir()
                if path.is_file() and path.name not in ["paper.qmd", "references.bib"]
            ),
        ),
        ("Sources", sorted((project / "sources").glob("*"))),
        ("Data", sorted((project / "data").glob("*"))),
        ("Figures", sorted((project / "figures").glob("*"))),
        ("Templates", sorted((project / "templates").glob("*"))),
        ("Outputs", sorted((project / "outputs").glob("*"))),
        ("Memory", sorted((project / "memory").glob("*"))),
    ]
    result = []
    for category, paths in categories:
        files = []
        for path in paths:
            if not path.exists() or not path.is_file() or path.name == ".gitkeep":
                continue
            if path.name == "sources_index.json":
                continue
            files.append(
                {
                    "name": path.name,
                    "relative_path": str(path.relative_to(project)),
                    "size": path.stat().st_size,
                    "size_label": file_size_label(path.stat().st_size),
                    "modified_at": datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"),
                    "extension": path.suffix.lower().lstrip(".") or "file",
                }
            )
        result.append({"category": category, "files": files})
    return result


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def append_jsonl(path: Path, item: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(item, ensure_ascii=False) + "\n")


def read_jsonl(path: Path, limit: int = 20) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows[-limit:]


def excerpt(text: str, limit: int = 700) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    if len(compact) <= limit:
        return compact
    return compact[:limit].rstrip() + "..."


def memory_summary_text(project: Path, limit: int = 4000) -> str:
    summary = project / "memory" / "summary.md"
    if not summary.exists():
        return ""
    text = summary.read_text(encoding="utf-8", errors="ignore").strip()
    if len(text) <= limit:
        return text
    return text[-limit:]


def memory_overview(project: Path) -> dict[str, Any]:
    conversations = read_jsonl(project / "memory" / "conversations.jsonl", limit=8)
    changes = read_jsonl(project / "memory" / "changes.jsonl", limit=8)
    return {
        "conversation_count": len(read_jsonl(project / "memory" / "conversations.jsonl", limit=100000)),
        "change_count": len(read_jsonl(project / "memory" / "changes.jsonl", limit=100000)),
        "recent_conversations": conversations,
        "recent_changes": changes,
        "summary": memory_summary_text(project, limit=1200),
    }


def append_memory_summary(project: Path, line: str) -> None:
    summary = project / "memory" / "summary.md"
    summary.parent.mkdir(parents=True, exist_ok=True)
    with summary.open("a", encoding="utf-8") as handle:
        handle.write(f"\n- {now_iso()} {line}\n")


def build_memory_context(project: Path) -> dict[str, Any]:
    conversations = read_jsonl(project / "memory" / "conversations.jsonl", limit=6)
    changes = read_jsonl(project / "memory" / "changes.jsonl", limit=6)
    return {
        "summary": memory_summary_text(project, limit=1800),
        "recent_ai_interactions": conversations,
        "recent_accepted_or_rejected_edits": changes,
    }


def log_ai_suggestion(
    project: Path,
    suggestion_id: str,
    req: SuggestRequest,
    suggestion: dict[str, Any],
    sources: list[dict[str, str]],
    raw_text: str,
) -> None:
    item = {
        "id": suggestion_id,
        "timestamp": now_iso(),
        "type": "suggestion",
        "instruction": req.instruction,
        "selected_text": excerpt(req.selected_text),
        "suggestion": suggestion,
        "source_files": sorted({source["filename"] for source in sources}),
        "raw_excerpt": excerpt(raw_text, limit=900),
        "status": "proposed",
    }
    append_jsonl(project / "memory" / "conversations.jsonl", item)
    append_memory_summary(
        project,
        f"AI suggested a revision for: \"{excerpt(req.selected_text, 160)}\"",
    )


def log_change(project: Path, item: dict[str, Any]) -> None:
    append_jsonl(project / "memory" / "changes.jsonl", item)
    status = item.get("status", "updated")
    if status == "accepted":
        append_memory_summary(project, f"Accepted edit: \"{excerpt(item.get('original_segment', ''), 120)}\" -> \"{excerpt(item.get('replacement', ''), 120)}\"")
    elif status == "rejected":
        append_memory_summary(project, f"Rejected suggestion for: \"{excerpt(item.get('original_segment', ''), 160)}\"")


def extract_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="需要安装 pypdf 才能读取 PDF。") from exc
    reader = PdfReader(str(path))
    return "\n\n".join(page.extract_text() or "" for page in reader.pages)


def extract_docx(path: Path) -> str:
    try:
        from docx import Document
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="需要安装 python-docx 才能读取 Word 文件。") from exc
    document = Document(str(path))
    return "\n".join(paragraph.text for paragraph in document.paragraphs if paragraph.text.strip())


def extract_csv(path: Path) -> str:
    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        for idx, row in enumerate(reader):
            if idx >= 200:
                rows.append(["..."])
                break
            rows.append(row)
    return "\n".join("\t".join(cell for cell in row) for row in rows)


def extract_xlsx(path: Path) -> str:
    try:
        from openpyxl import load_workbook
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="需要安装 openpyxl 才能读取 Excel 文件。") from exc
    workbook = load_workbook(str(path), read_only=True, data_only=True)
    parts = []
    for sheet in workbook.worksheets[:5]:
        parts.append(f"工作表: {sheet.title}")
        for idx, row in enumerate(sheet.iter_rows(values_only=True)):
            if idx >= 100:
                parts.append("...")
                break
            parts.append("\t".join("" if value is None else str(value) for value in row))
    return "\n".join(parts)


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return extract_pdf(path)
    if suffix == ".docx":
        return extract_docx(path)
    if suffix == ".csv":
        return extract_csv(path)
    if suffix in [".xlsx", ".xlsm"]:
        return extract_xlsx(path)
    raise HTTPException(status_code=400, detail="目前支持 PDF、Word .docx、CSV 和 Excel .xlsx。")


def chunks(text: str, size: int = 1200) -> list[str]:
    clean = re.sub(r"\s+", " ", text).strip()
    return [clean[i : i + size] for i in range(0, len(clean), size) if clean[i : i + size].strip()]


def search_sources(query: str, limit: int = 5) -> list[dict[str, str]]:
    project = workspace_path()
    terms = [term.lower() for term in re.findall(r"[\w\-]{2,}", query)]
    scored = []
    for item in read_source_index():
        text_path = project / "sources" / item.get("text_file", "")
        if not text_path.exists():
            continue
        for chunk in chunks(text_path.read_text(encoding="utf-8", errors="ignore")):
            lower = chunk.lower()
            score = sum(lower.count(term) for term in terms)
            if not terms and query[:12] in chunk:
                score = 1
            if score > 0:
                scored.append((score, item["filename"], chunk))
    scored.sort(key=lambda row: row[0], reverse=True)
    return [{"filename": filename, "text": text} for _, filename, text in scored[:limit]]


def new_memory_id(prefix: str) -> str:
    return f"{prefix}-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"


def build_ai_prompt(req: SuggestRequest, document: str, project: Path) -> tuple[str, list[dict[str, str]]]:
    outline = outline_from_document(document)
    context_query = f"{req.instruction}\n{req.selected_text}"
    source_hits = search_sources(context_query)
    payload = {
        "user_instruction": req.instruction,
        "selected_text": req.selected_text,
        "paper_outline": outline,
        "local_sources": source_hits,
        "project_memory": build_memory_context(project),
    }
    return (
        json.dumps(payload, ensure_ascii=False, indent=2),
        source_hits,
    )


def ai_instructions() -> str:
    return (
        "You are a rigorous academic writing collaborator. "
        "By default, revise the selected passage in polished academic English. "
        "Use only the selected text, paper outline, and provided local-source excerpts. "
        "Do not invent citations, data, or findings; flag uncertainty clearly. "
        "Return JSON only with these fields: rewritten_text, rationale, risks, citation_or_data_notes, confidence."
    )


def prepare_ai_request(req: SuggestRequest) -> tuple[Any, dict[str, Any], str, Path, list[dict[str, str]]]:
    if not req.selected_text.strip():
        raise HTTPException(status_code=400, detail="请先在正文中选中一段要修改的文字。")
    api_key = os.environ.get("OPENAI_API_KEY") or load_env_file().get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=400, detail="请先在设置中填写 OpenAI API Key。")
    try:
        import openai
        from openai import OpenAI
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="需要安装 openai Python 包。") from exc

    settings = read_settings()
    project = workspace_path()
    document = req.document if req.document is not None else paper_path().read_text(encoding="utf-8")
    prompt, source_hits = build_ai_prompt(req, document, project)
    client = OpenAI(api_key=api_key)
    if not hasattr(client, "responses"):
        version = getattr(openai, "__version__", "unknown")
        raise HTTPException(
            status_code=500,
            detail=(
                f"OpenAI Python SDK 版本过旧（当前 {version}），不支持 Responses API。"
                "请在 /Users/anqizhang/tool 运行 ./setup.sh 后重启。"
            ),
        )
    return client, settings, prompt, project, source_hits


def parse_ai_json(text: str) -> dict[str, Any]:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                pass
    return {
        "rewritten_text": text.strip(),
        "rationale": "AI 返回了非结构化内容，已作为改写文本显示。",
        "risks": ["请人工核对事实、引用和数据。"],
        "citation_or_data_notes": [],
        "confidence": "medium",
    }


@app.on_event("startup")
def startup() -> None:
    ensure_workspace()


@app.get("/api/project")
def get_project() -> dict[str, Any]:
    ensure_workspace()
    project_id = active_project_id()
    project = workspace_path(project_id)
    content = (project / "paper.qmd").read_text(encoding="utf-8")
    settings = read_settings()
    quarto_path = shutil.which("quarto")
    return {
        "projects_root": str(PROJECTS_ROOT),
        "workspace": str(project),
        "active_project": project_id,
        "projects": existing_projects(),
        "paper_exists": (project / "paper.qmd").exists(),
        "outline": outline_from_document(content),
        "sources": read_source_index(project_id),
        "files": list_project_files(project),
        "memory": memory_overview(project),
        "settings": {**settings, "api_key_masked": masked_api_key()},
        "quarto_available": quarto_path is not None,
        "quarto_path": quarto_path,
        "quarto_message": (
            "Quarto is installed and ready for Word export."
            if quarto_path
            else "Quarto was not found. Editing and AI still work; install Quarto to export Word/PDF."
        ),
    }


@app.post("/api/project/create")
def create_project(req: ProjectCreate) -> dict[str, Any]:
    name = (req.name or "Thesis Draft").strip()
    project_id = slugify(name)
    suffix = 2
    candidate = project_id
    while (safe_project_path(candidate) / "paper.qmd").exists():
        candidate = f"{project_id}-{suffix}"
        suffix += 1
    ensure_project(candidate, title=name, seed_legacy=(not existing_projects()))
    set_active_project(candidate)
    return get_project()


@app.post("/api/project/open")
def open_project(req: ProjectOpen) -> dict[str, Any]:
    set_active_project(req.project_id)
    return get_project()


@app.get("/api/document")
def get_document() -> dict[str, str]:
    ensure_workspace()
    return {"content": paper_path().read_text(encoding="utf-8")}


@app.post("/api/document")
def update_document(update: DocumentUpdate) -> dict[str, Any]:
    ensure_workspace()
    paper_path().write_text(update.content, encoding="utf-8")
    return {"ok": True, "outline": outline_from_document(update.content)}


@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    settings = read_settings()
    return {**settings, "api_key_masked": masked_api_key()}


@app.post("/api/settings")
def update_settings(update: SettingsUpdate) -> dict[str, Any]:
    settings = read_settings()
    for field in ["model", "reasoning", "reference_doc", "export_dir"]:
        value = getattr(update, field)
        if value:
            settings[field] = value
    if update.api_key:
        save_api_key(update.api_key)
    save_settings(settings)
    return get_settings()


@app.get("/api/memory")
def get_memory() -> dict[str, Any]:
    ensure_workspace()
    project = workspace_path()
    return memory_overview(project)


@app.post("/api/sources/import")
async def import_source(file: UploadFile = File(...)) -> dict[str, Any]:
    ensure_workspace()
    if not file.filename:
        raise HTTPException(status_code=400, detail="没有收到文件名。")
    project = workspace_path()
    safe_name = Path(file.filename).name
    target = project / "sources" / safe_name
    with target.open("wb") as handle:
        handle.write(await file.read())
    extracted = extract_text(target)
    if not extracted.strip():
        raise HTTPException(status_code=400, detail="文件已保存，但没有提取到可读取的文字。")
    text_file = f"{target.stem}.txt"
    (project / "sources" / text_file).write_text(extracted, encoding="utf-8")
    items = [item for item in read_source_index() if item.get("filename") != safe_name]
    entry = {
        "filename": safe_name,
        "text_file": text_file,
        "characters": len(extracted),
        "imported_at": datetime.now().isoformat(timespec="seconds"),
    }
    items.append(entry)
    write_source_index(items)
    return {"ok": True, "source": entry}


@app.post("/api/ai/suggest")
def suggest(req: SuggestRequest) -> dict[str, Any]:
    client, settings, prompt, project, source_hits = prepare_ai_request(req)
    suggestion_id = new_memory_id("sug")
    try:
        response = client.responses.create(
            model=settings["model"],
            reasoning={"effort": settings["reasoning"]},
            instructions=ai_instructions(),
            input=prompt,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"OpenAI 调用失败：{exc}") from exc
    raw_text = getattr(response, "output_text", "") or str(response)
    parsed = parse_ai_json(raw_text)
    log_ai_suggestion(project, suggestion_id, req, parsed, source_hits, raw_text)
    return {"ok": True, "suggestion_id": suggestion_id, "suggestion": parsed, "raw": raw_text}


@app.post("/api/ai/suggest/stream")
def suggest_stream(req: SuggestRequest) -> StreamingResponse:
    client, settings, prompt, project, source_hits = prepare_ai_request(req)
    suggestion_id = new_memory_id("sug")

    def event_stream():
        raw_parts: list[str] = []
        try:
            stream = client.responses.create(
                model=settings["model"],
                reasoning={"effort": settings["reasoning"]},
                instructions=ai_instructions(),
                input=prompt,
                stream=True,
            )
            for event in stream:
                event_type = getattr(event, "type", "")
                if event_type == "response.output_text.delta":
                    delta = getattr(event, "delta", "")
                    raw_parts.append(delta)
                    yield f"data: {json.dumps({'type': 'delta', 'text': delta}, ensure_ascii=False)}\n\n"
                elif event_type == "response.completed":
                    raw_text = "".join(raw_parts)
                    parsed = parse_ai_json(raw_text)
                    log_ai_suggestion(project, suggestion_id, req, parsed, source_hits, raw_text)
                    yield f"data: {json.dumps({'type': 'final', 'suggestion_id': suggestion_id, 'suggestion': parsed, 'raw': raw_text}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            payload = {"type": "error", "message": f"OpenAI 调用失败：{exc}"}
            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/ai/apply")
def apply_suggestion(req: ApplyRequest) -> dict[str, Any]:
    ensure_workspace()
    if not req.original_segment:
        raise HTTPException(status_code=400, detail="缺少原文片段，无法安全替换。")
    current_paper = paper_path()
    content = current_paper.read_text(encoding="utf-8")
    if req.original_segment not in content:
        raise HTTPException(status_code=409, detail="原文片段已经变化，请重新选择段落后再应用。")
    updated = content.replace(req.original_segment, req.replacement, 1)
    current_paper.write_text(updated, encoding="utf-8")
    log_change(
        workspace_path(),
        {
            "id": new_memory_id("chg"),
            "suggestion_id": req.suggestion_id,
            "timestamp": now_iso(),
            "type": "edit",
            "status": "accepted",
            "original_segment": excerpt(req.original_segment, limit=900),
            "replacement": excerpt(req.replacement, limit=900),
        },
    )
    return {"ok": True, "content": updated, "outline": outline_from_document(updated)}


@app.post("/api/ai/reject")
def reject_suggestion(req: RejectRequest) -> dict[str, Any]:
    ensure_workspace()
    log_change(
        workspace_path(),
        {
            "id": new_memory_id("chg"),
            "suggestion_id": req.suggestion_id,
            "timestamp": now_iso(),
            "type": "edit",
            "status": "rejected",
            "original_segment": excerpt(req.original_segment, limit=900),
            "suggestion": req.suggestion or {},
        },
    )
    return {"ok": True, "memory": memory_overview(workspace_path())}


@app.post("/api/export/docx")
def export_docx() -> dict[str, Any]:
    ensure_workspace()
    if shutil.which("quarto") is None:
        raise HTTPException(status_code=400, detail="没有找到 Quarto。请先安装 Quarto 后再导出 Word。")
    settings = read_settings()
    project = workspace_path()
    export_dir = project / settings.get("export_dir", "outputs")
    export_dir.mkdir(parents=True, exist_ok=True)
    output_name = f"paper-{datetime.now().strftime('%Y%m%d-%H%M%S')}.docx"
    command = ["quarto", "render", "paper.qmd", "--to", "docx", "--output", output_name]
    reference_doc = project / settings.get("reference_doc", "templates/reference.docx")
    if reference_doc.exists():
        command.extend(["-M", f"reference-doc:{reference_doc}"])
    result = subprocess.run(command, cwd=project, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=f"Word 导出失败：{result.stderr or result.stdout}")
    generated = project / output_name
    final_path = export_dir / output_name
    if generated.exists() and generated != final_path:
        generated.replace(final_path)
    return {"ok": True, "path": str(final_path), "filename": output_name}

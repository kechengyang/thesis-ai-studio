from __future__ import annotations

import csv
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from .analysis_skills import (
    chat_brief_turn,
    chat_data_turn,
    chat_mindmap_turn,
    dataframe_profile,
    insert_figure_into_manuscript,
    insert_mermaid_into_manuscript,
    load_tabular_data,
    run_brief_skill,
    run_data_analysis_skill,
    run_mindmap_skill,
    safe_project_file,
    SUPPORTED_DATA_SUFFIXES,
)
from .config import (
    DEFAULT_AI_INSTRUCTION,
    DEFAULT_PROJECT_ID,
    DEFAULT_PROJECTS_ROOT,
    DEFAULT_PROVIDER_MODELS,
    ENV_PATH,
    LEGACY_WORKSPACE,
    PROJECT_FOLDERS,
    STATE_PATH,
    load_env_file as config_load_env_file,
    mask_secret,
    read_settings as config_read_settings,
    save_settings as config_save_settings,
    settings_payload as config_settings_payload,
    update_env_values,
)
from .literature import (
    build_literature_prompt,
    cache_literature_result,
    import_literature_source,
    resolve_literature_candidate,
)
from .providers import get_provider, provider_payload
from .schemas import (
    ApplyRequest,
    BriefRequest,
    ChatRequest,
    DataAnalysisRequest,
    DataFigureInsertRequest,
    DocumentCreate,
    DocumentOpen,
    DocumentUpdate,
    LiteratureAnalyzeRequest,
    LiteratureImportRequest,
    MindmapInsertRequest,
    MindmapRequest,
    ProjectCreate,
    ProjectOpen,
    RejectRequest,
    SettingsUpdate,
    SuggestRequest,
    WorkspaceRootUpdate,
)

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

app = FastAPI(title="Quarto AI Paper Studio", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "null",  # Electron file:// pages send Origin: null
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

WORKSPACE_REQUIRED_MESSAGE = "请先选择 Workspace 文件夹。"
WORKSPACE_MISSING_MESSAGE = "当前 Workspace 文件夹不存在，请重新选择。"
WORKSPACE_INVALID_MESSAGE = "当前 Workspace 路径不是文件夹，请重新选择。"


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip().lower()).strip("-._")
    return slug[:80] or DEFAULT_PROJECT_ID


def ensure_settings() -> None:
    config_read_settings()


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


def merge_state(**updates: Any) -> dict[str, Any]:
    state = read_state()
    state.update(updates)
    write_state(state)
    return state


def workspace_state_key(path: Optional[Path] = None) -> str:
    return str((path or workspace_path()).resolve())


def configured_projects_root() -> Optional[Path]:
    env_root = str(os.environ.get("THESIS_PROJECTS_ROOT", "")).strip()
    if env_root:
        return Path(env_root).expanduser().resolve()
    state = read_state()
    remembered_workspace = str(state.get("workspace_path", "")).strip()
    if remembered_workspace:
        return Path(remembered_workspace).expanduser().resolve()
    remembered_root = str(state.get("projects_root", "")).strip()
    if remembered_root:
        return Path(remembered_root).expanduser().resolve()
    return None


def suggested_projects_root() -> Path:
    return (configured_projects_root() or DEFAULT_PROJECTS_ROOT).resolve()


def workspace_label(path: Optional[Path] = None) -> str:
    target = (path or configured_projects_root() or DEFAULT_PROJECTS_ROOT).resolve()
    return target.name or DEFAULT_PROJECT_ID


def projects_root_path() -> Path:
    root = configured_projects_root()
    if root is None:
        raise HTTPException(status_code=409, detail=WORKSPACE_REQUIRED_MESSAGE)
    return root


def normalize_projects_root(root_path: str) -> Path:
    cleaned = str(root_path or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="请选择一个 Workspace 文件夹。")
    return Path(cleaned).expanduser()


def safe_project_path(project_id: str, root: Optional[Path] = None) -> Path:
    projects_root = (root or projects_root_path()).expanduser()
    project_path = (projects_root / slugify(project_id)).resolve()
    root = projects_root.resolve()
    try:
        project_path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="项目名称不安全，请换一个名称。") from exc
    return project_path


def manuscript_paths(project: Path) -> list[Path]:
    return sorted(path for path in project.iterdir() if path.is_file() and path.suffix.lower() == ".qmd")


def manuscript_entries(project_id: Optional[str] = None) -> list[dict[str, Any]]:
    project = workspace_path(project_id)
    return [
        {
            "name": path.name,
            "relative_path": path.name,
            "size": path.stat().st_size,
            "size_label": file_size_label(path.stat().st_size),
            "modified_at": datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"),
        }
        for path in manuscript_paths(project)
    ]


def default_manuscript_name(project: Path) -> str:
    manuscripts = manuscript_paths(project)
    if not manuscripts:
        return "paper.qmd"
    preferred = project / "paper.qmd"
    if preferred.exists():
        return preferred.name
    return manuscripts[0].name


def active_manuscript_relative_path(project_id: Optional[str] = None) -> str:
    project = workspace_path(project_id)
    project_key = workspace_state_key(project)
    state = read_state()
    active_manuscripts = state.get("active_manuscripts", {})
    candidate = str(active_manuscripts.get(project_key, "")).strip()
    if candidate:
        path = project / candidate
        if path.exists() and path.is_file() and path.suffix.lower() == ".qmd":
            return candidate
    fallback = default_manuscript_name(project)
    active_manuscripts[project_key] = fallback
    merge_state(active_manuscripts=active_manuscripts)
    return fallback


def set_active_manuscript(relative_path: str, project_id: Optional[str] = None) -> str:
    project = workspace_path(project_id)
    cleaned = Path(relative_path.strip()).name
    if not cleaned.lower().endswith(".qmd"):
        raise HTTPException(status_code=400, detail="只能切换到 qmd 文稿。")
    target = project / cleaned
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="没有找到这个 qmd 文稿。")
    project_key = workspace_state_key(project)
    state = read_state()
    active_manuscripts = state.get("active_manuscripts", {})
    active_manuscripts[project_key] = cleaned
    merge_state(active_manuscripts=active_manuscripts)
    return cleaned


def paper_path(project_id: Optional[str] = None) -> Path:
    project = workspace_path(project_id)
    return project / active_manuscript_relative_path(project_id)


def create_manuscript_file(filename: str, project_id: Optional[str] = None) -> Path:
    project = workspace_path(project_id)
    raw_name = Path(filename.strip()).stem
    safe_name = slugify(raw_name)
    if not safe_name:
        raise HTTPException(status_code=400, detail="请输入新的 qmd 文件名。")
    target = project / f"{safe_name}.qmd"
    if target.exists():
        raise HTTPException(status_code=409, detail="这个 qmd 文件已经存在。")
    title = safe_name.replace("-", " ").title()
    target.write_text(DEFAULT_PAPER.replace('title: "Working Paper Title"', f'title: "{title}"'), encoding="utf-8")
    set_active_manuscript(target.name, project_id)
    return target


def project_file_path(relative_path: str, project_id: Optional[str] = None) -> Path:
    project = workspace_path(project_id).resolve()
    cleaned = relative_path.strip().lstrip("/")
    if not cleaned:
        raise HTTPException(status_code=400, detail="缺少文件路径。")
    candidate = (project / cleaned).resolve()
    try:
        candidate.relative_to(project)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="文件路径不安全。") from exc
    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail="没有找到这个项目文件。")
    return candidate


def source_index_path(project_id: Optional[str] = None) -> Path:
    return workspace_path(project_id) / "sources" / "sources_index.json"


def memory_dir(project_id: Optional[str] = None) -> Path:
    return workspace_path(project_id) / "memory"


def memory_path(name: str, project_id: Optional[str] = None) -> Path:
    return memory_dir(project_id) / name


def existing_projects(root: Optional[Path] = None) -> list[dict[str, Any]]:
    workspace = (root or workspace_path()).expanduser().resolve()
    if not workspace.exists() or not workspace.is_dir():
        return []
    manuscripts = manuscript_paths(workspace)
    modified_source = max(manuscripts, key=lambda item: item.stat().st_mtime) if manuscripts else workspace
    return [
        {
            "id": workspace_label(workspace),
            "name": workspace_label(workspace),
            "path": str(workspace),
            "paper_exists": bool(manuscripts),
            "modified_at": datetime.fromtimestamp(modified_source.stat().st_mtime).isoformat(timespec="seconds"),
        }
    ]


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


def ensure_project_scaffold(project: Path) -> None:
    for relative in [
        "data",
        "sources",
        "figures",
        "templates",
        "outputs",
        "outputs/analysis",
        "outputs/briefs",
        "outputs/mindmaps",
        "memory",
        "memory/chats",
    ]:
        (project / relative).mkdir(parents=True, exist_ok=True)


def ensure_project(
    project_id: Optional[str] = None,
    title: Optional[str] = None,
    seed_legacy: bool = False,
    root: Optional[Path] = None,
) -> Path:
    ensure_settings()
    project = (root or projects_root_path()).expanduser().resolve()
    project.mkdir(parents=True, exist_ok=True)
    ensure_project_scaffold(project)
    if not manuscript_paths(project):
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


def resolve_active_project_id(root: Optional[Path] = None, preferred: Optional[str] = None) -> str:
    project = ensure_project(title=preferred or workspace_label(root or projects_root_path()), root=root or projects_root_path())
    return workspace_label(project)


def active_project_id() -> str:
    state = read_state()
    selected = resolve_active_project_id(preferred=state.get("active_project", workspace_label(projects_root_path())))
    updates: dict[str, Any] = {"active_project": selected}
    if "THESIS_PROJECTS_ROOT" not in os.environ:
        updates["workspace_path"] = str(projects_root_path())
    merge_state(**updates)
    return selected


def set_active_project(project_id: str) -> None:
    target = (workspace_path().parent / slugify(project_id)).resolve()
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=404, detail="没有找到这个 Workspace 文件夹。")
    set_projects_root(str(target))


def set_projects_root(root_path: str) -> Path:
    if "THESIS_PROJECTS_ROOT" in os.environ:
        raise HTTPException(status_code=409, detail="当前通过 THESIS_PROJECTS_ROOT 启动，界面里不能修改 Workspace 文件夹。")
    project = normalize_projects_root(root_path)
    if project.exists() and not project.is_dir():
        raise HTTPException(status_code=400, detail="所选路径不是文件夹。")
    project.mkdir(parents=True, exist_ok=True)
    project = project.resolve()
    ensure_project(title=workspace_label(project), root=project)
    merge_state(workspace_path=str(project), projects_root=str(project), active_project=workspace_label(project))
    return project


def workspace_path(project_id: Optional[str] = None) -> Path:
    project = projects_root_path()
    if project.exists() and not project.is_dir():
        raise HTTPException(status_code=409, detail=WORKSPACE_INVALID_MESSAGE)
    if not project.exists():
        raise HTTPException(status_code=409, detail=WORKSPACE_MISSING_MESSAGE)
    ensure_project(title=workspace_label(project), root=project)
    return project


def ensure_workspace() -> None:
    project = workspace_path()
    active_project_id()
    if "THESIS_PROJECTS_ROOT" not in os.environ:
        merge_state(workspace_path=str(project), projects_root=str(project))


def load_env_file() -> dict[str, str]:
    return config_load_env_file()


def read_settings() -> dict[str, Any]:
    return config_read_settings()


def save_settings(settings: dict[str, Any]) -> None:
    config_save_settings(settings)


def save_api_key(api_key: str) -> None:
    update_env_values({"OPENAI_API_KEY": api_key})


def masked_api_key(provider: Optional[str] = None) -> str:
    settings = read_settings()
    env = load_env_file()
    if provider == "deepseek":
        return mask_secret(os.environ.get("DEEPSEEK_API_KEY") or env.get("DEEPSEEK_API_KEY", ""))
    if provider == "openai":
        return mask_secret(os.environ.get("OPENAI_API_KEY") or env.get("OPENAI_API_KEY", ""))
    active_provider = provider or settings.get("provider", "openai")
    if active_provider == "deepseek":
        return mask_secret(os.environ.get("DEEPSEEK_API_KEY") or env.get("DEEPSEEK_API_KEY", ""))
    return mask_secret(os.environ.get("OPENAI_API_KEY") or env.get("OPENAI_API_KEY", ""))


def choose_projects_root_dialog() -> Optional[Path]:
    initial_dir = suggested_projects_root()
    if sys.platform == "darwin":
        escaped_initial_dir = str(initial_dir).replace("\\", "\\\\").replace('"', '\\"')
        script_lines = ['set promptText to "Choose a Workspace folder"']
        if initial_dir.exists():
            script_lines.append(f'set defaultFolder to POSIX file "{escaped_initial_dir}"')
            script_lines.append("set chosenFolder to choose folder with prompt promptText default location defaultFolder")
        else:
            script_lines.append("set chosenFolder to choose folder with prompt promptText")
        script_lines.append("POSIX path of chosenFolder")
        result = subprocess.run(
            ["osascript", *sum((["-e", line] for line in script_lines), [])],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return None
        selected = result.stdout.strip()
        return Path(selected).expanduser() if selected else None
    raise HTTPException(status_code=501, detail="当前系统暂未实现文件夹选择器，请手动输入路径。")


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
    manuscript_files = manuscript_paths(project)
    manuscript_names = {path.name for path in manuscript_files}
    categories = [
        ("Manuscript", manuscript_files + ([project / "references.bib"] if (project / "references.bib").exists() else [])),
        (
            "Project Root",
            sorted(
                path
                for path in project.iterdir()
                if path.is_file() and path.name not in manuscript_names and path.name != "references.bib"
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


VALID_CHAT_TOOLS = {"literature", "data", "mindmap", "brief"}


def chat_history_path(tool: str, project: Optional[Path] = None) -> Path:
    return (project or workspace_path()) / "memory" / "chats" / f"{tool}.jsonl"


def load_chat_history(tool: str, project: Optional[Path] = None) -> list[dict[str, Any]]:
    path = chat_history_path(tool, project)
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def append_chat_messages(
    tool: str,
    project: Path,
    user_msg: dict[str, Any],
    assistant_msg: dict[str, Any],
) -> None:
    path = chat_history_path(tool, project)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(user_msg, ensure_ascii=False) + "\n")
        handle.write(json.dumps(assistant_msg, ensure_ascii=False) + "\n")


def clear_chat_history(tool: str, project: Path) -> None:
    path = chat_history_path(tool, project)
    if path.exists():
        path.write_text("", encoding="utf-8")


def build_chat_messages(
    history: list[dict[str, Any]],
    new_message: str,
    embedded_context: str,
) -> list[dict[str, str]]:
    recent = history[-16:] if len(history) > 16 else history
    messages: list[dict[str, str]] = []
    for msg in recent:
        messages.append({"role": msg["role"], "content": str(msg.get("content", ""))})
    user_content = new_message
    if embedded_context:
        user_content = f"{new_message}\n\nContext:\n{embedded_context}"
    messages.append({"role": "user", "content": user_content})
    return messages


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


def build_ai_trace(settings: dict[str, Any], source_hits: list[dict[str, str]], project: Path) -> dict[str, Any]:
    memory_context = build_memory_context(project)
    return {
        "provider": settings.get("provider", "openai"),
        "model": settings.get("model", ""),
        "reasoning_effort": settings.get("reasoning", ""),
        "source_count": len(source_hits),
        "source_files": sorted({source["filename"] for source in source_hits}),
        "memory_summary_used": bool(memory_context.get("summary")),
        "recent_ai_interactions_used": len(memory_context.get("recent_ai_interactions", [])),
        "recent_edits_used": len(memory_context.get("recent_accepted_or_rejected_edits", [])),
    }


def _chat_embedded_context(tool: str, req: ChatRequest, project: Path) -> str:
    """Build the JSON context string embedded in the new user message."""
    document = paper_path().read_text(encoding="utf-8")
    outline = outline_from_document(document)

    if tool == "mindmap":
        return json.dumps(
            {"outline": outline, "document_excerpt": document[:4000]},
            ensure_ascii=False,
        )

    if tool == "brief":
        from .analysis_skills import extract_section_text
        format_val = req.context.get("format", "ppt")
        scope = req.context.get("scope_heading", "")
        scoped = extract_section_text(document, scope).strip() or document
        return json.dumps(
            {"target_format": format_val, "scope_heading": scope, "outline": outline, "source_excerpt": scoped[:6000]},
            ensure_ascii=False,
        )

    if tool == "data":
        relative_path = req.context.get("relative_path", "")
        if not relative_path:
            raise HTTPException(status_code=400, detail="data tool 需要提供 relative_path。")
        data_path = safe_project_file(project, relative_path, SUPPORTED_DATA_SUFFIXES)
        df = load_tabular_data(data_path)
        profile = dataframe_profile(df)
        previous_code = ""
        for msg in reversed(req.history):
            if msg.role == "assistant" and msg.result and msg.result.get("generated_code"):
                previous_code = msg.result["generated_code"]
                break
        ctx: dict[str, Any] = {
            "data_file": data_path.name,
            "manuscript_outline": outline,
            "dataset_profile": profile,
        }
        if previous_code:
            ctx["previous_code"] = previous_code
        return json.dumps(ctx, ensure_ascii=False)

    if tool == "literature":
        candidate = resolve_literature_candidate(req.message)
        candidate.setdefault("excerpt", "")
        return json.dumps(
            {"candidate": candidate, "outline": outline},
            ensure_ascii=False,
        )

    return ""


def run_chat_turn(
    tool: str,
    project: Path,
    provider: Any,
    settings: dict[str, Any],
    req: ChatRequest,
) -> dict[str, Any]:
    """Dispatch one chat turn to the appropriate skill and return the assistant message dict."""
    document = paper_path().read_text(encoding="utf-8")
    outline = outline_from_document(document)
    history_dicts = [msg.model_dump() for msg in req.history]
    embedded_context = _chat_embedded_context(tool, req, project)
    messages = build_chat_messages(history_dicts, req.message, embedded_context)

    if tool == "mindmap":
        result_data = chat_mindmap_turn(project, provider, settings, messages, outline, document)
        result = result_data["mindmap"]
        content = result.get("content") or result.get("summary", "已生成思维导图。")

    elif tool == "brief":
        target_format = req.context.get("format", "ppt")
        result_data = chat_brief_turn(project, provider, settings, messages, target_format, outline)
        result = result_data["brief"]
        content = result.get("content") or result.get("summary", "已生成展示摘要。")

    elif tool == "data":
        relative_path = req.context.get("relative_path", "")
        result_data = chat_data_turn(project, provider, settings, messages, relative_path, outline)
        result = result_data["analysis"]
        content = result.get("content") or result.get("summary", "已生成图表。")

    elif tool == "literature":
        from .providers import literature_instructions, parse_literature_json
        candidate = resolve_literature_candidate(req.message)
        candidate.setdefault("excerpt", "")
        raw_text = provider.generate_chat_json(settings, literature_instructions(settings), messages)
        analysis = parse_literature_json(raw_text)
        analysis["title"] = analysis.get("title") or candidate.get("title", "")
        analysis["authors"] = analysis.get("authors") or candidate.get("authors", [])
        analysis["year"] = analysis.get("year") or candidate.get("year", "")
        analysis["venue"] = analysis.get("venue") or candidate.get("venue", "")
        cached_payload = {
            "query": req.message,
            "candidate": candidate,
            "analysis": analysis,
            "raw": raw_text,
            "created_at": now_iso(),
        }
        cache_id = cache_literature_result(cached_payload)
        content = analysis.get("content") or analysis.get("summary", "已完成文献分析。")
        result = {
            "analysis": analysis,
            "candidate": candidate,
            "cache_id": cache_id,
            "download_available": bool(candidate.get("download_url")),
        }

    else:
        raise HTTPException(status_code=400, detail=f"未知 tool：{tool}")

    return {
        "id": new_memory_id("msg"),
        "role": "assistant",
        "timestamp": now_iso(),
        "content": content,
        "result": result,
    }


def configured_provider(settings: Optional[dict[str, Any]] = None):
    resolved_settings = settings or read_settings()
    provider = get_provider(resolved_settings.get("provider", "openai"), load_env_file())
    if not provider.configured:
        raise HTTPException(status_code=400, detail=f"请先在设置中填写 {provider.display_name} API Key。")
    return provider, resolved_settings


def prepare_ai_request(req: SuggestRequest) -> tuple[Any, dict[str, Any], str, Path, list[dict[str, str]]]:
    if not req.selected_text.strip():
        raise HTTPException(status_code=400, detail="请先在正文中选中一段要修改的文字。")
    provider, settings = configured_provider()
    project = workspace_path()
    document = req.document if req.document is not None else paper_path().read_text(encoding="utf-8")
    prompt, source_hits = build_ai_prompt(req, document, project)
    return provider, settings, prompt, project, source_hits




@app.on_event("startup")
def startup() -> None:
    ensure_settings()


@app.get("/api/project")
def get_project() -> dict[str, Any]:
    settings = read_settings()
    quarto_path = shutil.which("quarto")
    payload = {
        "workspace_configured": False,
        "workspace_error": "",
        "workspace_suggestion": str(DEFAULT_PROJECTS_ROOT.resolve()),
        "projects_root": "",
        "workspace": "",
        "active_project": "",
        "active_manuscript": "",
        "manuscripts": [],
        "projects": [],
        "paper_exists": False,
        "outline": [],
        "sources": [],
        "files": [],
        "memory": {
            "conversation_count": 0,
            "change_count": 0,
            "recent_conversations": [],
            "recent_changes": [],
        },
        "settings": config_settings_payload(),
        "quarto_available": quarto_path is not None,
        "quarto_path": quarto_path,
        "quarto_message": (
            "Quarto is installed and ready for Word export."
            if quarto_path
            else "Quarto was not found. Editing and AI still work; install Quarto to export Word/PDF."
        ),
    }
    configured_root = configured_projects_root()
    if configured_root is None:
        return payload
    payload["projects_root"] = str(configured_root)
    if configured_root.exists() and not configured_root.is_dir():
        payload["workspace_error"] = WORKSPACE_INVALID_MESSAGE
        return payload
    if not configured_root.exists():
        payload["workspace_error"] = WORKSPACE_MISSING_MESSAGE
        return payload
    ensure_workspace()
    project_id = active_project_id()
    project = workspace_path(project_id)
    active_manuscript = active_manuscript_relative_path(project_id)
    content = (project / active_manuscript).read_text(encoding="utf-8")
    payload.update(
        {
            "workspace_configured": True,
            "workspace": str(project),
            "active_project": project_id,
            "active_manuscript": active_manuscript,
            "manuscripts": manuscript_entries(project_id),
            "projects": existing_projects(),
            "paper_exists": bool(manuscript_paths(project)),
            "outline": outline_from_document(content),
            "sources": read_source_index(project_id),
            "files": list_project_files(project),
            "memory": memory_overview(project),
        }
    )
    return payload


@app.post("/api/project/create")
def create_project(req: ProjectCreate) -> dict[str, Any]:
    name = (req.name or "Thesis Draft").strip()
    project_id = slugify(name)
    parent = workspace_path().parent
    suffix = 2
    candidate = project_id
    target = (parent / candidate).resolve()
    while target.exists():
        candidate = f"{project_id}-{suffix}"
        target = (parent / candidate).resolve()
        suffix += 1
    ensure_project(title=name, seed_legacy=False, root=target)
    set_projects_root(str(target))
    return get_project()


@app.post("/api/project/open")
def open_project(req: ProjectOpen) -> dict[str, Any]:
    set_active_project(req.project_id)
    return get_project()


@app.post("/api/workspace/root")
def update_workspace_root(req: WorkspaceRootUpdate) -> dict[str, Any]:
    set_projects_root(req.path)
    return get_project()


@app.post("/api/workspace/root/choose")
def choose_workspace_root() -> dict[str, Any]:
    selected = choose_projects_root_dialog()
    if not selected:
        return {"ok": False, "cancelled": True}
    set_projects_root(str(selected))
    payload = get_project()
    payload["ok"] = True
    payload["cancelled"] = False
    return payload


@app.get("/api/document")
def get_document() -> dict[str, Any]:
    ensure_workspace()
    current = paper_path()
    return {
        "content": current.read_text(encoding="utf-8"),
        "relative_path": str(current.relative_to(workspace_path())),
        "filename": current.name,
    }


@app.post("/api/document/open")
def open_document(req: DocumentOpen) -> dict[str, Any]:
    ensure_workspace()
    relative_path = set_active_manuscript(req.relative_path)
    current = workspace_path() / relative_path
    return {
        "ok": True,
        "content": current.read_text(encoding="utf-8"),
        "relative_path": relative_path,
        "filename": current.name,
        "outline": outline_from_document(current.read_text(encoding="utf-8")),
    }


@app.post("/api/document/create")
def create_document(req: DocumentCreate) -> dict[str, Any]:
    ensure_workspace()
    current = create_manuscript_file(req.filename)
    content = current.read_text(encoding="utf-8")
    return {
        "ok": True,
        "content": content,
        "relative_path": str(current.relative_to(workspace_path())),
        "filename": current.name,
        "outline": outline_from_document(content),
    }


@app.get("/api/project/file")
def get_project_file(relative_path: str) -> FileResponse:
    ensure_workspace()
    return FileResponse(project_file_path(relative_path))


@app.post("/api/document")
def update_document(update: DocumentUpdate) -> dict[str, Any]:
    ensure_workspace()
    current = paper_path()
    current.write_text(update.content, encoding="utf-8")
    return {"ok": True, "relative_path": str(current.relative_to(workspace_path())), "outline": outline_from_document(update.content)}


@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    return config_settings_payload()


@app.get("/api/providers")
def get_providers() -> dict[str, Any]:
    return provider_payload(read_settings(), load_env_file())


@app.post("/api/settings")
def update_settings(update: SettingsUpdate) -> dict[str, Any]:
    settings = read_settings()
    for field in ["provider", "model", "reasoning", "reference_doc", "export_dir"]:
        value = getattr(update, field)
        if value:
            settings[field] = value
    if update.instruction is not None:
        settings["instruction"] = update.instruction.strip() or DEFAULT_AI_INSTRUCTION
    if update.provider and not update.model:
        defaults = DEFAULT_PROVIDER_MODELS.get(update.provider, [])
        if defaults:
            settings["model"] = defaults[0]["id"]
    env_updates: dict[str, str | None] = {}
    if update.api_key:
        env_updates["OPENAI_API_KEY"] = update.api_key
    if update.openai_api_key:
        env_updates["OPENAI_API_KEY"] = update.openai_api_key
    if update.deepseek_api_key:
        env_updates["DEEPSEEK_API_KEY"] = update.deepseek_api_key
    if update.deepseek_base_url:
        env_updates["DEEPSEEK_BASE_URL"] = update.deepseek_base_url
    if env_updates:
        update_env_values(env_updates)
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


@app.post("/api/literature/analyze")
def analyze_literature(req: LiteratureAnalyzeRequest) -> dict[str, Any]:
    ensure_workspace()
    provider, settings = configured_provider()
    project = workspace_path()
    candidate = resolve_literature_candidate(req.query)
    candidate.setdefault("excerpt", "")
    outline = outline_from_document(paper_path().read_text(encoding="utf-8"))
    prompt = build_literature_prompt(req.query, candidate, outline)
    try:
        result = provider.analyze_literature(settings, prompt)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"{provider.display_name} 调用失败：{exc}") from exc
    analysis = result["analysis"]
    analysis["title"] = analysis.get("title") or candidate.get("title", "")
    analysis["authors"] = analysis.get("authors") or candidate.get("authors", [])
    analysis["year"] = analysis.get("year") or candidate.get("year", "")
    analysis["venue"] = analysis.get("venue") or candidate.get("venue", "")
    cached_payload = {
        "query": req.query,
        "candidate": candidate,
        "analysis": analysis,
        "raw": result.get("raw", ""),
        "created_at": now_iso(),
    }
    cache_id = cache_literature_result(cached_payload)
    return {
        "ok": True,
        "cache_id": cache_id,
        "candidate": candidate,
        "analysis": analysis,
        "download_available": bool(candidate.get("download_url")),
    }


@app.post("/api/literature/import")
def import_literature(req: LiteratureImportRequest) -> dict[str, Any]:
    ensure_workspace()
    project = workspace_path()
    entry = import_literature_source(req.cache_id, project, req.download_original)
    items = [item for item in read_source_index() if item.get("filename") != entry["filename"]]
    items.append(entry)
    write_source_index(items)
    return {"ok": True, "source": entry}


@app.post("/api/analysis/data")
def analyze_data(req: DataAnalysisRequest) -> dict[str, Any]:
    ensure_workspace()
    provider, settings = configured_provider()
    project = workspace_path()
    document = paper_path().read_text(encoding="utf-8")
    outline = outline_from_document(document)
    try:
        result = run_data_analysis_skill(project, provider, settings, req.relative_path, req.prompt, outline)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"{provider.display_name} 数据分析失败：{exc}") from exc
    return {"ok": True, **result}


@app.post("/api/analysis/data/insert")
def insert_data_figure(req: DataFigureInsertRequest) -> dict[str, Any]:
    ensure_workspace()
    project = workspace_path()
    safe_figure = project_file_path(req.figure_relative_path)
    if safe_figure.suffix.lower() not in [".png", ".jpg", ".jpeg", ".svg", ".webp"]:
        raise HTTPException(status_code=400, detail="只能插入图片文件到文稿中。")
    current_document = paper_path()
    updated = insert_figure_into_manuscript(
        current_document.read_text(encoding="utf-8"),
        {
            "figure_relative_path": req.figure_relative_path,
            "figure_title": req.figure_title,
            "figure_caption": req.figure_caption,
            "figure_alt_text": req.figure_alt_text or "",
            "section_title": req.section_title or "",
            "introduction": req.introduction or "",
        },
    )
    current_document.write_text(updated, encoding="utf-8")
    return {
        "ok": True,
        "content": updated,
        "relative_path": str(current_document.relative_to(project)),
        "outline": outline_from_document(updated),
    }


@app.post("/api/analysis/mindmap")
def create_mindmap(req: MindmapRequest) -> dict[str, Any]:
    ensure_workspace()
    provider, settings = configured_provider()
    project = workspace_path()
    document = paper_path().read_text(encoding="utf-8")
    outline = outline_from_document(document)
    try:
        result = run_mindmap_skill(project, provider, settings, req.prompt, outline, document)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"{provider.display_name} 思维导图生成失败：{exc}") from exc
    return {"ok": True, **result}


@app.post("/api/analysis/mindmap/insert")
def insert_mindmap(req: MindmapInsertRequest) -> dict[str, Any]:
    ensure_workspace()
    project = workspace_path()
    current_document = paper_path()
    content = current_document.read_text(encoding="utf-8")
    updated = insert_mermaid_into_manuscript(content, req.quarto_block, req.section_title or "")
    current_document.write_text(updated, encoding="utf-8")
    return {
        "ok": True,
        "content": updated,
        "relative_path": str(current_document.relative_to(project)),
        "outline": outline_from_document(updated),
    }


@app.post("/api/analysis/brief")
def create_brief(req: BriefRequest) -> dict[str, Any]:
    ensure_workspace()
    provider, settings = configured_provider()
    project = workspace_path()
    document = paper_path().read_text(encoding="utf-8")
    outline = outline_from_document(document)
    try:
        result = run_brief_skill(project, provider, settings, req.prompt, req.format, req.scope_heading, document, outline)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"{provider.display_name} 展示摘要生成失败：{exc}") from exc
    return {"ok": True, **result}


@app.get("/api/chat/{tool}")
def get_chat_history(tool: str) -> dict[str, Any]:
    if tool not in VALID_CHAT_TOOLS:
        raise HTTPException(status_code=400, detail=f"未知 tool：{tool}")
    ensure_workspace()
    project = workspace_path()
    return {"ok": True, "tool": tool, "history": load_chat_history(tool, project)}


@app.post("/api/chat/{tool}")
def post_chat_turn(tool: str, req: ChatRequest) -> dict[str, Any]:
    if tool not in VALID_CHAT_TOOLS:
        raise HTTPException(status_code=400, detail=f"未知 tool：{tool}")
    ensure_workspace()
    provider, settings = configured_provider()
    project = workspace_path()

    user_msg: dict[str, Any] = {
        "id": new_memory_id("msg"),
        "role": "user",
        "timestamp": now_iso(),
        "content": req.message,
        "context": req.context or {},
    }

    try:
        assistant_msg = run_chat_turn(tool, project, provider, settings, req)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI 调用失败：{exc}") from exc

    append_chat_messages(tool, project, user_msg, assistant_msg)
    return {"ok": True, "message": assistant_msg}


@app.delete("/api/chat/{tool}")
def delete_chat_history(tool: str) -> dict[str, Any]:
    if tool not in VALID_CHAT_TOOLS:
        raise HTTPException(status_code=400, detail=f"未知 tool：{tool}")
    ensure_workspace()
    clear_chat_history(tool, workspace_path())
    return {"ok": True}


@app.post("/api/ai/suggest")
def suggest(req: SuggestRequest) -> dict[str, Any]:
    provider, settings, prompt, project, source_hits = prepare_ai_request(req)
    suggestion_id = new_memory_id("sug")
    try:
        result = provider.create_suggestion(settings, prompt)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"{provider.display_name} 调用失败：{exc}") from exc
    raw_text = result["raw"]
    parsed = result["suggestion"]
    trace = build_ai_trace(settings, source_hits, project)
    log_ai_suggestion(project, suggestion_id, req, parsed, source_hits, raw_text)
    return {"ok": True, "suggestion_id": suggestion_id, "suggestion": parsed, "raw": raw_text, "trace": trace}


@app.post("/api/ai/suggest/stream")
def suggest_stream(req: SuggestRequest) -> StreamingResponse:
    provider, settings, prompt, project, source_hits = prepare_ai_request(req)
    suggestion_id = new_memory_id("sug")

    def event_stream():
        try:
            for event in provider.stream_suggestion(settings, prompt):
                if event.get("type") == "delta":
                    yield f"data: {json.dumps({'type': 'delta', 'text': event.get('text', '')}, ensure_ascii=False)}\n\n"
                elif event.get("type") == "final":
                    raw_text = event.get("raw", "")
                    parsed = event.get("suggestion", {})
                    trace = build_ai_trace(settings, source_hits, project)
                    log_ai_suggestion(project, suggestion_id, req, parsed, source_hits, raw_text)
                    yield f"data: {json.dumps({'type': 'final', 'suggestion_id': suggestion_id, 'suggestion': parsed, 'raw': raw_text, 'trace': trace}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            payload = {"type": "error", "message": f"{provider.display_name} 调用失败：{exc}"}
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
    current_manuscript = paper_path()
    export_dir = project / settings.get("export_dir", "outputs")
    export_dir.mkdir(parents=True, exist_ok=True)
    output_name = f"{current_manuscript.stem}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.docx"
    command = ["quarto", "render", current_manuscript.name, "--to", "docx", "--output", output_name]
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

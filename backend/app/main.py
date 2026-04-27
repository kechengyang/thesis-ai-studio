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
WORKSPACE = TOOL_ROOT / "workspace"
PAPER_PATH = WORKSPACE / "paper.qmd"
SETTINGS_PATH = TOOL_ROOT / "settings.json"
ENV_PATH = TOOL_ROOT / ".env"
SOURCE_INDEX_PATH = WORKSPACE / "sources" / "sources_index.json"

DEFAULT_SETTINGS = {
    "model": "gpt-5.5",
    "reasoning": "medium",
    "reference_doc": "templates/reference.docx",
    "export_dir": "outputs",
}

DEFAULT_PAPER = """---
title: "我的论文题目"
author: "作者姓名"
format:
  docx:
    toc: true
bibliography: references.bib
---

# 摘要

请在这里写论文摘要。你可以选中一段文字，让右侧 AI 帮你改写、扩展或检查逻辑。

# 引言

这里写研究背景、问题意识和贡献。

# 方法

这里写研究设计、数据来源和分析方法。

# 结果

这里写主要发现。图表可以放在 `figures/` 文件夹中，再用 Quarto 语法引用。

# 讨论

这里解释结果、说明局限，并连接到既有文献。

# 参考文献
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


app = FastAPI(title="Quarto AI Paper Studio", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5183",
        "http://127.0.0.1:5183",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def ensure_workspace() -> None:
    for folder in ["data", "sources", "figures", "templates", "outputs"]:
        (WORKSPACE / folder).mkdir(parents=True, exist_ok=True)
    if not SETTINGS_PATH.exists():
        SETTINGS_PATH.write_text(json.dumps(DEFAULT_SETTINGS, indent=2), encoding="utf-8")
    if not PAPER_PATH.exists():
        PAPER_PATH.write_text(DEFAULT_PAPER, encoding="utf-8")
    if not (WORKSPACE / "references.bib").exists():
        (WORKSPACE / "references.bib").write_text("", encoding="utf-8")
    if not SOURCE_INDEX_PATH.exists():
        SOURCE_INDEX_PATH.write_text("[]", encoding="utf-8")


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
    ensure_workspace()
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


def read_source_index() -> list[dict[str, Any]]:
    ensure_workspace()
    try:
        return json.loads(SOURCE_INDEX_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def write_source_index(items: list[dict[str, Any]]) -> None:
    SOURCE_INDEX_PATH.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")


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
    terms = [term.lower() for term in re.findall(r"[\w\-]{2,}", query)]
    scored = []
    for item in read_source_index():
        text_path = WORKSPACE / "sources" / item.get("text_file", "")
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


def build_ai_prompt(req: SuggestRequest, document: str) -> str:
    outline = outline_from_document(document)
    context_query = f"{req.instruction}\n{req.selected_text}"
    source_hits = search_sources(context_query)
    return json.dumps(
        {
            "user_instruction": req.instruction,
            "selected_text": req.selected_text,
            "paper_outline": outline,
            "local_sources": source_hits,
        },
        ensure_ascii=False,
        indent=2,
    )


def ai_instructions() -> str:
    return (
        "你是严谨的中文/英文学术论文写作协作助手。"
        "只根据用户选中文本、论文大纲和提供的本地资料片段提出修改建议。"
        "不要编造引用、数据或结论；不确定时必须提醒用户核对。"
        "输出必须是 JSON，字段包括 rewritten_text, rationale, risks, citation_or_data_notes, confidence。"
    )


def prepare_ai_request(req: SuggestRequest) -> tuple[Any, dict[str, Any], str]:
    if not req.selected_text.strip():
        raise HTTPException(status_code=400, detail="请先在正文中选中一段要修改的文字。")
    api_key = os.environ.get("OPENAI_API_KEY") or load_env_file().get("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=400, detail="请先在设置中填写 OpenAI API Key。")
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="需要安装 openai Python 包。") from exc

    settings = read_settings()
    document = req.document if req.document is not None else PAPER_PATH.read_text(encoding="utf-8")
    prompt = build_ai_prompt(req, document)
    return OpenAI(api_key=api_key), settings, prompt


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
    content = PAPER_PATH.read_text(encoding="utf-8")
    settings = read_settings()
    return {
        "workspace": str(WORKSPACE),
        "paper_exists": PAPER_PATH.exists(),
        "outline": outline_from_document(content),
        "sources": read_source_index(),
        "settings": {**settings, "api_key_masked": masked_api_key()},
        "quarto_available": shutil.which("quarto") is not None,
    }


@app.post("/api/project/create")
def create_project() -> dict[str, Any]:
    ensure_workspace()
    return get_project()


@app.get("/api/document")
def get_document() -> dict[str, str]:
    ensure_workspace()
    return {"content": PAPER_PATH.read_text(encoding="utf-8")}


@app.post("/api/document")
def update_document(update: DocumentUpdate) -> dict[str, Any]:
    ensure_workspace()
    PAPER_PATH.write_text(update.content, encoding="utf-8")
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


@app.post("/api/sources/import")
async def import_source(file: UploadFile = File(...)) -> dict[str, Any]:
    ensure_workspace()
    if not file.filename:
        raise HTTPException(status_code=400, detail="没有收到文件名。")
    safe_name = Path(file.filename).name
    target = WORKSPACE / "sources" / safe_name
    with target.open("wb") as handle:
        handle.write(await file.read())
    extracted = extract_text(target)
    if not extracted.strip():
        raise HTTPException(status_code=400, detail="文件已保存，但没有提取到可读取的文字。")
    text_file = f"{target.stem}.txt"
    (WORKSPACE / "sources" / text_file).write_text(extracted, encoding="utf-8")
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
    client, settings, prompt = prepare_ai_request(req)
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
    return {"ok": True, "suggestion": parsed, "raw": raw_text}


@app.post("/api/ai/suggest/stream")
def suggest_stream(req: SuggestRequest) -> StreamingResponse:
    client, settings, prompt = prepare_ai_request(req)

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
                    yield f"data: {json.dumps({'type': 'final', 'suggestion': parsed, 'raw': raw_text}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            payload = {"type": "error", "message": f"OpenAI 调用失败：{exc}"}
            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/ai/apply")
def apply_suggestion(req: ApplyRequest) -> dict[str, Any]:
    ensure_workspace()
    if not req.original_segment:
        raise HTTPException(status_code=400, detail="缺少原文片段，无法安全替换。")
    content = PAPER_PATH.read_text(encoding="utf-8")
    if req.original_segment not in content:
        raise HTTPException(status_code=409, detail="原文片段已经变化，请重新选择段落后再应用。")
    updated = content.replace(req.original_segment, req.replacement, 1)
    PAPER_PATH.write_text(updated, encoding="utf-8")
    return {"ok": True, "content": updated, "outline": outline_from_document(updated)}


@app.post("/api/export/docx")
def export_docx() -> dict[str, Any]:
    ensure_workspace()
    if shutil.which("quarto") is None:
        raise HTTPException(status_code=400, detail="没有找到 Quarto。请先安装 Quarto 后再导出 Word。")
    settings = read_settings()
    export_dir = WORKSPACE / settings.get("export_dir", "outputs")
    export_dir.mkdir(parents=True, exist_ok=True)
    output_name = f"paper-{datetime.now().strftime('%Y%m%d-%H%M%S')}.docx"
    command = ["quarto", "render", "paper.qmd", "--to", "docx", "--output", output_name]
    reference_doc = WORKSPACE / settings.get("reference_doc", "templates/reference.docx")
    if reference_doc.exists():
        command.extend(["-M", f"reference-doc:{reference_doc}"])
    result = subprocess.run(command, cwd=WORKSPACE, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=f"Word 导出失败：{result.stderr or result.stdout}")
    generated = WORKSPACE / output_name
    final_path = export_dir / output_name
    if generated.exists() and generated != final_path:
        generated.replace(final_path)
    return {"ok": True, "path": str(final_path), "filename": output_name}

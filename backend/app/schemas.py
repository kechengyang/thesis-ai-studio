from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel


class DocumentUpdate(BaseModel):
    content: str


class DocumentOpen(BaseModel):
    relative_path: str


class DocumentCreate(BaseModel):
    filename: str


class ProjectFileRename(BaseModel):
    relative_path: str
    new_name: str


class ProjectFileMove(BaseModel):
    relative_path: str
    target_category: str


class ProjectFileDelete(BaseModel):
    relative_path: str


class SettingsUpdate(BaseModel):
    api_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    deepseek_api_key: Optional[str] = None
    deepseek_base_url: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    reasoning: Optional[str] = None
    instruction: Optional[str] = None
    reference_doc: Optional[str] = None
    export_dir: Optional[str] = None


class SuggestRequest(BaseModel):
    instruction: str
    selected_text: str
    document: Optional[str] = None


class ApplyRequest(BaseModel):
    original_segment: Optional[str] = None
    replacement: str = ""
    operations: list[dict[str, Any]] = []
    suggestion_id: Optional[str] = None


class RejectRequest(BaseModel):
    original_segment: Optional[str] = None
    suggestion: Optional[dict[str, Any]] = None
    suggestion_id: Optional[str] = None


class ProjectCreate(BaseModel):
    name: Optional[str] = None


class ProjectOpen(BaseModel):
    project_id: str


class WorkspaceRootUpdate(BaseModel):
    path: str


class LiteratureAnalyzeRequest(BaseModel):
    query: str


class LiteratureImportRequest(BaseModel):
    cache_id: str
    download_original: bool = False


class DataAnalysisRequest(BaseModel):
    prompt: str
    relative_path: str


class DataFigureInsertRequest(BaseModel):
    figure_relative_path: str
    figure_title: str
    figure_caption: str
    figure_alt_text: Optional[str] = None
    section_title: Optional[str] = None
    introduction: Optional[str] = None


class MindmapRequest(BaseModel):
    prompt: str


class MindmapInsertRequest(BaseModel):
    quarto_block: str
    section_title: Optional[str] = None


class BriefRequest(BaseModel):
    prompt: str
    format: str = "ppt"
    scope_heading: Optional[str] = None


class ChatMessage(BaseModel):
    id: str
    role: str  # "user" or "assistant"
    timestamp: str
    content: str
    result: Optional[dict[str, Any]] = None
    context: Optional[dict[str, Any]] = None


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    context: dict[str, Any] = {}

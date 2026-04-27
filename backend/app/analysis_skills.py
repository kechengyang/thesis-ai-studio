from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import matplotlib

if TYPE_CHECKING:
    from .providers import AIProvider

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import pandas as pd
from fastapi import HTTPException

from .providers import build_persona_block, extract_json_value, normalize_text_list


SUPPORTED_DATA_SUFFIXES = {".csv", ".xlsx", ".xlsm"}
MAX_CODE_RETRIES = 2


def slugify(value: str, fallback: str = "item") -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value).strip().lower()).strip("-._")
    return slug[:80] or fallback


def clean_scalar(value: Any) -> Any:
    if value is None:
        return None
    if pd.isna(value):
        return None
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            pass
    return value


def serialize_scalar(value: Any) -> Any:
    cleaned = clean_scalar(value)
    if cleaned is None:
        return None
    if isinstance(cleaned, (int, float, bool)):
        return cleaned
    return str(cleaned)


def safe_project_file(project: Path, relative_path: str, suffixes: set[str] | None = None) -> Path:
    cleaned = relative_path.strip().lstrip("/")
    candidate = (project / cleaned).resolve()
    try:
        candidate.relative_to(project.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="项目文件路径不安全。") from exc
    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail="没有找到这个项目文件。")
    if suffixes and candidate.suffix.lower() not in suffixes:
        raise HTTPException(status_code=400, detail="当前 skill 只支持 CSV 或 Excel 数据文件。")
    return candidate


def ensure_unique_relative_path(project: Path, directory: str, stem: str, suffix: str) -> str:
    target_dir = project / directory
    target_dir.mkdir(parents=True, exist_ok=True)
    safe_stem = slugify(stem, fallback="artifact")
    candidate = target_dir / f"{safe_stem}{suffix}"
    counter = 2
    while candidate.exists():
        candidate = target_dir / f"{safe_stem}-{counter}{suffix}"
        counter += 1
    return str(candidate.relative_to(project))


def load_tabular_data(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    try:
        if suffix == ".csv":
            return pd.read_csv(path, low_memory=False)
        if suffix in {".xlsx", ".xlsm"}:
            return pd.read_excel(path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"读取数据文件失败：{exc}") from exc
    raise HTTPException(status_code=400, detail="当前 skill 只支持 CSV 或 Excel 数据文件。")


def dataframe_profile(df: pd.DataFrame) -> dict[str, Any]:
    preview_columns = list(df.columns[:12])
    preview_rows = []
    for _, row in df[preview_columns].head(8).iterrows():
        preview_rows.append({column: serialize_scalar(row[column]) for column in preview_columns})

    columns = []
    for column in df.columns[:32]:
        series = df[column]
        non_null = series.dropna()
        entry = {
            "name": str(column),
            "dtype": str(series.dtype),
            "non_null_ratio": round(float(non_null.shape[0]) / float(max(len(series), 1)), 4),
            "unique_values": int(non_null.nunique(dropna=True)),
            "sample_values": [serialize_scalar(value) for value in non_null.head(3).tolist()],
        }
        if pd.api.types.is_numeric_dtype(series):
            entry["min"] = serialize_scalar(non_null.min()) if not non_null.empty else None
            entry["max"] = serialize_scalar(non_null.max()) if not non_null.empty else None
            entry["mean"] = serialize_scalar(round(float(non_null.mean()), 4)) if not non_null.empty else None
        columns.append(entry)

    numeric_columns = [str(column) for column in df.columns if pd.api.types.is_numeric_dtype(df[column])]
    categorical_columns = [str(column) for column in df.columns if not pd.api.types.is_numeric_dtype(df[column])]
    return {
        "row_count": int(df.shape[0]),
        "column_count": int(df.shape[1]),
        "numeric_columns": numeric_columns[:20],
        "categorical_columns": categorical_columns[:20],
        "columns": columns,
        "preview_rows": preview_rows,
    }


def select_outline_section(outline: list[dict[str, Any]], requested: str | None = None) -> str:
    titles = [str(item.get("title", "")).strip() for item in outline if str(item.get("title", "")).strip()]
    requested_value = str(requested or "").strip()
    if requested_value:
        for title in titles:
            if title == requested_value:
                return title
        lowered = requested_value.lower()
        for title in titles:
            if lowered in title.lower() or title.lower() in lowered:
                return title
    preferred = ["Results", "Findings", "Analysis", "Discussion", "Methods", "Introduction"]
    for candidate in preferred:
        for title in titles:
            if candidate.lower() in title.lower():
                return title
    return titles[0] if titles else "Results"


def data_analysis_code_instructions(settings: dict[str, Any]) -> str:
    return (
        build_persona_block(settings)
        + (
            "You are a data-analysis skill inside a local research-writing studio. "
            "Given a dataset profile and a user prompt, write Python code that creates a "
            "publication-quality figure using pandas and matplotlib. "
            "Available in the execution namespace: df (the full DataFrame), pd, plt, np, output_path (a pathlib.Path). "
            "Rules for the code: "
            "(1) MUST end with plt.savefig(output_path, bbox_inches='tight', dpi=160) followed by plt.close(). "
            "(2) Do NOT call plt.show() or import any library — they are pre-imported. "
            "(3) Only reference columns that exist in the dataset profile. "
            "(4) Use plt.style.use('seaborn-v0_8-whitegrid') at the start for a clean academic style. "
            "(5) Keep the figure readable: limit categories shown, rotate long labels, add a clear title. "
            "Return JSON only with these fields: "
            "analysis_title, figure_title, figure_caption, figure_alt_text, "
            "suggested_section, summary, content, key_points, insert_paragraph, code. "
            "`content` must be 1-3 sentences of plain text summarising what was generated — used for display in a chat interface."
        )
    )


def extract_chart_code(payload: dict[str, Any]) -> str:
    code = str(payload.get("code", "")).strip()
    code = re.sub(r"^```(?:python)?\s*", "", code, flags=re.IGNORECASE)
    code = re.sub(r"\s*```$", "", code).strip()
    return code


def execute_chart_code(code: str, df: pd.DataFrame, output_path: Path) -> str | None:
    """Execute AI-generated chart code. Returns error string on failure, None on success."""
    import numpy as np

    namespace: dict[str, Any] = {
        "df": df.copy(),
        "pd": pd,
        "plt": plt,
        "np": np,
        "output_path": output_path,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        exec(compile(code, "<ai_chart>", "exec"), namespace)  # noqa: S102
        return None
    except Exception as exc:
        plt.close("all")
        return f"{type(exc).__name__}: {exc}"


def normalize_analysis_metadata(
    payload: dict[str, Any],
    prompt: str,
    outline: list[dict[str, Any]],
    figure_relative_path: str,
) -> dict[str, Any]:
    title = str(payload.get("analysis_title") or prompt or "Data Analysis").strip()
    summary = str(payload.get("summary") or "").strip()
    content = str(payload.get("content") or summary).strip()
    return {
        "analysis_title": title,
        "figure_title": str(payload.get("figure_title") or title).strip(),
        "figure_caption": str(payload.get("figure_caption") or "").strip(),
        "figure_alt_text": str(payload.get("figure_alt_text") or "").strip(),
        "suggested_section": select_outline_section(outline, payload.get("suggested_section")),
        "summary": summary,
        "content": content,
        "key_points": normalize_text_list(payload.get("key_points")),
        "insert_paragraph": str(payload.get("insert_paragraph") or "").strip(),
        "figure_relative_path": figure_relative_path,
    }


def run_data_analysis_skill(
    project: Path,
    provider: AIProvider,
    settings: dict[str, Any],
    relative_path: str,
    prompt: str,
    outline: list[dict[str, Any]],
) -> dict[str, Any]:
    data_path = safe_project_file(project, relative_path, SUPPORTED_DATA_SUFFIXES)
    dataframe = load_tabular_data(data_path)
    if dataframe.empty:
        raise HTTPException(status_code=400, detail="这个数据文件是空的，无法进行分析。")

    profile = dataframe_profile(dataframe)
    instructions = data_analysis_code_instructions(settings)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    figure_stem = slugify(f"{data_path.stem}-{prompt[:40]}-{timestamp}", fallback="analysis")
    figure_relative_path = ensure_unique_relative_path(project, "figures", figure_stem, ".png")
    figure_path = project / figure_relative_path

    base_request: dict[str, Any] = {
        "user_prompt": prompt.strip(),
        "data_file": data_path.name,
        "manuscript_outline": outline,
        "dataset_profile": profile,
    }
    request_payload = dict(base_request)
    raw_text = ""
    plan: dict[str, Any] = {}
    code = ""
    last_error: str | None = "未生成代码。"

    for attempt in range(MAX_CODE_RETRIES + 1):
        raw_text = provider.generate_json(
            settings, instructions, json.dumps(request_payload, ensure_ascii=False, indent=2)
        )
        plan = extract_json_value(raw_text, fallback={}) or {}
        code = extract_chart_code(plan)

        if not code:
            last_error = "AI 没有在响应中返回 code 字段。"
            if attempt < MAX_CODE_RETRIES:
                request_payload = {
                    **base_request,
                    "previous_response": raw_text[:2000],
                    "error": last_error,
                    "instruction": "请确保返回包含 code 字段的完整 JSON。",
                }
            continue

        last_error = execute_chart_code(code, dataframe, figure_path)
        if last_error is None:
            break

        if attempt < MAX_CODE_RETRIES:
            request_payload = {
                **base_request,
                "previous_code": code,
                "execution_error": last_error,
                "instruction": "上一段代码执行时报错，请根据错误信息修正后重新生成完整 JSON 和 code。",
            }

    if last_error is not None or not figure_path.exists():
        raise HTTPException(
            status_code=400,
            detail=f"图表生成失败（已重试 {MAX_CODE_RETRIES} 次）：{last_error}",
        )

    meta = normalize_analysis_metadata(plan, prompt, outline, figure_relative_path)
    record_relative_path = ensure_unique_relative_path(project, "outputs/analysis", figure_stem, ".json")
    record_payload = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "data_file": data_path.name,
        "prompt": prompt.strip(),
        "generated_code": code,
        "metadata": meta,
        "raw_model_output": raw_text,
    }
    record_path = project / record_relative_path
    record_path.parent.mkdir(parents=True, exist_ok=True)
    record_path.write_text(json.dumps(record_payload, indent=2, ensure_ascii=False), encoding="utf-8")

    return {
        "analysis": {
            **meta,
            "data_file": data_path.name,
            "record_relative_path": record_relative_path,
            "generated_code": code,
        }
    }


def chat_data_turn(
    project: Path,
    provider: AIProvider,
    settings: dict[str, Any],
    messages: list[dict[str, str]],
    relative_path: str,
    outline: list[dict[str, Any]],
) -> dict[str, Any]:
    """Run one data analysis chat turn. `messages` already contains embedded context."""
    data_path = safe_project_file(project, relative_path, SUPPORTED_DATA_SUFFIXES)
    dataframe = load_tabular_data(data_path)
    if dataframe.empty:
        raise HTTPException(status_code=400, detail="这个数据文件是空的，无法进行分析。")

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    figure_stem = slugify(f"{data_path.stem}-chat-{timestamp}", fallback="analysis")
    figure_relative_path = ensure_unique_relative_path(project, "figures", figure_stem, ".png")
    figure_path = project / figure_relative_path

    last_error: str | None = "未生成代码。"
    plan: dict[str, Any] = {}
    code = ""
    current_messages = list(messages)

    for attempt in range(MAX_CODE_RETRIES + 1):
        raw_text = provider.generate_chat_json(
            settings, data_analysis_code_instructions(settings), current_messages
        )
        plan = extract_json_value(raw_text, fallback={}) or {}
        code = extract_chart_code(plan)

        if not code:
            last_error = "AI 没有在响应中返回 code 字段。"
            if attempt < MAX_CODE_RETRIES:
                current_messages = list(messages) + [
                    {"role": "user", "content": f"上一次没有返回 code 字段，请返回包含 code 字段的完整 JSON。上次响应摘要：{raw_text[:500]}"}
                ]
            continue

        last_error = execute_chart_code(code, dataframe, figure_path)
        if last_error is None:
            break

        if attempt < MAX_CODE_RETRIES:
            current_messages = list(messages) + [
                {"role": "user", "content": f"上一段代码执行时报错，请修正。错误：{last_error}\n代码：{code[:800]}"}
            ]

    if last_error is not None or not figure_path.exists():
        raise HTTPException(
            status_code=400,
            detail=f"图表生成失败（已重试 {MAX_CODE_RETRIES} 次）：{last_error}",
        )

    meta = normalize_analysis_metadata(plan, "", outline, figure_relative_path)
    record_relative_path = ensure_unique_relative_path(project, "outputs/analysis", figure_stem, ".json")
    record_payload = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "data_file": data_path.name,
        "generated_code": code,
        "metadata": meta,
        "raw_model_output": raw_text,
    }
    record_path = project / record_relative_path
    record_path.parent.mkdir(parents=True, exist_ok=True)
    record_path.write_text(json.dumps(record_payload, indent=2, ensure_ascii=False), encoding="utf-8")

    return {
        "analysis": {
            **meta,
            "data_file": data_path.name,
            "record_relative_path": record_relative_path,
            "generated_code": code,
        }
    }


def escape_attr(value: str) -> str:
    return str(value).replace('"', "&quot;")


def build_figure_block(req: dict[str, Any]) -> str:
    lines = [f"### {req['figure_title']}"]
    intro = str(req.get("introduction") or "").strip()
    if intro:
        lines.extend(["", intro])
    image_line = f"![{req['figure_caption']}]({req['figure_relative_path']})"
    alt_text = str(req.get("figure_alt_text") or "").strip()
    if alt_text:
        image_line += f'{{fig-alt="{escape_attr(alt_text)}"}}'
    lines.extend(["", image_line])
    return "\n".join(lines).strip()


def insert_block_into_section(content: str, section_title: str, block: str) -> str:
    pattern = re.compile(rf"^(?P<hashes>#+)\s+{re.escape(section_title)}\s*$", flags=re.MULTILINE)
    match = pattern.search(content)
    if not match:
        return content.rstrip() + "\n\n" + block.strip() + "\n"
    insert_at = match.end()
    return content[:insert_at] + "\n\n" + block.strip() + content[insert_at:]


def insert_figure_into_manuscript(content: str, payload: dict[str, Any]) -> str:
    block = build_figure_block(payload)
    section_title = str(payload.get("section_title") or "").strip()
    if not section_title:
        return content.rstrip() + "\n\n" + block + "\n"
    return insert_block_into_section(content, section_title, block)


def clean_mermaid_code(value: str, fallback_title: str) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^```(?:mermaid)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    text = text.strip()
    if text.startswith("{") and text.endswith("}"):
        text = ""
    if text.lstrip().startswith("mindmap"):
        return text
    safe_title = fallback_title or "Research Map"
    return (
        "mindmap\n"
        f"  root(({safe_title}))\n"
        "    Context\n"
        "    Evidence\n"
        "    Implications\n"
    )


def normalize_mindmap(payload: Any, prompt: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        payload = {}
    title = str(payload.get("title") or prompt or "Research Mindmap").strip()
    summary = str(payload.get("summary") or "Generated a Mermaid mindmap from the current prompt.").strip()
    content = str(payload.get("content") or summary).strip()
    mermaid = clean_mermaid_code(str(payload.get("mermaid") or ""), title)
    return {
        "title": title,
        "summary": summary,
        "content": content,
        "mermaid": mermaid,
        "quarto_block": f"```{{mermaid}}\n{mermaid}\n```",
    }


def mindmap_instructions(settings: dict[str, Any]) -> str:
    return (
        build_persona_block(settings)
        + (
            "You are a concept-mapping skill inside a local research-writing studio. "
            "Create a Mermaid mindmap that helps the user think about the requested topic, paper structure, or argument. "
            "Rules for clarity: "
            "Use Mermaid mindmap syntax only (no other diagram types). "
            "Maximum 3 levels of depth. "
            "Keep each node label to 1-5 words — no full sentences. "
            "Aim for 8-16 nodes total; prefer fewer over crowding. "
            "Do not wrap the diagram in Markdown fences inside the JSON field. "
            "Return JSON only with these fields: title, summary, content, mermaid. "
            "`content` must be 1-3 sentences of plain text summarising what was generated — used for display in a chat interface."
        )
    )


def insert_mermaid_into_manuscript(content: str, quarto_block: str, section_title: str) -> str:
    if not section_title:
        return content.rstrip() + "\n\n" + quarto_block + "\n"
    return insert_block_into_section(content, section_title, quarto_block)


def run_mindmap_skill(
    project: Path,
    provider: AIProvider,
    settings: dict[str, Any],
    prompt: str,
    outline: list[dict[str, Any]],
    content: str,
) -> dict[str, Any]:
    payload = {
        "user_prompt": prompt.strip(),
        "outline": outline,
        "document_excerpt": content[:6000],
    }
    raw_text = provider.generate_json(
        settings,
        mindmap_instructions(settings),
        json.dumps(payload, ensure_ascii=False, indent=2),
    )
    result = normalize_mindmap(extract_json_value(raw_text, fallback={}) or {}, prompt)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    relative_path = ensure_unique_relative_path(project, "outputs/mindmaps", f"{result['title']}-{timestamp}", ".mmd")
    path = project / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(result["mermaid"].rstrip() + "\n", encoding="utf-8")
    return {"mindmap": {**result, "output_relative_path": relative_path}}


def chat_mindmap_turn(
    project: Path,
    provider: AIProvider,
    settings: dict[str, Any],
    messages: list[dict[str, str]],
    outline: list[dict[str, Any]],
    document: str,
) -> dict[str, Any]:
    """Run one mindmap chat turn. `messages` is already built by build_chat_messages."""
    raw_text = provider.generate_chat_json(settings, mindmap_instructions(settings), messages)
    result = normalize_mindmap(extract_json_value(raw_text, fallback={}) or {}, "")
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    relative_path = ensure_unique_relative_path(
        project, "outputs/mindmaps", f"{result['title']}-{timestamp}", ".mmd"
    )
    path = project / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(result["mermaid"].rstrip() + "\n", encoding="utf-8")
    return {"mindmap": {**result, "output_relative_path": relative_path}}


def extract_section_text(content: str, heading: str) -> str:
    if not heading.strip():
        return content
    lines = content.splitlines()
    start_index = None
    target_level = None
    for index, line in enumerate(lines):
        match = re.match(r"^(#{1,6})\s+(.+)$", line.strip())
        if not match:
            continue
        if match.group(2).strip() == heading.strip():
            start_index = index
            target_level = len(match.group(1))
            break
    if start_index is None:
        return content
    end_index = len(lines)
    for index in range(start_index + 1, len(lines)):
        match = re.match(r"^(#{1,6})\s+(.+)$", lines[index].strip())
        if match and len(match.group(1)) <= int(target_level or 1):
            end_index = index
            break
    return "\n".join(lines[start_index:end_index]).strip()


def normalize_poster_sections(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    sections: list[dict[str, str]] = []
    for item in value:
        if isinstance(item, dict):
            heading = str(item.get("heading", "")).strip()
            content = str(item.get("content", "")).strip()
            if heading or content:
                sections.append({"heading": heading or "Section", "content": content})
        else:
            text = str(item).strip()
            if text:
                sections.append({"heading": "Section", "content": text})
    return sections


def normalize_brief(payload: Any, prompt: str, target_format: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        payload = {}
    title = str(payload.get("title") or "Presentation Brief").strip()
    summary = str(payload.get("summary") or "Generated a presentation-oriented brief from the current manuscript context.").strip()
    content = str(payload.get("content") or summary).strip()
    return {
        "title": title,
        "target_format": str(payload.get("target_format") or target_format).strip(),
        "focus": str(payload.get("focus") or prompt).strip(),
        "summary": summary,
        "content": content,
        "one_liner": str(payload.get("one_liner") or "").strip(),
        "key_messages": normalize_text_list(payload.get("key_messages")),
        "display_bullets": normalize_text_list(payload.get("display_bullets")),
        "speaker_notes": normalize_text_list(payload.get("speaker_notes")),
        "poster_sections": normalize_poster_sections(payload.get("poster_sections")),
        "call_to_action": str(payload.get("call_to_action") or "").strip(),
    }


def brief_instructions(settings: dict[str, Any]) -> str:
    return (
        build_persona_block(settings)
        + (
            "You are a dissemination skill inside a local research-writing studio. "
            "Turn manuscript content into presentation-ready material for slides, posters, or concise article summaries. "
            "Be concrete, selective, and audience-aware. "
            "Return JSON only with these fields: title, target_format, focus, summary, content, one_liner, key_messages, display_bullets, speaker_notes, poster_sections, call_to_action. "
            "`content` must be 1-3 sentences of plain text summarising what was generated — used for display in a chat interface. "
            "`key_messages`, `display_bullets`, and `speaker_notes` should each be arrays of short strings. "
            "`poster_sections` should be an array of objects with heading and content."
        )
    )


def chat_brief_turn(
    project: Path,
    provider: AIProvider,
    settings: dict[str, Any],
    messages: list[dict[str, str]],
    target_format: str,
    outline: list[dict[str, Any]],
) -> dict[str, Any]:
    """Run one brief chat turn. `messages` is already built by build_chat_messages."""
    raw_text = provider.generate_chat_json(settings, brief_instructions(settings), messages)
    brief = normalize_brief(extract_json_value(raw_text, fallback={}) or {}, "", target_format)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    relative_path = ensure_unique_relative_path(
        project, "outputs/briefs", f"{brief['title']}-{timestamp}", ".md"
    )
    path = project / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(brief_markdown(brief), encoding="utf-8")
    return {"brief": {**brief, "output_relative_path": relative_path}}


def brief_markdown(brief: dict[str, Any]) -> str:
    lines = [f"# {brief['title']}", ""]
    if brief["one_liner"]:
        lines.extend(["## One-liner", "", brief["one_liner"], ""])
    if brief["summary"]:
        lines.extend(["## Summary", "", brief["summary"], ""])
    if brief["key_messages"]:
        lines.append("## Key Messages")
        lines.append("")
        lines.extend([f"- {item}" for item in brief["key_messages"]])
        lines.append("")
    if brief["display_bullets"]:
        lines.append("## Display Bullets")
        lines.append("")
        lines.extend([f"- {item}" for item in brief["display_bullets"]])
        lines.append("")
    if brief["speaker_notes"]:
        lines.append("## Speaker Notes")
        lines.append("")
        lines.extend([f"- {item}" for item in brief["speaker_notes"]])
        lines.append("")
    if brief["poster_sections"]:
        lines.append("## Poster Blocks")
        lines.append("")
        for section in brief["poster_sections"]:
            lines.extend([f"### {section['heading']}", "", section["content"], ""])
    if brief["call_to_action"]:
        lines.extend(["## Call to Action", "", brief["call_to_action"], ""])
    return "\n".join(lines).rstrip() + "\n"


def run_brief_skill(
    project: Path,
    provider: AIProvider,
    settings: dict[str, Any],
    prompt: str,
    target_format: str,
    scope_heading: str | None,
    content: str,
    outline: list[dict[str, Any]],
) -> dict[str, Any]:
    scoped_content = extract_section_text(content, scope_heading or "").strip() or content
    payload = {
        "user_prompt": prompt.strip(),
        "target_format": target_format,
        "scope_heading": scope_heading or "",
        "outline": outline,
        "source_excerpt": scoped_content[:9000],
    }
    raw_text = provider.generate_json(
        settings,
        brief_instructions(settings),
        json.dumps(payload, ensure_ascii=False, indent=2),
    )
    brief = normalize_brief(extract_json_value(raw_text, fallback={}) or {}, prompt, target_format)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    relative_path = ensure_unique_relative_path(project, "outputs/briefs", f"{brief['title']}-{timestamp}", ".md")
    path = project / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(brief_markdown(brief), encoding="utf-8")
    return {"brief": {**brief, "output_relative_path": relative_path}}

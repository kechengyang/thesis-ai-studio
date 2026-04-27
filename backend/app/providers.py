from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from typing import Any, Iterator

import httpx
from fastapi import HTTPException
from openai import OpenAI

from .config import DEFAULT_PROVIDER_MODELS, get_provider_api_key, get_provider_base_url, load_env_file


def normalize_text_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        items = []
        for item in value:
            text = str(item).strip()
            if text:
                items.append(text)
        return items
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        lines = []
        for raw_line in text.splitlines():
            cleaned = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", raw_line).strip()
            if cleaned:
                lines.append(cleaned)
        if len(lines) > 1:
            return lines
        return [text]
    text = str(value).strip()
    return [text] if text else []


def normalize_suggestion(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        payload = {"rewritten_text": str(payload).strip()}
    return {
        "rewritten_text": str(payload.get("rewritten_text", "")).strip(),
        "rationale": str(payload.get("rationale", "")).strip() or "AI 没有提供额外说明。",
        "process_summary": normalize_text_list(
            payload.get("process_summary")
            or payload.get("thinking_summary")
            or payload.get("revision_process")
        ),
        "risks": normalize_text_list(payload.get("risks")),
        "citation_or_data_notes": normalize_text_list(payload.get("citation_or_data_notes")),
        "confidence": payload.get("confidence", "medium"),
    }


def extract_json_value(text: str, fallback: Any | None = None) -> Any:
    parsed: Any | None = None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if match:
            try:
                parsed = json.loads(match.group(0))
            except json.JSONDecodeError:
                pass
    if parsed is None:
        return fallback
    return parsed


def parse_json_payload(text: str) -> dict[str, Any]:
    parsed = extract_json_value(
        text,
        fallback={
            "rewritten_text": text.strip(),
            "rationale": "AI 返回了非结构化内容，已作为改写文本显示。",
            "process_summary": [],
            "risks": ["请人工核对事实、引用和数据。"],
            "citation_or_data_notes": [],
            "confidence": "medium",
        },
    )
    return normalize_suggestion(parsed)


def normalize_literature_analysis(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        payload = {}
    return {
        "title": str(payload.get("title", "")).strip(),
        "authors": normalize_text_list(payload.get("authors")),
        "year": str(payload.get("year", "")).strip(),
        "venue": str(payload.get("venue", "")).strip(),
        "summary": str(payload.get("summary", "")).strip(),
        "content": str(payload.get("content", "")).strip(),
        "relevance": str(payload.get("relevance", "")).strip(),
        "structure_suggestions": normalize_text_list(payload.get("structure_suggestions")),
        "citation_uses": normalize_text_list(payload.get("citation_uses")),
        "import_recommendation": str(payload.get("import_recommendation", "")).strip(),
    }


def parse_literature_json(text: str) -> dict[str, Any]:
    return normalize_literature_analysis(extract_json_value(text, fallback={}) or {})


def build_persona_block(settings: dict[str, Any]) -> str:
    instruction = str(settings.get("instruction", "")).strip()
    if not instruction:
        return ""
    return (
        "Adopt the following default scholarly persona and style unless the current "
        "user request explicitly overrides it:\n"
        f"{instruction}\n"
    )


def suggestion_instructions(settings: dict[str, Any]) -> str:
    return (
        build_persona_block(settings)
        + (
        "You are a rigorous academic writing collaborator. "
        "By default, revise the selected passage in polished academic English. "
        "Use only the selected text, paper outline, and provided local-source excerpts. "
        "Do not invent citations, data, or findings; flag uncertainty clearly. "
        "Return JSON only with these fields: rewritten_text, rationale, process_summary, risks, citation_or_data_notes, confidence. "
        "`process_summary` must be an array of 2-4 short bullet strings that explain the visible revision process at a high level. "
        "Do not reveal hidden chain-of-thought or internal reasoning tokens."
        )
    )


def literature_instructions(settings: dict[str, Any]) -> str:
    return (
        build_persona_block(settings)
        + (
        "You are helping a researcher evaluate a candidate literature source. "
        "Use only the provided bibliographic metadata, abstract, excerpt, and the paper outline. "
        "Return JSON only with these fields: title, authors, year, venue, summary, content, relevance, structure_suggestions, citation_uses, import_recommendation. "
        "`content` must be 1-3 sentences of plain text summarising the source and its relevance — used for display in a chat interface. "
        "`structure_suggestions` should be 2-5 concrete suggestions linked to the current outline. "
        "`citation_uses` should be 1-4 practical ways to use the source in a literature review or framing section."
        )
    )


def merge_models(provider: str, discovered: list[str]) -> list[dict[str, str]]:
    by_id = {item["id"]: dict(item) for item in DEFAULT_PROVIDER_MODELS.get(provider, [])}
    for model_id in discovered:
        if model_id not in by_id:
            by_id[model_id] = {"id": model_id, "label": model_id, "description": "Live model listing."}
    ordered = []
    seen = set()
    for item in DEFAULT_PROVIDER_MODELS.get(provider, []):
        ordered.append(by_id[item["id"]])
        seen.add(item["id"])
    for model_id in sorted(by_id):
        if model_id in seen:
            continue
        ordered.append(by_id[model_id])
    return ordered


def matches_curated_model(provider: str, model_id: str) -> bool:
    curated_ids = [item["id"] for item in DEFAULT_PROVIDER_MODELS.get(provider, [])]
    for curated_id in curated_ids:
        if model_id == curated_id:
            return True
        if not model_id.startswith(f"{curated_id}-"):
            continue
        suffix = model_id.removeprefix(f"{curated_id}-")
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", suffix):
            return True
    return False


class AIProvider(ABC):
    provider_id: str
    display_name: str

    def __init__(self, env: dict[str, str] | None = None) -> None:
        self.env = env or load_env_file()

    @property
    def api_key(self) -> str:
        return get_provider_api_key(self.provider_id, self.env)

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    @abstractmethod
    def list_models(self) -> list[dict[str, str]]:
        raise NotImplementedError

    @abstractmethod
    def generate_json(self, settings: dict[str, Any], instructions: str, prompt: str) -> str:
        raise NotImplementedError

    @abstractmethod
    def create_suggestion(self, settings: dict[str, Any], prompt: str) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def stream_suggestion(self, settings: dict[str, Any], prompt: str) -> Iterator[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def analyze_literature(self, settings: dict[str, Any], prompt: str) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def generate_chat_json(
        self,
        settings: dict[str, Any],
        instructions: str,
        messages: list[dict[str, str]],
    ) -> str:
        raise NotImplementedError


class OpenAIProvider(AIProvider):
    provider_id = "openai"
    display_name = "OpenAI"

    def _client(self) -> OpenAI:
        if not self.api_key:
            raise HTTPException(status_code=400, detail="请先填写 OpenAI API Key。")
        return OpenAI(api_key=self.api_key)

    def list_models(self) -> list[dict[str, str]]:
        discovered: list[str] = []
        if self.api_key:
            try:
                models = self._client().models.list()
                for item in models.data:
                    model_id = getattr(item, "id", "")
                    if matches_curated_model(self.provider_id, model_id):
                        discovered.append(model_id)
            except Exception:
                pass
        return merge_models(self.provider_id, discovered)

    def generate_json(self, settings: dict[str, Any], instructions: str, prompt: str) -> str:
        response = self._client().responses.create(
            model=settings["model"],
            reasoning={"effort": settings["reasoning"], "summary": "auto"},
            instructions=instructions,
            input=prompt,
        )
        return getattr(response, "output_text", "") or str(response)

    def create_suggestion(self, settings: dict[str, Any], prompt: str) -> dict[str, Any]:
        raw_text = self.generate_json(settings, suggestion_instructions(settings), prompt)
        parsed = parse_json_payload(raw_text)
        return {"suggestion": parsed, "raw": raw_text}

    def stream_suggestion(self, settings: dict[str, Any], prompt: str) -> Iterator[dict[str, Any]]:
        raw_parts: list[str] = []
        stream = self._client().responses.create(
            model=settings["model"],
            reasoning={"effort": settings["reasoning"], "summary": "auto"},
            instructions=suggestion_instructions(settings),
            input=prompt,
            stream=True,
        )
        for event in stream:
            event_type = getattr(event, "type", "")
            if event_type == "response.output_text.delta":
                delta = getattr(event, "delta", "")
                raw_parts.append(delta)
                yield {"type": "delta", "text": delta}
            elif event_type == "response.completed":
                raw_text = "".join(raw_parts)
                parsed = parse_json_payload(raw_text)
                yield {"type": "final", "suggestion": parsed, "raw": raw_text}

    def analyze_literature(self, settings: dict[str, Any], prompt: str) -> dict[str, Any]:
        raw_text = self.generate_json(settings, literature_instructions(settings), prompt)
        return {"analysis": parse_literature_json(raw_text), "raw": raw_text}

    def generate_chat_json(
        self,
        settings: dict[str, Any],
        instructions: str,
        messages: list[dict[str, str]],
    ) -> str:
        response = self._client().responses.create(
            model=settings["model"],
            reasoning={"effort": settings["reasoning"], "summary": "auto"},
            instructions=instructions,
            input=messages,
        )
        return getattr(response, "output_text", "") or str(response)


class DeepSeekProvider(AIProvider):
    provider_id = "deepseek"
    display_name = "DeepSeek"

    @property
    def base_url(self) -> str:
        return get_provider_base_url(self.provider_id, self.env) or "https://api.deepseek.com"

    def _client(self) -> OpenAI:
        if not self.api_key:
            raise HTTPException(status_code=400, detail="请先填写 DeepSeek API Key。")
        return OpenAI(api_key=self.api_key, base_url=self.base_url)

    def list_models(self) -> list[dict[str, str]]:
        discovered: list[str] = []
        if self.api_key:
            try:
                response = httpx.get(
                    f"{self.base_url.rstrip('/')}/models",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    timeout=30,
                )
                response.raise_for_status()
                payload = response.json()
                for item in payload.get("data", []):
                    model_id = str(item.get("id", "")).strip()
                    if model_id:
                        discovered.append(model_id)
            except Exception:
                pass
        return merge_models(self.provider_id, discovered)

    def _chat_completion(self, settings: dict[str, Any], prompt: str, instructions: str, json_mode: bool = False):
        kwargs: dict[str, Any] = {
            "model": settings["model"],
            "messages": [
                {"role": "system", "content": instructions},
                {"role": "user", "content": prompt},
            ],
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        return self._client().chat.completions.create(**kwargs)

    def generate_json(self, settings: dict[str, Any], instructions: str, prompt: str) -> str:
        response = self._chat_completion(settings, prompt, instructions, json_mode=True)
        message = response.choices[0].message
        return message.content or ""

    def create_suggestion(self, settings: dict[str, Any], prompt: str) -> dict[str, Any]:
        raw_text = self.generate_json(settings, suggestion_instructions(settings), prompt)
        parsed = parse_json_payload(raw_text)
        return {"suggestion": parsed, "raw": raw_text}

    def stream_suggestion(self, settings: dict[str, Any], prompt: str) -> Iterator[dict[str, Any]]:
        raw_parts: list[str] = []
        stream = self._client().chat.completions.create(
            model=settings["model"],
            messages=[
                {"role": "system", "content": suggestion_instructions(settings)},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            stream=True,
        )
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            text_delta = getattr(delta, "content", None)
            if text_delta:
                raw_parts.append(text_delta)
                yield {"type": "delta", "text": text_delta}
        raw_text = "".join(raw_parts)
        parsed = parse_json_payload(raw_text)
        yield {"type": "final", "suggestion": parsed, "raw": raw_text}

    def analyze_literature(self, settings: dict[str, Any], prompt: str) -> dict[str, Any]:
        raw_text = self.generate_json(settings, literature_instructions(settings), prompt)
        return {"analysis": parse_literature_json(raw_text), "raw": raw_text}

    def generate_chat_json(
        self,
        settings: dict[str, Any],
        instructions: str,
        messages: list[dict[str, str]],
    ) -> str:
        all_messages = [{"role": "system", "content": instructions}] + messages
        response = self._client().chat.completions.create(
            model=settings["model"],
            messages=all_messages,
            response_format={"type": "json_object"},
        )
        return response.choices[0].message.content or ""


def get_provider(provider_id: str, env: dict[str, str] | None = None) -> AIProvider:
    providers: dict[str, type[AIProvider]] = {
        "openai": OpenAIProvider,
        "deepseek": DeepSeekProvider,
    }
    provider_cls = providers.get(provider_id)
    if not provider_cls:
        raise HTTPException(status_code=400, detail=f"不支持的模型提供商：{provider_id}")
    return provider_cls(env=env)


def provider_payload(settings: dict[str, Any], env: dict[str, str] | None = None) -> dict[str, Any]:
    env_values = env or load_env_file()
    openai_provider = OpenAIProvider(env_values)
    deepseek_provider = DeepSeekProvider(env_values)
    return {
        "current_provider": settings.get("provider", "openai"),
        "providers": [
            {
                "id": openai_provider.provider_id,
                "name": openai_provider.display_name,
                "configured": openai_provider.configured,
                "models": openai_provider.list_models(),
            },
            {
                "id": deepseek_provider.provider_id,
                "name": deepseek_provider.display_name,
                "configured": deepseek_provider.configured,
                "base_url": deepseek_provider.base_url,
                "models": deepseek_provider.list_models(),
            },
        ],
    }

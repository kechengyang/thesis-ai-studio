from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


TOOL_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_ROOT = TOOL_ROOT / ".runtime"
LEGACY_WORKSPACE = TOOL_ROOT / "workspace"

# In Electron / packaged mode, THESIS_DATA_DIR points to the user's app data dir
# (e.g. ~/Library/Application Support/ThesisAIStudio). Settings and state live there
# so they're writable and survive app updates. Falls back to TOOL_ROOT for Docker/dev.
_DATA_ROOT = Path(os.environ.get("THESIS_DATA_DIR", str(TOOL_ROOT))).expanduser()

SETTINGS_PATH = _DATA_ROOT / "settings.json"
ENV_PATH = _DATA_ROOT / ".env"
STATE_PATH = _DATA_ROOT / "state.json"
DEFAULT_PROJECTS_ROOT = _DATA_ROOT / "projects"
PROJECTS_ROOT = Path(os.environ.get("THESIS_PROJECTS_ROOT", str(DEFAULT_PROJECTS_ROOT))).expanduser()
DEFAULT_PROJECT_ID = "thesis-draft"
PROJECT_FOLDERS = ["data", "sources", "figures", "templates", "outputs", "memory"]
LITERATURE_CACHE_DIR = RUNTIME_ROOT / "literature_cache"

DEFAULT_AI_INSTRUCTION = (
    "You are a senior scholar and domain expert in African higher education and "
    "internationalization studies. Bring strong critical thinking, offer incisive "
    "insights, and pay particular attention to theory, conceptual framing, and "
    "analytical frameworks. When reviewing or revising text, strengthen theoretical "
    "clarity, argument structure, and the link between evidence and framework."
)

DEFAULT_SETTINGS = {
    "provider": "openai",
    "model": "gpt-5.5",
    "reasoning": "medium",
    "instruction": DEFAULT_AI_INSTRUCTION,
    "reference_doc": "templates/reference.docx",
    "export_dir": "outputs",
}


DEFAULT_PROVIDER_MODELS = {
    "openai": [
        {"id": "gpt-5.5", "label": "gpt-5.5", "description": "Balanced default."},
        {"id": "gpt-5.5-pro", "label": "gpt-5.5-pro", "description": "Higher capability, higher cost."},
        {"id": "gpt-5.4", "label": "gpt-5.4", "description": "Strong general model."},
        {"id": "gpt-5.4-mini", "label": "gpt-5.4-mini", "description": "Lower cost and faster."},
        {"id": "gpt-5.2", "label": "gpt-5.2", "description": "Stable fallback."},
    ],
    "deepseek": [
        {"id": "deepseek-v4-flash", "label": "deepseek-v4-flash", "description": "Cheaper and faster."},
        {"id": "deepseek-v4-pro", "label": "deepseek-v4-pro", "description": "Higher quality, higher cost."},
    ],
}


def ensure_settings() -> None:
    if not SETTINGS_PATH.exists():
        SETTINGS_PATH.write_text(json.dumps(DEFAULT_SETTINGS, indent=2), encoding="utf-8")


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


def update_env_values(updates: dict[str, str | None]) -> None:
    lines: list[str] = []
    found: set[str] = set()
    existing_lines = ENV_PATH.read_text(encoding="utf-8").splitlines() if ENV_PATH.exists() else []
    for line in existing_lines:
        if "=" not in line or line.strip().startswith("#"):
            lines.append(line)
            continue
        key, _ = line.split("=", 1)
        key = key.strip()
        if key in updates and updates[key] is not None:
            lines.append(f"{key}={updates[key]}")
            found.add(key)
        else:
            lines.append(line)
    for key, value in updates.items():
        if value is None or key in found:
            continue
        lines.append(f"{key}={value}")
    if lines:
        ENV_PATH.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


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


def mask_secret(value: str | None) -> str:
    if not value:
        return ""
    if len(value) < 8:
        return ""
    return f"{value[:3]}...{value[-4:]}"


def provider_key_name(provider: str) -> str:
    return {
        "openai": "OPENAI_API_KEY",
        "deepseek": "DEEPSEEK_API_KEY",
    }.get(provider, "")


def provider_base_url_name(provider: str) -> str:
    return {
        "deepseek": "DEEPSEEK_BASE_URL",
    }.get(provider, "")


def get_provider_api_key(provider: str, env: dict[str, str] | None = None) -> str:
    env_values = env or load_env_file()
    key_name = provider_key_name(provider)
    if not key_name:
        return ""
    return os.environ.get(key_name) or env_values.get(key_name, "")


def get_provider_base_url(provider: str, env: dict[str, str] | None = None) -> str:
    env_values = env or load_env_file()
    base_name = provider_base_url_name(provider)
    if not base_name:
        return ""
    return os.environ.get(base_name) or env_values.get(base_name, "")


def settings_payload() -> dict[str, Any]:
    settings = read_settings()
    env = load_env_file()
    return {
        **settings,
        "api_key_masked": mask_secret(get_provider_api_key(settings.get("provider", "openai"), env)),
        "openai_api_key_masked": mask_secret(get_provider_api_key("openai", env)),
        "deepseek_api_key_masked": mask_secret(get_provider_api_key("deepseek", env)),
        "deepseek_base_url": get_provider_base_url("deepseek", env),
    }

# Design: Multi-Turn Conversation Sessions for Analysis Tools

**Date:** 2026-04-28  
**Status:** Approved

## Overview

The four analysis tools (Literature, Data Analysis, Mindmap, Brief) currently support only single-shot interactions: one prompt → one AI call → one result. This design adds multi-turn conversation sessions so users can refine AI output through follow-up messages, with history persisted to disk per project.

## Requirements

- Each of the four tools supports a back-and-forth conversation (multi-turn)
- Conversation history persists across page refreshes and app restarts (written to disk)
- Each tool has its own independent conversation history (switching tools does not mix history)
- UI adopts a chat bubble form: user messages right-aligned, AI messages left-aligned
- Users can clear a tool's conversation history

## Storage

Each project gains a `memory/chats/` directory with one JSONL file per tool:

```
{project}/
  memory/
    chats/
      literature.jsonl
      data.jsonl
      mindmap.jsonl
      brief.jsonl
```

`ensure_project_scaffold` is extended to create `memory/chats/` on project init.

### Message Schema

Each line in a JSONL file represents one message:

```jsonc
{
  "id": "msg-20260428120000-xxxx",
  "role": "user" | "assistant",
  "timestamp": "2026-04-28T12:00:00",
  "content": "请让导图更详细，增加理论框架层",
  "result": { ... },    // assistant only: structured tool output
  "context": { ... }    // user only: tool-specific context sent with this turn
}
```

`result` shape by tool:
- **mindmap**: `{ title, summary, mermaid, quarto_block, output_relative_path }`
- **brief**: `{ title, one_liner, key_messages, display_bullets, speaker_notes, poster_sections, call_to_action, output_relative_path }`
- **data**: `{ figure_title, figure_caption, figure_alt_text, figure_relative_path, summary, key_points, generated_code, suggested_section, data_file, record_relative_path }`
- **literature**: `{ analysis: {...}, candidate: {...}, cache_id }`

`context` shape by tool:
- **data**: `{ relative_path: "data/survey.csv" }`
- **brief**: `{ format: "ppt", scope_heading: "Results" }`
- **literature**, **mindmap**: `{}`

## Backend

### New Endpoints

```
GET    /api/chat/{tool}    Load history from disk (on app start / project switch)
POST   /api/chat/{tool}    Send a new message, get AI reply
DELETE /api/chat/{tool}    Clear conversation history for this tool
```

`tool` is one of: `literature` | `data` | `mindmap` | `brief`

### POST /api/chat/{tool} — Request

```jsonc
{
  "message": "请让导图更详细，增加理论框架层",
  "history": [ ...最近 8 轮 (16 条) 消息... ],
  "context": {
    "relative_path": "data/survey.csv",  // data only
    "format": "ppt",                     // brief only
    "scope_heading": "Results"           // brief only
  }
}
```

History is sent by the frontend (not re-read from disk by the backend on each call), capped at the most recent 8 turns (16 messages) to limit token usage. Full history is always written to disk.

### POST /api/chat/{tool} — Response

```jsonc
{
  "ok": true,
  "message": {
    "id": "msg-...",
    "role": "assistant",
    "timestamp": "...",
    "content": "已更新思维导图，增加了 Capability Approach 分支...",
    "result": { ... }
  }
}
```

After the AI response is returned, both the user message and the assistant message are appended to the tool's JSONL file.

### Provider Layer: New `generate_chat_json` Method

The two providers use fundamentally different APIs for multi-turn:
- **OpenAI** uses the Responses API (`responses.create`) where `input` can be a list of message objects
- **DeepSeek** uses Chat Completions (`chat.completions.create`) with a standard `messages` array

A new abstract method is added to `AIProvider`:

```python
@abstractmethod
def generate_chat_json(
    self,
    settings: dict[str, Any],
    instructions: str,
    messages: list[dict[str, str]],  # [{"role": "user"|"assistant", "content": "..."}]
) -> str:
    raise NotImplementedError
```

`OpenAIProvider.generate_chat_json` passes `messages` as the `input` list to `responses.create`.  
`DeepSeekProvider.generate_chat_json` prepends the system message and passes the full array to `chat.completions.create`.

The existing `generate_json(instructions, prompt)` method is kept unchanged for all non-chat paths (manuscript suggest, stream, literature single-shot).

### AI Context Construction

Each tool's system instructions are updated to include `content` as a required JSON field — a 1-3 sentence plain-text summary of what was generated, used for chat bubble display and as the assistant turn in subsequent rounds. All other existing JSON fields are preserved.

History is converted to a messages list for `generate_chat_json`:

```
[
  {"role": "user",      "content": "[turn 1 user message + context JSON]"},
  {"role": "assistant", "content": "[turn 1 content text from stored message]"},
  {"role": "user",      "content": "[turn 2 ...]"},
  ...
  {"role": "user",      "content": "[current message + context JSON]"},
]
```

History is truncated to the most recent 8 turns (16 messages) before building this array. The first turn (no prior history) calls `generate_chat_json` with a single-element messages list, which is equivalent to the existing single-shot behavior.

### Literature Multi-Turn

Literature currently uses `provider.analyze_literature()` → `provider.generate_json()`. For multi-turn, literature also routes through `generate_chat_json`. The system instructions (`literature_instructions`) are updated to include the `content` field. On first turn the behavior is identical to the existing single-shot path.

### Data Analysis: Follow-up Code Refinement

When conversation history contains a previous data analysis turn, the most recent `generated_code` from that turn is injected into the current user message context as `"previous_code"`. This lets the AI modify the existing chart rather than rewriting from scratch. The execute-and-retry loop (max 2 retries) runs the same way as the initial call.

### New Pydantic Schemas

```python
class ChatMessage(BaseModel):
    id: str
    role: str  # "user" | "assistant"
    timestamp: str
    content: str
    result: Optional[dict] = None
    context: Optional[dict] = None

class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    context: dict = {}
```

### New Backend Functions

- `chat_history_path(tool, project)` → `Path` to the JSONL file
- `load_chat_history(tool, project)` → `list[dict]`
- `append_chat_messages(tool, project, user_msg, assistant_msg)` → writes both messages to disk
- `clear_chat_history(tool, project)` → truncates the JSONL file
- `build_chat_messages(history, new_message, context)` → constructs the messages list for `generate_chat_json`
- `run_chat_turn(tool, project, provider, settings, request)` → dispatches to the appropriate skill and returns an assistant message dict

The existing `run_mindmap_skill`, `run_brief_skill`, `run_data_analysis_skill` functions are refactored to accept a `messages` list (already built by `build_chat_messages`) and call `provider.generate_chat_json` instead of `provider.generate_json`.

## Frontend

### State Management (AnalysisWorkspace)

```js
const [chatHistories, setChatHistories] = useState({
  literature: [],
  data: [],
  mindmap: [],
  brief: [],
});
const [chatBusy, setChatBusy] = useState('');  // tool id or ''
```

On mount and on project switch: fetch all four histories in parallel via `GET /api/chat/{tool}`.

When switching between tools, the history for each tool stays in `chatHistories` (no re-fetch needed mid-session).

### New Component: ChatPanel

`frontend/src/components/ChatPanel.jsx` — shared across all four tools.

Props:
```js
{
  tool,           // "literature"|"data"|"mindmap"|"brief"
  messages,       // current tool's history array
  isBusy,
  onSend,         // (message, context) => void
  onClear,        // () => void
  contextSlot,    // optional JSX rendered above the input (e.g., data file selector)
  renderResult,   // (message) => JSX — renders structured result inside AI bubble
}
```

Layout:
- Message list area (scrollable, newest at bottom)
- User messages: right-aligned bubble
- Assistant messages: left-aligned bubble with `content` text + `renderResult(message)` below
- Fixed footer: `contextSlot` (optional) + textarea input + Send button
- Clear button in header

### Tool-Specific Result Rendering

Each tool passes a `renderResult` function to `ChatPanel`:

**mindmap** — renders `<MermaidPreview code={msg.result.mermaid} />` + collapsible Quarto snippet  
**brief** — renders key messages list, one-liner, call to action  
**data** — renders figure `<img>` + collapsible insert form (section title, caption, introduction) + "插入到文稿" button  
**literature** — renders existing `<LiteraturePanel>` result card + "导入摘要" / "下载原文" buttons bound to `msg.result.cache_id`

### Tool Context Slots

**data**: file selector `<select>` above the input  
**brief**: format `<select>` + scope heading `<select>` above the input  
**literature**, **mindmap**: no context slot needed

### Clearing History

Clear button calls `DELETE /api/chat/{tool}` then sets `chatHistories[tool] = []`.

## Error Handling

- If the AI call fails, no messages are written to disk. The error is surfaced via `onSetMessage` as before.
- If the JSONL file is corrupt, `load_chat_history` returns an empty list (same pattern as existing `read_jsonl`).
- History truncation (max 8 turns) is applied silently; the full file on disk is never truncated.

## Files Changed

**Backend:**
- `backend/app/schemas.py` — add `ChatMessage`, `ChatRequest`
- `backend/app/providers.py` — add abstract `generate_chat_json`; implement in `OpenAIProvider` and `DeepSeekProvider`; update per-tool instruction functions to include `content` field
- `backend/app/analysis_skills.py` — refactor skill functions to accept a `messages` list and call `generate_chat_json`
- `backend/app/main.py` — add `GET/POST/DELETE /api/chat/{tool}` endpoints; extend `ensure_project_scaffold` to create `memory/chats/`

**Frontend:**
- `frontend/src/components/ChatPanel.jsx` — new shared chat component
- `frontend/src/components/AnalysisWorkspace.jsx` — replace four tool panels with `ChatPanel` instances
- `frontend/src/api.js` — add `chatApi.load(tool)`, `chatApi.send(tool, payload)`, `chatApi.clear(tool)`

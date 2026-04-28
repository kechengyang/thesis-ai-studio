import React, { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, Send, Trash2, User } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { buildProjectFileUrl } from '../api';

const DEFAULT_INPUT_HEIGHT = 150;
const MIN_INPUT_HEIGHT = 78;
const MAX_INPUT_HEIGHT = 380;

function asHttpUrl(value) {
  const text = String(value || '').trim();
  return /^https?:\/\//i.test(text) ? text : '';
}

function sourceHref(source) {
  const externalUrl = asHttpUrl(source.url || source.source_url);
  if (externalUrl) return externalUrl;
  const localName = String(source.text_file || source.filename || '').trim();
  if (localName) return buildProjectFileUrl(`sources/${localName}`);
  const title = String(source.title || '').trim();
  return title ? `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}` : '';
}

function linkifySourceCitations(markdown, sourceReferences) {
  if (!Array.isArray(sourceReferences) || sourceReferences.length === 0) return markdown;
  const sourceById = new Map();
  sourceReferences.forEach((source, index) => {
    const id = String(source.id || index + 1).replace(/^\[|\]$/g, '');
    const href = sourceHref(source);
    if (id && href) sourceById.set(id, { href, title: String(source.title || source.filename || `Source ${id}`).trim() });
  });
  if (sourceById.size === 0) return markdown;
  return markdown.replace(/(?<!!)\[(\d+)\](?!\()/g, (match, id) => {
    const source = sourceById.get(String(id));
    if (!source) return match;
    const title = source.title.length > 48 ? `${source.title.slice(0, 45).trimEnd()}...` : source.title;
    return `[[${id}] ${title}](${source.href})`;
  });
}

function MessageContent({ msg }) {
  const rawMarkdown = msg.role === 'assistant' ? String(msg.result?.answer_markdown || '').trim() : '';
  const markdown = rawMarkdown ? linkifySourceCitations(rawMarkdown, msg.result?.source_references) : '';
  if (markdown) {
    return (
      <div className="chat-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ node: _node, ...props }) => (
              <a {...props} rel="noreferrer" target="_blank" />
            ),
          }}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    );
  }
  return <p className="chat-bubble-content">{msg.content}</p>;
}

export function ChatPanel({
  tool,
  title = '',
  messages,
  isBusy,
  onSend,
  onClear,
  contextSlot,
  renderResult,
  placeholder = '输入消息... (Cmd/Ctrl+Enter 发送)',
  sendDisabled = false,
}) {
  const [input, setInput] = useState('');
  const [inputHeight, setInputHeight] = useState(DEFAULT_INPUT_HEIGHT);
  const bottomRef = useRef(null);
  const resizeRef = useRef({ active: false, startY: 0, startHeight: DEFAULT_INPUT_HEIGHT });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function handleSend() {
    const text = input.trim();
    if (!text || isBusy || sendDisabled) return;
    setInput('');
    onSend(text);
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      handleSend();
    }
  }

  function startInputResize(event) {
    resizeRef.current = {
      active: true,
      startY: event.clientY,
      startHeight: inputHeight,
    };

    function onPointerMove(moveEvent) {
      if (!resizeRef.current.active) return;
      const delta = resizeRef.current.startY - moveEvent.clientY;
      const nextHeight = Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, resizeRef.current.startHeight + delta));
      setInputHeight(nextHeight);
    }

    function onPointerUp() {
      resizeRef.current.active = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    event.preventDefault();
  }

  return (
    <div className="chat-panel">
      <div className="chat-panel-header">
        <span className="chat-panel-title">{title || `${tool} conversation`}</span>
        <button
          className="chat-clear-btn"
          disabled={isBusy || messages.length === 0}
          onClick={onClear}
          title="清空对话"
          type="button"
        >
          <Trash2 size={14} />
          清空
        </button>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>还没有对话。输入你的问题开始吧。</p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-bubble-row ${msg.role === 'user' ? 'user' : 'assistant'}`}>
            <div className="chat-bubble-avatar">
              {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
            </div>
            <div className="chat-bubble">
              <MessageContent msg={msg} />
              {msg.role === 'assistant' && msg.result && renderResult && (
                <div className="chat-bubble-result">
                  {renderResult(msg)}
                </div>
              )}
              <span className="chat-bubble-time">{msg.timestamp?.slice(0, 16).replace('T', ' ')}</span>
            </div>
          </div>
        ))}
        {isBusy && (
          <div className="chat-bubble-row assistant">
            <div className="chat-bubble-avatar"><Bot size={14} /></div>
            <div className="chat-bubble chat-bubble-loading">
              <Loader2 className="spin" size={16} />
              <span>AI 正在思考...</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-panel-footer">
        {contextSlot && <div className="chat-context-slot">{contextSlot}</div>}
        <div
          aria-label="调整输入框高度"
          className="chat-input-resize-handle"
          onDoubleClick={() => setInputHeight(DEFAULT_INPUT_HEIGHT)}
          onPointerDown={startInputResize}
          role="separator"
          title="拖拽调整输入框高度，双击恢复默认"
        >
          <span />
        </div>
        <div className="chat-input-row">
          <textarea
            className="chat-input"
            disabled={isBusy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={5}
            style={{ height: inputHeight }}
            value={input}
          />
          <button
            className="primary chat-send-btn"
            disabled={isBusy || !input.trim() || sendDisabled}
            onClick={handleSend}
            title="发送 (Cmd+Enter)"
            type="button"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

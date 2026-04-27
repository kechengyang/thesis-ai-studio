import React, { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, Send, Trash2, User } from 'lucide-react';

export function ChatPanel({
  tool,
  messages,
  isBusy,
  onSend,
  onClear,
  contextSlot,
  renderResult,
}) {
  const [input, setInput] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function handleSend() {
    const text = input.trim();
    if (!text || isBusy) return;
    setInput('');
    onSend(text);
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      handleSend();
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-panel-header">
        <span className="chat-panel-title">{tool} conversation</span>
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
              <p className="chat-bubble-content">{msg.content}</p>
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
        <div className="chat-input-row">
          <textarea
            className="chat-input"
            disabled={isBusy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Cmd/Ctrl+Enter 发送)"
            rows={2}
            value={input}
          />
          <button
            className="primary chat-send-btn"
            disabled={isBusy || !input.trim()}
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

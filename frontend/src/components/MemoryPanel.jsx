import React, { useMemo, useState } from 'react';
import { MessageSquareText, X } from 'lucide-react';

function compactText(text, limit = 88) {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  if (!value) return 'Untitled memory';
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}...`;
}

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildEntries(memory) {
  const changes = (memory.recent_changes || []).map((item) => ({
    id: item.id,
    kind: 'change',
    label: item.status === 'accepted' ? 'Accepted edit' : 'Rejected suggestion',
    status: item.status || 'change',
    timestamp: item.timestamp || '',
    title: compactText(item.original_segment),
    item,
  }));

  const conversations = (memory.recent_conversations || []).map((item) => ({
    id: item.id,
    kind: 'conversation',
    label: 'AI suggestion',
    status: 'conversation',
    timestamp: item.timestamp || '',
    title: compactText(item.instruction || item.selected_text),
    item,
  }));

  return [...changes, ...conversations].sort((left, right) => {
    return String(right.timestamp || '').localeCompare(String(left.timestamp || ''));
  });
}

function DetailBlock({ children, title }) {
  if (!children) return null;
  return (
    <section className="memory-detail-block">
      <span>{title}</span>
      {typeof children === 'string' ? <p>{children}</p> : children}
    </section>
  );
}

function OperationList({ operations }) {
  if (!Array.isArray(operations) || operations.length === 0) return null;
  return (
    <ul className="memory-detail-list">
      {operations.map((operation, index) => (
        <li key={`${operation.type || 'op'}-${index}`}>
          {operation.type === 'replace_text' && `Replace: ${(operation.target_text || '').slice(0, 120)}`}
          {operation.type === 'insert_under_heading' && `Insert under ${operation.section_title || 'document end'}`}
          {operation.type === 'insert_figure' && `Insert figure ${operation.figure_relative_path || ''} under ${operation.section_title || 'document end'}`}
          {!['replace_text', 'insert_under_heading', 'insert_figure'].includes(operation.type) && (operation.type || 'edit')}
        </li>
      ))}
    </ul>
  );
}

function ToolResultList({ results }) {
  if (!Array.isArray(results) || results.length === 0) return null;
  return (
    <ul className="memory-detail-list">
      {results.map((result, index) => (
        <li key={`${result.type || 'tool'}-${index}`}>
          {result.type === 'import_literature' && `Imported literature: ${result.candidate_title || result.query || ''}`}
          {result.type === 'create_data_figure' && `Generated figure: ${result.figure_relative_path || result.data_relative_path || ''}`}
          {result.type === 'create_brief' && `Created brief: ${result.title || result.output_relative_path || ''}`}
          {!['import_literature', 'create_data_figure', 'create_brief'].includes(result.type) && (result.type || 'tool')}
          {result.status === 'error' && result.error ? ` (${result.error})` : ''}
        </li>
      ))}
    </ul>
  );
}

function ToolActionList({ actions }) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  return (
    <ul className="memory-detail-list">
      {actions.map((action, index) => (
        <li key={`${action.type || 'tool-action'}-${index}`}>
          {action.type === 'import_literature' && `Import literature: ${action.query || ''}`}
          {action.type === 'create_data_figure' && `Create figure from ${action.data_relative_path || ''}`}
          {action.type === 'create_brief' && `Create brief: ${action.format || 'summary'}`}
          {!['import_literature', 'create_data_figure', 'create_brief'].includes(action.type) && (action.type || 'tool action')}
        </li>
      ))}
    </ul>
  );
}

export function MemoryPanel({ memory }) {
  const [activeEntryId, setActiveEntryId] = useState('');
  const entries = useMemo(() => buildEntries(memory), [memory]);
  const activeEntry = entries.find((item) => item.id === activeEntryId) || null;

  return (
    <section className="memory-panel">
      <details className="collapsible-panel" data-section="memory">
        <summary className="collapsible-summary">
          <div className="panel-heading compact">
            <MessageSquareText size={16} />
            <span>项目 Memory</span>
          </div>
          <div className="memory-counts">
            <span>{memory.conversation_count || 0} AI conversations</span>
            <span>{memory.change_count || 0} edits</span>
          </div>
        </summary>
        <div className="memory-list">
          {entries.map((entry) => (
            <button
              className={`memory-item-button ${entry.status}`}
              key={entry.id}
              onClick={() => setActiveEntryId(entry.id)}
              type="button"
            >
              <div className="memory-item-topline">
                <strong>{entry.label}</strong>
                <span>{formatTimestamp(entry.timestamp)}</span>
              </div>
              <p>{entry.title}</p>
            </button>
          ))}
          {entries.length === 0 && <p className="empty-line">No memory yet</p>}
        </div>
      </details>

      {activeEntry && (
        <div className="modal-backdrop">
          <section className="modal modal-wide modal-scrollable">
            <header>
              <h2>{activeEntry.label}</h2>
              <button onClick={() => setActiveEntryId('')} title="关闭">
                <X size={18} />
              </button>
            </header>

            <div className="memory-detail-meta">
              <span className={`memory-status-pill ${activeEntry.status}`}>{activeEntry.label}</span>
              <span>{formatTimestamp(activeEntry.timestamp)}</span>
            </div>

            {activeEntry.kind === 'change' ? (
              <div className="memory-detail-grid">
                <DetailBlock title="Title">{activeEntry.title}</DetailBlock>
                <DetailBlock title="Original Segment">{activeEntry.item.original_segment}</DetailBlock>
                {activeEntry.item.replacement && (
                  <DetailBlock title="Applied Revision">
                    <pre className="memory-detail-pre">{activeEntry.item.replacement}</pre>
                  </DetailBlock>
                )}
                {activeEntry.item.operations?.length > 0 && (
                  <DetailBlock title="Applied Operations">
                    <OperationList operations={activeEntry.item.operations} />
                  </DetailBlock>
                )}
                {activeEntry.item.suggestion?.rewritten_text && (
                  <DetailBlock title="Rejected Revision">
                    <pre className="memory-detail-pre">{activeEntry.item.suggestion.rewritten_text}</pre>
                  </DetailBlock>
                )}
                {activeEntry.item.suggestion?.operations?.length > 0 && (
                  <DetailBlock title="Rejected Operations">
                    <OperationList operations={activeEntry.item.suggestion.operations} />
                  </DetailBlock>
                )}
                {activeEntry.item.suggestion?.tool_results?.length > 0 && (
                  <DetailBlock title="Tool Effects">
                    <ToolResultList results={activeEntry.item.suggestion.tool_results} />
                  </DetailBlock>
                )}
                {activeEntry.item.suggestion?.rationale && (
                  <DetailBlock title="Rationale">{activeEntry.item.suggestion.rationale}</DetailBlock>
                )}
              </div>
            ) : (
              <div className="memory-detail-grid">
                <DetailBlock title="Title">{activeEntry.title}</DetailBlock>
                <DetailBlock title="Instruction">{activeEntry.item.instruction}</DetailBlock>
                <DetailBlock title="Selected Text">{activeEntry.item.selected_text}</DetailBlock>
                {activeEntry.item.suggestion?.rewritten_text && (
                  <DetailBlock title="Suggested Revision">
                    <pre className="memory-detail-pre">{activeEntry.item.suggestion.rewritten_text}</pre>
                  </DetailBlock>
                )}
                {activeEntry.item.suggestion?.operations?.length > 0 && (
                  <DetailBlock title="Planned Operations">
                    <OperationList operations={activeEntry.item.suggestion.operations} />
                  </DetailBlock>
                )}
                {activeEntry.item.suggestion?.tool_actions?.length > 0 && (
                  <DetailBlock title="Planned Tool Actions">
                    <ToolActionList actions={activeEntry.item.suggestion.tool_actions} />
                  </DetailBlock>
                )}
                {activeEntry.item.suggestion?.tool_results?.length > 0 && (
                  <DetailBlock title="Executed Tool Results">
                    <ToolResultList results={activeEntry.item.suggestion.tool_results} />
                  </DetailBlock>
                )}
                {activeEntry.item.suggestion?.rationale && (
                  <DetailBlock title="Rationale">{activeEntry.item.suggestion.rationale}</DetailBlock>
                )}
                {activeEntry.item.source_files?.length > 0 && (
                  <DetailBlock title="Sources Used">
                    <ul className="memory-detail-list">
                      {activeEntry.item.source_files.map((filename) => (
                        <li key={filename}>{filename}</li>
                      ))}
                    </ul>
                  </DetailBlock>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}

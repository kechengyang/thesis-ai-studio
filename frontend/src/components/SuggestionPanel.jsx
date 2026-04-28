import React from 'react';
import { Check, X } from 'lucide-react';

import { buildProjectFileUrl } from '../api';

function tokenizeDiffText(text) {
  return String(text || '').match(
    /\s+|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[A-Za-z0-9_]+|[^\sA-Za-z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g,
  ) || [];
}

function tokenKey(token) {
  return /\s/.test(token) ? ' ' : token;
}

function buildHighlightedDiff(originalText, rewrittenText) {
  const originalTokens = tokenizeDiffText(originalText);
  const rewrittenTokens = tokenizeDiffText(rewrittenText);

  if (rewrittenTokens.length === 0) return [];
  if (originalTokens.length === 0) {
    return rewrittenTokens.map((value, index) => ({
      id: `added-${index}`,
      value,
      changed: false,
    }));
  }

  const rows = originalTokens.length + 1;
  const cols = rewrittenTokens.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = originalTokens.length - 1; i >= 0; i -= 1) {
    for (let j = rewrittenTokens.length - 1; j >= 0; j -= 1) {
      if (tokenKey(originalTokens[i]) === tokenKey(rewrittenTokens[j])) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const segments = [];
  let i = 0;
  let j = 0;

  while (i < originalTokens.length && j < rewrittenTokens.length) {
    if (tokenKey(originalTokens[i]) === tokenKey(rewrittenTokens[j])) {
      segments.push({
        id: `keep-${i}-${j}`,
        value: rewrittenTokens[j],
        changed: false,
      });
      i += 1;
      j += 1;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
      continue;
    }

    segments.push({
      id: `add-${i}-${j}`,
      value: rewrittenTokens[j],
      changed: true,
    });
    j += 1;
  }

  while (j < rewrittenTokens.length) {
    segments.push({
      id: `tail-${j}`,
      value: rewrittenTokens[j],
      changed: true,
    });
    j += 1;
  }

  return segments;
}

function operationLabel(operation) {
  if (operation.type === 'replace_text') return '替换原文';
  if (operation.type === 'insert_under_heading') return '插入段落';
  if (operation.type === 'insert_figure') return '插入 Figure';
  return operation.type || '编辑动作';
}

function operationSummary(operation) {
  if (operation.summary) return operation.summary;
  if (operation.type === 'replace_text') {
    return String(operation.target_text || '').trim().slice(0, 120);
  }
  if (operation.type === 'insert_under_heading') {
    return operation.section_title ? `插入到 ${operation.section_title}` : '插入到文末';
  }
  if (operation.type === 'insert_figure') {
    return operation.section_title
      ? `${operation.figure_relative_path || ''} -> ${operation.section_title}`
      : (operation.figure_relative_path || '');
  }
  return '';
}

function toolResultLabel(result) {
  if (result.type === 'search_literature') return '外部资料检索';
  if (result.type === 'import_literature') return '文献导入';
  if (result.type === 'create_data_figure') return '图表生成';
  if (result.type === 'create_brief') return 'Brief 生成';
  return result.type || '工具执行';
}

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

function credibilityLabel(value) {
  if (value === 'high') return '高可信';
  if (value === 'medium') return '中等可信';
  if (value === 'background_only') return '背景资料';
  if (value === 'project') return '项目资料';
  return value || '待核对';
}

export function SuggestionPanel({ isBusy, onApply, onReject, suggestion, compact = false }) {
  if (!suggestion) {
    return null;
  }

  const operations = Array.isArray(suggestion.operations) ? suggestion.operations : [];
  const primaryReplaceOperation = operations.find((operation) => operation.type === 'replace_text') || null;
  const suggestionTrace = suggestion.trace || null;
  const sourceText = suggestion.selected_text || primaryReplaceOperation?.target_text || '';
  const rewrittenText = suggestion.rewritten_text || primaryReplaceOperation?.replacement || '';
  const diffSegments = buildHighlightedDiff(sourceText, rewrittenText);
  const hasHighlightedChanges = diffSegments.some((segment) => segment.changed && segment.value.trim());
  const toolResults = Array.isArray(suggestion.tool_results) ? suggestion.tool_results : [];
  const sourceReferences = Array.isArray(suggestion.source_references) ? suggestion.source_references : [];

  return (
    <section className={`suggestion${compact ? ' compact' : ''}`}>
      {!compact && <h2>建议改写</h2>}
      {rewrittenText && (
        <>
          {hasHighlightedChanges && (
            <div className="suggestion-diff-hint">
              高亮部分表示 AI 相对原文新增或改写的内容。
            </div>
          )}
          <pre className="suggestion-diff-text">
            {diffSegments.map((segment) => (
              <span
                className={segment.changed && segment.value.trim() ? 'suggestion-diff-changed' : undefined}
                key={segment.id}
              >
                {segment.value}
              </span>
            ))}
          </pre>
        </>
      )}
      {operations.length > 0 && (
        <div className="suggestion-operations">
          <h3>{compact ? '动作' : '编辑动作'}</h3>
          <div className="suggestion-operation-list">
            {operations.map((operation, index) => (
              <div className="suggestion-operation-card" key={`${operation.type || 'op'}-${index}`}>
                <div className="suggestion-operation-topline">
                  <strong>{operationLabel(operation)}</strong>
                  <span>{operationSummary(operation)}</span>
                </div>
                {operation.type === 'insert_under_heading' && operation.content && (
                  <pre>{operation.content}</pre>
                )}
                {operation.type === 'replace_text' && operation.replacement && (
                  <pre>{operation.replacement}</pre>
                )}
                {operation.type === 'insert_figure' && (
                  <p className="suggestion-operation-meta">
                    {operation.figure_relative_path}
                    {operation.figure_title ? ` · ${operation.figure_title}` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {toolResults.length > 0 && (
        <div className="suggestion-operations">
          <h3>{compact ? '工具' : '工具执行'}</h3>
          <div className="suggestion-operation-list">
            {toolResults.map((result, index) => (
              <div className="suggestion-operation-card" key={`${result.type || 'tool'}-${index}`}>
                <div className="suggestion-operation-topline">
                  <strong>{toolResultLabel(result)}</strong>
                  <span>{result.status === 'error' ? '失败' : '已完成'}</span>
                </div>
                {result.error ? (
                  <p className="suggestion-operation-meta">{result.error}</p>
                ) : (
                  <p className="suggestion-operation-meta">
                    {result.candidate_title || result.figure_relative_path || result.title || result.output_relative_path || result.summary || ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {(suggestionTrace || suggestion.process_summary?.length > 0) && (
        <details className="collapsible-panel trace-collapsible" data-section="trace">
          <summary className="collapsible-summary">
            <h3>{compact ? '过程' : 'AI 过程'}</h3>
            <span className="collapsible-meta">
              {(suggestion.process_summary?.length || 0) > 0
                ? `${suggestion.process_summary.length} steps`
                : 'details'}
            </span>
          </summary>
          <div className="trace-panel">
            {suggestionTrace && (
              <div className="trace-chips">
                <span className="trace-chip">Provider {suggestionTrace.provider}</span>
                <span className="trace-chip">Model {suggestionTrace.model}</span>
                <span className="trace-chip">Reasoning {suggestionTrace.reasoning_effort}</span>
                <span className="trace-chip">Sources {suggestionTrace.source_count}</span>
                <span className="trace-chip">
                  Memory {suggestionTrace.recent_ai_interactions_used}/{suggestionTrace.recent_edits_used}
                </span>
              </div>
            )}
            {suggestionTrace?.source_files?.length > 0 && (
              <div className="trace-box">
                <span>本次用到的本地资料</span>
                <div className="trace-chips">
                  {suggestionTrace.source_files.map((filename) => (
                    <span className="trace-chip muted" key={filename}>{filename}</span>
                  ))}
                </div>
              </div>
            )}
            {suggestion.process_summary?.length > 0 && (
              <div className="trace-box">
                <span>过程摘要</span>
                <ul>
                  {suggestion.process_summary.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
      {sourceReferences.length > 0 && (
        <div className="suggestion-sources">
          <h3>🔎 Sources</h3>
          <div className="suggestion-source-list">
            {sourceReferences.map((source, index) => {
              const href = sourceHref(source);
              const sourceId = String(source.id || index + 1).replace(/^\[|\]$/g, '');
              const isFallbackSearch = href.includes('scholar.google.com') && !asHttpUrl(source.url || source.source_url);
              return (
                <article className="suggestion-source-card" key={`${sourceId}-${source.url || source.title || index}`}>
                  <div className="suggestion-source-topline">
                    <span className="suggestion-source-id">[{sourceId}]</span>
                    {href ? (
                      <a href={href} rel="noreferrer" target="_blank">
                        {source.title || source.filename || `Source ${sourceId}`}
                      </a>
                    ) : (
                      <strong>{source.title || source.filename || `Source ${sourceId}`}</strong>
                    )}
                  </div>
                  <div className="suggestion-source-tags">
                    <span>{source.source_type || 'source'}</span>
                    <span>{credibilityLabel(source.credibility)}</span>
                    {isFallbackSearch && <span>Scholar search</span>}
                  </div>
                  {source.used_for && <p>{source.used_for}</p>}
                  {source.snippet && <blockquote>{source.snippet}</blockquote>}
                </article>
              );
            })}
          </div>
        </div>
      )}
      {suggestion.rationale && !suggestion.answer_markdown && (
        <>
          <h3>理由</h3>
          <p>{suggestion.rationale}</p>
        </>
      )}
      {suggestion.risks?.length > 0 && (
        <>
          <h3>需要核对</h3>
          <ul>
            {suggestion.risks.map((risk, index) => <li key={index}>{risk}</li>)}
          </ul>
        </>
      )}
      {suggestion.citation_or_data_notes?.length > 0 && (
        <>
          <h3>引用/数据提示</h3>
          <ul>
            {suggestion.citation_or_data_notes.map((note, index) => <li key={index}>{note}</li>)}
          </ul>
        </>
      )}
      {(onApply || onReject) && (suggestion.rewritten_text || operations.length > 0) && (
        <div className="suggestion-actions">
          {onApply && (
            <button onClick={onApply} disabled={isBusy} title="接受建议">
              <Check size={18} />接受
            </button>
          )}
          {onReject && (
            <button onClick={onReject} disabled={isBusy} title="拒绝建议">
              <X size={18} />拒绝
            </button>
          )}
        </div>
      )}
    </section>
  );
}

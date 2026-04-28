import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookText, Bot, Database, FileText, Image, Loader2, Send, Sparkles, Trash2, User } from 'lucide-react';

import { buildProjectFileUrl, chatApi, studioApi } from '../api';
import { MermaidPreview } from './MermaidPreview';

const TOOLS = ['literature', 'data', 'mindmap', 'brief'];

function filesByCategory(project, category) {
  const match = (project?.files || []).find((item) => item.category === category);
  return match?.files || [];
}

function compactLine(value, fallback = 'Not available') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text;
}

function asHttpUrl(value) {
  const text = String(value || '').trim();
  return /^https?:\/\//i.test(text) ? text : '';
}

function ResultLink({ label, url }) {
  const href = asHttpUrl(url);
  if (!href) return null;
  return (
    <a className="analysis-result-link" href={href} rel="noreferrer" target="_blank">
      {label}
    </a>
  );
}

function literatureSourceTitle(source) {
  return String(source?.filename || source?.text_file || 'Imported source').trim() || 'Imported source';
}

function literatureSourceOptionLabel(source) {
  return `${literatureSourceTitle(source)} · ${source?.downloaded_original ? '原文' : '文本摘要'}`;
}

function buildLiteratureFocus(source, overrides = {}) {
  return {
    cache_id: overrides.cache_id || '',
    filename: source?.filename || '',
    text_file: source?.text_file || '',
    title: overrides.title || literatureSourceTitle(source),
    downloaded_original: Boolean(source?.downloaded_original),
  };
}

function defaultLiteratureSourcePrompt() {
  return '请结合当前稿件结构评估这篇文献，总结核心观点，说明相关性，给出 citation uses，并直接起草一段 literature review。';
}

// ── Result renderers ──────────────────────────────────────

function MindmapResult({ msg }) {
  const { result } = msg;
  if (!result) return null;
  return (
    <div>
      <div className="analysis-figure-frame">
        <MermaidPreview code={result.mermaid} />
      </div>
      <details className="analysis-code-block" style={{ marginTop: 8 }}>
        <summary>查看 Mermaid 代码 / Quarto Snippet</summary>
        <pre>{result.quarto_block}</pre>
      </details>
      <p className="analysis-inline-note" style={{ marginTop: 6 }}>{result.output_relative_path}</p>
    </div>
  );
}

function BriefResult({ msg }) {
  const { result } = msg;
  if (!result) return null;
  return (
    <div>
      <p className="analysis-meta">{compactLine(result.target_format)} · {compactLine(result.focus)}</p>
      {result.one_liner && (
        <div className="analysis-subcard">
          <span>One-liner</span>
          <p>{result.one_liner}</p>
        </div>
      )}
      {result.key_messages?.length > 0 && (
        <div className="analysis-subcard">
          <span>Key Messages</span>
          <ul className="analysis-result-list">
            {result.key_messages.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      )}
      <p className="analysis-inline-note" style={{ marginTop: 6 }}>{result.output_relative_path}</p>
    </div>
  );
}

function DataResult({ msg, outlineTitles, onRefreshWorkspace, onSetMessage, isBusy, onSetBusy }) {
  const { result } = msg;
  const [insertForm, setInsertForm] = useState({
    figure_title: result?.figure_title || '',
    figure_caption: result?.figure_caption || '',
    figure_alt_text: result?.figure_alt_text || '',
    section_title: result?.suggested_section || '',
    introduction: result?.insert_paragraph || '',
  });

  if (!result) return null;
  const previewColumns = result.dataset_snapshot?.preview_columns || [];
  const previewRows = result.dataset_snapshot?.preview_rows || [];

  async function handleInsert() {
    onSetBusy('analysis-insert');
    try {
      await studioApi.insertDataFigure({
        figure_relative_path: result.figure_relative_path,
        figure_title: insertForm.figure_title,
        figure_caption: insertForm.figure_caption,
        figure_alt_text: insertForm.figure_alt_text,
        section_title: insertForm.section_title,
        introduction: insertForm.introduction,
      });
      await onRefreshWorkspace();
      onSetMessage(`图表已插入到 ${insertForm.section_title || '当前文稿'}。`);
    } catch (error) {
      onSetMessage(error.message);
    } finally {
      onSetBusy('');
    }
  }

  return (
    <div>
      {result.data_result && (
        <div className="analysis-subcard" style={{ marginBottom: 8 }}>
          <span>Data Result</span>
          <p>{result.data_result}</p>
        </div>
      )}
      {(result.supporting_data?.length > 0 || result.key_points?.length > 0) && (
        <div className="analysis-subcard" style={{ marginBottom: 8 }}>
          <span>Supporting Data</span>
          <ul className="analysis-result-list">
            {(result.supporting_data?.length > 0 ? result.supporting_data : result.key_points).map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      )}
      {previewColumns.length > 0 && previewRows.length > 0 && (
        <div className="analysis-subcard" style={{ marginBottom: 8 }}>
          <span>Dataset Snapshot</span>
          <p className="analysis-meta">
            {result.dataset_snapshot?.row_count || 0} rows · {result.dataset_snapshot?.column_count || 0} columns
          </p>
          <div className="analysis-table-wrap">
            <table className="analysis-mini-table">
              <thead>
                <tr>
                  {previewColumns.map((column) => <th key={column}>{column}</th>)}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {previewColumns.map((column) => <td key={`${rowIndex}-${column}`}>{compactLine(row[column], '—')}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="analysis-figure-frame">
        <img
          alt={result.figure_alt_text || result.figure_title}
          className="analysis-figure-preview"
          src={buildProjectFileUrl(result.figure_relative_path)}
        />
      </div>
      <details style={{ marginTop: 8 }}>
        <summary className="analysis-inline-label">插入到文稿</summary>
        <div className="analysis-insert-grid" style={{ marginTop: 8 }}>
          <label>
            插入位置
            <input
              list="chat-section-options"
              onChange={(e) => setInsertForm((c) => ({ ...c, section_title: e.target.value }))}
              value={insertForm.section_title}
            />
            <datalist id="chat-section-options">
              {outlineTitles.map((t) => <option key={t} value={t} />)}
            </datalist>
          </label>
          <label>
            图表标题
            <input
              onChange={(e) => setInsertForm((c) => ({ ...c, figure_title: e.target.value }))}
              value={insertForm.figure_title}
            />
          </label>
          <label className="analysis-span-2">
            Caption
            <textarea
              onChange={(e) => setInsertForm((c) => ({ ...c, figure_caption: e.target.value }))}
              value={insertForm.figure_caption}
            />
          </label>
          <label className="analysis-span-2">
            引入段落
            <textarea
              onChange={(e) => setInsertForm((c) => ({ ...c, introduction: e.target.value }))}
              value={insertForm.introduction}
            />
          </label>
        </div>
        <div className="analysis-actions" style={{ marginTop: 8 }}>
          <button className="primary" disabled={isBusy} onClick={handleInsert} type="button">
            插入到当前文稿
          </button>
        </div>
      </details>
      <p className="analysis-inline-note" style={{ marginTop: 6 }}>{result.figure_relative_path}</p>
    </div>
  );
}

function LiteratureResult({ msg, onActivateFocus, onRefreshWorkspace, onSetMessage, isBusy, onSetBusy }) {
  const { result } = msg;
  if (!result) return null;
  const {
    analysis,
    cache_id,
    candidate,
    download_available,
    scholar_search_url,
    search_results = [],
  } = result;
  const visibleResults = search_results.length > 0 ? search_results : (candidate ? [candidate] : []);

  async function handleImport(downloadOriginal) {
    onSetBusy(downloadOriginal ? 'literature-download' : 'literature-import');
    try {
      const data = await studioApi.importLiterature(cache_id, downloadOriginal);
      await onRefreshWorkspace();
      if (onActivateFocus) {
        onActivateFocus({
          cache_id: cache_id,
          filename: data.source?.filename || '',
          text_file: data.source?.text_file || '',
          title: analysis?.title || candidate?.title || '',
          downloaded_original: Boolean(data.source?.downloaded_original),
        });
      }
      onSetMessage(
        downloadOriginal
          ? `已下载并导入：${data.source.filename}。现在可以继续追问文章内容，或让 AI 直接生成 literature review。`
          : `已导入文献摘要：${data.source.filename}。如果需要围绕原文深入讨论，建议下载原文后继续追问。`,
      );
    } catch (error) {
      onSetMessage(error.message);
    } finally {
      onSetBusy('');
    }
  }

  return (
    <div>
      {(analysis?.title || candidate?.title) && (
        <strong style={{ display: 'block', marginBottom: 4 }}>{analysis?.title || candidate?.title}</strong>
      )}
      {(analysis?.authors?.length > 0 || candidate?.authors?.length > 0 || analysis?.year || candidate?.year || analysis?.venue || candidate?.venue) && (
        <p className="analysis-meta">
          {(analysis?.authors?.length > 0 ? analysis.authors : candidate?.authors || []).join(', ')}
          {(analysis?.year || candidate?.year) ? ` (${analysis?.year || candidate?.year})` : ''}
          {analysis?.venue || candidate?.venue ? ` · ${analysis?.venue || candidate?.venue}` : ''}
        </p>
      )}
      {analysis?.relevance && (
        <div className="analysis-subcard" style={{ marginTop: 8 }}>
          <span>Relevance</span>
          <p>{analysis.relevance}</p>
        </div>
      )}
      {analysis?.structure_suggestions?.length > 0 && (
        <div className="analysis-subcard">
          <span>Structure Suggestions</span>
          <ul className="analysis-result-list">
            {analysis.structure_suggestions.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
      {(candidate?.source_url || candidate?.download_url || scholar_search_url) && (
        <div className="analysis-subcard">
          <span>Links</span>
          <div className="analysis-link-list">
            <ResultLink label="Primary source URL" url={candidate?.source_url} />
            <ResultLink label="Download URL" url={candidate?.download_url} />
            <ResultLink label="Google Scholar search" url={scholar_search_url} />
          </div>
        </div>
      )}
      {visibleResults.length > 0 && (
        <div className="analysis-subcard">
          <span>Candidate Results</span>
          <ul className="analysis-result-list">
            {visibleResults.map((item, index) => (
              <li key={`${item.source_url || item.title || 'candidate'}-${index}`}>
                <strong>{item.title || `Candidate ${index + 1}`}</strong>
                {(item.authors?.length > 0 || item.year || item.venue) && (
                  <span className="analysis-inline-note" style={{ display: 'block', marginTop: 2 }}>
                    {(item.authors || []).slice(0, 4).join(', ')}
                    {item.year ? ` (${item.year})` : ''}
                    {item.venue ? ` · ${item.venue}` : ''}
                  </span>
                )}
                <div className="analysis-link-list" style={{ marginTop: 6 }}>
                  <ResultLink label="Source URL" url={item.source_url} />
                  <ResultLink label="Download URL" url={item.download_url} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {analysis?.citation_uses?.length > 0 && (
        <div className="analysis-subcard">
          <span>Citation Uses</span>
          <ul className="analysis-result-list">
            {analysis.citation_uses.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      )}
      {analysis?.literature_review && (
        <div className="analysis-subcard">
          <span>Literature Review Draft</span>
          <p>{analysis.literature_review}</p>
        </div>
      )}
      {result?.output_relative_path && (
        <p className="analysis-inline-note" style={{ marginTop: 8 }}>
          Literature review 已保存到 {result.output_relative_path}
        </p>
      )}
      {analysis?.discussion_points?.length > 0 && (
        <div className="analysis-subcard">
          <span>Discussion Points</span>
          <ul className="analysis-result-list">
            {analysis.discussion_points.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      )}
      {analysis?.import_recommendation && (
        <p className="analysis-inline-note" style={{ marginTop: 8 }}>{analysis.import_recommendation}</p>
      )}
      <p className="analysis-inline-note" style={{ marginTop: 8 }}>
        优先直接提供论文标题、DOI 或 URL。若目前只有主题词，可先点 Google Scholar 搜索，再把具体条目链接发回来。
      </p>
      <div className="analysis-actions" style={{ marginTop: 10 }}>
        <button className="primary" disabled={isBusy || !cache_id} onClick={() => handleImport(false)} type="button">
          导入摘要
        </button>
        {download_available && (
          <button disabled={isBusy || !cache_id} onClick={() => handleImport(true)} type="button">
            下载原文并导入
          </button>
        )}
      </div>
    </div>
  );
}

// ── Chat history bubbles ───────────────────────────────────

function ToolHistoryArea({ messages, isBusy, renderResult }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isBusy]);

  if (messages.length === 0 && !isBusy) return null;

  return (
    <div className="tool-history-area">
      {messages.map((msg) => (
        <div key={msg.id} className={`chat-bubble-row ${msg.role === 'user' ? 'user' : 'assistant'}`}>
          <div className="chat-bubble-avatar">
            {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
          </div>
          <div className="chat-bubble">
            <p className="chat-bubble-content">{msg.content}</p>
            {msg.role === 'assistant' && msg.result && renderResult && (
              <div className="chat-bubble-result">{renderResult(msg)}</div>
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
  );
}

// ── AnalysisWorkspace ────────────────────────────────────

export function AnalysisWorkspace({
  isBusy,
  onRefreshWorkspace,
  onSetBusy,
  onSetMessage,
  outline,
  project,
}) {
  const dataFiles = useMemo(
    () => filesByCategory(project, 'Data').filter((item) => ['csv', 'xlsx', 'xlsm'].includes(item.extension)),
    [project],
  );
  const figureFiles = useMemo(
    () => filesByCategory(project, 'Figures').filter((item) => ['png', 'jpg', 'jpeg', 'svg', 'webp'].includes(item.extension)),
    [project],
  );
  const projectSources = useMemo(
    () => (project?.sources || []).filter((item) => item?.text_file),
    [project],
  );
  const outlineTitles = useMemo(
    () => (outline || []).map((item) => item.title).filter(Boolean),
    [outline],
  );
  const outlinePreview = useMemo(() => outlineTitles.slice(0, 6), [outlineTitles]);

  const [activeTool, setActiveTool] = useState('literature');
  const [selectedDataFile, setSelectedDataFile] = useState('');
  const [briefFormat, setBriefFormat] = useState('ppt');
  const [briefScopeHeading, setBriefScopeHeading] = useState('');
  const [literatureFocus, setLiteratureFocus] = useState(null);
  const [selectedLiteratureSource, setSelectedLiteratureSource] = useState('');

  const [toolInput, setToolInput] = useState({ literature: '', data: '', mindmap: '', brief: '' });

  const [chatHistories, setChatHistories] = useState({
    literature: [], data: [], mindmap: [], brief: [],
  });
  const [chatBusy, setChatBusy] = useState('');
  const anyChatBusy = chatBusy !== '';

  const [sidebarWidth, setSidebarWidth] = useState(300);
  const dragRef = useRef({ active: false, startX: 0, startWidth: 0 });

  useEffect(() => {
    Promise.all(TOOLS.map((tool) => chatApi.load(tool).then((data) => ({ tool, history: data.history || [] }))))
      .then((results) => {
        const histories = {};
        for (const { tool, history } of results) histories[tool] = history;
        setChatHistories(histories);
      })
      .catch(() => {});
  }, [project?.workspace]);

  useEffect(() => {
    if (literatureFocus?.text_file) return;
    const history = chatHistories.literature || [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const item = history[index];
      const focus = item?.result?.source_focus || item?.context || null;
      if (focus?.text_file) {
        setLiteratureFocus({
          cache_id: focus.cache_id || '',
          filename: focus.filename || '',
          text_file: focus.text_file || '',
          title: focus.title || '',
          downloaded_original: Boolean(focus.downloaded_original),
        });
        return;
      }
    }
  }, [chatHistories.literature, literatureFocus]);

  useEffect(() => {
    if (literatureFocus?.text_file && projectSources.some((item) => item.text_file === literatureFocus.text_file)) {
      setSelectedLiteratureSource(literatureFocus.text_file);
      return;
    }
    if (selectedLiteratureSource && projectSources.some((item) => item.text_file === selectedLiteratureSource)) return;
    setSelectedLiteratureSource(projectSources[0]?.text_file || '');
  }, [projectSources, selectedLiteratureSource, literatureFocus?.text_file]);

  useEffect(() => {
    if (!selectedDataFile && dataFiles[0]) {
      setSelectedDataFile(dataFiles[0].relative_path);
      return;
    }
    if (selectedDataFile && dataFiles.some((item) => item.relative_path === selectedDataFile)) return;
    setSelectedDataFile(dataFiles[0]?.relative_path || '');
  }, [dataFiles, selectedDataFile]);

  useEffect(() => {
    function onMouseMove(event) {
      if (!dragRef.current.active) return;
      const delta = event.clientX - dragRef.current.startX;
      setSidebarWidth(Math.max(180, Math.min(520, dragRef.current.startWidth + delta)));
    }
    function onMouseUp() { dragRef.current.active = false; }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  function startResize(event) {
    dragRef.current = { active: true, startX: event.clientX, startWidth: sidebarWidth };
    event.preventDefault();
  }

  function buildToolContext(tool, overrideLiteratureFocus = null) {
    if (tool === 'data') return { relative_path: selectedDataFile };
    if (tool === 'brief') return { format: briefFormat, scope_heading: briefScopeHeading };
    if (tool === 'literature' && overrideLiteratureFocus?.text_file) return { ...overrideLiteratureFocus };
    if (tool === 'literature' && literatureFocus?.text_file) return { ...literatureFocus };
    return {};
  }

  async function handleSend(tool, options = {}) {
    const previousInput = toolInput[tool];
    const message = String(options.message ?? previousInput).trim();
    if (!message || chatBusy) return;
    const context = options.context || buildToolContext(tool);
    const shouldClearInput = options.clearInput !== false;

    setChatBusy(tool);
    if (shouldClearInput) {
      setToolInput((prev) => ({ ...prev, [tool]: '' }));
    }

    const optimisticUser = {
      id: `optimistic-${Date.now()}`,
      role: 'user',
      timestamp: new Date().toISOString().slice(0, 19),
      content: message,
      context,
    };
    setChatHistories((prev) => ({
      ...prev,
      [tool]: [...prev[tool], optimisticUser],
    }));

    try {
      const history = chatHistories[tool];
      const data = await chatApi.send(tool, message, history, context);
      const assistantMsg = data.message;
      setChatHistories((prev) => ({
        ...prev,
        [tool]: [...prev[tool].filter((m) => m.id !== optimisticUser.id), optimisticUser, assistantMsg],
      }));
      await onRefreshWorkspace();
    } catch (error) {
      setChatHistories((prev) => ({
        ...prev,
        [tool]: prev[tool].filter((m) => m.id !== optimisticUser.id),
      }));
      if (shouldClearInput) {
        setToolInput((prev) => ({ ...prev, [tool]: previousInput || message }));
      }
      onSetMessage(error.message);
    } finally {
      setChatBusy('');
    }
  }

  async function handleClear(tool) {
    try {
      await chatApi.clear(tool);
      setChatHistories((prev) => ({ ...prev, [tool]: [] }));
      if (tool === 'literature') {
        setLiteratureFocus(null);
      }
    } catch (error) {
      onSetMessage(error.message);
    }
  }

  function handleKeyDown(tool, event) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      handleSend(tool);
    }
  }

  const selectedSourceEntry = useMemo(
    () => projectSources.find((item) => item.text_file === selectedLiteratureSource) || null,
    [projectSources, selectedLiteratureSource],
  );

  function activateLiteratureSource(source, options = {}) {
    if (!source?.text_file) {
      onSetMessage('请先选择一个项目资料。');
      return;
    }
    const nextFocus = buildLiteratureFocus(source);
    setLiteratureFocus(nextFocus);
    setSelectedLiteratureSource(nextFocus.text_file);
    setActiveTool('literature');
    if (options.announce !== false) {
      onSetMessage(`已将「${nextFocus.title}」设为当前文献焦点。`);
    }
  }

  function handleUseSelectedLiteratureSource() {
    if (!selectedSourceEntry) {
      onSetMessage('请先选择一个项目资料。');
      return;
    }
    activateLiteratureSource(selectedSourceEntry);
  }

  async function handleAnalyzeSelectedLiteratureSource() {
    if (!selectedSourceEntry) {
      onSetMessage('请先选择一个项目资料。');
      return;
    }
    const nextFocus = buildLiteratureFocus(selectedSourceEntry);
    activateLiteratureSource(selectedSourceEntry, { announce: false });
    await handleSend('literature', {
      message: defaultLiteratureSourcePrompt(),
      context: nextFocus,
      clearInput: false,
    });
  }

  const activeManuscriptName = project?.active_manuscript?.split('/').pop() || 'No manuscript';

  const toolOptions = [
    { id: 'literature', label: 'Literature', hint: '项目资料 / 标题 / DOI / URL', icon: BookText },
    { id: 'data', label: 'Data Analysis', hint: '图表生成 + 文中插入', icon: Database },
    { id: 'mindmap', label: 'Mindmap', hint: 'Mermaid 理论图谱', icon: Sparkles },
    { id: 'brief', label: 'PPT / Poster Brief', hint: '展示摘要 + key messages', icon: FileText },
  ];

  function makeRenderResult(tool) {
    return (msg) => {
      if (tool === 'mindmap') return <MindmapResult msg={msg} />;
      if (tool === 'brief') return <BriefResult msg={msg} />;
      if (tool === 'data') return (
        <DataResult
          isBusy={isBusy || chatBusy === 'data'}
          msg={msg}
          onRefreshWorkspace={onRefreshWorkspace}
          onSetBusy={onSetBusy}
          onSetMessage={onSetMessage}
          outlineTitles={outlineTitles}
        />
      );
      if (tool === 'literature') return (
        <LiteratureResult
          isBusy={isBusy || chatBusy === 'literature'}
          msg={msg}
          onActivateFocus={setLiteratureFocus}
          onRefreshWorkspace={onRefreshWorkspace}
          onSetBusy={onSetBusy}
          onSetMessage={onSetMessage}
        />
      );
      return null;
    };
  }

  const toolConfig = {
    literature: {
      placeholder: literatureFocus?.text_file
        ? `当前正围绕「${literatureFocus.title || literatureFocus.filename}」讨论。可以继续追问文章内容，或清除焦点后改用标题、DOI、URL、主题词。`
        : '可以先从项目资料里选择 source，也可以直接输入论文标题、DOI、URL 或主题词。',
      label: '文献查找 / 分析',
    },
    data: {
      placeholder: '描述希望生成什么图表，或对上一张图的修改意见...',
      label: '数据分析',
    },
    mindmap: {
      placeholder: '描述理论框架、概念关系或想要可视化的结构...',
      label: '思维导图',
    },
    brief: {
      placeholder: '补充说明，或对上一版 brief 的修改意见（可留空直接生成）...',
      label: '展示摘要',
    },
  };

  return (
    <section className="analysis-shell" style={{ '--sidebar-w': `${sidebarWidth}px` }}>
      <aside className="analysis-sidebar">
        <section className="analysis-sidebar-card">
          <div className="panel-heading compact">
            <FileText size={16} />
            <span>Current Manuscript</span>
          </div>
          <strong>{activeManuscriptName}</strong>
          <p>{outlineTitles.length > 0 ? '标题可用作图表位置、brief scope 或 mindmap 锚点。' : '当前文稿还没有可识别的标题。'}</p>
          {outlinePreview.length > 0 ? (
            <div className="analysis-outline-preview">
              {outlinePreview.map((title, i) => <span key={`${title}-${i}`}>{title}</span>)}
            </div>
          ) : (
            <p className="empty-line">No outline detected</p>
          )}
          {outlineTitles.length > outlinePreview.length && (
            <p>+ {outlineTitles.length - outlinePreview.length} more sections</p>
          )}
        </section>

        <section className="analysis-sidebar-card">
          <div className="panel-heading compact">
            <BookText size={16} />
            <span>Sources</span>
          </div>
          {projectSources.length > 0 ? (
            <div className="analysis-file-picker">
              {projectSources.map((source) => {
                const isActive = literatureFocus?.text_file === source.text_file;
                return (
                  <button
                    className={`analysis-file-button ${isActive ? 'active' : ''}`}
                    disabled={anyChatBusy}
                    key={source.text_file}
                    onClick={() => activateLiteratureSource(source)}
                    type="button"
                  >
                    <strong>{literatureSourceTitle(source)}</strong>
                    <span>{source.downloaded_original ? 'Original imported' : 'Extracted text available'}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="empty-line">No imported sources yet.</p>
          )}
        </section>

        <section className="analysis-sidebar-card">
          <div className="panel-heading compact">
            <Database size={16} />
            <span>Data Files</span>
          </div>
          {dataFiles.length > 0 ? (
            <div className="analysis-file-picker">
              {dataFiles.map((file) => (
                <button
                  className={`analysis-file-button ${selectedDataFile === file.relative_path ? 'active' : ''}`}
                  disabled={isBusy || chatBusy === 'data'}
                  key={file.relative_path}
                  onClick={() => setSelectedDataFile(file.relative_path)}
                  type="button"
                >
                  <strong>{file.name}</strong>
                  <span>{file.size_label}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="empty-line">Import a CSV or Excel file first.</p>
          )}
        </section>

        <section className="analysis-sidebar-card">
          <div className="panel-heading compact">
            <Image size={16} />
            <span>Generated Figures</span>
          </div>
          {figureFiles.length === 0
            ? <p className="empty-line">No figures yet</p>
            : figureFiles.map((f) => (
              <div className="analysis-sidebar-item" key={f.relative_path}>
                <strong>{f.name}</strong>
                <span>{f.size_label}</span>
              </div>
            ))
          }
        </section>
      </aside>

      <div className="analysis-resize-handle" onMouseDown={startResize} />

      <section className="analysis-main">
        <div className="analysis-tool-switcher">
          {toolOptions.map((tool) => {
            const Icon = tool.icon;
            return (
              <button
                className={activeTool === tool.id ? 'active' : ''}
                key={tool.id}
                onClick={() => setActiveTool(tool.id)}
                type="button"
              >
                <div className="analysis-tool-icon"><Icon size={16} /></div>
                <div className="analysis-tool-copy">
                  <strong>{tool.label}</strong>
                  <small>{chatBusy === tool.id ? `${tool.hint} · AI 思考中` : tool.hint}</small>
                </div>
              </button>
            );
          })}
        </div>

        <div className="analysis-chat-area">
          {toolOptions.map((tool) => {
            const cfg = toolConfig[tool.id];
            const messages = chatHistories[tool.id];
            const busy = chatBusy === tool.id;
            const inputVal = toolInput[tool.id];

            return (
              <div
                className="tool-panel"
                key={tool.id}
                style={{ display: activeTool === tool.id ? 'flex' : 'none' }}
              >
                {/* Chat history (hidden when empty) */}
                <ToolHistoryArea
                  isBusy={busy}
                  messages={messages}
                  renderResult={makeRenderResult(tool.id)}
                />

                {/* Form area */}
                <div className="tool-form-area">
                  <div className="tool-form-top-row">
                    <span className="tool-form-label">{cfg.label}</span>
                    {messages.length > 0 && (
                      <button
                        className="chat-clear-btn"
                        disabled={anyChatBusy}
                        onClick={() => handleClear(tool.id)}
                        type="button"
                      >
                        <Trash2 size={13} />
                        清空对话
                      </button>
                    )}
                  </div>

                  {tool.id === 'literature' && (
                    <div className="analysis-subcard">
                      <span>Start From Project Source</span>
                      {projectSources.length > 0 ? (
                        <>
                          <div className="tool-form-controls">
                            <select
                              disabled={anyChatBusy}
                              onChange={(e) => setSelectedLiteratureSource(e.target.value)}
                              value={selectedLiteratureSource}
                            >
                              {projectSources.map((source) => (
                                <option key={source.text_file} value={source.text_file}>
                                  {literatureSourceOptionLabel(source)}
                                </option>
                              ))}
                            </select>
                            <button disabled={anyChatBusy || !selectedSourceEntry} onClick={handleUseSelectedLiteratureSource} type="button">
                              设为焦点
                            </button>
                            <button className="primary" disabled={anyChatBusy || !selectedSourceEntry} onClick={handleAnalyzeSelectedLiteratureSource} type="button">
                              快速分析
                            </button>
                          </div>
                          <p className="analysis-inline-note">也可以不选项目资料，直接在下方输入论文标题、DOI、URL 或检索提示。</p>
                        </>
                      ) : (
                        <p className="empty-line">先导入 PDF / DOCX 等资料，或直接在下方输入论文标题、DOI、URL。</p>
                      )}
                    </div>
                  )}

                  {tool.id === 'literature' && literatureFocus?.text_file && (
                    <div className="analysis-subcard">
                      <span>Current Source Focus</span>
                      <p>{literatureFocus.title || literatureFocus.filename}</p>
                      <div className="analysis-actions">
                        <span>{literatureFocus.downloaded_original ? '已下载原文，可继续讨论全文并生成 literature review。' : '当前基于已导入文本摘要进行讨论。'}</span>
                        <button onClick={() => setLiteratureFocus(null)} type="button">清除焦点</button>
                      </div>
                    </div>
                  )}

                  {/* Tool-specific selectors */}
                  {tool.id === 'data' && (
                    <div className="tool-form-controls">
                      <select
                        disabled={isBusy || chatBusy === 'data' || dataFiles.length === 0}
                        onChange={(e) => setSelectedDataFile(e.target.value)}
                        value={selectedDataFile}
                      >
                        {dataFiles.length === 0 && <option value="">No data files</option>}
                        {dataFiles.map((f) => <option key={f.relative_path} value={f.relative_path}>{f.name}</option>)}
                      </select>
                    </div>
                  )}

                  {tool.id === 'brief' && (
                    <div className="tool-form-controls">
                      <select
                        disabled={busy}
                        onChange={(e) => setBriefFormat(e.target.value)}
                        value={briefFormat}
                      >
                        <option value="ppt">PPT</option>
                        <option value="poster">Poster</option>
                        <option value="summary">Article Summary</option>
                        <option value="custom">Custom</option>
                      </select>
                      <select
                        disabled={busy}
                        onChange={(e) => setBriefScopeHeading(e.target.value)}
                        value={briefScopeHeading}
                      >
                        <option value="">Whole Manuscript</option>
                        {outlineTitles.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  )}

                  {/* Prompt input */}
                  <div className="tool-form-input-row">
                    <textarea
                      className="chat-input"
                      disabled={busy}
                      onChange={(e) => setToolInput((prev) => ({ ...prev, [tool.id]: e.target.value }))}
                      onKeyDown={(e) => handleKeyDown(tool.id, e)}
                      placeholder={cfg.placeholder}
                      rows={3}
                      value={inputVal}
                    />
                    <button
                      className="primary chat-send-btn"
                      disabled={anyChatBusy || !inputVal.trim()}
                      onClick={() => handleSend(tool.id)}
                      title="发送 (Cmd+Enter)"
                      type="button"
                    >
                      {busy ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </section>
  );
}

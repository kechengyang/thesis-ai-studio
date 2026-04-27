import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookText, Database, FileText, Image, Sparkles } from 'lucide-react';

import { buildProjectFileUrl, chatApi, studioApi } from '../api';
import { ChatPanel } from './ChatPanel';
import { FilePreview } from './FilePreview';
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
      <div className="analysis-figure-frame">
        <img
          alt={result.figure_alt_text || result.figure_title}
          className="analysis-figure-preview"
          src={buildProjectFileUrl(result.figure_relative_path)}
        />
      </div>
      {result.key_points?.length > 0 && (
        <div className="analysis-subcard" style={{ marginTop: 8 }}>
          <span>Key Points</span>
          <ul className="analysis-result-list">
            {result.key_points.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </div>
      )}
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

function LiteratureResult({ msg, onRefreshWorkspace, onSetMessage, isBusy, onSetBusy }) {
  const { result } = msg;
  if (!result) return null;
  const { analysis, cache_id, download_available } = result;

  async function handleImport(downloadOriginal) {
    onSetBusy(downloadOriginal ? 'literature-download' : 'literature-import');
    try {
      const data = await studioApi.importLiterature(cache_id, downloadOriginal);
      await onRefreshWorkspace();
      onSetMessage(downloadOriginal ? `已下载并导入：${data.source.filename}` : `已导入文献摘要：${data.source.filename}`);
    } catch (error) {
      onSetMessage(error.message);
    } finally {
      onSetBusy('');
    }
  }

  return (
    <div>
      {analysis?.title && <strong style={{ display: 'block', marginBottom: 4 }}>{analysis.title}</strong>}
      {(analysis?.authors?.length > 0 || analysis?.year) && (
        <p className="analysis-meta">{analysis.authors?.join(', ')}{analysis.year ? ` (${analysis.year})` : ''}</p>
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
      {analysis?.import_recommendation && (
        <p className="analysis-inline-note" style={{ marginTop: 8 }}>{analysis.import_recommendation}</p>
      )}
      <div className="analysis-actions" style={{ marginTop: 10 }}>
        <button className="primary" disabled={isBusy || !cache_id} onClick={() => handleImport(false)} type="button">
          导入摘要
        </button>
        {download_available && (
          <button disabled={isBusy || !cache_id} onClick={() => handleImport(true)} type="button">
            下载原文
          </button>
        )}
      </div>
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
  const outlineTitles = useMemo(
    () => (outline || []).map((item) => item.title).filter(Boolean),
    [outline],
  );
  const outlinePreview = useMemo(() => outlineTitles.slice(0, 6), [outlineTitles]);

  const [activeTool, setActiveTool] = useState('literature');
  const [selectedDataFile, setSelectedDataFile] = useState('');
  const [briefFormat, setBriefFormat] = useState('ppt');
  const [briefScopeHeading, setBriefScopeHeading] = useState('');
  const [inlinePreviewFile, setInlinePreviewFile] = useState(null);

  const [chatHistories, setChatHistories] = useState({
    literature: [], data: [], mindmap: [], brief: [],
  });
  const [chatBusy, setChatBusy] = useState('');

  const [sidebarWidth, setSidebarWidth] = useState(300);
  const dragRef = useRef({ active: false, startX: 0, startWidth: 0 });

  // Load all chat histories on mount or project switch
  useEffect(() => {
    Promise.all(TOOLS.map((tool) => chatApi.load(tool).then((data) => ({ tool, history: data.history || [] }))))
      .then((results) => {
        const histories = {};
        for (const { tool, history } of results) histories[tool] = history;
        setChatHistories(histories);
      })
      .catch(() => {});
  }, [project?.workspace]);

  // Keep selected data file in sync
  useEffect(() => {
    if (!selectedDataFile && dataFiles[0]) {
      setSelectedDataFile(dataFiles[0].relative_path);
      return;
    }
    if (selectedDataFile && dataFiles.some((item) => item.relative_path === selectedDataFile)) return;
    setSelectedDataFile(dataFiles[0]?.relative_path || '');
  }, [dataFiles, selectedDataFile]);

  useEffect(() => {
    if (!selectedDataFile) { setInlinePreviewFile(null); return; }
    const found = dataFiles.find((f) => f.relative_path === selectedDataFile);
    setInlinePreviewFile(found || null);
  }, [selectedDataFile, dataFiles]);

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

  async function handleSend(tool, message) {
    const context = tool === 'data'
      ? { relative_path: selectedDataFile }
      : tool === 'brief'
      ? { format: briefFormat, scope_heading: briefScopeHeading }
      : {};

    setChatBusy(tool);
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
      onSetMessage('AI 回复已生成。');
    } catch (error) {
      setChatHistories((prev) => ({
        ...prev,
        [tool]: prev[tool].filter((m) => m.id !== optimisticUser.id),
      }));
      onSetMessage(error.message);
    } finally {
      setChatBusy('');
    }
  }

  async function handleClear(tool) {
    try {
      await chatApi.clear(tool);
      setChatHistories((prev) => ({ ...prev, [tool]: [] }));
      onSetMessage(`${tool} 对话已清空。`);
    } catch (error) {
      onSetMessage(error.message);
    }
  }

  const activeManuscriptName = project?.active_manuscript?.split('/').pop() || 'No manuscript';

  const toolOptions = [
    { id: 'literature', label: 'Literature', hint: '资料检索 + 结构判断', icon: BookText },
    { id: 'data', label: 'Data Analysis', hint: '图表生成 + 文中插入', icon: Database },
    { id: 'mindmap', label: 'Mindmap', hint: 'Mermaid 理论图谱', icon: Sparkles },
    { id: 'brief', label: 'PPT / Poster Brief', hint: '展示摘要 + key messages', icon: FileText },
  ];

  function renderResult(tool) {
    return (msg) => {
      if (tool === 'mindmap') return <MindmapResult msg={msg} />;
      if (tool === 'brief') return <BriefResult msg={msg} />;
      if (tool === 'data') return (
        <DataResult
          msg={msg}
          outlineTitles={outlineTitles}
          onRefreshWorkspace={onRefreshWorkspace}
          onSetMessage={onSetMessage}
          isBusy={isBusy || chatBusy === 'data'}
          onSetBusy={onSetBusy}
        />
      );
      if (tool === 'literature') return (
        <LiteratureResult
          msg={msg}
          onRefreshWorkspace={onRefreshWorkspace}
          onSetMessage={onSetMessage}
          isBusy={isBusy || chatBusy === 'literature'}
          onSetBusy={onSetBusy}
        />
      );
      return null;
    };
  }

  function contextSlot(tool) {
    if (tool === 'data') return (
      <>
        <select
          disabled={isBusy || chatBusy === 'data' || dataFiles.length === 0}
          onChange={(e) => setSelectedDataFile(e.target.value)}
          value={selectedDataFile}
          style={{ flex: 1 }}
        >
          {dataFiles.length === 0 && <option value="">No data files</option>}
          {dataFiles.map((f) => <option key={f.relative_path} value={f.relative_path}>{f.name}</option>)}
        </select>
        {inlinePreviewFile && <FilePreview compact file={inlinePreviewFile} />}
      </>
    );
    if (tool === 'brief') return (
      <>
        <select
          disabled={isBusy || chatBusy === 'brief'}
          onChange={(e) => setBriefFormat(e.target.value)}
          value={briefFormat}
        >
          <option value="ppt">PPT</option>
          <option value="poster">Poster</option>
          <option value="summary">Article Summary</option>
          <option value="custom">Custom</option>
        </select>
        <select
          disabled={isBusy || chatBusy === 'brief'}
          onChange={(e) => setBriefScopeHeading(e.target.value)}
          value={briefScopeHeading}
        >
          <option value="">Whole Manuscript</option>
          {outlineTitles.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </>
    );
    return null;
  }

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
            <Database size={16} />
            <span>Data Files</span>
          </div>
          {dataFiles.length > 0 ? (
            <div className="analysis-file-picker">
              {dataFiles.map((file) => (
                <button
                  className={`analysis-file-button ${selectedDataFile === file.relative_path ? 'active' : ''}`}
                  disabled={isBusy || chatBusy !== ''}
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
                disabled={isBusy || (chatBusy !== '' && chatBusy !== tool.id)}
                key={tool.id}
                onClick={() => setActiveTool(tool.id)}
                type="button"
              >
                <div className="analysis-tool-icon"><Icon size={16} /></div>
                <div className="analysis-tool-copy">
                  <strong>{tool.label}</strong>
                  <small>{tool.hint}</small>
                </div>
              </button>
            );
          })}
        </div>

        <div className="analysis-chat-area">
          {toolOptions.map((tool) => (
            <div
              key={tool.id}
              style={{ display: activeTool === tool.id ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}
            >
              <ChatPanel
                tool={tool.id}
                messages={chatHistories[tool.id]}
                isBusy={chatBusy === tool.id}
                onSend={(message) => handleSend(tool.id, message)}
                onClear={() => handleClear(tool.id)}
                contextSlot={contextSlot(tool.id)}
                renderResult={renderResult(tool.id)}
              />
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

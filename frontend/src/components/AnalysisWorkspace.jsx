import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookText, Database, FileText, Image, Sparkles } from 'lucide-react';

import { buildProjectFileUrl, studioApi } from '../api';
import { FilePreview } from './FilePreview';
import { LiteraturePanel } from './LiteraturePanel';
import { MermaidPreview } from './MermaidPreview';

function filesByCategory(project, category) {
  const match = (project?.files || []).find((item) => item.category === category);
  return match?.files || [];
}

function compactLine(value, fallback = 'Not available') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text;
}

function baseName(relativePath) {
  return relativePath ? relativePath.split('/').pop() : '';
}

function PreviewList({ items }) {
  if (!items?.length) return <p className="empty-line">No items yet</p>;
  return (
    <div className="analysis-sidebar-list">
      {items.map((item) => (
        <div className="analysis-sidebar-item" key={item.relative_path || item.name}>
          <strong>{item.name}</strong>
          <span>{item.size_label}</span>
        </div>
      ))}
    </div>
  );
}

function AnalysisPlaceholder({ title, copy }) {
  return (
    <div className="analysis-placeholder">
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  );
}

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
  const [dataPrompt, setDataPrompt] = useState('');
  const [dataResult, setDataResult] = useState(null);
  const [insertForm, setInsertForm] = useState({
    figure_title: '',
    figure_caption: '',
    figure_alt_text: '',
    section_title: '',
    introduction: '',
  });

  const [mindmapPrompt, setMindmapPrompt] = useState('');
  const [mindmapResult, setMindmapResult] = useState(null);

  const [briefPrompt, setBriefPrompt] = useState('');
  const [briefFormat, setBriefFormat] = useState('ppt');
  const [briefScopeHeading, setBriefScopeHeading] = useState('');
  const [briefResult, setBriefResult] = useState(null);

  const [literatureQuery, setLiteratureQuery] = useState('');
  const [literatureResult, setLiteratureResult] = useState(null);

  const [inlinePreviewFile, setInlinePreviewFile] = useState(null);

  const [sidebarWidth, setSidebarWidth] = useState(300);
  const dragRef = useRef({ active: false, startX: 0, startWidth: 0 });

  useEffect(() => {
    function onMouseMove(event) {
      if (!dragRef.current.active) return;
      const delta = event.clientX - dragRef.current.startX;
      setSidebarWidth(Math.max(180, Math.min(520, dragRef.current.startWidth + delta)));
    }
    function onMouseUp() {
      dragRef.current.active = false;
    }
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

  useEffect(() => {
    if (!selectedDataFile && dataFiles[0]) {
      setSelectedDataFile(dataFiles[0].relative_path);
      return;
    }
    if (selectedDataFile && dataFiles.some((item) => item.relative_path === selectedDataFile)) {
      return;
    }
    setSelectedDataFile(dataFiles[0]?.relative_path || '');
  }, [dataFiles, selectedDataFile]);

  useEffect(() => {
    if (!selectedDataFile) {
      setInlinePreviewFile(null);
      return;
    }
    const found = dataFiles.find((f) => f.relative_path === selectedDataFile);
    setInlinePreviewFile(found || null);
  }, [selectedDataFile, dataFiles]);

  useEffect(() => {
    const analysis = dataResult?.analysis || null;
    if (!analysis) return;
    setInsertForm({
      figure_title: analysis.figure_title || '',
      figure_caption: analysis.figure_caption || '',
      figure_alt_text: analysis.figure_alt_text || '',
      section_title: analysis.suggested_section || '',
      introduction: analysis.insert_paragraph || '',
    });
  }, [dataResult]);

  async function handleAnalyzeData() {
    if (!selectedDataFile || !dataPrompt.trim()) return;
    onSetBusy('analysis-data');
    setDataResult(null);
    try {
      const data = await studioApi.analyzeData(selectedDataFile, dataPrompt);
      setDataResult(data);
      await onRefreshWorkspace();
      onSetMessage('数据分析已完成，图表已保存到 figures。');
    } catch (error) {
      onSetMessage(error.message);
    } finally {
      onSetBusy('');
    }
  }

  async function handleAnalyzeLiterature() {
    if (!literatureQuery.trim()) return;
    onSetBusy('literature-analyze');
    setLiteratureResult(null);
    try {
      const data = await studioApi.analyzeLiterature(literatureQuery);
      setLiteratureResult(data);
      onSetMessage('资料分析已完成。');
    } catch (error) {
      onSetMessage(error.message);
    } finally {
      onSetBusy('');
    }
  }

  async function handleImportLiterature(downloadOriginal) {
    if (!literatureResult?.cache_id) return;
    onSetBusy(downloadOriginal ? 'literature-download' : 'literature-import');
    try {
      const data = await studioApi.importLiterature(literatureResult.cache_id, downloadOriginal);
      await onRefreshWorkspace();
      onSetMessage(downloadOriginal ? `已下载并导入：${data.source.filename}` : `已导入文献摘要：${data.source.filename}`);
    } catch (error) {
      onSetMessage(error.message);
    } finally {
      onSetBusy('');
    }
  }

  async function handleInsertFigure() {
    const analysis = dataResult?.analysis || null;
    if (!analysis?.figure_relative_path) return;
    onSetBusy('analysis-insert');
    try {
      await studioApi.insertDataFigure({
        figure_relative_path: analysis.figure_relative_path,
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

  async function handleCreateMindmap() {
    if (!mindmapPrompt.trim()) return;
    onSetBusy('analysis-mindmap');
    setMindmapResult(null);
    try {
      const data = await studioApi.createMindmap(mindmapPrompt);
      setMindmapResult(data);
      await onRefreshWorkspace();
      onSetMessage('思维导图已生成并保存。');
    } catch (error) {
      onSetMessage(error.message);
    } finally {
      onSetBusy('');
    }
  }

  async function handleCreateBrief() {
    if (!briefPrompt.trim()) return;
    onSetBusy('analysis-brief');
    setBriefResult(null);
    try {
      const data = await studioApi.createBrief({
        prompt: briefPrompt,
        format: briefFormat,
        scope_heading: briefScopeHeading || undefined,
      });
      setBriefResult(data);
      await onRefreshWorkspace();
      onSetMessage('展示摘要已生成并保存。');
    } catch (error) {
      onSetMessage(error.message);
    } finally {
      onSetBusy('');
    }
  }

  const activeManuscriptName = project?.active_manuscript?.split('/').pop() || 'No manuscript';
  const dataAnalysis = dataResult?.analysis || null;
  const mindmap = mindmapResult?.mindmap || null;
  const brief = briefResult?.brief || null;
  const selectedDataFileName = baseName(selectedDataFile) || 'Choose a data file';
  const briefScopeLabel = briefScopeHeading || 'Whole manuscript';
  const toolOptions = [
    {
      id: 'literature',
      label: 'Literature',
      hint: '资料检索 + 结构判断',
      icon: BookText,
      title: 'Literature fit and source capture',
      description: '先判断文献值不值得纳入当前论文结构，再决定是否导入到 sources，避免把分析和收藏混在一起。',
      focus: literatureResult?.analysis?.title || 'Title / DOI / URL lookup',
      supporting: `Current manuscript: ${activeManuscriptName}`,
    },
    {
      id: 'data',
      label: 'Data Analysis',
      hint: '图表生成 + 文中插入',
      icon: Database,
      title: 'Data analysis and figure insertion',
      description: '围绕当前项目数据集生成图表、解释结果，并直接准备标题、caption 和插入段落。',
      focus: selectedDataFileName,
      supporting: `${figureFiles.length} generated figure${figureFiles.length === 1 ? '' : 's'} in project`,
    },
    {
      id: 'mindmap',
      label: 'Mindmap',
      hint: 'Mermaid 理论图谱',
      icon: Sparkles,
      title: 'Theory and framework mapping',
      description: '根据 prompt 和稿件结构生成 Mermaid 思维导图，适合整理理论、框架、变量关系与叙事逻辑。',
      focus: mindmap?.title || `${outlineTitles.length} outline anchors available`,
      supporting: 'Saved as reusable Quarto-ready output',
    },
    {
      id: 'brief',
      label: 'PPT / Poster Brief',
      hint: '展示摘要 + key messages',
      icon: FileText,
      title: 'Presentation-ready briefs',
      description: '把稿件或某个部分压缩成适合 PPT、poster 或 article summary 的要点表达，并保存到 outputs/briefs。',
      focus: brief?.title || briefScopeLabel,
      supporting: `Target format: ${briefFormat.toUpperCase()}`,
    },
  ];
  const activeToolMeta = toolOptions.find((item) => item.id === activeTool) || toolOptions[0];

  return (
    <section className="analysis-shell" style={{ '--sidebar-w': `${sidebarWidth}px` }}>
      <aside className="analysis-sidebar">
        <section className="analysis-sidebar-card">
          <div className="panel-heading compact">
            <FileText size={16} />
            <span>Current Manuscript</span>
          </div>
          <strong>{activeManuscriptName}</strong>
          <p>{outlineTitles.length > 0 ? '下面这些标题可以直接作为图表插入位置、brief scope 或 mindmap 的锚点。' : '当前文稿还没有可识别的标题结构。'}</p>
          {outlinePreview.length > 0 ? (
            <div className="analysis-outline-preview">
              {outlinePreview.map((title, index) => (
                <span key={`${title}-${index}`}>{title}</span>
              ))}
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
                  disabled={isBusy}
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
          <PreviewList items={figureFiles} />
        </section>
      </aside>

      <div className="analysis-resize-handle" onMouseDown={startResize} />

      <section className="analysis-main">
        <header className="analysis-hero">
          <div className="analysis-hero-copy">
            <span className="analysis-eyebrow">{activeToolMeta.label}</span>
            <h2>{activeToolMeta.title}</h2>
          </div>
          <div className="analysis-hero-focus">
            <span>Current focus</span>
            <strong>{activeToolMeta.focus}</strong>
            <p>{activeToolMeta.supporting}</p>
          </div>
        </header>

        <div className="analysis-tool-switcher">
          {toolOptions.map((tool) => {
            const Icon = tool.icon;
            return (
              <button
                className={activeTool === tool.id ? 'active' : ''}
                disabled={isBusy}
                key={tool.id}
                onClick={() => setActiveTool(tool.id)}
                type="button"
              >
                <div className="analysis-tool-icon">
                  <Icon size={16} />
                </div>
                <div className="analysis-tool-copy">
                  <strong>{tool.label}</strong>
                  <small>{tool.hint}</small>
                </div>
              </button>
            );
          })}
        </div>

        {activeTool === 'literature' && (
          <section className="analysis-panel">
            <LiteraturePanel
              isBusy={isBusy}
              literatureQuery={literatureQuery}
              literatureResult={literatureResult}
              onAnalyze={handleAnalyzeLiterature}
              onImport={handleImportLiterature}
              outlineTitles={outlineTitles}
              setLiteratureQuery={setLiteratureQuery}
            />
          </section>
        )}

        {activeTool === 'data' && (
          <section className="analysis-panel">
            <div className="analysis-grid-2">
              <section className="analysis-section-card">
                <div className="analysis-section-head">
                  <span>Prompt</span>
                  <strong>{selectedDataFileName}</strong>
                </div>
                <div className="analysis-form-row">
                  <select
                    disabled={isBusy || dataFiles.length === 0}
                    onChange={(event) => setSelectedDataFile(event.target.value)}
                    value={selectedDataFile}
                  >
                    {dataFiles.map((file) => (
                      <option key={file.relative_path} value={file.relative_path}>
                        {file.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="primary"
                    disabled={isBusy || !selectedDataFile || !dataPrompt.trim()}
                    onClick={handleAnalyzeData}
                    type="button"
                  >
                    分析并绘图
                  </button>
                </div>
                {inlinePreviewFile && (
                  <FilePreview compact file={inlinePreviewFile} />
                )}
                <textarea
                  className="analysis-prompt"
                  onChange={(event) => setDataPrompt(event.target.value)}
                  placeholder="例如：比较不同国家合作类型的分布，并生成一张适合放在 Results 部分的图。"
                  value={dataPrompt}
                />
                <p className="analysis-inline-note">建议在 prompt 里明确变量、比较维度、预期图形，以及你想放进文稿的章节位置。</p>

                {dataAnalysis ? (
                  <div className="analysis-result-card">
                    <strong>{dataAnalysis.figure_title}</strong>
                    <p className="analysis-meta">
                      {dataAnalysis.data_file} · {dataAnalysis.chart_type} · {dataAnalysis.aggregation}
                    </p>
                    <p>{dataAnalysis.summary}</p>
                    {dataAnalysis.key_points?.length > 0 && (
                      <div className="analysis-subcard">
                        <span>Key Points</span>
                        <ul className="analysis-result-list">
                          {dataAnalysis.key_points.map((item, index) => <li key={index}>{item}</li>)}
                        </ul>
                      </div>
                    )}
                    {dataAnalysis.execution_notes?.length > 0 && (
                      <div className="analysis-subcard">
                        <span>Execution Notes</span>
                        <ul className="analysis-result-list">
                          {dataAnalysis.execution_notes.map((item, index) => <li key={index}>{item}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : (
                  <AnalysisPlaceholder
                    title="Run analysis"
                    copy="完成后这里会生成图表摘要、关键发现和执行说明，方便你先判断是否值得插入文稿。"
                  />
                )}
              </section>

              <section className="analysis-section-card">
                <div className="analysis-section-head">
                  <span>Figure and insertion</span>
                  <strong>{dataAnalysis ? 'Ready to place' : 'Awaiting output'}</strong>
                </div>
                {dataAnalysis ? (
                  <>
                    <div className="analysis-figure-frame">
                      <img
                        alt={dataAnalysis.figure_alt_text || dataAnalysis.figure_title}
                        className="analysis-figure-preview"
                        src={buildProjectFileUrl(dataAnalysis.figure_relative_path)}
                      />
                    </div>
                    <div className="analysis-subcard analysis-insert-card">
                      <span>Insertion Draft</span>
                      <div className="analysis-insert-grid">
                        <label>
                          插入位置
                          <input
                            list="analysis-section-options"
                            onChange={(event) => setInsertForm((current) => ({ ...current, section_title: event.target.value }))}
                            value={insertForm.section_title}
                          />
                          <datalist id="analysis-section-options">
                            {outlineTitles.map((title) => <option key={title} value={title} />)}
                          </datalist>
                        </label>
                        <label>
                          图表标题
                          <input
                            onChange={(event) => setInsertForm((current) => ({ ...current, figure_title: event.target.value }))}
                            value={insertForm.figure_title}
                          />
                        </label>
                        <label className="analysis-span-2">
                          Caption
                          <textarea
                            onChange={(event) => setInsertForm((current) => ({ ...current, figure_caption: event.target.value }))}
                            value={insertForm.figure_caption}
                          />
                        </label>
                        <label className="analysis-span-2">
                          引入段落
                          <textarea
                            onChange={(event) => setInsertForm((current) => ({ ...current, introduction: event.target.value }))}
                            value={insertForm.introduction}
                          />
                        </label>
                        <label className="analysis-span-2">
                          Alt Text
                          <input
                            onChange={(event) => setInsertForm((current) => ({ ...current, figure_alt_text: event.target.value }))}
                            value={insertForm.figure_alt_text}
                          />
                        </label>
                      </div>
                      <div className="analysis-actions">
                        <button className="primary" disabled={isBusy} onClick={handleInsertFigure} type="button">
                          插入到当前文稿
                        </button>
                        <span>{dataAnalysis.figure_relative_path}</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <AnalysisPlaceholder
                    title="Preview will appear here"
                    copy="图表会保存在 figures，同时自动生成标题、caption、alt text 和插入段落草稿。"
                  />
                )}
              </section>
            </div>
          </section>
        )}

        {activeTool === 'mindmap' && (
          <section className="analysis-panel">
            <div className="analysis-grid-2">
              <section className="analysis-section-card">
                <div className="analysis-section-head">
                  <span>Prompt</span>
                  <strong>{outlineTitles.length > 0 ? `${outlineTitles.length} outline anchors available` : 'Theory / framework prompt'}</strong>
                </div>
                <textarea
                  className="analysis-prompt"
                  onChange={(event) => setMindmapPrompt(event.target.value)}
                  placeholder="例如：围绕 African higher education inequality 的理论框架画一张思维导图。"
                  value={mindmapPrompt}
                />
                <div className="analysis-actions">
                  <button className="primary" disabled={isBusy || !mindmapPrompt.trim()} onClick={handleCreateMindmap} type="button">
                    生成思维导图
                  </button>
                </div>
                {outlinePreview.length > 0 && (
                  <>
                    <span className="analysis-inline-label">Available sections</span>
                    <div className="analysis-outline-preview">
                      {outlinePreview.map((title, index) => (
                        <span key={`${title}-${index}`}>{title}</span>
                      ))}
                    </div>
                  </>
                )}
                <p className="analysis-inline-note">可以直接指定理论、framework、变量关系或某个章节，让导图更贴近你的论证结构。</p>
              </section>

              <section className="analysis-section-card">
                <div className="analysis-section-head">
                  <span>Rendered preview</span>
                  <strong>{mindmap?.title || 'Awaiting diagram'}</strong>
                </div>
                {mindmap ? (
                  <div className="analysis-result-card">
                    <p>{mindmap.summary}</p>
                    <div className="analysis-figure-frame">
                      <MermaidPreview code={mindmap.mermaid} />
                    </div>
                    <details className="analysis-code-block">
                      <summary>查看 Mermaid 代码 / Quarto Snippet</summary>
                      <pre>{mindmap.quarto_block}</pre>
                    </details>
                    <div className="analysis-actions">
                      <span>{mindmap.output_relative_path}</span>
                    </div>
                  </div>
                ) : (
                  <AnalysisPlaceholder
                    title="Mindmap preview"
                    copy="生成后这里会渲染 Mermaid 图，并提供可直接放进 qmd 的代码块。"
                  />
                )}
              </section>
            </div>
          </section>
        )}

        {activeTool === 'brief' && (
          <section className="analysis-panel">
            <div className="analysis-grid-2">
              <section className="analysis-section-card">
                <div className="analysis-section-head">
                  <span>Brief setup</span>
                  <strong>{briefScopeLabel}</strong>
                </div>
                <div className="analysis-form-row">
                  <select disabled={isBusy} onChange={(event) => setBriefFormat(event.target.value)} value={briefFormat}>
                    <option value="ppt">PPT</option>
                    <option value="poster">Poster</option>
                    <option value="summary">Article Summary</option>
                    <option value="custom">Custom</option>
                  </select>
                  <select disabled={isBusy} onChange={(event) => setBriefScopeHeading(event.target.value)} value={briefScopeHeading}>
                    <option value="">Whole Manuscript</option>
                    {outlineTitles.map((title) => (
                      <option key={title} value={title}>{title}</option>
                    ))}
                  </select>
                </div>
                <textarea
                  className="analysis-prompt"
                  onChange={(event) => setBriefPrompt(event.target.value)}
                  placeholder="例如：为 poster 生成一个清晰的问题意识、三条核心发现和一个 takeaway。"
                  value={briefPrompt}
                />
                <div className="analysis-actions">
                  <button className="primary" disabled={isBusy || !briefPrompt.trim()} onClick={handleCreateBrief} type="button">
                    生成展示摘要
                  </button>
                </div>
                <p className="analysis-inline-note">适合做 poster、conference PPT、摘要页，或者把单个章节压缩成更有展示性的表达。</p>
              </section>

              <section className="analysis-section-card">
                <div className="analysis-section-head">
                  <span>Output</span>
                  <strong>{brief?.title || 'Awaiting brief'}</strong>
                </div>
                {brief ? (
                  <div className="analysis-result-card">
                    <p className="analysis-meta">{compactLine(brief.target_format)} · {compactLine(brief.focus)}</p>
                    {brief.one_liner && (
                      <div className="analysis-subcard">
                        <span>One-liner</span>
                        <p>{brief.one_liner}</p>
                      </div>
                    )}
                    <p>{brief.summary}</p>
                    {brief.key_messages?.length > 0 && (
                      <div className="analysis-subcard">
                        <span>Key Messages</span>
                        <ul className="analysis-result-list">
                          {brief.key_messages.map((item, index) => <li key={index}>{item}</li>)}
                        </ul>
                      </div>
                    )}
                    {brief.slide_outline?.length > 0 && (
                      <div className="analysis-subcard">
                        <span>Suggested Outline</span>
                        <ul className="analysis-result-list">
                          {brief.slide_outline.map((item, index) => <li key={index}>{item}</li>)}
                        </ul>
                      </div>
                    )}
                    <div className="analysis-actions">
                      <span>{brief.output_relative_path}</span>
                    </div>
                  </div>
                ) : (
                  <AnalysisPlaceholder
                    title="Brief output"
                    copy="生成后这里会展示 one-liner、核心信息和建议结构，适合直接转成展示页。"
                  />
                )}
              </section>
            </div>
          </section>
        )}
      </section>
    </section>
  );
}

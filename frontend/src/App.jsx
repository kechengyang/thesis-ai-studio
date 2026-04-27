import React, { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Bot,
  ChevronDown,
  CircleAlert,
  Database,
  Download,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Sparkles,
  Upload,
} from 'lucide-react';

import { API, request, studioApi } from './api';
import { AnalysisWorkspace } from './components/AnalysisWorkspace';
import { FilePreview } from './components/FilePreview';
import { MemoryPanel } from './components/MemoryPanel';
import { NewManuscriptModal } from './components/NewManuscriptModal';
import { NewProjectModal } from './components/NewProjectModal';
import { QmdPreview } from './components/QmdPreview';
import { SettingsModal } from './components/SettingsModal';
import { SuggestionPanel } from './components/SuggestionPanel';

function estimateWordCount(value) {
  const cleaned = String(value || '')
    .replace(/^---[\s\S]*?---/, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[>#*_=[\]{}()!-]/g, ' ')
    .trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).filter(Boolean).length;
}

function slugifySectionTitle(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[`"'’.:,/()[\]{}!?&]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function splitSections(content) {
  const sections = [];
  const usedAnchors = new Map();
  let position = 0;

  for (const line of content.split('\n')) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (match) {
      const title = match[2].trim();
      const baseAnchor = slugifySectionTitle(title) || `section-${sections.length + 1}`;
      const seen = usedAnchors.get(baseAnchor) || 0;
      usedAnchors.set(baseAnchor, seen + 1);
      sections.push({
        level: match[1].length,
        title,
        anchorId: seen === 0 ? baseAnchor : `${baseAnchor}-${seen + 1}`,
        position,
      });
    }
    position += line.length + 1;
  }

  return sections;
}

function categoryIcon(category) {
  if (category === 'Manuscript') return <BookOpen size={15} />;
  if (category === 'Sources') return <FileText size={15} />;
  if (category === 'Data') return <Database size={15} />;
  if (category === 'Figures') return <Image size={15} />;
  return <Folder size={15} />;
}

export default function App() {
  const editorRef = useRef(null);
  const previewRef = useRef(null);
  const sourceImportRef = useRef(null);
  const fileMenuRef = useRef(null);
  const [project, setProject] = useState(null);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [instruction, setInstruction] = useState('Revise the selected passage into clear, polished academic English while preserving the meaning.');
  const [suggestion, setSuggestion] = useState(null);
  const [suggestionId, setSuggestionId] = useState('');
  const [settings, setSettings] = useState({ provider: 'openai', model: 'gpt-5.5', reasoning: 'medium', instruction: '' });
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [deepseekApiKey, setDeepseekApiKey] = useState('');
  const [deepseekBaseUrl, setDeepseekBaseUrl] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showCreateManuscript, setShowCreateManuscript] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState('manuscript');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [providerCatalog, setProviderCatalog] = useState({ current_provider: 'openai', providers: [] });
  const [activeOutlineId, setActiveOutlineId] = useState('');
  const [previewFile, setPreviewFile] = useState(null);

  async function refreshWorkspace() {
    const [projectData, documentData, providerData] = await Promise.all([
      studioApi.getProject(),
      studioApi.getDocument(),
      studioApi.getProviders(),
    ]);
    setProject(projectData);
    setSettings(projectData.settings);
    setContent(documentData.content);
    setSavedContent(documentData.content);
    setSelectedProjectId(projectData.active_project);
    setProviderCatalog(providerData);
    setDeepseekBaseUrl(projectData.settings.deepseek_base_url || '');
    const nextOutline = splitSections(documentData.content);
    setActiveOutlineId((current) => (
      current && nextOutline.some((item) => item.anchorId === current)
        ? current
        : nextOutline[0]?.anchorId || ''
    ));
  }

  useEffect(() => {
    refreshWorkspace().catch((error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    const provider = providerCatalog.providers?.find((item) => item.id === (settings.provider || 'openai'));
    if (!provider?.models?.length) return;
    if (provider.models.some((item) => item.id === settings.model)) return;
    setSettings((current) => ({ ...current, model: provider.models[0].id }));
  }, [providerCatalog, settings.provider, settings.model]);

  async function refreshMemory() {
    const memory = await studioApi.getMemory();
    setProject((current) => (current ? { ...current, memory } : current));
  }

  function closeFileMenu() {
    if (fileMenuRef.current) {
      fileMenuRef.current.open = false;
    }
  }

  function captureSelection() {
    const editor = editorRef.current;
    if (!editor) return;
    setSelectedText(editor.value.slice(editor.selectionStart, editor.selectionEnd));
  }

  function jumpToEditorPosition(position) {
    const editor = editorRef.current;
    if (!editor) return;
    const safePosition = Math.max(0, Math.min(position, editor.value.length));
    const lineHeight = parseFloat(window.getComputedStyle(editor).lineHeight) || 28;
    const lineNumber = editor.value.slice(0, safePosition).split('\n').length - 1;

    window.requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(safePosition, safePosition);
      editor.scrollTop = Math.max(0, (lineNumber - 2) * lineHeight);
    });
  }

  function jumpToPreviewHeading(anchorId) {
    const container = previewRef.current;
    if (!container || !anchorId) return false;
    const target = container.querySelector(`[data-outline-id="${anchorId}"]`);
    if (!target) return false;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }

  function jumpToOutlineItem(item) {
    if (!item) return;
    setActiveOutlineId(item.anchorId);
    if (showPreview) {
      if (jumpToPreviewHeading(item.anchorId)) {
        setMessage(`已跳转到预览中的 “${item.title}”。`);
        return;
      }
      setMessage(`没有在预览中定位到 “${item.title}”。`);
      return;
    }
    jumpToEditorPosition(item.position);
    setMessage(`已跳转到文稿中的 “${item.title}”。`);
  }

  async function persistCurrentDocument(nextContent = content) {
    await studioApi.saveDocument(nextContent);
    setSavedContent(nextContent);
  }

  async function saveCurrentIfDirty() {
    if (content === savedContent) return false;
    await persistCurrentDocument(content);
    return true;
  }

  async function refresh() {
    setBusy('refresh');
    try {
      await saveCurrentIfDirty();
      await refreshWorkspace();
      setMessage('工作区已刷新。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function switchWorkspaceMode(nextMode) {
    if (nextMode === workspaceMode) return;
    setBusy('workspace-mode');
    try {
      setPreviewFile(null);
      if (nextMode === 'analysis') {
        await saveCurrentIfDirty();
      }
      if (nextMode === 'manuscript') {
        setShowPreview(false);
      }
      await refreshWorkspace();
      setWorkspaceMode(nextMode);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function createProject(name) {
    setBusy('create');
    try {
      await saveCurrentIfDirty();
      await studioApi.createProject(name || 'Thesis Draft');
      setShowPreview(false);
      setSuggestion(null);
      setSuggestionId('');
      setSelectedText('');
      setShowCreateProject(false);
      await refreshWorkspace();
      setMessage('新论文项目已创建。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function openProject(projectId = selectedProjectId) {
    if (!projectId) return;
    setBusy('open');
    try {
      await saveCurrentIfDirty();
      await studioApi.openProject(projectId);
      setShowPreview(false);
      setSuggestion(null);
      setSuggestionId('');
      setSelectedText('');
      await refreshWorkspace();
      setMessage('项目已打开。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function saveDocument() {
    setBusy('save');
    try {
      await persistCurrentDocument(content);
      setMessage(`已保存 ${activeManuscriptName || 'qmd 文稿'}。`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function switchManuscript(relativePath) {
    if (!relativePath || relativePath === activeManuscript) return;
    setBusy('document-open');
    try {
      const autoSaved = await saveCurrentIfDirty();
      await studioApi.openDocument(relativePath);
      setShowPreview(false);
      setSuggestion(null);
      setSuggestionId('');
      setSelectedText('');
      await refreshWorkspace();
      setMessage(autoSaved ? `已自动保存当前文稿，并切换到 ${relativePath}。` : `已切换到 ${relativePath}。`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function createManuscript(filename) {
    if (!filename.trim()) return;
    setBusy('document-create');
    try {
      await saveCurrentIfDirty();
      const data = await studioApi.createDocument(filename);
      setShowPreview(false);
      setSuggestion(null);
      setSuggestionId('');
      setSelectedText('');
      setShowCreateManuscript(false);
      await refreshWorkspace();
      setMessage(`已创建并切换到 ${data.filename}。`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function importSource(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy('import');
    const form = new FormData();
    form.append('file', file);
    try {
      await request('/sources/import', { method: 'POST', body: form });
      await refresh();
      setMessage(`已导入资料：${file.name}`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
      event.target.value = '';
    }
  }

  async function askAi() {
    captureSelection();
    const currentSelection = selectedText || (() => {
      const editor = editorRef.current;
      return editor ? editor.value.slice(editor.selectionStart, editor.selectionEnd) : '';
    })();
    setBusy('ai');
    setSuggestion(null);
    setSuggestionId('');
    try {
      const response = await fetch(`${API}/ai/suggest/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction, selected_text: currentSelection, document: content }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'AI 建议生成失败。');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let rawText = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const event of events) {
          const line = event.split('\n').find((item) => item.startsWith('data: '));
          if (!line) continue;
          const payload = JSON.parse(line.slice(6));
          if (payload.type === 'delta') {
            rawText += payload.text;
            setMessage(`AI 正在生成建议... ${rawText.length} 字`);
          }
          if (payload.type === 'final') {
            setSuggestion({ ...payload.suggestion, trace: payload.trace || null });
            setSuggestionId(payload.suggestion_id || '');
          }
          if (payload.type === 'error') {
            throw new Error(payload.message);
          }
        }
      }
      setSelectedText(currentSelection);
      await refreshMemory();
      setMessage('AI 建议已生成，确认后才会写入正文。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function applySuggestion() {
    if (!suggestion?.rewritten_text) return;
    setBusy('apply');
    try {
      const data = await studioApi.applySuggestion(selectedText, suggestion.rewritten_text, suggestionId);
      setContent(data.content);
      setSavedContent(data.content);
      setSuggestion(null);
      setSuggestionId('');
      setSelectedText('');
      await refreshMemory();
      setMessage('修改已应用到正文。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function rejectSuggestion() {
    if (!suggestion) return;
    setBusy('reject');
    try {
      await studioApi.rejectSuggestion(selectedText, suggestion, suggestionId);
      setSuggestion(null);
      setSuggestionId('');
      await refreshMemory();
      setMessage('已拒绝建议，并记录到项目 memory。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function exportDocx() {
    setBusy('export');
    try {
      await saveCurrentIfDirty();
      const data = await studioApi.exportDocx();
      setMessage(`Word 已导出：${data.path}`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function saveSettings() {
    setBusy('settings');
    try {
      await studioApi.saveSettings({
        provider: settings.provider,
        model: settings.model,
        reasoning: settings.reasoning,
        instruction: settings.instruction,
        reference_doc: settings.reference_doc,
        export_dir: settings.export_dir,
        openai_api_key: openaiApiKey || undefined,
        deepseek_api_key: deepseekApiKey || undefined,
        deepseek_base_url: deepseekBaseUrl || undefined,
      });
      await refresh();
      setOpenaiApiKey('');
      setDeepseekApiKey('');
      setShowSettings(false);
      setMessage('设置已保存。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  function switchProvider(providerId) {
    const provider = providerCatalog.providers.find((item) => item.id === providerId);
    const nextModel = provider?.models?.[0]?.id || settings.model;
    setSettings((current) => ({ ...current, provider: providerId, model: nextModel }));
  }

  const outline = splitSections(content);
  const sources = project?.sources || [];
  const files = project?.files || [];
  const projectDataFiles = (files.find((g) => g.category === 'Data')?.files || []).filter((f) => ['csv', 'xlsx', 'xlsm'].includes(f.extension));
  const projectFigureFiles = (files.find((g) => g.category === 'Figures')?.files || []).filter((f) => ['png', 'jpg', 'jpeg', 'svg', 'webp'].includes(f.extension));
  const manuscriptWordCount = estimateWordCount(content);
  const manuscripts = project?.manuscripts || [];
  const projects = project?.projects || [];
  const memory = project?.memory || { conversation_count: 0, change_count: 0, recent_conversations: [], recent_changes: [] };
  const isBusy = Boolean(busy);
  const providers = providerCatalog.providers || [];
  const selectedProvider = providers.find((item) => item.id === (settings.provider || 'openai'));
  const modelOptions = selectedProvider?.models || [];
  const activeManuscript = project?.active_manuscript || manuscripts[0]?.relative_path || '';
  const activeManuscriptName = activeManuscript ? activeManuscript.split('/').pop() : '';
  const hasUnsavedChanges = content !== savedContent;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <p className="eyebrow">Local Quarto AI Studio</p>
          <h1>Thesis workspace</h1>
          <p className="root-path">{project?.projects_root || '.runtime/projects'}</p>
        </div>
        <div className="toolbar">
          <div className="workspace-mode-switcher">
            <button
              className={workspaceMode === 'manuscript' ? 'active' : ''}
              disabled={isBusy}
              onClick={() => switchWorkspaceMode('manuscript')}
              type="button"
            >
              Manuscript
            </button>
            <button
              className={workspaceMode === 'analysis' ? 'active' : ''}
              disabled={isBusy}
              onClick={() => switchWorkspaceMode('analysis')}
              type="button"
            >
              Analysis
            </button>
          </div>
          <details className="file-menu" ref={fileMenuRef}>
            <summary>
              <FolderOpen size={17} />
              <span>File</span>
              <ChevronDown size={15} />
            </summary>
            <div className="file-menu-popover">
              <section className="file-menu-section">
                <span className="file-menu-label">Workspace</span>
                <p className="file-menu-current">{project?.active_project || 'thesis-draft'}</p>
                <select
                  disabled={isBusy || projects.length === 0}
                  onChange={(event) => setSelectedProjectId(event.target.value)}
                  value={selectedProjectId}
                >
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
                <div className="file-menu-row">
                  <button
                    disabled={isBusy || !selectedProjectId}
                    onClick={() => {
                      closeFileMenu();
                      openProject();
                    }}
                    type="button"
                  >
                    打开
                  </button>
                  <button
                    disabled={isBusy}
                    onClick={() => {
                      closeFileMenu();
                      setShowCreateProject(true);
                    }}
                    type="button"
                  >
                    <Plus size={16} />新建 Workspace
                  </button>
                </div>
              </section>

              <section className="file-menu-section">
                <span className="file-menu-label">Project Actions</span>
                <button
                  className="file-menu-action"
                  disabled={isBusy}
                  onClick={() => {
                    closeFileMenu();
                    refresh();
                  }}
                  type="button"
                >
                  <RefreshCw size={16} />刷新
                </button>
                <button
                  className="file-menu-action"
                  disabled={isBusy}
                  onClick={() => {
                    closeFileMenu();
                    sourceImportRef.current?.click();
                  }}
                  type="button"
                >
                  <Upload size={16} />导入资料
                </button>
                <button
                  className="file-menu-action"
                  disabled={isBusy}
                  onClick={() => {
                    closeFileMenu();
                    exportDocx();
                  }}
                  type="button"
                >
                  <Download size={16} />导出 Word
                </button>
                <button
                  className="file-menu-action"
                  onClick={() => {
                    closeFileMenu();
                    setShowSettings(true);
                  }}
                  type="button"
                >
                  <Settings size={16} />设置
                </button>
                <input
                  ref={sourceImportRef}
                  style={{ display: 'none' }}
                  type="file"
                  accept=".pdf,.docx,.csv,.xlsx,.xlsm"
                  onChange={importSource}
                />
              </section>
            </div>
          </details>
        </div>
      </header>

      {message && <section className="notice">{message}</section>}

      <section className={`workspace-grid ${workspaceMode === 'analysis' ? 'analysis-mode' : ''}`}>
        <aside className="project-panel">
          <section className="panel-section">
            <div className="panel-heading">
              <FolderOpen size={16} />
              <span>当前 Workspace</span>
            </div>
            <p className="workspace-overview-name">{project?.active_project || 'thesis-draft'}</p>
            <p className="active-path">{project?.workspace}</p>
            <div className="analysis-mini-stats">
              {[
                { label: 'Words', value: manuscriptWordCount.toLocaleString() },
                { label: 'Outline', value: outline.length.toLocaleString() },
                { label: 'Data', value: projectDataFiles.length.toLocaleString() },
                { label: 'Figures', value: projectFigureFiles.length.toLocaleString() },
              ].map((item) => (
                <div className="analysis-mini-stat" key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
          </section>

          <section className="panel-section">
            <div className="panel-heading">
              <BookOpen size={16} />
              <span>论文结构</span>
            </div>
            <nav className="outline">
              {outline.map((item, index) => (
                <button
                  className={item.anchorId === activeOutlineId ? 'active' : ''}
                  key={`${item.anchorId}-${index}`}
                  onClick={() => jumpToOutlineItem(item)}
                  style={{ paddingLeft: `${item.level * 10}px` }}
                  type="button"
                >
                  {item.title}
                </button>
              ))}
            </nav>
          </section>

          <section className="panel-section">
            <div className="panel-heading">
              <Folder size={16} />
              <span>项目文件</span>
            </div>
            <div className="file-browser">
              {files.map((group) => (
                <details key={group.category} open={['Manuscript', 'Sources', 'Data'].includes(group.category)}>
                  <summary>{categoryIcon(group.category)}{group.category}</summary>
                  {group.files.length === 0 && <p className="empty-line">No files</p>}
                  {group.files.map((file) => {
                    const isSwitchableManuscript = group.category === 'Manuscript' && file.extension === 'qmd';
                    const isActiveFile = file.relative_path === activeManuscript;
                    if (isSwitchableManuscript) {
                      return (
                        <button
                          className={`file-row file-row-button ${isActiveFile ? 'active' : ''}`}
                          disabled={isBusy}
                          key={file.relative_path}
                          onClick={() => switchManuscript(file.relative_path)}
                          title={`切换到 ${file.name}`}
                        >
                          <span>{file.name}</span>
                          <small>{file.size_label}</small>
                        </button>
                      );
                    }
                    return (
                      <button
                        className={`file-row file-row-button${previewFile?.relative_path === file.relative_path ? ' active' : ''}`}
                        key={file.relative_path}
                        onClick={() => setPreviewFile(file)}
                        title={`预览 ${file.name}`}
                        type="button"
                      >
                        <span>{file.name}</span>
                        <small>{file.size_label}</small>
                      </button>
                    );
                  })}
                </details>
              ))}
            </div>
          </section>

          <section className={`quarto-box ${project?.quarto_available ? 'ready' : 'missing'}`}>
            <div>
              <strong>Quarto</strong>
              <p>{project?.quarto_message}</p>
            </div>
            <CircleAlert size={18} />
          </section>
        </aside>

        {previewFile ? (
          <FilePreview
            file={previewFile}
            onClose={() => setPreviewFile(null)}
          />
        ) : workspaceMode === 'manuscript' ? (
          <>
            <section className="editor-panel">
              <div className="editor-head">
                <div>
                  <div className="panel-heading compact">
                    <FileText size={16} />
                    <span>Manuscript</span>
                  </div>
                  <div className="manuscript-switcher-row">
                    <div className="manuscript-switcher">
                      <select
                        disabled={isBusy || manuscripts.length === 0}
                        onChange={(event) => switchManuscript(event.target.value)}
                        value={activeManuscript}
                      >
                        {manuscripts.map((item) => (
                          <option key={item.relative_path} value={item.relative_path}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button disabled={isBusy} onClick={() => setShowCreateManuscript(true)} title="新建 qmd">
                      <Plus size={16} />新建
                    </button>
                  </div>
                  <p>
                    {manuscripts.length > 0 ? `${manuscripts.length} qmd in this project` : 'No qmd manuscript'}
                    {activeManuscriptName ? ` · Current: ${activeManuscriptName}` : ''}
                    {hasUnsavedChanges ? ' · Unsaved changes' : ''}
                  </p>
                </div>
                <div className="editor-actions">
                  <button onClick={() => setShowPreview((current) => !current)} title="预览 QMD">
                    <Eye size={18} />{showPreview ? '继续编辑' : '预览'}
                  </button>
                  <button onClick={saveDocument} disabled={isBusy} title="保存正文">
                    <Save size={18} />保存
                  </button>
                </div>
              </div>
              {showPreview ? (
                <QmdPreview
                  activeOutlineId={activeOutlineId}
                  content={content}
                  containerRef={previewRef}
                  outline={outline}
                />
              ) : (
                <textarea
                  ref={editorRef}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  onSelect={captureSelection}
                  spellCheck={true}
                />
              )}
            </section>

            <aside className="ai-panel">
              <div className="panel-heading">
                <Sparkles size={16} />
                <span>AI 协作</span>
              </div>
              <div className="selection-box">
                <span>当前选中</span>
                <p>{selectedText ? selectedText.slice(0, 260) : '请先在正文里选中一段文字。'}</p>
              </div>
              <textarea
                className="instruction"
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
              />
              <button className="primary" onClick={askAi} disabled={isBusy || !selectedText} title="生成 AI 建议">
                {busy === 'ai' ? <Loader2 className="spin" size={18} /> : <Bot size={18} />}
                生成建议
              </button>

              <section className="source-strip">
                <strong>已索引资料</strong>
                <span>{sources.length} files</span>
              </section>
              <SuggestionPanel
                isBusy={isBusy}
                onApply={applySuggestion}
                onReject={rejectSuggestion}
                suggestion={suggestion}
              />
              <MemoryPanel memory={memory} />
            </aside>
          </>
        ) : (
          <AnalysisWorkspace
            isBusy={isBusy}
            onRefreshWorkspace={refreshWorkspace}
            onSetBusy={setBusy}
            onSetMessage={setMessage}
            outline={outline}
            project={project}
          />
        )}
      </section>

      {showSettings && (
        <SettingsModal
          deepseekApiKey={deepseekApiKey}
          deepseekBaseUrl={deepseekBaseUrl}
          isBusy={isBusy}
          modelOptions={modelOptions}
          openaiApiKey={openaiApiKey}
          onClose={() => setShowSettings(false)}
          onSave={saveSettings}
          providers={providers}
          setDeepseekApiKey={setDeepseekApiKey}
          setDeepseekBaseUrl={setDeepseekBaseUrl}
          setOpenaiApiKey={setOpenaiApiKey}
          setSettings={setSettings}
          settings={settings}
          switchProvider={switchProvider}
        />
      )}
      {showCreateManuscript && (
        <NewManuscriptModal
          isBusy={isBusy}
          onClose={() => setShowCreateManuscript(false)}
          onCreate={createManuscript}
        />
      )}
      {showCreateProject && (
        <NewProjectModal
          isBusy={isBusy}
          onClose={() => setShowCreateProject(false)}
          onCreate={createProject}
        />
      )}
    </main>
  );
}

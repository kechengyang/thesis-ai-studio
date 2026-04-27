import React, { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Bot,
  Check,
  CircleAlert,
  Database,
  Download,
  FileText,
  Folder,
  FolderOpen,
  Image,
  KeyRound,
  Loader2,
  MessageSquareText,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';

const API = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8011/api';

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.detail || '操作失败，请稍后再试。');
  }
  return data;
}

function splitSections(content) {
  return content
    .split('\n')
    .filter((line) => /^#{1,6}\s+/.test(line.trim()))
    .map((line) => ({
      level: line.match(/^#+/)[0].length,
      title: line.replace(/^#{1,6}\s+/, ''),
    }));
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
  const [project, setProject] = useState(null);
  const [content, setContent] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [instruction, setInstruction] = useState('Revise the selected passage into clear, polished academic English while preserving the meaning.');
  const [suggestion, setSuggestion] = useState(null);
  const [suggestionId, setSuggestionId] = useState('');
  const [settings, setSettings] = useState({ model: 'gpt-5.5', reasoning: 'medium' });
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [newProjectName, setNewProjectName] = useState('Thesis Draft');
  const [selectedProjectId, setSelectedProjectId] = useState('');

  async function refresh() {
    const projectData = await request('/project');
    const documentData = await request('/document');
    setProject(projectData);
    setSettings(projectData.settings);
    setContent(documentData.content);
    setSelectedProjectId(projectData.active_project);
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, []);

  async function refreshMemory() {
    const memory = await request('/memory');
    setProject((current) => (current ? { ...current, memory } : current));
  }

  function captureSelection() {
    const editor = editorRef.current;
    if (!editor) return;
    setSelectedText(editor.value.slice(editor.selectionStart, editor.selectionEnd));
  }

  async function createProject() {
    setBusy('create');
    try {
      await request('/project/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newProjectName || 'Thesis Draft' }),
      });
      await refresh();
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
      await request('/project/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      });
      await refresh();
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
      await request('/document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      setMessage('已保存 paper.qmd。');
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
            setSuggestion(payload.suggestion);
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
      const data = await request('/ai/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          original_segment: selectedText,
          replacement: suggestion.rewritten_text,
          suggestion_id: suggestionId || undefined,
        }),
      });
      setContent(data.content);
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
      await request('/ai/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          original_segment: selectedText,
          suggestion,
          suggestion_id: suggestionId || undefined,
        }),
      });
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
      await saveDocument();
      const data = await request('/export/docx', { method: 'POST' });
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
      const updated = await request('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, api_key: apiKey || undefined }),
      });
      setSettings(updated);
      setApiKey('');
      setShowSettings(false);
      setMessage('设置已保存。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  const outline = splitSections(content);
  const sources = project?.sources || [];
  const files = project?.files || [];
  const projects = project?.projects || [];
  const memory = project?.memory || { conversation_count: 0, change_count: 0, recent_conversations: [], recent_changes: [] };
  const isBusy = Boolean(busy);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <p className="eyebrow">Local Quarto AI Studio</p>
          <h1>Thesis workspace</h1>
          <p className="root-path">{project?.projects_root || '/Users/anqizhang/work/thesis'}</p>
        </div>
        <div className="toolbar">
          <button onClick={refresh} disabled={isBusy} title="刷新">
            <RefreshCw size={18} />刷新
          </button>
          <label className="button-like" title="导入资料">
            <Upload size={18} />导入资料
            <input type="file" accept=".pdf,.docx,.csv,.xlsx,.xlsm" onChange={importSource} />
          </label>
          <button onClick={exportDocx} disabled={isBusy} title="导出 Word">
            <Download size={18} />导出 Word
          </button>
          <button onClick={() => setShowSettings(true)} title="设置">
            <Settings size={18} />设置
          </button>
        </div>
      </header>

      {message && <section className="notice">{message}</section>}

      <section className="workspace-grid">
        <aside className="project-panel">
          <section className="panel-section">
            <div className="panel-heading">
              <FolderOpen size={16} />
              <span>论文项目</span>
            </div>
            <div className="project-open-row">
              <select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
              <button onClick={() => openProject()} disabled={isBusy || !selectedProjectId} title="打开项目">
                打开
              </button>
            </div>
            <div className="new-project-row">
              <input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} />
              <button onClick={createProject} disabled={isBusy} title="新建论文项目">
                <Plus size={16} />
              </button>
            </div>
            <p className="active-path">{project?.workspace}</p>
          </section>

          <section className="panel-section">
            <div className="panel-heading">
              <BookOpen size={16} />
              <span>论文结构</span>
            </div>
            <nav className="outline">
              {outline.map((item, index) => (
                <button key={`${item.title}-${index}`} style={{ paddingLeft: `${item.level * 10}px` }}>
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
                  {group.files.map((file) => (
                    <div className="file-row" key={file.relative_path}>
                      <span>{file.name}</span>
                      <small>{file.size_label}</small>
                    </div>
                  ))}
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

        <section className="editor-panel">
          <div className="editor-head">
            <div>
              <div className="panel-heading compact">
                <FileText size={16} />
                <span>paper.qmd</span>
              </div>
              <p>English Quarto manuscript</p>
            </div>
            <button onClick={saveDocument} disabled={isBusy} title="保存正文">
              <Save size={18} />保存
            </button>
          </div>
          <textarea
            ref={editorRef}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onSelect={captureSelection}
            spellCheck={true}
          />
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

          <section className="memory-panel">
            <div className="panel-heading compact">
              <MessageSquareText size={16} />
              <span>项目 Memory</span>
            </div>
            <div className="memory-counts">
              <span>{memory.conversation_count || 0} AI conversations</span>
              <span>{memory.change_count || 0} edits</span>
            </div>
            <div className="memory-list">
              {(memory.recent_changes || []).slice(-3).reverse().map((item) => (
                <div className={`memory-item ${item.status}`} key={item.id}>
                  <strong>{item.status === 'accepted' ? 'Accepted edit' : 'Rejected suggestion'}</strong>
                  <p>{item.original_segment}</p>
                </div>
              ))}
              {(memory.recent_conversations || []).slice(-2).reverse().map((item) => (
                <div className="memory-item" key={item.id}>
                  <strong>AI suggestion</strong>
                  <p>{item.instruction}</p>
                </div>
              ))}
              {(!memory.recent_changes?.length && !memory.recent_conversations?.length) && (
                <p className="empty-line">No memory yet</p>
              )}
            </div>
          </section>

          {suggestion && (
            <section className="suggestion">
              <h2>建议改写</h2>
              <pre>{suggestion.rewritten_text}</pre>
              <h3>理由</h3>
              <p>{suggestion.rationale}</p>
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
              <div className="suggestion-actions">
                <button onClick={applySuggestion} disabled={isBusy} title="接受建议">
                  <Check size={18} />接受
                </button>
                <button onClick={rejectSuggestion} disabled={isBusy} title="拒绝建议">
                  <X size={18} />拒绝
                </button>
              </div>
            </section>
          )}
        </aside>
      </section>

      {showSettings && (
        <div className="modal-backdrop">
          <section className="modal">
            <header>
              <h2>设置</h2>
              <button onClick={() => setShowSettings(false)} title="关闭">
                <X size={18} />
              </button>
            </header>
            <label>
              OpenAI API Key
              <input
                type="password"
                value={apiKey}
                placeholder={settings.api_key_masked || 'sk-...'}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
            <label>
              模型
              <input
                value={settings.model || 'gpt-5.5'}
                onChange={(event) => setSettings({ ...settings, model: event.target.value })}
              />
            </label>
            <label>
              推理强度
              <select
                value={settings.reasoning || 'medium'}
                onChange={(event) => setSettings({ ...settings, reasoning: event.target.value })}
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
            </label>
            <label>
              Word 模板
              <input
                value={settings.reference_doc || 'templates/reference.docx'}
                onChange={(event) => setSettings({ ...settings, reference_doc: event.target.value })}
              />
            </label>
            <button className="primary" onClick={saveSettings} disabled={isBusy}>
              <KeyRound size={18} />保存设置
            </button>
          </section>
        </div>
      )}
    </main>
  );
}

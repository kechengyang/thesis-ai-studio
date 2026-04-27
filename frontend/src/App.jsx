import React, { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  Download,
  FilePlus2,
  FolderOpen,
  KeyRound,
  Loader2,
  Save,
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

export default function App() {
  const editorRef = useRef(null);
  const [project, setProject] = useState(null);
  const [content, setContent] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [instruction, setInstruction] = useState('请帮我把这段改得更清晰、更符合学术论文表达。');
  const [suggestion, setSuggestion] = useState(null);
  const [settings, setSettings] = useState({ model: 'gpt-5.5', reasoning: 'medium' });
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  async function refresh() {
    const projectData = await request('/project');
    const documentData = await request('/document');
    setProject(projectData);
    setSettings(projectData.settings);
    setContent(documentData.content);
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, []);

  function captureSelection() {
    const editor = editorRef.current;
    if (!editor) return;
    const value = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    setSelectedText(value);
  }

  async function createProject() {
    setBusy('create');
    try {
      await request('/project/create', { method: 'POST' });
      await refresh();
      setMessage('论文项目已准备好。');
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
      setMessage('已保存正文。');
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
          }
          if (payload.type === 'error') {
            throw new Error(payload.message);
          }
        }
      }
      setSelectedText(currentSelection);
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
        }),
      });
      setContent(data.content);
      setSuggestion(null);
      setSelectedText('');
      setMessage('修改已应用到正文。');
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
  const isBusy = Boolean(busy);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Quarto AI Paper Studio</p>
          <h1>论文工作台</h1>
        </div>
        <div className="toolbar">
          <button onClick={createProject} disabled={isBusy} title="新建论文">
            <FilePlus2 size={18} />新建论文
          </button>
          <button onClick={refresh} disabled={isBusy} title="打开论文">
            <FolderOpen size={18} />打开论文
          </button>
          <label className="button-like" title="导入资料">
            <Upload size={18} />导入资料
            <input type="file" accept=".pdf,.docx,.csv,.xlsx,.xlsm" onChange={importSource} />
          </label>
          <button onClick={exportDocx} disabled={isBusy} title="导出 Word">
            <Download size={18} />导出 Word
          </button>
          <button onClick={() => setShowSettings(true)} title="设置">
            <KeyRound size={18} />设置
          </button>
        </div>
      </header>

      {message && <section className="notice">{message}</section>}

      <section className="workspace-grid">
        <aside className="sidebar">
          <div className="panel-title">论文结构</div>
          <nav className="outline">
            {outline.map((item, index) => (
              <button key={`${item.title}-${index}`} style={{ paddingLeft: `${item.level * 10}px` }}>
                {item.title}
              </button>
            ))}
          </nav>
          <div className="panel-title sources-title">本地资料</div>
          <div className="source-list">
            {sources.length === 0 && <p>还没有导入资料。</p>}
            {sources.map((source) => (
              <div className="source-item" key={source.filename}>
                <strong>{source.filename}</strong>
                <span>{source.characters} 字符</span>
              </div>
            ))}
          </div>
          <div className="status-box">
            <span>Quarto</span>
            <strong>{project?.quarto_available ? '已找到' : '未找到'}</strong>
          </div>
        </aside>

        <section className="editor-panel">
          <div className="editor-head">
            <div>
              <div className="panel-title">正文</div>
              <p>主稿文件：paper.qmd</p>
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
            spellCheck={false}
          />
        </section>

        <aside className="ai-panel">
          <div className="panel-title">AI 协作</div>
          <div className="selection-box">
            <span>当前选中</span>
            <p>{selectedText ? selectedText.slice(0, 220) : '请先在正文里选中一段文字。'}</p>
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
                <button onClick={() => setSuggestion(null)} title="拒绝建议">
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
              <Save size={18} />保存设置
            </button>
          </section>
        </div>
      )}
    </main>
  );
}

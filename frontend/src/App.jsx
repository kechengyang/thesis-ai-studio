import React, { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  Database,
  Download,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  GripVertical,
  Image,
  Pencil,
  Plus,
  RefreshCw,
  Redo2,
  RotateCcw,
  Save,
  Settings,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';

import { chatApi, request, studioApi } from './api';
import { AnalysisWorkspace } from './components/AnalysisWorkspace';
import { ChatPanel } from './components/ChatPanel';
import { FilePreview } from './components/FilePreview';
import { MemoryPanel } from './components/MemoryPanel';
import { NewManuscriptModal } from './components/NewManuscriptModal';
import { QmdPreview } from './components/QmdPreview';
import { SettingsModal } from './components/SettingsModal';
import { SuggestionPanel } from './components/SuggestionPanel';
import { WorkspaceRootModal } from './components/WorkspaceRootModal';

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

function hasConfiguredWorkspace(projectData) {
  if (!projectData) return false;
  if (typeof projectData.workspace_configured === 'boolean') {
    return projectData.workspace_configured;
  }
  return Boolean(projectData.workspace || projectData.active_project || projectData.active_manuscript);
}

function latestSelectedTextFromMessages(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const selected = message?.result?.selected_text || message?.context?.selected_text || '';
    if (String(selected).trim()) {
      return String(selected).trim();
    }
  }
  return '';
}

function describeEditorChatError(error) {
  const message = String(error?.message || '').trim();
  if (message === 'Not Found') {
    return 'AI 协作会话接口未加载到当前后端。请重启应用或后端服务后再试。';
  }
  return message || 'AI 协作请求失败。';
}

function readStoredPanelWidth(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key);
  const value = Number(raw);
  return Number.isFinite(value) && value >= 340 ? value : fallback;
}

function summarizeEditorOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) return '';
  return operations.slice(0, 3).map((operation) => {
    if (operation.type === 'replace_text') {
      return `替换：${String(operation.target_text || '').trim().slice(0, 36)}`;
    }
    if (operation.type === 'insert_under_heading') {
      return `插入到 ${operation.section_title || '文末'}`;
    }
    if (operation.type === 'insert_figure') {
      return `插图：${operation.figure_relative_path || ''}`;
    }
    return operation.type || 'edit';
  }).join(' / ');
}

function hasEditorActions(result) {
  if (!result) return false;
  if (result.rewritten_text && result.selected_text) return true;
  return Array.isArray(result.operations) && result.operations.length > 0;
}

function hasEditorToolResults(result) {
  return Array.isArray(result?.tool_results) && result.tool_results.length > 0;
}

const EDITOR_HISTORY_LIMIT = 80;
const EDITOR_HISTORY_GROUP_MS = 700;

export default function App() {
  const editorRef = useRef(null);
  const previewRef = useRef(null);
  const sourceImportRef = useRef(null);
  const fileMenuRef = useRef(null);
  const manuscriptResizeRef = useRef({ active: false, startX: 0, startWidth: 0 });
  const editorHistoryRef = useRef({ past: [], future: [] });
  const editorTypingRef = useRef({ active: false, timeoutId: 0 });
  const [project, setProject] = useState(null);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [editorNeedsFreshSelection, setEditorNeedsFreshSelection] = useState(false);
  const [editorMessages, setEditorMessages] = useState([]);
  const [editorHistoryState, setEditorHistoryState] = useState({ canUndo: false, canRedo: false });
  const [settings, setSettings] = useState({ provider: 'openai', model: 'gpt-5.5', reasoning: 'medium', instruction: '' });
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [deepseekApiKey, setDeepseekApiKey] = useState('');
  const [deepseekBaseUrl, setDeepseekBaseUrl] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showCreateManuscript, setShowCreateManuscript] = useState(false);
  const [showWorkspaceRootModal, setShowWorkspaceRootModal] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState('manuscript');
  const [providerCatalog, setProviderCatalog] = useState({ current_provider: 'openai', providers: [] });
  const [activeOutlineId, setActiveOutlineId] = useState('');
  const [previewFile, setPreviewFile] = useState(null);
  const [manuscriptAiWidth, setManuscriptAiWidth] = useState(() => readStoredPanelWidth('tas.manuscriptAiWidth', 500));
  const [draggedFile, setDraggedFile] = useState(null);
  const [dragOverCategory, setDragOverCategory] = useState('');

  async function refreshWorkspace() {
    const [projectData, providerData] = await Promise.all([
      studioApi.getProject(),
      studioApi.getProviders(),
    ]);
    setProject(projectData);
    setSettings(projectData.settings);
    setProviderCatalog(providerData);
    setDeepseekBaseUrl(projectData.settings.deepseek_base_url || '');
    if (!hasConfiguredWorkspace(projectData)) {
      resetWorkspaceTransientState();
      resetEditorHistory();
      setContent('');
      setSavedContent('');
      setActiveOutlineId('');
      return;
    }
    const documentData = await studioApi.getDocument();
    resetEditorHistory();
    setContent(documentData.content);
    setSavedContent(documentData.content);
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
    if (!project) return;
    if (!hasConfiguredWorkspace(project)) {
      setShowWorkspaceRootModal(true);
      if (project.workspace_error) {
        setMessage(project.workspace_error);
      }
    }
  }, [project]);

  useEffect(() => {
    const provider = providerCatalog.providers?.find((item) => item.id === (settings.provider || 'openai'));
    if (!provider?.models?.length) return;
    if (provider.models.some((item) => item.id === settings.model)) return;
    setSettings((current) => ({ ...current, model: provider.models[0].id }));
  }, [providerCatalog, settings.provider, settings.model]);

  useEffect(() => {
    const activeWorkspace = project?.workspace || '';
    const activeManuscriptPath = project?.active_manuscript || '';
    if (!activeWorkspace || !activeManuscriptPath) {
      setEditorMessages([]);
      return;
    }
    let cancelled = false;
    chatApi.load('editor', { chatKey: activeManuscriptPath })
      .then((data) => {
        if (!cancelled) {
          setEditorMessages(data.history || []);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setMessage(describeEditorChatError(error));
          setEditorMessages([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project?.workspace, project?.active_manuscript]);

  useEffect(() => {
    function onMouseMove(event) {
      if (!manuscriptResizeRef.current.active) return;
      const delta = manuscriptResizeRef.current.startX - event.clientX;
      setManuscriptAiWidth(Math.max(360, Math.min(760, manuscriptResizeRef.current.startWidth + delta)));
    }
    function onMouseUp() {
      manuscriptResizeRef.current.active = false;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('tas.manuscriptAiWidth', String(manuscriptAiWidth));
  }, [manuscriptAiWidth]);

  useEffect(() => () => {
    clearEditorTypingBatch();
  }, []);

  async function refreshMemory() {
    if (!hasConfiguredWorkspace(project)) return;
    const memory = await studioApi.getMemory();
    setProject((current) => (current ? { ...current, memory } : current));
  }

  function closeFileMenu() {
    if (fileMenuRef.current) {
      fileMenuRef.current.open = false;
    }
  }

  function startManuscriptResize(event) {
    manuscriptResizeRef.current = {
      active: true,
      startX: event.clientX,
      startWidth: manuscriptAiWidth,
    };
    event.preventDefault();
  }

  function resetWorkspaceTransientState() {
    setShowPreview(false);
    setSelectedText('');
    setEditorNeedsFreshSelection(false);
    setEditorMessages([]);
    setPreviewFile(null);
  }

  function syncEditorHistoryState() {
    const history = editorHistoryRef.current;
    setEditorHistoryState({
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
    });
  }

  function clearEditorTypingBatch() {
    const typing = editorTypingRef.current;
    if (typing.timeoutId) {
      window.clearTimeout(typing.timeoutId);
    }
    typing.active = false;
    typing.timeoutId = 0;
  }

  function resetEditorHistory() {
    clearEditorTypingBatch();
    editorHistoryRef.current = { past: [], future: [] };
    syncEditorHistoryState();
  }

  function getEditorSelectionRange() {
    const editor = editorRef.current;
    if (!editor) return { start: 0, end: 0 };
    return {
      start: editor.selectionStart || 0,
      end: editor.selectionEnd || 0,
    };
  }

  function restoreEditorSelection(selection) {
    if (!selection || showPreview) return;
    window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const start = Math.max(0, Math.min(selection.start ?? 0, editor.value.length));
      const end = Math.max(0, Math.min(selection.end ?? start, editor.value.length));
      editor.focus();
      editor.setSelectionRange(start, end);
    });
  }

  function pushEditorHistorySnapshot(snapshot) {
    const history = editorHistoryRef.current;
    const last = history.past[history.past.length - 1];
    if (last?.content === snapshot.content) {
      return;
    }
    history.past.push(snapshot);
    if (history.past.length > EDITOR_HISTORY_LIMIT) {
      history.past.shift();
    }
    history.future = [];
    syncEditorHistoryState();
  }

  function applyEditorContent(nextContent, options = {}) {
    const {
      markSaved = false,
      recordHistory = false,
      selection = null,
    } = options;
    clearEditorTypingBatch();
    if (recordHistory && nextContent !== content) {
      pushEditorHistorySnapshot({ content, selection: getEditorSelectionRange() });
    }
    setContent(nextContent);
    if (markSaved) {
      setSavedContent(nextContent);
    }
    restoreEditorSelection(selection);
    if (!recordHistory) {
      syncEditorHistoryState();
    }
  }

  function scheduleEditorTypingBoundary() {
    const typing = editorTypingRef.current;
    if (typing.timeoutId) {
      window.clearTimeout(typing.timeoutId);
    }
    typing.active = true;
    typing.timeoutId = window.setTimeout(() => {
      typing.active = false;
      typing.timeoutId = 0;
    }, EDITOR_HISTORY_GROUP_MS);
  }

  function handleEditorChange(event) {
    const nextValue = event.target.value;
    if (nextValue === content) return;
    if (!editorTypingRef.current.active) {
      pushEditorHistorySnapshot({ content, selection: getEditorSelectionRange() });
    }
    scheduleEditorTypingBoundary();
    setContent(nextValue);
  }

  function undoEditorChange() {
    clearEditorTypingBatch();
    const history = editorHistoryRef.current;
    const previous = history.past.pop();
    if (!previous) {
      syncEditorHistoryState();
      return false;
    }
    history.future.push({ content, selection: getEditorSelectionRange() });
    if (history.future.length > EDITOR_HISTORY_LIMIT) {
      history.future.shift();
    }
    setContent(previous.content);
    restoreEditorSelection(previous.selection);
    syncEditorHistoryState();
    return true;
  }

  function redoEditorChange() {
    clearEditorTypingBatch();
    const history = editorHistoryRef.current;
    const next = history.future.pop();
    if (!next) {
      syncEditorHistoryState();
      return false;
    }
    history.past.push({ content, selection: getEditorSelectionRange() });
    if (history.past.length > EDITOR_HISTORY_LIMIT) {
      history.past.shift();
    }
    setContent(next.content);
    restoreEditorSelection(next.selection);
    syncEditorHistoryState();
    return true;
  }

  function readEditorSelection() {
    const editor = editorRef.current;
    if (!editor) return '';
    return editor.value.slice(editor.selectionStart, editor.selectionEnd);
  }

  function resolveEditorTargetText() {
    if (editorNeedsFreshSelection) return '';
    return readEditorSelection() || selectedText || latestSelectedTextFromMessages(editorMessages);
  }

  function captureSelection() {
    const nextSelection = readEditorSelection();
    setSelectedText(nextSelection);
    if (nextSelection.trim()) {
      setEditorNeedsFreshSelection(false);
    }
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

  function handleEditorKeyDown(event) {
    if (event.defaultPrevented || event.altKey) return;
    const key = String(event.key || '').toLowerCase();
    const primaryModifier = event.metaKey || event.ctrlKey;
    if (!primaryModifier) return;

    const wantsUndo = key === 'z' && !event.shiftKey;
    const wantsRedo = (key === 'z' && event.shiftKey) || (key === 'y' && event.ctrlKey && !event.metaKey);
    if (!wantsUndo && !wantsRedo) return;

    const handled = wantsRedo ? redoEditorChange() : undoEditorChange();
    if (handled) {
      event.preventDefault();
    }
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
    if (!hasConfiguredWorkspace(project)) return false;
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

  async function updateWorkspaceRoot(path) {
    setBusy('workspace-root');
    try {
      await saveCurrentIfDirty();
      const nextProject = await studioApi.updateWorkspaceRoot(path);
      resetWorkspaceTransientState();
      setShowWorkspaceRootModal(false);
      setProject(nextProject);
      await refreshWorkspace();
      setMessage('Workspace 已载入，并已写入本地状态。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function chooseWorkspaceRoot() {
    setBusy('workspace-root-choose');
    try {
      await saveCurrentIfDirty();
      const data = await studioApi.chooseWorkspaceRoot();
      if (data.cancelled) {
        setMessage('已取消选择 Workspace 文件夹。');
        return;
      }
      resetWorkspaceTransientState();
      await refreshWorkspace();
      setMessage('Workspace 已载入，并已写入本地状态。');
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
      setSelectedText('');
      setEditorNeedsFreshSelection(false);
      setEditorMessages([]);
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
      setSelectedText('');
      setEditorNeedsFreshSelection(false);
      setEditorMessages([]);
      setShowCreateManuscript(false);
      await refreshWorkspace();
      setMessage(`已创建并切换到 ${data.filename}。`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  function clearFileDragState() {
    setDraggedFile(null);
    setDragOverCategory('');
  }

  function canDropIntoCategory(category) {
    if (isBusy || !draggedFile) return false;
    return Array.isArray(draggedFile.move_targets) && draggedFile.move_targets.includes(category);
  }

  function startFileDrag(event, file) {
    if (!file?.can_move || isBusy) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', file.relative_path);
    setDraggedFile(file);
    setDragOverCategory('');
  }

  async function renameWorkspaceFile(file) {
    if (!file?.can_rename || isBusy) return;
    const nextName = window.prompt('输入新的文件名', file.name);
    if (nextName === null) return;
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === file.name) return;
    setBusy('file-rename');
    try {
      if (file.relative_path === activeManuscript) {
        await saveCurrentIfDirty();
      }
      const data = await studioApi.renameProjectFile(file.relative_path, trimmed);
      if (previewFile?.relative_path === file.relative_path) {
        setPreviewFile((current) => (current ? { ...current, name: data.filename, relative_path: data.relative_path } : current));
      }
      await refreshWorkspace();
      setMessage(`已将 ${file.name} 重命名为 ${data.filename}。`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function moveWorkspaceFile(file, targetCategory) {
    if (!file?.can_move || isBusy || !file.move_targets?.includes(targetCategory)) return;
    setBusy('file-move');
    try {
      const data = await studioApi.moveProjectFile(file.relative_path, targetCategory);
      if (previewFile?.relative_path === file.relative_path) {
        setPreviewFile((current) => (current ? { ...current, name: data.filename, relative_path: data.relative_path } : current));
      }
      await refreshWorkspace();
      setMessage(`已将 ${file.name} 移动到 ${targetCategory}。`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
      clearFileDragState();
    }
  }

  async function deleteWorkspaceFile(file) {
    if (!file?.can_delete || isBusy) return;
    const confirmed = window.confirm(`确认删除 ${file.name}？此操作不会进入回收站。`);
    if (!confirmed) return;
    setBusy('file-delete');
    try {
      if (file.relative_path === activeManuscript) {
        await saveCurrentIfDirty();
        setSelectedText('');
        setEditorNeedsFreshSelection(false);
        setEditorMessages([]);
      }
      await studioApi.deleteProjectFile(file.relative_path);
      if (previewFile?.relative_path === file.relative_path) {
        setPreviewFile(null);
      }
      await refreshWorkspace();
      setMessage(`已删除 ${file.name}。`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
      clearFileDragState();
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

  async function sendEditorMessage(messageText) {
    const currentSelection = resolveEditorTargetText().trim();
    const context = {
      chat_key: activeManuscript,
      active_manuscript: activeManuscript,
      selected_text: currentSelection,
      document: content,
    };
    const optimisticUser = {
      id: `optimistic-${Date.now()}`,
      role: 'user',
      timestamp: new Date().toISOString(),
      content: messageText,
      context,
    };
    setBusy('editor-chat');
    setEditorMessages((current) => [...current, optimisticUser]);
    try {
      const history = editorMessages;
      const data = await chatApi.send('editor', messageText, history, context);
      const assistantMessage = data.message;
      setEditorMessages((current) => [
        ...current.filter((item) => item.id !== optimisticUser.id),
        optimisticUser,
        assistantMessage,
      ]);
      setSelectedText(String(assistantMessage.result?.selected_text || currentSelection || '').trim());
      setEditorNeedsFreshSelection(false);
      await refreshMemory();
      if (hasEditorToolResults(assistantMessage.result)) {
        await refreshWorkspace();
      }
      setMessage(
        hasEditorActions(assistantMessage.result)
          ? `AI 已规划可应用的编辑动作${assistantMessage.result?.operations?.length ? `（${assistantMessage.result.operations.length} 项）` : ''}。`
          : hasEditorToolResults(assistantMessage.result)
            ? `AI 已执行 ${assistantMessage.result.tool_results.length} 个工具步骤。`
          : 'AI 回复已生成。',
      );
    } catch (error) {
      setEditorMessages((current) => current.filter((item) => item.id !== optimisticUser.id));
      setMessage(describeEditorChatError(error));
    } finally {
      setBusy('');
    }
  }

  async function clearEditorConversation() {
    if (!activeManuscript) return;
    setBusy('editor-chat-clear');
    try {
      await chatApi.clear('editor', { chatKey: activeManuscript });
      setEditorMessages([]);
      setSelectedText('');
      setEditorNeedsFreshSelection(false);
      setMessage('已清空当前文稿的 AI 会话。');
    } catch (error) {
      setMessage(describeEditorChatError(error));
    } finally {
      setBusy('');
    }
  }

  async function applyEditorSuggestion(chatMessage) {
    const result = chatMessage?.result || {};
    const operations = Array.isArray(result.operations) ? result.operations : [];
    if (!hasEditorActions(result)) {
      setMessage('这条建议没有可执行的编辑动作，暂时不能直接应用。');
      return;
    }
    setBusy('apply');
    try {
      const data = await studioApi.applySuggestion(result.selected_text, result.rewritten_text, result.suggestion_id, operations);
      applyEditorContent(data.content, { markSaved: true, recordHistory: true });
      setSelectedText('');
      setEditorNeedsFreshSelection(true);
      await refreshMemory();
      setMessage(operations.length > 0 ? `已将 ${operations.length} 个编辑动作应用到正文。可在主编辑框按 Cmd+Z 撤回。` : '修改已应用到正文。可在主编辑框按 Cmd+Z 撤回。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy('');
    }
  }

  async function rejectEditorSuggestion(chatMessage) {
    const result = chatMessage?.result || {};
    if (!hasEditorActions(result)) {
      setMessage('这条建议没有可追踪的编辑动作。');
      return;
    }
    setBusy('reject');
    try {
      await studioApi.rejectSuggestion(result.selected_text || summarizeEditorOperations(result.operations), result, result.suggestion_id);
      setSelectedText('');
      setEditorNeedsFreshSelection(true);
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

  function renderEditorResult(message) {
    if (!message?.result) return null;
    const suggestion = message.result;
    if (!suggestion.rewritten_text && !(suggestion.operations?.length > 0) && !(suggestion.tool_results?.length > 0) && !suggestion.rationale && !suggestion.trace) return null;
    return (
      <SuggestionPanel
        compact={true}
        isBusy={isBusy}
        onApply={hasEditorActions(suggestion) ? () => applyEditorSuggestion(message) : undefined}
        onReject={hasEditorActions(suggestion) ? () => rejectEditorSuggestion(message) : undefined}
        suggestion={suggestion}
      />
    );
  }

  const outline = splitSections(content);
  const sources = project?.sources || [];
  const files = project?.files || [];
  const projectDataFiles = (files.find((g) => g.category === 'Data')?.files || []).filter((f) => ['csv', 'xlsx', 'xlsm'].includes(f.extension));
  const projectFigureFiles = (files.find((g) => g.category === 'Figures')?.files || []).filter((f) => ['png', 'jpg', 'jpeg', 'svg', 'webp'].includes(f.extension));
  const manuscriptWordCount = estimateWordCount(content);
  const manuscripts = project?.manuscripts || [];
  const memory = project?.memory || { conversation_count: 0, change_count: 0, recent_conversations: [], recent_changes: [] };
  const isBusy = Boolean(busy);
  const workspaceConfigured = hasConfiguredWorkspace(project);
  const workspaceRootLabel = project?.projects_root || project?.workspace_suggestion || '请选择 Workspace 文件夹';
  const workspaceDisplayName = project?.active_project || '未选择 Workspace';
  const providers = providerCatalog.providers || [];
  const selectedProvider = providers.find((item) => item.id === (settings.provider || 'openai'));
  const modelOptions = selectedProvider?.models || [];
  const activeManuscript = project?.active_manuscript || manuscripts[0]?.relative_path || '';
  const activeManuscriptName = activeManuscript ? activeManuscript.split('/').pop() : '';
  const hasUnsavedChanges = content !== savedContent;
  const liveEditorSelection = readEditorSelection().trim();
  const editorTargetText = editorNeedsFreshSelection ? '' : (liveEditorSelection || selectedText || latestSelectedTextFromMessages(editorMessages));
  const editorSelectionLabel = liveEditorSelection ? '当前选中' : editorTargetText ? '会话目标' : '当前文稿';
  const editorChatBusy = ['editor-chat', 'editor-chat-clear', 'apply', 'reject'].includes(busy);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <p className="eyebrow">Local Quarto AI Studio</p>
          <h1>Thesis workspace</h1>
          <p className="root-path">{workspaceRootLabel}</p>
        </div>
        <div className="toolbar">
          <div className="workspace-mode-switcher">
            <button
              className={workspaceMode === 'manuscript' ? 'active' : ''}
              disabled={isBusy || !workspaceConfigured}
              onClick={() => switchWorkspaceMode('manuscript')}
              type="button"
            >
              Manuscript
            </button>
            <button
              className={workspaceMode === 'analysis' ? 'active' : ''}
              disabled={isBusy || !workspaceConfigured}
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
                <p className="file-menu-current">{workspaceDisplayName}</p>
                <button
                  className="file-menu-action"
                  disabled={isBusy}
                  onClick={async () => {
                    closeFileMenu();
                    await chooseWorkspaceRoot();
                  }}
                  type="button"
                >
                  <FolderOpen size={16} />选择 Workspace 文件夹
                </button>
                <button
                  className="file-menu-action"
                  disabled={isBusy}
                  onClick={() => {
                    closeFileMenu();
                    setShowWorkspaceRootModal(true);
                  }}
                  type="button"
                >
                  <Settings size={16} />手动输入路径
                </button>
              </section>

              <section className="file-menu-section">
                <span className="file-menu-label">Project Actions</span>
                <button
                  className="file-menu-action"
                  disabled={isBusy || !workspaceConfigured}
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
                  disabled={isBusy || !workspaceConfigured}
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
                  disabled={isBusy || !workspaceConfigured}
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

      {!workspaceConfigured ? (
        <section className="workspace-empty-state">
          <div className="workspace-empty-card">
            <span className="workspace-empty-eyebrow">Workspace Required</span>
            <h2>还没有选定 Workspace 文件夹</h2>
            <p>
              应用不再自动创建默认 `projects/`。请选择一个现有文件夹，或者输入一个新路径；只有在你明确选择后，系统才会创建并补齐标准目录结构。
            </p>
            <p className="workspace-empty-path">{workspaceRootLabel}</p>
            {project?.workspace_error && <p className="workspace-empty-warning">{project.workspace_error}</p>}
            <div className="workspace-empty-actions">
              <button className="primary" disabled={isBusy} onClick={chooseWorkspaceRoot} type="button">
                <FolderOpen size={18} />选择 Workspace 文件夹
              </button>
              <button disabled={isBusy} onClick={() => setShowWorkspaceRootModal(true)} type="button">
                <Settings size={18} />手动输入路径
              </button>
            </div>
          </div>
        </section>
      ) : (
      <section
        className={`workspace-grid ${workspaceMode === 'analysis' ? 'analysis-mode' : ''} ${workspaceMode === 'manuscript' && !previewFile ? 'manuscript-mode' : ''}`}
        style={workspaceMode === 'manuscript' && !previewFile ? { '--manuscript-ai-width': `${manuscriptAiWidth}px` } : undefined}
      >
        <aside className="project-panel">
          <section className="panel-section">
            <div className="panel-heading">
              <FolderOpen size={16} />
              <span>当前 Workspace</span>
            </div>
            <p className="workspace-overview-name">{workspaceDisplayName}</p>
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
                <details
                  className={`${canDropIntoCategory(group.category) ? 'file-drop-enabled' : ''}${dragOverCategory === group.category ? ' file-drop-target' : ''}`}
                  key={group.category}
                  onDragOver={(event) => {
                    if (!canDropIntoCategory(group.category)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    if (dragOverCategory !== group.category) {
                      setDragOverCategory(group.category);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!canDropIntoCategory(group.category) || !draggedFile) {
                      clearFileDragState();
                      return;
                    }
                    moveWorkspaceFile(draggedFile, group.category);
                  }}
                  open={['Manuscript', 'Sources', 'Data'].includes(group.category)}
                >
                  <summary>{categoryIcon(group.category)}{group.category}</summary>
                  {group.files.length === 0 && <p className="empty-line">No files</p>}
                  {group.files.map((file) => {
                    const isSwitchableManuscript = group.category === 'Manuscript' && file.extension === 'qmd';
                    const isActiveFile = file.relative_path === activeManuscript;
                    return (
                      <div
                        className={`file-row ${isActiveFile || previewFile?.relative_path === file.relative_path ? 'active' : ''}${draggedFile?.relative_path === file.relative_path ? ' dragging' : ''}`}
                        draggable={Boolean(file.can_move) && !isBusy}
                        key={file.relative_path}
                        onDragEnd={clearFileDragState}
                        onDragStart={(event) => startFileDrag(event, file)}
                      >
                        <button
                          className={`file-row-button ${isActiveFile || previewFile?.relative_path === file.relative_path ? 'active' : ''}`}
                          disabled={isBusy}
                          onClick={() => {
                            if (isSwitchableManuscript) {
                              switchManuscript(file.relative_path);
                              return;
                            }
                            setPreviewFile(file);
                          }}
                          title={isSwitchableManuscript ? `切换到 ${file.name}` : `预览 ${file.name}`}
                          type="button"
                        >
                          <span>{file.name}</span>
                        </button>
                        <div className="file-row-side">
                          <small>{file.size_label}</small>
                          <div className="file-row-actions">
                            {file.can_move && (
                              <span className="file-action-hint" title="拖到其他分组以移动">
                                <GripVertical size={14} />
                              </span>
                            )}
                            {file.can_rename && (
                              <button
                                className="file-icon-button"
                                disabled={isBusy}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  renameWorkspaceFile(file);
                                }}
                                title={`重命名 ${file.name}`}
                                type="button"
                              >
                                <Pencil size={14} />
                              </button>
                            )}
                            {file.can_delete && (
                              <button
                                className="file-icon-button danger"
                                disabled={isBusy}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  deleteWorkspaceFile(file);
                                }}
                                title={`删除 ${file.name}`}
                                type="button"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </details>
              ))}
            </div>
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
                  <button
                    disabled={isBusy || !editorHistoryState.canUndo}
                    onClick={undoEditorChange}
                    title="撤回上一笔编辑（Cmd+Z）"
                    type="button"
                  >
                    <RotateCcw size={18} />撤回
                  </button>
                  <button
                    disabled={isBusy || !editorHistoryState.canRedo}
                    onClick={redoEditorChange}
                    title="重做（Shift+Cmd+Z）"
                    type="button"
                  >
                    <Redo2 size={18} />重做
                  </button>
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
                  onChange={handleEditorChange}
                  onKeyDown={handleEditorKeyDown}
                  onSelect={captureSelection}
                  spellCheck={true}
                />
              )}
            </section>

            <div
              aria-label="调整 AI 协作面板宽度"
              className="workspace-resize-handle"
              onDoubleClick={() => setManuscriptAiWidth(500)}
              onMouseDown={startManuscriptResize}
              role="separator"
              title="拖拽调整 AI 协作面板宽度，双击恢复默认"
            />

            <aside className="ai-panel">
              <div className="panel-heading">
                <Sparkles size={16} />
                <span>AI 协作</span>
              </div>
              <ChatPanel
                tool="AI 协作"
                title="持续协作会话"
                messages={editorMessages}
                isBusy={editorChatBusy}
                onClear={clearEditorConversation}
                onSend={sendEditorMessage}
                placeholder="输入你想让 AI 如何修改，例如：润色摘要、压缩引言第二段、找出最该重写的段落并直接改。"
                renderResult={renderEditorResult}
                sendDisabled={!activeManuscript}
                contextSlot={(
                  <div className="editor-chat-context">
                    <div className="selection-box">
                      <span>{editorSelectionLabel}</span>
                      <p>
                        {editorNeedsFreshSelection
                          ? '本轮建议已经处理完成。请在正文里重新选中一段文字，再继续新的协作。'
                          : editorTargetText
                            ? editorTargetText.slice(0, 260)
                            : '可以先选中一段精确修改，也可以不选中，直接让 AI 根据你的指令在当前文稿里自行判断并提出可应用的改写。'}
                      </p>
                    </div>
                    <section className="source-strip">
                      <strong>已索引资料</strong>
                      <span>{sources.length} files</span>
                    </section>
                  </div>
                )}
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
      )}

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
      {showWorkspaceRootModal && (
        <WorkspaceRootModal
          initialPath={project?.projects_root || project?.workspace_suggestion || ''}
          isBusy={isBusy}
          onClose={() => setShowWorkspaceRootModal(false)}
          onSave={updateWorkspaceRoot}
        />
      )}
      {showCreateManuscript && (
        <NewManuscriptModal
          isBusy={isBusy}
          onClose={() => setShowCreateManuscript(false)}
          onCreate={createManuscript}
        />
      )}
    </main>
  );
}

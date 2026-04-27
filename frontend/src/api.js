function resolveApiBase() {
  // Electron passes the dynamically assigned backend port as a URL query param
  const params = new URLSearchParams(window.location.search);
  const port = params.get('backendPort');
  if (port) return `http://127.0.0.1:${port}/api`;
  return import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8011/api';
}

export const API = resolveApiBase();

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isRetriableNetworkError(error) {
  const message = String(error?.message || '');
  return /failed to fetch|networkerror|load failed/i.test(message);
}

async function fetchWithRetry(url, options = {}, attempts = 4) {
  const method = String(options.method || 'GET').toUpperCase();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      const canRetry = method === 'GET' && attempt < attempts && isRetriableNetworkError(error);
      if (!canRetry) {
        throw error;
      }
      await sleep(350 * attempt);
    }
  }

  throw new Error('请求失败，请稍后重试。');
}

async function parseResponse(response) {
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(text);
    }
  }
  if (!response.ok) {
    throw new Error(data.detail || '操作失败，请稍后再试。');
  }
  return data;
}

function jsonOptions(method, payload) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function withQuery(path, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export async function request(path, options = {}) {
  try {
    const response = await fetchWithRetry(`${API}${path}`, options);
    return parseResponse(response);
  } catch (error) {
    if (isRetriableNetworkError(error)) {
      throw new Error('无法连接到后端服务。若刚重启 Docker，请等待 1-2 秒后重试。');
    }
    throw error;
  }
}

export function buildProjectFileUrl(relativePath) {
  return `${API}/project/file?relative_path=${encodeURIComponent(relativePath)}`;
}

export const studioApi = {
  getProject() {
    return request('/project');
  },
  getDocument() {
    return request('/document');
  },
  renameProjectFile(relativePath, newName) {
    return request('/project/file/rename', jsonOptions('POST', { relative_path: relativePath, new_name: newName }));
  },
  moveProjectFile(relativePath, targetCategory) {
    return request('/project/file/move', jsonOptions('POST', { relative_path: relativePath, target_category: targetCategory }));
  },
  deleteProjectFile(relativePath) {
    return request('/project/file/delete', jsonOptions('POST', { relative_path: relativePath }));
  },
  openDocument(relativePath) {
    return request('/document/open', jsonOptions('POST', { relative_path: relativePath }));
  },
  createDocument(filename) {
    return request('/document/create', jsonOptions('POST', { filename }));
  },
  getProviders() {
    return request('/providers');
  },
  getMemory() {
    return request('/memory');
  },
  createProject(name) {
    return request('/project/create', jsonOptions('POST', { name }));
  },
  openProject(projectId) {
    return request('/project/open', jsonOptions('POST', { project_id: projectId }));
  },
  updateWorkspaceRoot(path) {
    return request('/workspace/root', jsonOptions('POST', { path }));
  },
  chooseWorkspaceRoot() {
    return request('/workspace/root/choose', { method: 'POST' });
  },
  saveDocument(content) {
    return request('/document', jsonOptions('POST', { content }));
  },
  analyzeData(relativePath, prompt) {
    return request('/analysis/data', jsonOptions('POST', { relative_path: relativePath, prompt }));
  },
  insertDataFigure(payload) {
    return request('/analysis/data/insert', jsonOptions('POST', payload));
  },
  createMindmap(prompt) {
    return request('/analysis/mindmap', jsonOptions('POST', { prompt }));
  },
  insertMindmap(quartoBlock, sectionTitle) {
    return request('/analysis/mindmap/insert', jsonOptions('POST', {
      quarto_block: quartoBlock,
      section_title: sectionTitle || undefined,
    }));
  },
  createBrief(payload) {
    return request('/analysis/brief', jsonOptions('POST', payload));
  },
  analyzeLiterature(query) {
    return request('/literature/analyze', jsonOptions('POST', { query }));
  },
  importLiterature(cacheId, downloadOriginal) {
    return request('/literature/import', jsonOptions('POST', {
      cache_id: cacheId,
      download_original: downloadOriginal,
    }));
  },
  applySuggestion(originalSegment, replacement, suggestionId, operations = []) {
    return request('/ai/apply', jsonOptions('POST', {
      original_segment: originalSegment || undefined,
      replacement: replacement || '',
      operations,
      suggestion_id: suggestionId || undefined,
    }));
  },
  rejectSuggestion(originalSegment, suggestion, suggestionId) {
    return request('/ai/reject', jsonOptions('POST', {
      original_segment: originalSegment,
      suggestion,
      suggestion_id: suggestionId || undefined,
    }));
  },
  exportDocx() {
    return request('/export/docx', { method: 'POST' });
  },
  saveSettings(payload) {
    return request('/settings', jsonOptions('POST', payload));
  },
};

export const chatApi = {
  load(tool, options = {}) {
    return request(withQuery(`/chat/${tool}`, { chat_key: options.chatKey || '' }));
  },
  send(tool, message, history, context = {}) {
    return request(`/chat/${tool}`, jsonOptions('POST', { message, history, context }));
  },
  clear(tool, options = {}) {
    return request(withQuery(`/chat/${tool}`, { chat_key: options.chatKey || '' }), { method: 'DELETE' });
  },
};

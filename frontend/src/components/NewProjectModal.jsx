import React, { useState } from 'react';
import { FolderPlus, X } from 'lucide-react';

export function NewProjectModal({ isBusy, onClose, onCreate }) {
  const [projectName, setProjectName] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    if (!projectName.trim()) return;
    await onCreate(projectName);
  }

  return (
    <div className="modal-backdrop">
      <section className="modal modal-compact">
        <header>
          <h2>新建 Workspace</h2>
          <button onClick={onClose} title="关闭" type="button">
            <X size={18} />
          </button>
        </header>
        <form className="modal-form" onSubmit={handleSubmit}>
          <label>
            Workspace 名称
            <input
              autoFocus
              disabled={isBusy}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="e.g. higher-education-round-2"
              value={projectName}
            />
            <p className="field-hint">
              系统会自动创建并补齐标准目录结构：`data`、`sources`、`figures`、`templates`、`outputs`、`memory`。
            </p>
          </label>
          <div className="modal-actions">
            <button onClick={onClose} type="button">
              取消
            </button>
            <button className="primary" disabled={isBusy || !projectName.trim()} type="submit">
              <FolderPlus size={18} />创建
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import { Save, X } from 'lucide-react';

export function WorkspaceRootModal({ initialPath, isBusy, onClose, onSave }) {
  const [path, setPath] = useState(initialPath || '');

  useEffect(() => {
    setPath(initialPath || '');
  }, [initialPath]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!path.trim()) return;
    await onSave(path);
  }

  return (
    <div className="modal-backdrop">
      <section className="modal modal-compact">
        <header>
          <h2>Workspace 根目录</h2>
          <button onClick={onClose} title="关闭" type="button">
            <X size={18} />
          </button>
        </header>
        <form className="modal-form" onSubmit={handleSubmit}>
          <label>
            文件夹路径
            <input
              autoFocus
              disabled={isBusy}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/Users/you/Documents/thesis-projects"
              value={path}
            />
            <p className="field-hint">
              这里填写的就是当前 Workspace 本身。系统只会在你明确保存这个路径后，才创建文件夹并补齐标准目录结构；下次启动也会继续打开它。
            </p>
          </label>
          <div className="modal-actions">
            <button onClick={onClose} type="button">
              取消
            </button>
            <button className="primary" disabled={isBusy || !path.trim()} type="submit">
              <Save size={18} />保存路径
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

import React, { useState } from 'react';
import { FilePlus2, X } from 'lucide-react';

export function NewManuscriptModal({ isBusy, onClose, onCreate }) {
  const [filename, setFilename] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    if (!filename.trim()) return;
    await onCreate(filename);
  }

  return (
    <div className="modal-backdrop">
      <section className="modal modal-compact">
        <header>
          <h2>新建 Manuscript</h2>
          <button onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>
        <form className="modal-form" onSubmit={handleSubmit}>
          <label>
            文件名
            <input
              autoFocus
              disabled={isBusy}
              onChange={(event) => setFilename(event.target.value)}
              placeholder="e.g. chapter-2-review"
              value={filename}
            />
            <p className="field-hint">只需要输入名字，系统会自动保存为 `.qmd` 并切换过去。</p>
          </label>
          <div className="modal-actions">
            <button onClick={onClose} type="button">
              取消
            </button>
            <button className="primary" disabled={isBusy || !filename.trim()} type="submit">
              <FilePlus2 size={18} />创建
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

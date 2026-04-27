import React, { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';

import { buildProjectFileUrl } from '../api';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'svg', 'webp']);
const TABLE_EXTS = new Set(['csv']);
const MAX_FULL_ROWS = 20;
const MAX_COMPACT_ROWS = 5;

function parseCSVRow(line) {
  const result = [];
  let inQuote = false;
  let field = '';
  for (const ch of line) {
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(field.trim());
      field = '';
    } else {
      field += ch;
    }
  }
  result.push(field.trim());
  return result;
}

async function fetchCSVPreview(relativePath, maxRows, signal) {
  const url = buildProjectFileUrl(relativePath);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('Failed to fetch file');
  const text = await response.text();
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [], total: 0 };
  const headers = parseCSVRow(lines[0]);
  const dataLines = lines.slice(1);
  const rows = dataLines.slice(0, maxRows).map(parseCSVRow);
  return { headers, rows, total: dataLines.length };
}

function TablePreview({ headers, rows, total, compact }) {
  return (
    <div className={compact ? 'data-inline-preview' : undefined}>
      {compact && (
        <div className="data-inline-preview-label">
          预览 · 前 {rows.length} 行 / 共 {total} 行
        </div>
      )}
      <div className="file-preview-table-wrap">
        <table className="file-preview-table">
          <thead>
            <tr>
              {headers.map((h, i) => <th key={i}>{h || `列${i + 1}`}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {headers.map((_, ci) => (
                  <td key={ci}>{row[ci] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!compact && (
        <p className="file-preview-row-note">
          显示前 {rows.length} 行 / 共 {total} 行 · {headers.length} 列
        </p>
      )}
    </div>
  );
}

export function FilePreview({ file, onClose, compact = false }) {
  const ext = (file?.extension || '').toLowerCase();
  const maxRows = compact ? MAX_COMPACT_ROWS : MAX_FULL_ROWS;

  const [csvData, setCsvData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!TABLE_EXTS.has(ext)) return;

    const controller = new AbortController();
    setLoading(true);
    setCsvData(null);

    fetchCSVPreview(file.relative_path, maxRows, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setCsvData(data); })
      .catch(() => { if (!controller.signal.aborted) setCsvData(null); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => controller.abort();
  }, [file?.relative_path, ext, maxRows]);

  if (!file) return null;

  // ── Compact mode (inline in AnalysisWorkspace) ──────────
  if (compact) {
    if (loading) {
      return (
        <div className="data-inline-preview">
          <div className="data-inline-preview-label">加载中...</div>
        </div>
      );
    }
    if (csvData) {
      return (
        <TablePreview
          compact
          headers={csvData.headers}
          rows={csvData.rows}
          total={csvData.total}
        />
      );
    }
    // XLSX or load failure — metadata card
    return (
      <div className="data-inline-preview">
        <div className="data-inline-preview-label">
          {file.name} · {file.size_label} · Excel 文件，已提取内容供 AI 分析
        </div>
      </div>
    );
  }

  // ── Full mode (main area takeover) ──────────────────────
  function renderBody() {
    if (IMAGE_EXTS.has(ext)) {
      return (
        <img
          alt={file.name}
          className="file-preview-image"
          src={buildProjectFileUrl(file.relative_path)}
        />
      );
    }
    if (TABLE_EXTS.has(ext)) {
      if (loading) return <p className="file-preview-row-note">加载中...</p>;
      if (csvData) {
        return (
          <TablePreview
            headers={csvData.headers}
            rows={csvData.rows}
            total={csvData.total}
          />
        );
      }
      return <p className="file-preview-row-note">无法加载文件内容。</p>;
    }
    // PDF, DOCX, XLSX, or unknown
    return (
      <div className="file-preview-meta-card">
        <strong>{file.name}</strong>
        <span>{file.size_label}</span>
        <span>
          {ext === 'pdf' || ext === 'docx'
            ? '已提取文本供 AI 分析，无法在此渲染原始格式。'
            : ext === 'xlsx' || ext === 'xlsm'
              ? 'Excel 文件，已提取内容供 AI 分析。'
              : '此文件类型暂不支持预览。'}
        </span>
      </div>
    );
  }

  const metaSuffix = csvData ? `${csvData.total} 行 · ${csvData.headers.length} 列` : file.size_label;

  return (
    <section className="file-preview-panel">
      <div className="file-preview-header">
        <div className="file-preview-header-left">
          <span className="file-preview-title">{file.name}</span>
          <span className="file-preview-meta">{metaSuffix}</span>
        </div>
        {onClose && (
          <button onClick={onClose} type="button">
            <ArrowLeft size={15} />
            返回
          </button>
        )}
      </div>
      <div className="file-preview-body">{renderBody()}</div>
    </section>
  );
}

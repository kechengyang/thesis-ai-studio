import React, { useEffect, useState } from 'react';
import mermaid from 'mermaid';

let mermaidInitialized = false;

function ensureMermaid() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'default',
    themeVariables: {
      primaryTextColor: '#1a1a2e',
      lineColor: '#6b7280',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '14px',
    },
  });
  mermaidInitialized = true;
}

export function MermaidPreview({ code }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function renderMermaid() {
      const trimmed = (code || '').trim();
      if (!trimmed) {
        setSvg('');
        setError('');
        return;
      }

      ensureMermaid();
      try {
        const renderId = `mermaid-${Math.random().toString(36).slice(2)}`;
        const rendered = await mermaid.render(renderId, trimmed);
        if (cancelled) return;
        setSvg(rendered.svg);
        setError('');
      } catch (renderError) {
        if (cancelled) return;
        setSvg('');
        setError(renderError instanceof Error ? renderError.message : 'Mermaid 渲染失败。');
      }
    }

    renderMermaid();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return <p className="analysis-error">{error}</p>;
  }

  if (!svg) {
    return <p className="empty-line">暂无 Mermaid 预览。</p>;
  }

  return <div className="mermaid-preview" dangerouslySetInnerHTML={{ __html: svg }} />;
}

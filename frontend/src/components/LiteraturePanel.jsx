import React from 'react';
import { Download, Search } from 'lucide-react';

function LiteraturePlaceholder() {
  return (
    <div className="analysis-placeholder">
      <strong>Assessment will appear here</strong>
      <p>运行后会给出摘要、与当前结构的相关性、结构建议、引用切口，以及是否建议导入 Sources。</p>
    </div>
  );
}

function LiteratureBlock({ children, title }) {
  return (
    <div className="literature-block">
      <span>{title}</span>
      {children}
    </div>
  );
}

export function LiteraturePanel({
  isBusy,
  literatureQuery,
  literatureResult,
  onAnalyze,
  onImport,
  outlineTitles,
  setLiteratureQuery,
}) {
  const candidate = literatureResult?.candidate || null;
  const analysis = literatureResult?.analysis || null;
  const outlinePreview = (outlineTitles || []).slice(0, 5);

  return (
    <section className="literature-panel">
      <div className="analysis-grid-2 literature-grid">
        <section className="analysis-section-card">
          <div className="analysis-section-head">
            <span>Lookup</span>
            <strong>Title / DOI / URL</strong>
          </div>
          <p className="literature-copy">输入论文标题、DOI 或链接，先判断它和当前稿件结构是否匹配，再决定是否导入到 Sources。</p>
          <div className="literature-query-row">
            <input
              value={literatureQuery}
              onChange={(event) => setLiteratureQuery(event.target.value)}
              placeholder="例如：文章标题 / DOI / https://..."
            />
            <button onClick={onAnalyze} disabled={isBusy || !literatureQuery.trim()} title="分析资料" type="button">
              <Search size={16} />
            </button>
          </div>
          {outlinePreview.length > 0 && (
            <>
              <span className="analysis-inline-label">Current outline anchors</span>
              <div className="analysis-outline-preview">
                {outlinePreview.map((title, index) => (
                  <span key={`${title}-${index}`}>{title}</span>
                ))}
              </div>
            </>
          )}
          <p className="analysis-inline-note">如果这篇文献适合当前写作结构，再导入 Sources，后续做 literature review 时就能直接引用。</p>
        </section>

        <section className="analysis-section-card">
          <div className="analysis-section-head">
            <span>Assessment</span>
            <strong>{analysis?.title || candidate?.title || 'Awaiting literature candidate'}</strong>
          </div>
          {literatureResult ? (
            <div className="literature-result">
              <p className="literature-meta">
                {[analysis?.year || candidate?.year, analysis?.venue || candidate?.venue].filter(Boolean).join(' · ') || 'Metadata unavailable'}
              </p>
              {analysis?.summary && (
                <LiteratureBlock title="总结">
                  <p>{analysis.summary}</p>
                </LiteratureBlock>
              )}
              {analysis?.relevance && (
                <LiteratureBlock title="与当前文章结构的相关性">
                  <p>{analysis.relevance}</p>
                </LiteratureBlock>
              )}
              {analysis?.structure_suggestions?.length > 0 && (
                <LiteratureBlock title="结构建议">
                  <ul>
                    {analysis.structure_suggestions.map((item, index) => <li key={index}>{item}</li>)}
                  </ul>
                </LiteratureBlock>
              )}
              {analysis?.citation_uses?.length > 0 && (
                <LiteratureBlock title="可如何引用">
                  <ul>
                    {analysis.citation_uses.map((item, index) => <li key={index}>{item}</li>)}
                  </ul>
                </LiteratureBlock>
              )}
              {analysis?.import_recommendation && (
                <LiteratureBlock title="导入建议">
                  <p>{analysis.import_recommendation}</p>
                </LiteratureBlock>
              )}
              <div className="literature-actions">
                <button onClick={() => onImport(false)} disabled={isBusy} title="导入摘要" type="button">
                  导入摘要
                </button>
                <button
                  onClick={() => onImport(true)}
                  disabled={isBusy || !literatureResult.download_available}
                  title="下载并导入原文"
                  type="button"
                >
                  <Download size={16} />下载原文
                </button>
              </div>
            </div>
          ) : (
            <LiteraturePlaceholder />
          )}
        </section>
      </div>
    </section>
  );
}

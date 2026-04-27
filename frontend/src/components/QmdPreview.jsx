import React, { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { buildProjectFileUrl } from '../api';

function splitFrontmatter(content) {
  if (!content.startsWith('---\n')) {
    return { frontmatter: '', body: content };
  }
  const closingIndex = content.indexOf('\n---\n', 4);
  if (closingIndex === -1) {
    return { frontmatter: '', body: content };
  }
  return {
    frontmatter: content.slice(4, closingIndex).trim(),
    body: content.slice(closingIndex + 5).trim(),
  };
}

function extractTitle(frontmatter) {
  const titleLine = frontmatter
    .split('\n')
    .find((line) => line.trim().startsWith('title:'));
  if (!titleLine) {
    return '';
  }
  return titleLine
    .split(':')
    .slice(1)
    .join(':')
    .trim()
    .replace(/^["']|["']$/g, '');
}

function stripQuartoMarkup(content) {
  return content
    .replace(/(^|\n):::.*(\n|$)/g, '\n')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)\{[^}]+\}/g, '![$1]($2)')
    .replace(/\[([^\]]+)\]\(([^)]+)\)\{[^}]+\}/g, '[$1]($2)');
}

function isExternalLink(value) {
  return /^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith('data:') || value.startsWith('#');
}

function normalizeRelativePath(value) {
  return value.replace(/^\.?\//, '');
}

function buildHeadingLineMap(content, outline) {
  const lineMap = new Map();
  let outlineIndex = 0;

  content.split('\n').forEach((line, index) => {
    if (!/^#{1,6}\s+/.test(line.trim())) {
      return;
    }
    const item = outline[outlineIndex];
    if (item) {
      lineMap.set(index + 1, item);
    }
    outlineIndex += 1;
  });

  return lineMap;
}

function renderHeading(Tag, lineMap, activeOutlineId, props) {
  const item = lineMap.get(props.node?.position?.start?.line) || null;
  const className = [props.className, item?.anchorId === activeOutlineId ? 'is-target' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <Tag
      {...props}
      className={className || undefined}
      data-outline-id={item?.anchorId || undefined}
      id={item?.anchorId || undefined}
    />
  );
}

export function QmdPreview({ activeOutlineId = '', content, containerRef = null, outline = [] }) {
  const { frontmatter, body } = splitFrontmatter(content || '');
  const previewTitle = extractTitle(frontmatter);
  const previewBody = stripQuartoMarkup(body);
  const headingLineMap = buildHeadingLineMap(previewBody, outline);

  useEffect(() => {
    if (!containerRef?.current || !activeOutlineId) return;
    const target = containerRef.current.querySelector(`[data-outline-id="${activeOutlineId}"]`);
    if (target) {
      target.scrollIntoView({ block: 'start' });
    }
  }, [activeOutlineId, containerRef, content]);

  return (
    <div className="editor-preview" ref={containerRef}>
      <p className="preview-note">本地 QMD 预览，仅用于快速查看结构和排版，不等同于 Quarto 最终输出。</p>
      <article className="qmd-preview">
        {previewTitle && <h1>{previewTitle}</h1>}
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a({ href, children }) {
              const finalHref = href && !isExternalLink(href)
                ? buildProjectFileUrl(normalizeRelativePath(href))
                : href;
              return <a href={finalHref} rel="noreferrer" target="_blank">{children}</a>;
            },
            img({ alt, src }) {
              if (!src) {
                return null;
              }
              const finalSrc = isExternalLink(src)
                ? src
                : buildProjectFileUrl(normalizeRelativePath(src));
              return <img alt={alt || ''} src={finalSrc} />;
            },
            h1(props) {
              return renderHeading('h1', headingLineMap, activeOutlineId, props);
            },
            h2(props) {
              return renderHeading('h2', headingLineMap, activeOutlineId, props);
            },
            h3(props) {
              return renderHeading('h3', headingLineMap, activeOutlineId, props);
            },
            h4(props) {
              return renderHeading('h4', headingLineMap, activeOutlineId, props);
            },
            h5(props) {
              return renderHeading('h5', headingLineMap, activeOutlineId, props);
            },
            h6(props) {
              return renderHeading('h6', headingLineMap, activeOutlineId, props);
            },
          }}
        >
          {previewBody || '_暂无可预览内容_'}
        </ReactMarkdown>
      </article>
    </div>
  );
}

import { useMemo } from "react";
import type { RendererObject } from "marked";
import { createXiangyingMarked } from "../../shared/markdown-lexer";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/gu, (character) => HTML_ESCAPES[character]!);
}

const SAFE_LINK_PROTOCOL = /^(?:https?:|mailto:|tel:)/iu;
const EXPLICIT_PROTOCOL = /^[a-z][a-z0-9+.-]*:/iu;
const PRIVATE_ASSET_SOURCE =
  /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=[?#]|$)/iu;

function safeLinkHref(value: string | null | undefined) {
  const href = value?.trim() ?? "";
  if (!href) return null;
  if (SAFE_LINK_PROTOCOL.test(href)) return href;
  if (EXPLICIT_PROTOCOL.test(href)) return null;
  return href;
}

function safeImageHref(value: string | null | undefined) {
  const href = value?.trim() ?? "";
  return PRIVATE_ASSET_SOURCE.test(href) ? href : null;
}

const renderer: RendererObject = {
  html({ text }) {
    return escapeHtml(text);
  },
  link({ href, title, tokens }) {
    const safeHref = safeLinkHref(href);
    const label = this.parser.parseInline(tokens);
    if (!safeHref) return label;
    return `<a href="${escapeHtml(safeHref)}"${
      title ? ` title="${escapeHtml(title)}"` : ""
    } target="_blank" rel="noopener noreferrer">${label}</a>`;
  },
  image({ href, title, text }) {
    const safeHref = safeImageHref(href);
    if (!safeHref)
      return `<span class="memo-image-placeholder">${escapeHtml(text || "图片")}</span>`;
    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text || "")}"${
      title ? ` title="${escapeHtml(title)}"` : ""
    } loading="lazy">`;
  },
};

const memoMarked = createXiangyingMarked();
memoMarked.use({ renderer });

export function renderMemoMarkdown(markdown: string) {
  return memoMarked.parse(markdown) as string;
}

export function MemoMarkdown({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderMemoMarkdown(markdown), [markdown]);
  return <div className="note-prose memo-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

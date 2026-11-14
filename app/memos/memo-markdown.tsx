import { useMemo } from "react";
import type { RendererObject, Token, Tokens } from "marked";
import {
  createXiangyingMarked,
  findWikiLinkStart,
  tokenizeWikiLink,
} from "../../shared/markdown-lexer";
import { findTagRanges } from "../../shared/tags";

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
const TABLE_PATTERN = /<table>[\s\S]*?<\/table>/gu;

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

function renderMemoText(text: string) {
  const ranges = findTagRanges(text);
  if (ranges.length === 0) return escapeHtml(text);

  let html = "";
  let cursor = 0;
  for (const range of ranges) {
    html += escapeHtml(text.slice(cursor, range.start));
    html += `<span class="memo-tag">${escapeHtml(text.slice(range.start, range.end))}</span>`;
    cursor = range.end;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}

function withoutCheckboxes(tokens: Token[]): Token[] {
  return tokens.flatMap((token) => {
    if (token.type === "checkbox") return [];
    if (!("tokens" in token) || !Array.isArray(token.tokens)) return [token];
    return [
      {
        ...token,
        tokens: withoutCheckboxes(token.tokens),
      } as Token,
    ];
  });
}

function wrapMemoTables(html: string) {
  return html.replace(TABLE_PATTERN, (table) => `<div class="table-scroll-shell">${table}</div>`);
}

const renderer: RendererObject = {
  text(token) {
    if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length)
      return this.parser.parseInline(token.tokens);
    return renderMemoText(token.text);
  },
  list(token) {
    const groups: Array<{ task: boolean; items: Tokens.ListItem[] }> = [];
    for (const item of token.items) {
      const task = Boolean(item.task);
      const current = groups.at(-1);
      if (current?.task === task) current.items.push(item);
      else groups.push({ task, items: [item] });
    }
    return groups
      .map((group) => {
        const tag = group.task || !token.ordered ? "ul" : "ol";
        const type = group.task ? ' data-type="taskList"' : "";
        const start =
          !group.task && token.ordered && token.start !== 1 && token.start !== ""
            ? ` start="${token.start}"`
            : "";
        return `<${tag}${start}${type}>${group.items
          .map((item) => this.listitem(item))
          .join("")}</${tag}>\n`;
      })
      .join("");
  },
  listitem(item) {
    if (!item.task) return `<li>${this.parser.parse(item.tokens)}</li>\n`;

    const checked = Boolean(item.checked);
    const contentTokens = withoutCheckboxes(item.tokens);
    const nestedLists = contentTokens.filter((token) => token.type === "list");
    const body = item.loose
      ? this.parser.parse(contentTokens)
      : `<p>${this.parser.parseInline(
          contentTokens.filter((token) => token.type !== "list"),
        )}</p>${nestedLists.map((token) => this.parser.parse([token])).join("")}`;
    return `<li data-checked="${checked}" data-type="taskItem"><label><input${
      checked ? ' checked=""' : ""
    } type="checkbox"><span></span></label><div>${body}</div></li>\n`;
  },
  html({ text }) {
    return escapeHtml(text);
  },
  code({ text, lang }) {
    const language = lang?.trim().split(/\s+/u)[0] ?? "";
    return `<pre>${
      language
        ? `<span class="code-block-language" aria-hidden="true">${escapeHtml(language)}</span>`
        : ""
    }<code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(text)}\n</code></pre>\n`;
  },
  link({ href, tokens }) {
    const safeHref = safeLinkHref(href);
    const label = this.parser.parseInline(tokens);
    if (!safeHref) return label;
    return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  },
  image({ href, text }) {
    const safeHref = safeImageHref(href);
    if (!safeHref)
      return `<span class="memo-image-placeholder">${escapeHtml(text || "图片")}</span>`;
    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text || "")}" loading="lazy">`;
  },
};

const memoMarked = createXiangyingMarked();
memoMarked.use({
  extensions: [
    {
      name: "wikiLink",
      level: "inline",
      start: findWikiLinkStart,
      tokenizer: tokenizeWikiLink,
      renderer(token) {
        const { target, alias } = token as unknown as { target: string; alias?: string };
        return `<span class="editor-wiki-link">${escapeHtml(alias || target)}</span>`;
      },
    },
  ],
});
memoMarked.use({ renderer });

export function renderMemoMarkdown(markdown: string) {
  return wrapMemoTables(memoMarked.parse(markdown) as string);
}

export function MemoMarkdown({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderMemoMarkdown(markdown), [markdown]);
  return (
    <div
      className="note-prose read-only-prose memo-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

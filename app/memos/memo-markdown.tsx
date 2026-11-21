import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import { copyCodeBlockText } from "../editor/code-block-copy";
import { readColumnWidthsFromDelimiter } from "../editor/table-extensions";
import type { RendererObject, Token, Tokens } from "marked";
import {
  createXiangyingMarked,
  findWikiLinkStart,
  tokenizeWikiLink,
} from "../../shared/markdown-lexer";
import { findTagRanges } from "../../shared/tags";
import { findLongTextRuns } from "../../shared/long-text-wrap";

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

function renderWrappedText(text: string, inlineCode = false) {
  let html = "";
  let cursor = 0;
  for (const run of findLongTextRuns(text, inlineCode)) {
    html += escapeHtml(text.slice(cursor, run.index));
    html += `<span class="long-text-run">${escapeHtml(run[0])}</span>`;
    cursor = run.index + run[0].length;
  }
  return html + escapeHtml(text.slice(cursor));
}

const SAFE_LINK_PROTOCOL = /^(?:https?:|mailto:|tel:)/iu;
const EXPLICIT_PROTOCOL = /^[a-z][a-z0-9+.-]*:/iu;
const PRIVATE_ASSET_SOURCE =
  /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=[?#]|$)/iu;
const COPY_BUTTON = `<button class="code-block-copy-button" type="button" aria-label="复制代码"><svg data-copy-icon="idle" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg><svg data-copy-icon="copied" hidden xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg><svg data-copy-icon="error" hidden xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4m0 4h.01"></path></svg><span class="visually-hidden" aria-live="polite"></span></button>`;

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
  if (ranges.length === 0) return renderWrappedText(text);

  let html = "";
  let cursor = 0;
  for (const range of ranges) {
    html += renderWrappedText(text.slice(cursor, range.start));
    html += `<span class="memo-tag">${renderWrappedText(text.slice(range.start, range.end))}</span>`;
    cursor = range.end;
  }
  html += renderWrappedText(text.slice(cursor));
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
    } type="checkbox" disabled><span></span></label><div>${body}</div></li>\n`;
  },
  html({ text }) {
    return escapeHtml(text);
  },
  table({ raw, header, rows }) {
    const widths = readColumnWidthsFromDelimiter(raw);
    const columns = widths
      ? `<colgroup>${widths.map((width) => `<col style="width: ${width}px">`).join("")}</colgroup>`
      : "";
    const width = widths
      ? ` style="width: ${widths.reduce((total, value) => total + value, 0)}px"`
      : "";
    const body = [header, ...rows]
      .map((row) => this.tablerow({ text: row.map((cell) => this.tablecell(cell)).join("") }))
      .join("");
    return `<div class="table-scroll-shell"><table${width}>${columns}<tbody>${body}</tbody></table></div>\n`;
  },
  code({ text, lang }) {
    const language = lang?.trim().split(/\s+/u)[0] ?? "";
    return `<pre>${
      language
        ? `<span class="code-block-language" aria-hidden="true">${escapeHtml(language)}</span>`
        : ""
    }${COPY_BUTTON}<code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${renderWrappedText(text)}\n</code></pre>\n`;
  },
  codespan({ text }) {
    return `<code>${renderWrappedText(text, true)}</code>`;
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
        return `<span class="editor-wiki-link">${renderWrappedText(alias || target)}</span>`;
      },
    },
  ],
});
memoMarked.use({ renderer });

export function renderMemoMarkdown(markdown: string) {
  return memoMarked.parse(markdown) as string;
}

export function MemoMarkdown({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderMemoMarkdown(markdown), [markdown]);
  const rootRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef(new Map<HTMLButtonElement, number>());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, [html]);

  const onClick = async (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("button.code-block-copy-button");
    if (!button || !event.currentTarget.contains(button)) return;
    event.stopPropagation();
    const code = button.parentElement?.querySelector("code");
    if (!code) return;
    const text = code.textContent ?? "";
    let status: "copied" | "error";
    try {
      await copyCodeBlockText(text.endsWith("\n") ? text.slice(0, -1) : text);
      status = "copied";
    } catch {
      status = "error";
    }
    if (!rootRef.current?.contains(button)) return;
    const update = (next: "idle" | "copied" | "error") => {
      const label = next === "copied" ? "代码已复制" : next === "error" ? "复制失败" : "复制代码";
      button.classList.toggle("is-copied", next === "copied");
      button.classList.toggle("is-error", next === "error");
      button.setAttribute("aria-label", label);
      const announcement = button.querySelector("[aria-live]");
      if (announcement) announcement.textContent = next === "idle" ? "" : label;
      button.querySelectorAll<SVGElement>("[data-copy-icon]").forEach((icon) => {
        icon.toggleAttribute("hidden", icon.dataset.copyIcon !== next);
      });
    };
    update(status);
    const previous = timersRef.current.get(button);
    if (previous !== undefined) window.clearTimeout(previous);
    timersRef.current.set(
      button,
      window.setTimeout(() => {
        timersRef.current.delete(button);
        update("idle");
      }, 1600),
    );
  };
  return (
    <div
      ref={rootRef}
      className="note-prose read-only-prose memo-markdown"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

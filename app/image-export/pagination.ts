export const IMAGE_PAGE_WIDTH = 720;
export const IMAGE_PAGE_HEIGHT = 1600;
export const IMAGE_PAGE_PADDING = 48;
export const IMAGE_PAGE_LIMIT = 200;

/** Keep surrogate pairs together when a measured text fragment ends mid-character. */
export function safeTextBoundary(text: string, boundary: number): number {
  const end = Math.max(0, Math.min(text.length, boundary));
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) return end - 1;
  return end;
}

type Shell = { element: HTMLElement; listStart?: number };

/** Source must be a sanitized .note-prose containing the title and rendered Markdown. */
export async function paginateNote(source: HTMLElement, host: HTMLElement, signal: AbortSignal): Promise<HTMLElement[]> {
  const pages: HTMLElement[] = [];
  let page!: HTMLElement;
  let prose!: HTMLElement;
  let shells = new Map<HTMLElement, HTMLElement>();
  let operations = 0;
  const check = () => signal.throwIfAborted();
  const cooperate = async () => {
    check();
    if (++operations % 12 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      check();
    }
  };
  const newPage = () => {
    check();
    if (pages.length >= IMAGE_PAGE_LIMIT) throw new Error(`笔记超过 ${IMAGE_PAGE_LIMIT} 页，请缩短内容后导出。`);
    page = document.createElement("article");
    page.className = "image-export-page";
    Object.assign(page.style, { width: `${IMAGE_PAGE_WIDTH}px`, padding: `${IMAGE_PAGE_PADDING}px`, boxSizing: "border-box" });
    prose = source.cloneNode(false) as HTMLElement;
    prose.removeAttribute("contenteditable");
    prose.removeAttribute("id");
    prose.className = "note-prose";
    Object.assign(prose.style, { margin: "0", display: "flow-root" });
    page.append(prose);
    host.append(page);
    pages.push(page);
    shells = new Map();
  };
  const fits = () => prose.getBoundingClientRect().bottom - page.getBoundingClientRect().top + IMAGE_PAGE_PADDING <= IMAGE_PAGE_HEIGHT + 0.5;
  const targetFor = (ancestors: Shell[]): HTMLElement => {
    let target = prose;
    for (const shell of ancestors) {
      let clone = shells.get(shell.element);
      if (!clone) {
        clone = shell.element.cloneNode(false) as HTMLElement;
        clone.removeAttribute("id");
        if (shell.listStart !== undefined) clone.setAttribute("start", String(shell.listStart));
        // Callout icons and task checkboxes belong to the container, including
        // each continuation page; they are not independent flow blocks.
        const decoration = shell.element.matches("aside.note-callout")
          ? shell.element.querySelector(":scope > .note-callout-icon")
          : shell.element.matches('li[data-type="taskItem"]')
            ? shell.element.querySelector(":scope > label") : null;
        if (decoration) clone.append(decoration.cloneNode(true));
        target.append(clone);
        shells.set(shell.element, clone);
      }
      target = clone;
    }
    return target;
  };
  const removeEmptyShells = () => {
    for (const [original, clone] of Array.from(shells).reverse()) {
      const onlyDecoration = (clone.matches("aside.note-callout") && clone.children.length === 1 && clone.firstElementChild?.matches(".note-callout-icon"))
        || (clone.matches('li[data-type="taskItem"]') && clone.children.length === 1 && clone.firstElementChild?.tagName === "LABEL");
      if (!clone.childNodes.length || onlyDecoration) {
        clone.remove();
        shells.delete(original);
      }
    }
  };
  const tryAppend = (node: Node, ancestors: Shell[]) => {
    targetFor(ancestors).append(node);
    if (fits()) return true;
    node.parentNode?.removeChild(node);
    removeEmptyShells();
    return false;
  };

  const appendText = async (element: HTMLElement, ancestors: Shell[]) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    let current: Node | null;
    while ((current = walker.nextNode())) texts.push(current as Text);
    const text = texts.map((node) => node.data).join("");
    if (!text.length) throw new Error("有内容无法放入一页，请缩小图片或简化该内容后重试。");
    const point = (offset: number): [Node, number] => {
      for (const node of texts) {
        if (offset <= node.length) return [node, offset];
        offset -= node.length;
      }
      const last = texts[texts.length - 1]!;
      return [last, last.length];
    };
    const fragment = (start: number, end: number) => {
      const range = document.createRange();
      if (start === 0) range.setStart(element, 0);
      else range.setStart(...point(start));
      if (end === text.length) range.setEnd(element, element.childNodes.length);
      else range.setEnd(...point(end));
      const clone = element.cloneNode(false) as HTMLElement;
      clone.removeAttribute("id");
      clone.append(range.cloneContents());
      return clone;
    };
    let start = 0;
    while (start < text.length) {
      await cooperate();
      let low = start;
      let high = text.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const candidate = fragment(start, mid);
        targetFor(ancestors).append(candidate);
        const valid = fits();
        candidate.remove();
        if (valid) low = mid;
        else high = mid - 1;
      }
      let end = safeTextBoundary(text, low);
      if (end <= start) {
        removeEmptyShells();
        if (prose.textContent?.length || prose.querySelector("img, hr, table")) { newPage(); continue; }
        throw new Error("正文样式过高，无法放入一页，请简化该内容后重试。");
      }
      if (end < text.length) {
        if (element.tagName === "PRE") {
          const lineEnd = text.lastIndexOf("\n", end - 1) + 1;
          if (lineEnd > start) end = lineEnd;
        } else {
          // The maximum fitting prefix ends within the final rendered line. Find
          // that line's first character so the continuation begins on a full line.
          const probe = document.createRange();
          probe.setStart(...point(end - 1));
          probe.setEnd(...point(end));
          const bottomLine = probe.getBoundingClientRect().top;
          if (bottomLine) {
            let lineStart = end - 1;
            while (lineStart > start) {
              probe.setStart(...point(lineStart - 1));
              probe.setEnd(...point(lineStart));
              if (Math.abs(probe.getBoundingClientRect().top - bottomLine) > 1) break;
              lineStart--;
            }
            if (lineStart > start) end = safeTextBoundary(text, lineStart);
          }
        }
      }
      targetFor(ancestors).append(fragment(start, end));
      start = end;
      if (start < text.length) newPage();
    }
  };

  const appendTable = async (table: HTMLTableElement, ancestors: Shell[]) => {
    const rows = Array.from(table.rows);
    const headers = rows.filter((row) => row.parentElement?.tagName === "THEAD" || (row === rows[0] && !!row.querySelector("th")));
    const bodyRows = rows.filter((row) => !headers.includes(row));
    let tableClone: HTMLTableElement | undefined;
    let body: HTMLTableSectionElement;
    const beginTable = () => {
      tableClone = table.cloneNode(false) as HTMLTableElement;
      const colgroup = table.querySelector(":scope > colgroup");
      if (colgroup) tableClone.append(colgroup.cloneNode(true));
      if (headers.length) {
        const head = document.createElement("thead");
        head.append(...headers.map((row) => row.cloneNode(true)));
        tableClone.append(head);
      }
      body = document.createElement("tbody");
      tableClone.append(body);
      targetFor(ancestors).append(tableClone);
    };
    for (const row of bodyRows) {
      await cooperate();
      if (!tableClone) beginTable();
      const clone = row.cloneNode(true);
      body!.append(clone);
      if (!fits()) {
        clone.parentNode?.removeChild(clone);
        if (!body!.children.length) tableClone!.remove();
        newPage();
        beginTable();
        body!.append(clone);
        if (!fits()) throw new Error("表格中有单行超过一页，请拆分该行后导出。");
      }
    }
    if (!bodyRows.length) {
      beginTable();
      if (!fits()) throw new Error("表格表头超过一页，请简化表头后导出。");
    }
  };

  const appendFlow = async (node: Node, ancestors: Shell[] = []): Promise<void> => {
    await cooperate();
    if (!(node instanceof HTMLElement)) {
      if (!node.textContent?.trim()) return;
      const p = document.createElement("p");
      p.append(node.cloneNode(true));
      return appendFlow(p, ancestors);
    }
    const clone = node.cloneNode(true) as HTMLElement;
    if (tryAppend(clone, ancestors)) return;
    // Preserve ordinary blocks intact whenever they can fit on a fresh page.
    const precedingHeading = prose.lastElementChild?.matches("h1, h2, h3, h4, h5, h6");
    if (!precedingHeading && (prose.textContent?.length || prose.querySelector("img, hr, table")) && node.getBoundingClientRect().height <= IMAGE_PAGE_HEIGHT - IMAGE_PAGE_PADDING * 2) {
      newPage();
      if (tryAppend(clone, ancestors)) return;
    }
    if (node.tagName === "TABLE") return appendTable(node as HTMLTableElement, ancestors);
    if (["P", "PRE", "H1", "H2", "H3", "H4", "H5", "H6"].includes(node.tagName) && node.textContent?.length) return appendText(node, ancestors);
    if (["UL", "OL", "LI", "BLOCKQUOTE", "DIV", "SECTION", "ASIDE"].includes(node.tagName) && node.children.length) {
      const children = Array.from(node.childNodes);
      let listIndex = Number(node.getAttribute("start") || 1);
      for (const child of children) {
        if (child instanceof HTMLElement && ((node.matches("aside.note-callout") && child.matches(".note-callout-icon"))
          || (node.matches('li[data-type="taskItem"]') && child.tagName === "LABEL"))) continue;
        const shell: Shell = { element: node };
        if (node.tagName === "OL") shell.listStart = listIndex;
        await appendFlow(child, [...ancestors, shell]);
        if (child instanceof HTMLElement && child.tagName === "LI") listIndex++;
      }
      return;
    }
    if (prose.textContent?.length || prose.querySelector("img, hr, table")) newPage();
    if (!tryAppend(clone, ancestors)) throw new Error("有图片或内容块超过一页，请缩小该内容后导出。");
  };

  newPage();
  try {
    const blocks = Array.from(source.childNodes);
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]!;
      if (block instanceof HTMLElement && /^H[1-6]$/.test(block.tagName) && prose.children.length) {
        const next = blocks.slice(index + 1).find((item) => item instanceof HTMLElement);
        if (next) {
          const heading = block.cloneNode(true);
          let following = next.cloneNode(true);
          if (next instanceof HTMLElement && next.getBoundingClientRect().height > IMAGE_PAGE_HEIGHT - IMAGE_PAGE_PADDING * 2) {
            const walker = document.createTreeWalker(next, NodeFilter.SHOW_TEXT);
            let first = walker.nextNode() as Text | null;
            while (first && !first.data.trim()) first = walker.nextNode() as Text | null;
            if (first) {
              const range = document.createRange();
              range.setStart(next, 0);
              range.setEnd(first, safeTextBoundary(first.data, Math.min(first.length, 32)));
              following = next.cloneNode(false);
              following.appendChild(range.cloneContents());
            }
          }
          prose.append(heading, following);
          const togetherFits = fits();
          heading.parentNode?.removeChild(heading);
          following.parentNode?.removeChild(following);
          if (!togetherFits) newPage();
        }
      }
      await appendFlow(block);
    }
    return pages;
  } catch (error) {
    for (const item of pages) item.remove();
    throw error;
  }
}

import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { isMermaidLanguage } from "../mermaid/protocol";
import { getDraggableBlockFromElement, type BlockTarget } from "./block-drag-commands";

export const HANDLE_LEFT = -30;
export const HANDLE_HEIGHT = 28;
export const HANDLE_HOVER_LEFT = HANDLE_LEFT - 14;
export const HANDLE_HOVER_RIGHT = 36;
export const DRAG_THRESHOLD = 6;
const PREVIEW_PADDING_X = 10;
const PREVIEW_PADDING_Y = 7;
export const SCROLL_EDGE = 60;
export const SCROLL_MAX_STEP = 14;
export const MENU_WIDTH = 164;
export const MENU_ESTIMATED_HEIGHT = 158;
export const HIDE_DELAY = 220;
export const HANDLE_FADE_OUT = 180;
const MIN_LIST_PREVIEW_WIDTH = 160;

export const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function restoreEditorFocus(editor: Editor, scroll: HTMLElement | null) {
  if (editor.isDestroyed) return;
  const { selection } = editor.state;
  if (
    selection instanceof NodeSelection &&
    selection.node.type.name === "codeBlock" &&
    isMermaidLanguage(selection.node.attrs.language)
  ) {
    // Wait for the moved React node view to mount. Focusing the editor itself
    // can turn the node selection into a source caret in WebKit.
    requestAnimationFrame(() => {
      if (editor.isDestroyed || !editor.state.selection.eq(selection)) return;
      const dom = editor.view.nodeDOM(selection.from);
      const trigger =
        dom instanceof HTMLElement
          ? dom.querySelector<HTMLButtonElement>(".mermaid-edit-trigger")
          : null;
      if (trigger && !trigger.closest("[inert]")) trigger.focus({ preventScroll: true });
    });
    return;
  }

  const scrollTop = scroll?.scrollTop;
  try {
    if (!editor.view.hasFocus()) {
      editor.view.focus();
    }
  } catch {
    // Ignore focus errors
  }
  if (scroll && scrollTop !== undefined && scroll.scrollTop !== scrollTop) {
    scroll.scrollTop = scrollTop;
  }
}

function firstLineCenter(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.textContent && node.textContent.trim().length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });
  const textNode = walker.nextNode();
  if (textNode) {
    try {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(1, textNode.textContent?.length ?? 1));
      const rangeRect = range.getBoundingClientRect();
      if (rangeRect.height > 0) {
        return rangeRect.top + rangeRect.height / 2;
      }
    } catch {
      // fallback
    }
  }

  const firstMedia = element.querySelector<HTMLElement>("img, input, pre, table, hr");
  if (firstMedia) {
    const mediaRect = firstMedia.getBoundingClientRect();
    if (mediaRect.height > 0) {
      return mediaRect.top + Math.min(14, mediaRect.height / 2);
    }
  }

  const style = getComputedStyle(element);
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const fontSize = Number.parseFloat(style.fontSize) || 16;
  const lineHeightRaw = style.lineHeight;
  const lineHeight =
    lineHeightRaw === "normal"
      ? fontSize * 1.5
      : Number.parseFloat(lineHeightRaw) || fontSize * 1.5;
  return rect.top + paddingTop + lineHeight / 2;
}

export function blockHandleCenter(block: BlockTarget, scroll: HTMLElement | null): number {
  if (!block.dom) return 0;
  const center = firstLineCenter(block.dom);
  if (!scroll) return center;
  const scrollRect = scroll.getBoundingClientRect();
  const inset = HANDLE_HEIGHT / 2 + 4;
  return Math.min(
    Math.max(center, scrollRect.top + inset),
    Math.max(scrollRect.top + inset, scrollRect.bottom - inset),
  );
}

export function translateY(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  return transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m42 : 0;
}

export function pointerInHandleGutter(
  container: HTMLElement,
  scroll: HTMLElement | null,
  x: number,
  y: number,
): boolean {
  const containerRect = container.getBoundingClientRect();
  const scrollRect = scroll?.getBoundingClientRect();
  return (
    x >= containerRect.left + HANDLE_HOVER_LEFT &&
    x <= containerRect.left + HANDLE_HOVER_RIGHT &&
    (!scrollRect || (y >= scrollRect.top && y <= scrollRect.bottom))
  );
}

export function blockAtHandleGutter(editor: Editor, y: number): BlockTarget | null {
  const editorDom = editor.view.dom;
  const rect = editorDom.getBoundingClientRect();
  const target = document.elementFromPoint(rect.left + 6, y);
  if (!(target instanceof HTMLElement)) return null;
  if (target !== editorDom && !editorDom.contains(target)) return null;

  const listRoot = target.closest<HTMLElement>("li, ul, ol");
  if (listRoot) {
    if (listRoot.tagName === "LI") {
      return getDraggableBlockFromElement(editor, listRoot, { x: rect.left + 6, y });
    }
    const items = Array.from(listRoot.querySelectorAll<HTMLElement>("li"));
    let listItem: HTMLElement | null = null;
    let listItemDepth = -1;
    let listItemHeight = Number.POSITIVE_INFINITY;
    for (const item of items) {
      const itemRect = item.getBoundingClientRect();
      if (y < itemRect.top || y > itemRect.bottom) continue;
      let depth = 0;
      for (
        let parent = item.parentElement;
        parent && parent !== editorDom;
        parent = parent.parentElement
      ) {
        if (parent.tagName === "LI") depth += 1;
      }
      if (depth < listItemDepth) continue;
      if (depth === listItemDepth && itemRect.height >= listItemHeight) continue;
      listItem = item;
      listItemDepth = depth;
      listItemHeight = itemRect.height;
    }
    if (listItem) {
      return getDraggableBlockFromElement(editor, listItem, { x: rect.left + 6, y });
    }
  }

  return getDraggableBlockFromElement(editor, target, { x: rect.left + 6, y });
}

function textContentRight(element: HTMLElement): number | null {
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let right: number | null = null;
  let node = walker.nextNode();
  while (node) {
    if (node.nodeValue?.trim()) {
      range.selectNodeContents(node);
      Array.from(range.getClientRects()).forEach((rect) => {
        if (rect.width <= 0 || rect.height <= 0) return;
        right = Math.max(right ?? rect.right, rect.right);
      });
    }
    node = walker.nextNode();
  }
  return right;
}

function sanitizePreviewClone(clone: HTMLElement, isFirst: boolean, isLast: boolean) {
  if (isFirst) clone.style.marginTop = "0";
  if (isLast) clone.style.marginBottom = "0";
  clone
    .querySelectorAll<HTMLElement>(
      "[contenteditable], button, input, select, textarea, a[href], [tabindex]",
    )
    .forEach((element) => {
      element.removeAttribute("contenteditable");
      element.setAttribute("tabindex", "-1");
    });
  clone.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    image.draggable = false;
  });
}

export function createDragPreview(sources: BlockTarget[]): HTMLElement | null {
  const firstSource = sources[0];
  const firstDom = firstSource?.dom;
  if (!firstDom) return null;
  const firstRect = firstDom.getBoundingClientRect();

  const preview = document.createElement("div");
  preview.className = "block-drag-preview";
  preview.setAttribute("aria-hidden", "true");
  preview.setAttribute("inert", "");

  const content = document.createElement("div");
  content.className = "note-prose block-drag-preview-content";

  if (firstSource.kind === "listItem" && firstDom.parentElement) {
    const listParent = firstDom.parentElement;
    const listClone = listParent.cloneNode(false) as HTMLElement;
    listClone.style.marginTop = "0";
    listClone.style.marginBottom = "0";
    const listPadding = Number.parseFloat(getComputedStyle(listParent).paddingLeft) || 0;

    let maxVisibleWidth = MIN_LIST_PREVIEW_WIDTH;
    sources.forEach((source, index) => {
      if (!source.dom) return;
      const clone = source.dom.cloneNode(true) as HTMLElement;
      sanitizePreviewClone(clone, index === 0, index === sources.length - 1);
      if (clone instanceof HTMLLIElement && listParent instanceof HTMLOListElement) {
        const start = Number.parseInt(listParent.getAttribute("start") ?? "1", 10) || 1;
        clone.value = start + source.index;
      }
      listClone.appendChild(clone);

      const sourceRect = source.dom.getBoundingClientRect();
      const contentRight = textContentRight(source.dom);
      const hasWideContent = Boolean(source.dom.querySelector("img, video, iframe, table, pre"));
      const visibleWidth = hasWideContent
        ? sourceRect.width
        : contentRight === null
          ? MIN_LIST_PREVIEW_WIDTH
          : Math.min(
              sourceRect.width,
              Math.max(MIN_LIST_PREVIEW_WIDTH, contentRight - sourceRect.left),
            );
      maxVisibleWidth = Math.max(maxVisibleWidth, visibleWidth);
    });

    content.style.width = `${maxVisibleWidth + listPadding}px`;
    content.appendChild(listClone);
    preview.style.width = `${maxVisibleWidth + listPadding + PREVIEW_PADDING_X * 2}px`;
    preview.style.left = `${firstRect.left - listPadding - PREVIEW_PADDING_X}px`;
  } else {
    const sourceWidth = firstRect.width;
    sources.forEach((source, index) => {
      if (!source.dom) return;
      const clone = source.dom.cloneNode(true) as HTMLElement;
      sanitizePreviewClone(clone, index === 0, index === sources.length - 1);
      content.appendChild(clone);
    });

    content.style.width = `${sourceWidth}px`;
    preview.style.width = `${sourceWidth + PREVIEW_PADDING_X * 2}px`;
    preview.style.left = `${firstRect.left - PREVIEW_PADDING_X}px`;
  }

  if (sources.length > 1) {
    const badge = document.createElement("div");
    badge.className = "block-drag-count-badge";
    badge.textContent = String(sources.length);
    badge.setAttribute("aria-hidden", "true");
    preview.appendChild(badge);
  }

  preview.style.top = `${firstRect.top - PREVIEW_PADDING_Y}px`;
  preview.appendChild(content);
  document.body.appendChild(preview);
  return preview;
}

export function animatePreview(
  preview: HTMLElement,
  fromY: number,
  toY: number,
  duration: number,
): Promise<void> {
  if (prefersReducedMotion()) {
    preview.style.transform = `translate3d(0, ${toY}px, 0)`;
    return Promise.resolve();
  }
  const animation = preview.animate(
    [{ transform: `translate3d(0, ${fromY}px, 0)` }, { transform: `translate3d(0, ${toY}px, 0)` }],
    {
      duration,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      fill: "forwards",
    },
  );
  return animation.finished
    .catch(() => undefined)
    .then(() => {
      preview.style.transform = `translate3d(0, ${toY}px, 0)`;
      animation.cancel();
    });
}

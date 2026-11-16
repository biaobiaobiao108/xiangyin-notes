import { useMemo } from "react";
import type { Editor } from "@tiptap/core";
import { Selection } from "@tiptap/pm/state";
import {
  detectLeakedImePrefix,
  normalizeChineseMarkdownBlockMarkers,
  shouldParseMarkdownPaste,
} from "../editor-metrics";
import {
  executeBlockShortcutAtSelection,
  handleMarkdownBlockShortcutInput,
} from "./markdown-shortcuts";
import { pastePlainTextIntoCodeBlock } from "./code-block-paste";
import { isImageFile } from "./image-files";
import { prepareMarkdownForEditor } from "./prepare-markdown";

type Ref<T> = { current: T };
type Candidate = { key: string; blockStartPos: number; emptyAtStart: boolean } | null;

export function useEditorProps({
  mobileViewportRef,
  onNavigateWikiLinkRef,
  onToggleAnnotationRef,
  onClearAnnotationRef,
  uploadImageFilesRef,
  editorInstanceRef,
  isPastingRef,
  smoothScrollToHeadRef,
  typewriterModeRef,
  alignTypewriterRef,
  mobileCaretScrollRef,
  composingRef,
  leakedCandidateRef,
  imeCleanupTimerRef,
  surfaceSyncRef,
}: {
  mobileViewportRef: Ref<boolean>;
  onNavigateWikiLinkRef: Ref<((title: string) => void) | undefined>;
  onToggleAnnotationRef: Ref<(id: string) => void>;
  onClearAnnotationRef: Ref<() => void>;
  uploadImageFilesRef: Ref<(files: File[]) => void>;
  editorInstanceRef: Ref<Editor | null>;
  isPastingRef: Ref<boolean>;
  smoothScrollToHeadRef: Ref<(view: Editor["view"]) => void>;
  typewriterModeRef: Ref<boolean>;
  alignTypewriterRef: Ref<(view: Editor | Editor["view"], immediate?: boolean) => void>;
  mobileCaretScrollRef: Ref<() => void>;
  composingRef: Ref<boolean>;
  leakedCandidateRef: Ref<Candidate>;
  imeCleanupTimerRef: Ref<ReturnType<typeof setTimeout> | null>;
  surfaceSyncRef: Ref<(instance: Editor) => void>;
}) {
  const editorProps = useMemo(
    () => ({
      attributes: { class: "note-prose" },
      handleClick: (_view: Editor["view"], _pos: number, event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        if (event.ctrlKey || event.metaKey || mobileViewportRef.current) {
          const wikiLinkEl = target?.closest(".editor-wiki-link");
          if (wikiLinkEl) {
            event.preventDefault();
            event.stopPropagation();
            const targetTitle = wikiLinkEl.getAttribute("data-wiki-link");
            if (targetTitle && onNavigateWikiLinkRef.current) {
              onNavigateWikiLinkRef.current(targetTitle);
              return true;
            }
          }
        }
        if (event.ctrlKey || event.metaKey) {
          const anchor = target?.closest("a");
          if (anchor?.href) {
            event.preventDefault();
            event.stopPropagation();
            window.open(anchor.href, "_blank", "noopener,noreferrer");
            return true;
          }
        }
        const annotationEl = target?.closest<HTMLElement>(".note-annotation[data-annotation-id]");
        if (
          annotationEl &&
          !event.ctrlKey &&
          !event.metaKey &&
          !window.getSelection()?.toString().trim()
        ) {
          const annotationId = annotationEl.getAttribute("data-annotation-id");
          if (annotationId) {
            onToggleAnnotationRef.current(annotationId);
            return true;
          }
        } else if (
          !target?.closest(".annotation-card, .annotation-composer, [role='dialog'], [role='menu']")
        ) {
          onClearAnnotationRef.current();
        }
        return false;
      },
      handlePaste: (view: Editor["view"], event: ClipboardEvent) => {
        const imageFiles = Array.from(event.clipboardData?.files ?? []).filter(isImageFile);
        if (imageFiles.length) {
          event.preventDefault();
          uploadImageFilesRef.current(imageFiles);
          return true;
        }
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (pastePlainTextIntoCodeBlock(view, text)) {
          event.preventDefault();
          return true;
        }
        isPastingRef.current = true;
        window.setTimeout(() => {
          isPastingRef.current = false;
        }, 200);
        const html = event.clipboardData?.getData("text/html") ?? "";
        if (!shouldParseMarkdownPaste(text, Boolean(html))) return false;
        const markdownManager = editorInstanceRef.current?.markdown;
        if (!markdownManager) return false;
        try {
          const parsedDocument = view.state.schema.nodeFromJSON(
            markdownManager.parse(
              prepareMarkdownForEditor(normalizeChineseMarkdownBlockMarkers(text)),
            ),
          );
          const slice = parsedDocument.slice(0, parsedDocument.content.size);
          view.dispatch(view.state.tr.replaceSelection(slice).setMeta("uiEvent", "paste"));
          isPastingRef.current = false;
          smoothScrollToHeadRef.current(view);
          return true;
        } catch {
          return false;
        }
      },
      handleDrop: (view: Editor["view"], event: DragEvent, _slice: unknown, moved: boolean) => {
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!files.length) return false;
        const imageFiles = files.filter(isImageFile);
        if (!imageFiles.length) {
          event.preventDefault();
          return true;
        }
        event.preventDefault();
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (coords) {
          const tr = view.state.tr.setSelection(Selection.near(view.state.doc.resolve(coords.pos)));
          view.dispatch(tr);
        }
        uploadImageFilesRef.current(imageFiles);
        return true;
      },
      handleScrollToSelection: (view: Editor["view"]) => {
        if (isPastingRef.current) {
          isPastingRef.current = false;
          smoothScrollToHeadRef.current(view);
          return true;
        }
        if (typewriterModeRef.current) {
          alignTypewriterRef.current(view);
          return true;
        }
        if (mobileViewportRef.current) {
          mobileCaretScrollRef.current();
          return true;
        }
        return false;
      },
      handleKeyDown: (view: Editor["view"], event: KeyboardEvent) => {
        if (event.isComposing || event.keyCode === 229 || event.key === "Process") {
          composingRef.current = true;
          if (!leakedCandidateRef.current) {
            const { $from } = view.state.selection;
            if (
              $from.parent.content.size === 0 ||
              ($from.parentOffset === 0 && $from.parent.textContent.length === 0)
            ) {
              let key = "";
              if (event.code && event.code.startsWith("Key")) {
                key = event.code.slice(3).toLowerCase();
              } else if (event.code && event.code.startsWith("Digit")) {
                key = event.code.slice(5);
              } else if (event.key && event.key.length === 1 && event.key !== "Process") {
                key = event.key.toLowerCase();
              }
              leakedCandidateRef.current = {
                key,
                blockStartPos: $from.start(),
                emptyAtStart: true,
              };
            }
          }
        }
        return false;
      },
      handleTextInput: (view: Editor["view"], from: number, to: number, text: string) => {
        return handleMarkdownBlockShortcutInput(view, from, to, text, composingRef.current);
      },
      handleDOMEvents: {
        compositionstart: (view: Editor["view"]) => {
          composingRef.current = true;
          if (imeCleanupTimerRef.current !== null) {
            clearTimeout(imeCleanupTimerRef.current);
            imeCleanupTimerRef.current = null;
          }
          const { $from } = view.state.selection;
          const text = $from.parent.textContent;
          if (!leakedCandidateRef.current) {
            if (
              $from.parent.content.size === 0 ||
              ($from.parentOffset === 0 && text.length === 0)
            ) {
              leakedCandidateRef.current = {
                key: "",
                blockStartPos: $from.start(),
                emptyAtStart: true,
              };
            }
          }
          return false;
        },
        compositionend: (view: Editor["view"], event: Event) => {
          composingRef.current = false;
          const candidate = leakedCandidateRef.current;
          const committedText = (event as CompositionEvent).data;
          if (imeCleanupTimerRef.current !== null) {
            clearTimeout(imeCleanupTimerRef.current);
            imeCleanupTimerRef.current = null;
          }
          if (!candidate?.emptyAtStart) leakedCandidateRef.current = null;
          imeCleanupTimerRef.current = setTimeout(() => {
            imeCleanupTimerRef.current = null;
            try {
              if (!view || view.isDestroyed) return;
              if (candidate?.emptyAtStart) {
                const { state, dispatch } = view;
                const resolvedPos = Math.min(candidate.blockStartPos, state.doc.content.size);
                const $pos = state.doc.resolve(resolvedPos);
                const block = $pos.parent;
                const blockStart = $pos.start();
                const blockText = block.textContent;

                const leakedLen = detectLeakedImePrefix(
                  blockText,
                  candidate.key || null,
                  committedText,
                );
                if (leakedLen && leakedLen > 0) {
                  const deleteFrom = blockStart;
                  const deleteTo = blockStart + leakedLen;
                  const tr = state.tr.delete(deleteFrom, deleteTo);
                  dispatch(tr.scrollIntoView());
                }
              }
              executeBlockShortcutAtSelection(view);
            } finally {
              leakedCandidateRef.current = null;
            }
          }, 30);
          if (editorInstanceRef.current) {
            surfaceSyncRef.current(editorInstanceRef.current);
            if (typewriterModeRef.current) {
              alignTypewriterRef.current(editorInstanceRef.current);
            }
          }
          return false;
        },
        compositioncancel: () => {
          composingRef.current = false;
          leakedCandidateRef.current = null;
          if (imeCleanupTimerRef.current !== null) {
            clearTimeout(imeCleanupTimerRef.current);
            imeCleanupTimerRef.current = null;
          }
          if (editorInstanceRef.current) {
            surfaceSyncRef.current(editorInstanceRef.current);
          }
          return false;
        },
      },
    }),
    [],
  );
  return editorProps;
}

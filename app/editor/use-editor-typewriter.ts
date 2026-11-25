import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import type { Editor } from "@tiptap/core";

export type UseEditorTypewriterOptions = {
  noteId: string;
  typewriterMode: boolean;
  editorScrollRef: RefObject<HTMLDivElement | null>;
  editorInstanceRef: MutableRefObject<Editor | null>;
  typewriterModeRef: MutableRefObject<boolean>;
  typewriterAnimRef: MutableRefObject<number | null>;
  typewriterTargetRef: MutableRefObject<number | null>;
  alignTypewriter: (view: Editor | Editor["view"], immediate?: boolean) => void;
};

/** Keeps typewriter scrolling synced and cancels animation on manual scroll, note change, or unmount. */
export function useEditorTypewriter({
  noteId,
  typewriterMode,
  editorScrollRef,
  editorInstanceRef,
  typewriterModeRef,
  typewriterAnimRef,
  typewriterTargetRef,
  alignTypewriter,
}: UseEditorTypewriterOptions) {
  const alignTypewriterRef = useRef(alignTypewriter);
  alignTypewriterRef.current = alignTypewriter;

  const cancelTypewriterAnimation = useCallback(() => {
    if (typewriterAnimRef.current !== null) {
      cancelAnimationFrame(typewriterAnimRef.current);
      typewriterAnimRef.current = null;
      typewriterTargetRef.current = null;
    }
  }, [typewriterAnimRef, typewriterTargetRef]);

  useEffect(() => {
    if (typewriterMode && editorInstanceRef.current?.view.hasFocus()) {
      alignTypewriterRef.current(editorInstanceRef.current);
    } else if (!typewriterMode) {
      cancelTypewriterAnimation();
    }
  }, [cancelTypewriterAnimation, editorInstanceRef, typewriterMode]);

  useEffect(() => {
    const scrollContainer = editorScrollRef.current;
    if (!scrollContainer) return;
    scrollContainer.addEventListener("wheel", cancelTypewriterAnimation, { passive: true });
    scrollContainer.addEventListener("touchmove", cancelTypewriterAnimation, { passive: true });
    return () => {
      scrollContainer.removeEventListener("wheel", cancelTypewriterAnimation);
      scrollContainer.removeEventListener("touchmove", cancelTypewriterAnimation);
    };
  }, [cancelTypewriterAnimation, editorScrollRef]);

  useEffect(() => {
    cancelTypewriterAnimation();
  }, [cancelTypewriterAnimation, noteId]);

  useEffect(() => cancelTypewriterAnimation, [cancelTypewriterAnimation]);

  // Expose live toggle alignment through a stable ref for TipTap callbacks.
  void typewriterModeRef;

  return { alignTypewriterRef, cancelTypewriterAnimation };
}

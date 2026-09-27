import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { codeBlockLanguageOptions, setCodeBlockLanguage } from "./code-block-lowlight";

type CodeBlockLanguagePosition = {
  top: number;
  left: number;
  language: string;
};

const CONTROL_WIDTH = 136;

export function CodeBlockLanguageControl({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  const [position, setPosition] = useState<CodeBlockLanguagePosition | null>(null);

  useEffect(() => {
    let frame: number | null = null;
    const updatePosition = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (editor.isDestroyed || !editor.isEditable) {
          setPosition(null);
          return;
        }

        const { $from } = editor.state.selection;
        let codeBlockDepth = -1;
        for (let depth = $from.depth; depth > 0; depth -= 1) {
          if ($from.node(depth).type.name === "codeBlock") {
            codeBlockDepth = depth;
            break;
          }
        }
        if (codeBlockDepth < 0) {
          setPosition(null);
          return;
        }

        const node = editor.view.nodeDOM($from.before(codeBlockDepth));
        const codeBlock = node instanceof HTMLElement
          ? (node.matches("pre") ? node : node.closest<HTMLElement>("pre"))
          : null;
        if (!codeBlock) {
          setPosition(null);
          return;
        }

        const rect = codeBlock.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) {
          setPosition(null);
          return;
        }

        const width = Math.min(CONTROL_WIDTH, Math.max(0, window.innerWidth - 16));
        const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
        const top = Math.max(8, Math.min(rect.top - 32, window.innerHeight - 30));
        const language = typeof $from.node(codeBlockDepth).attrs.language === "string"
          ? $from.node(codeBlockDepth).attrs.language as string
          : "plaintext";
        const next = { top, left, language };
        setPosition((current) => current && current.top === top && current.left === left && current.language === language ? current : next);
      });
    };

    editor.on("selectionUpdate", updatePosition);
    editor.on("transaction", updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    updatePosition();
    return () => {
      editor.off("selectionUpdate", updatePosition);
      editor.off("transaction", updatePosition);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [editor]);

  if (!position || typeof document === "undefined") return null;
  const knownLanguage = codeBlockLanguageOptions.some((option) => option.value === position.language);
  const selectedLabel = codeBlockLanguageOptions.find((option) => option.value === position.language)?.label ?? position.language;

  return createPortal(<div className="code-block-language-control" style={{ top: position.top, left: position.left }}>
    <span aria-hidden="true">语言</span>
    <select
      aria-label="代码块语言"
      title={`代码块语言：${selectedLabel}`}
      value={position.language}
      disabled={disabled}
      onChange={(event) => setCodeBlockLanguage(editor, event.currentTarget.value)}
    >
      {!knownLanguage && <option value={position.language}>{position.language}（未知）</option>}
      {codeBlockLanguageOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
    </select>
  </div>, document.body);
}

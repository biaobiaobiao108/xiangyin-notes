import { useEffect, useRef, useState } from "react";
import CodeBlock from "@tiptap/extension-code-block";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Check, CircleAlert, Copy } from "lucide-react";

export async function copyCodeBlockText(text: string, clipboard: Pick<Clipboard, "writeText"> | null = typeof navigator === "undefined" ? null : navigator.clipboard ?? null) {
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the legacy copy command when clipboard permissions are unavailable.
    }
  }

  if (typeof document === "undefined" || !document.execCommand) throw new Error("Clipboard API is unavailable");

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.insetInlineStart = "-9999px";
  document.body.append(textarea);
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
    activeElement?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach((range) => selection.addRange(range));
    }
  }

  if (!copied) throw new Error("Clipboard copy failed");
}

function CodeBlockCopyView({ node }: NodeViewProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const resetTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  const copy = async () => {
    let copied = false;
    try {
      await copyCodeBlockText(node.textContent);
      copied = true;
    } catch {
      copied = false;
    }

    if (!mountedRef.current) return;
    setStatus(copied ? "copied" : "error");
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      setStatus("idle");
    }, 1600);
  };

  const Icon = status === "copied" ? Check : status === "error" ? CircleAlert : Copy;
  const label = status === "copied" ? "代码已复制" : status === "error" ? "复制失败" : "复制代码";

  return <NodeViewWrapper as="pre" className="code-block-node-view" style={{ whiteSpace: "pre-wrap" }}>
    <button
      className={`code-block-copy-button ${status === "idle" ? "" : `is-${status}`}`}
      type="button"
      contentEditable={false}
      aria-label={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void copy()}
    >
      <Icon size={16} strokeWidth={1.9} aria-hidden="true" />
      <span className="visually-hidden" aria-live="polite">{label}</span>
    </button>
    <NodeViewContent<"code"> as="code" />
  </NodeViewWrapper>;
}

export const CodeBlockWithCopy = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockCopyView);
  },
});

import { useEffect, useRef, useState } from "react";
import CodeBlock from "@tiptap/extension-code-block";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Check, CircleAlert, Copy } from "lucide-react";
import { isMermaidLanguage, mermaidTokenSource } from "../mermaid/protocol";
import { MermaidCodeBlock } from "./mermaid-code-block";

export async function copyPlainText(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | null = typeof navigator === "undefined"
    ? null
    : (navigator.clipboard ?? null),
) {
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the legacy copy command when clipboard permissions are unavailable.
    }
  }

  if (typeof document === "undefined" || !document.execCommand)
    throw new Error("Clipboard API is unavailable");

  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.fontSize = "16px";
  textarea.style.insetInlineStart = "-9999px";
  document.body.append(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

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

export const copyCodeBlockText = copyPlainText;

function CodeBlockCopyView(props: NodeViewProps) {
  const { node } = props;
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
  const language = typeof node.attrs?.language === "string" ? node.attrs.language.trim() : "";

  const copyButton = (
    <button
      className={`code-block-copy-button ${status === "idle" ? "" : `is-${status}`}`}
      type="button"
      contentEditable={false}
      data-drag-handle-ignore=""
      aria-label={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void copy()}
    >
      <Icon size={16} strokeWidth={1.9} aria-hidden="true" />
      <span className="visually-hidden" aria-live="polite">
        {label}
      </span>
    </button>
  );
  if (isMermaidLanguage(language)) return <MermaidCodeBlock {...props} copyButton={copyButton} />;

  return (
    <NodeViewWrapper as="pre" className="code-block-node-view" style={{ whiteSpace: "pre-wrap" }}>
      {language ? (
        <span
          className="code-block-language"
          contentEditable={false}
          aria-hidden="true"
          data-drag-handle-ignore=""
        >
          {language}
        </span>
      ) : null}
      {copyButton}
      <NodeViewContent<"code"> as="code" />
    </NodeViewWrapper>
  );
}

export const CodeBlockWithCopy = CodeBlock.extend({
  parseMarkdown(token, helpers) {
    if (isMermaidLanguage(token.lang) && token.raw) {
      return this.parent!(
        {
          ...token,
          raw: token.raw.replace(/^ {1,3}(?=`{3}|~{3})/u, ""),
          text: mermaidTokenSource(token.text ?? "", token.raw),
        },
        helpers,
      );
    }
    return this.parent!(token, helpers);
  },
  renderMarkdown(node, helpers, context) {
    const language = node.attrs?.language;
    if (!isMermaidLanguage(language)) return this.parent!(node, helpers, context);

    const source = node.content ? helpers.renderChildren(node.content) : "";
    let backticks = 3;
    let tildes = 3;
    // An enclosing fence must be longer than any closing fence in the diagram text.
    for (const match of source.matchAll(/^ {0,3}(`{3,}|~{3,})[`~]*[\t ]*$/gmu)) {
      const marker = match[1]!;
      if (marker.startsWith("`")) backticks = Math.max(backticks, marker.length + 1);
      else tildes = Math.max(tildes, marker.length + 1);
    }
    const fence =
      backticks <= tildes && !language.includes("`") ? "`".repeat(backticks) : "~".repeat(tildes);
    return `${fence}${language}\n${source}\n${fence}`;
  },
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockCopyView);
  },
});

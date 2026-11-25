import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  useEditorState,
  type NodeViewProps,
} from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { searchHighlightPluginKey } from "../editor-search";
import { FloatingScrollbar } from "../floating-scrollbar";
import { DiagramPreview } from "../mermaid/diagram-preview";

export function MermaidCodeBlock({
  node,
  editor,
  getPos,
  copyButton,
}: NodeViewProps & { copyButton: ReactNode }) {
  const [edit, setEdit] = useState(false);
  const [showReadOnlySource, setShowReadOnlySource] = useState(false);
  const [dismissedMatch, setDismissedMatch] = useState<number | null>(null);
  const [previewSource, setPreviewSource] = useState(node.textContent);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  const sourceId = useId();
  const position = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const start = getPos();
      if (typeof start !== "number" || start < 0 || start >= current.state.doc.content.size)
        return { caretInside: false, match: null };
      const documentNode = current.state.doc.nodeAt(start);
      if (documentNode?.type.name !== "codeBlock") return { caretInside: false, match: null };
      const end = start + documentNode.nodeSize;
      const selection = current.state.selection;
      const caretInside =
        current.isFocused &&
        selection instanceof TextSelection &&
        selection.empty &&
        selection.from > start &&
        selection.from < end;
      const search = searchHighlightPluginKey.getState(current.state);
      const match = search?.matches[search.activeIndex]?.from;
      return { caretInside, match: match != null && match > start && match < end ? match : null };
    },
  });
  const revealSearch = position.match !== null && position.match !== dismissedMatch;
  const showSource = editor.isEditable
    ? edit || position.caretInside || revealSearch
    : showReadOnlySource;

  useEffect(() => {
    if (position.match === null) setDismissedMatch(null);
  }, [position.match]);

  const source = node.textContent;
  useEffect(() => {
    if (!showSource) setPreviewSource(source);
  }, [showSource, source]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const preview = previewRef.current;
    if (!body || !preview) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) body.style.setProperty("--mermaid-body-height", `${entry.contentRect.height}px`);
    });
    observer.observe(preview);
    return () => observer.disconnect();
  }, []);

  const toggle = () => {
    if (!editor.isEditable) {
      setShowReadOnlySource(!showReadOnlySource);
      return;
    }
    if (showSource) {
      setEdit(false);
      setDismissedMatch(position.match);
      toggleRef.current?.focus({ preventScroll: true });
      return;
    }
    setEdit(true);
    const start = getPos();
    if (typeof start === "number") {
      if (sourceRef.current) sourceRef.current.scrollTop = 0;
      editor.commands.focus(start + 1, { scrollIntoView: false });
    }
  };

  return (
    <NodeViewWrapper className="mermaid-code-block">
      <div className="mermaid-toolbar" contentEditable={false}>
        <button
          ref={toggleRef}
          className="mermaid-action"
          type="button"
          aria-expanded={showSource}
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggle}
        >
          {showSource
            ? editor.isEditable
              ? "完成"
              : "显示图表"
            : editor.isEditable
              ? "编辑图表"
              : "查看源码"}
        </button>
      </div>
      <div ref={bodyRef} className="mermaid-body">
        <div ref={previewRef} className="mermaid-rendered" inert={showSource}>
          <DiagramPreview source={previewSource} keepPrevious />
        </div>
        <div className="mermaid-source" inert={!showSource}>
          <div
            ref={sourceRef}
            id={sourceId}
            className="mermaid-source-scroll floating-scrollbar-target"
          >
            <pre className="code-block-node-view">
              {copyButton}
              <NodeViewContent<"code"> as="code" />
            </pre>
          </div>
          {showSource ? (
            <FloatingScrollbar
              scrollTargetRef={sourceRef}
              controlsId={sourceId}
              ariaLabel="滚动图表源码"
              placement="right"
            />
          ) : null}
        </div>
      </div>
    </NodeViewWrapper>
  );
}

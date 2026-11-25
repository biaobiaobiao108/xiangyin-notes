import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  useEditorState,
  type NodeViewProps,
} from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { searchHighlightPluginKey } from "../editor-search";
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
  const toggleRef = useRef<HTMLButtonElement>(null);
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
    if (typeof start === "number") editor.commands.focus(start + 1);
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
      {!showSource ? <DiagramPreview source={node.textContent} /> : null}
      <pre className="code-block-node-view" hidden={!showSource} style={{ whiteSpace: "pre-wrap" }}>
        {copyButton}
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

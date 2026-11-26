import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from "react";
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
import { useDiagramActivation } from "../mermaid/use-diagram-activation";
import { useDiagramHeight } from "../mermaid/use-diagram-height";
import { useMermaidImageActions } from "../mermaid/image-actions";

export function MermaidCodeBlock({
  node,
  editor,
  getPos,
  copyButton,
}: NodeViewProps & { copyButton: ReactNode }) {
  const [edit, setEdit] = useState(false);
  const [showReadOnlySource, setShowReadOnlySource] = useState(false);
  const [dismissedMatch, setDismissedMatch] = useState<number | null>(null);
  const [dismissedSelection, setDismissedSelection] = useState<string | null>(null);
  const [previewSource, setPreviewSource] = useState(node.textContent);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  const sourceId = useId();
  const editable = editor.isEditable;
  const openSource = () => {
    const start = getPos();
    if (typeof start !== "number") return;
    setEdit(true);
    if (sourceRef.current) sourceRef.current.scrollTop = 0;
  };
  const imageActions = useMermaidImageActions(rootRef, {
    onEditSource: editable ? openSource : undefined,
  });
  const position = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const start = getPos();
      if (typeof start !== "number" || start < 0 || start >= current.state.doc.content.size)
        return { selection: null, match: null };
      const documentNode = current.state.doc.nodeAt(start);
      if (documentNode?.type.name !== "codeBlock") return { selection: null, match: null };
      const end = start + documentNode.nodeSize;
      const selection = current.state.selection;
      const selectionInside =
        current.isFocused &&
        selection instanceof TextSelection &&
        selection.from > start &&
        selection.to < end;
      const search = searchHighlightPluginKey.getState(current.state);
      const match = search?.matches[search.activeIndex]?.from;
      return {
        selection: selectionInside ? `${selection.anchor}:${selection.head}` : null,
        match: match != null && match > start && match < end ? match : null,
      };
    },
  });
  const revealSearch = position.match !== null && position.match !== dismissedMatch;
  const revealSelection = position.selection !== null && position.selection !== dismissedSelection;
  const showSource = editable ? edit || revealSelection || revealSearch : showReadOnlySource;

  useEffect(() => {
    if (position.match === null) setDismissedMatch(null);
  }, [position.match]);

  useEffect(() => {
    if (dismissedSelection !== null && position.selection !== dismissedSelection)
      setDismissedSelection(null);
  }, [position.selection, dismissedSelection]);

  const source = node.textContent;
  useEffect(() => {
    if (!showSource) setPreviewSource(source);
  }, [showSource, source]);

  useDiagramHeight(bodyRef, previewRef);

  const diagramActivation = useDiagramActivation(openSource, true);

  const closeSource = useEffectEvent(() => {
    setEdit(false);
    setDismissedMatch(position.match);
    setDismissedSelection(position.selection);
  });

  useEffect(() => {
    const body = bodyRef.current;
    if (!editable || !showSource || !body) return;
    const editorDom = editor.view.dom;
    const { ownerDocument } = body;
    const closeOutside = (event: Event) => {
      if (body.contains(event.target as Node)) return;
      if (event.type === "focusin" && event.target === editorDom) return;
      closeSource();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      )
        return;
      const target = event.target;
      if (
        target instanceof Element &&
        !body.contains(target) &&
        target.closest(
          "dialog[open], [role='dialog'], [role='menu'], [role='listbox'], input, textarea",
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      closeSource();
      // Wait for the preview to become interactive before returning keyboard focus to it.
      requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    };
    ownerDocument.addEventListener("click", closeOutside, true);
    ownerDocument.addEventListener("focusin", closeOutside);
    ownerDocument.addEventListener("keydown", handleEscape, true);
    return () => {
      ownerDocument.removeEventListener("click", closeOutside, true);
      ownerDocument.removeEventListener("focusin", closeOutside);
      ownerDocument.removeEventListener("keydown", handleEscape, true);
    };
  }, [editable, editor, getPos, showSource]);

  return (
    <NodeViewWrapper
      ref={rootRef}
      className="mermaid-code-block"
      onContextMenu={imageActions.onContextMenu}
      onKeyDown={imageActions.onKeyDown}
    >
      {!editable ? (
        <div className="mermaid-toolbar" contentEditable={false}>
          <button
            className="mermaid-action"
            type="button"
            aria-expanded={showSource}
            onClick={() => setShowReadOnlySource((value) => !value)}
          >
            {showSource ? "显示图表" : "查看源码"}
          </button>
        </div>
      ) : null}
      <div ref={bodyRef} className="mermaid-body">
        <div
          ref={previewRef}
          className={editable ? "mermaid-rendered is-editable" : "mermaid-rendered"}
          contentEditable={false}
          inert={showSource}
          {...(editable ? diagramActivation : undefined)}
          onMouseDownCapture={
            editable
              ? (event) => {
                  // Do not let a non-editable diagram restore a stale editor selection.
                  if (event.button === 0 || event.button === 2) event.preventDefault();
                }
              : undefined
          }
        >
          {editable ? (
            <button
              ref={triggerRef}
              className="mermaid-edit-trigger"
              type="button"
              aria-label="编辑图表"
              aria-controls={sourceId}
              onClick={openSource}
            />
          ) : null}
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
      {imageActions.menu}
    </NodeViewWrapper>
  );
}

import { useEffect, useRef, type MouseEvent } from "react";
import type { Editor } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import {
  Copy,
  Scissors,
  ClipboardPaste,
  Undo2,
  Redo2,
  TextSelect,
  Bold,
  Eraser,
  Highlighter,
  Italic,
  MessageSquarePlus,
  MessageSquareText,
  RemoveFormatting,
  FileText,
  Trash2,
} from "lucide-react";
import { textFieldMenuItems, useContextMenu, type ContextMenuItem } from "../context-menu";
import { modKey } from "../platform";
import { pastePlainTextIntoCodeBlock } from "./code-block-paste";
import { copyPlainText } from "./code-block-copy";
import {
  annotationIdsInRange,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_COLOR_LABELS,
  HIGHLIGHT_COLOR_VALUES,
  normalizeHighlightColor,
} from "./highlight-annotation";

function clipboardError(action: "copy" | "paste") {
  return new Error(
    `浏览器未允许${action === "copy" ? "写入" : "读取"}剪贴板，请使用 ${modKey}+${action === "copy" ? "C" : "V"}。`,
  );
}

export function useEditorContextMenu({
  editor,
  noteId,
  locked,
  deleted,
  onTitleChange,
  noteActions,
  onAddAnnotation,
  onEditAnnotation,
  onDeleteAnnotation,
}: {
  editor: Editor | null;
  noteId: string;
  locked: boolean;
  deleted: boolean;
  onTitleChange: (title: string) => void;
  noteActions: ContextMenuItem[];
  onAddAnnotation: (from: number, to: number) => void;
  onEditAnnotation: (id: string) => void;
  onDeleteAnnotation: (ids: string[]) => void;
}) {
  const { openMenu, closeMenu, menu } = useContextMenu();
  const contextRef = useRef({ noteId, locked, deleted });
  contextRef.current = { noteId, locked, deleted };
  useEffect(() => {
    closeMenu();
  }, [noteId, locked, deleted, closeMenu]);

  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!(event.target instanceof HTMLElement)) return;
    const field = event.target.closest("textarea");
    if (field) {
      openMenu(
        event,
        textFieldMenuItems(
          field,
          onTitleChange,
          () =>
            contextRef.current.noteId === noteId &&
            !contextRef.current.locked &&
            !contextRef.current.deleted,
        ),
        "标题编辑",
      );
      return;
    }
    if (event.target.closest("dialog, [role='menu'], input")) return;
    if (!event.target.closest(".tiptap")) {
      openMenu(event, noteActions, "当前笔记");
      return;
    }
    if (!editor || editor.isDestroyed) return;
    if (editor.view.composing) return;
    const { selection, doc } = editor.state;
    const editable = !locked && !deleted && editor.isEditable;
    const hasSelection = !selection.empty;
    const valid = () =>
      !editor.isDestroyed &&
      editor.state.doc === doc &&
      contextRef.current.noteId === noteId &&
      !contextRef.current.locked &&
      !contextRef.current.deleted;
    const restore = () => {
      if (!valid()) return false;
      editor.view.dispatch(editor.state.tr.setSelection(selection));
      editor.view.focus();
      return true;
    };
    const copy = async (cut = false) => {
      const { dom, text } = editor.view.serializeForClipboard(selection.content());
      try {
        if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": new Blob([text], { type: "text/plain" }),
              "text/html": new Blob([dom.innerHTML], { type: "text/html" }),
            }),
          ]);
        } else await navigator.clipboard.writeText(text);
      } catch {
        try {
          await copyPlainText(text);
        } catch {
          throw clipboardError("copy");
        }
      }
      if (cut && restore() && editor.isEditable) editor.commands.deleteSelection();
    };
    const paste = async (plain = false) => {
      let text = "";
      let html = "";
      const files: File[] = [];
      try {
        if (!plain && navigator.clipboard?.read) {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            if (item.types.includes("text/plain"))
              text = await (await item.getType("text/plain")).text();
            if (item.types.includes("text/html"))
              html = await (await item.getType("text/html")).text();
            const imageType = item.types.find((type) => /^image\/(png|jpeg|webp|gif)$/.test(type));
            if (imageType && !html)
              files.push(
                new File([await item.getType(imageType)], `粘贴图片.${imageType.split("/")[1]}`, {
                  type: imageType,
                }),
              );
          }
        } else text = await navigator.clipboard.readText();
      } catch {
        throw clipboardError("paste");
      }
      // A delayed permission prompt must never paste into another note or overwrite newer edits.
      if (!restore() || !editor.isEditable) return;
      if (plain) {
        if (!text || pastePlainTextIntoCodeBlock(editor.view, text)) return;
        const paragraphs = text
          .replace(/\r\n?/g, "\n")
          .split("\n")
          .map((line) =>
            editor.schema.nodes.paragraph!.create(
              null,
              line ? editor.schema.text(line) : undefined,
            ),
          );
        const slice = Slice.maxOpen(Fragment.fromArray(paragraphs));
        editor.view.dispatch(
          editor.state.tr.replaceSelection(slice).setMeta("uiEvent", "paste").scrollIntoView(),
        );
      } else {
        const data = new DataTransfer();
        if (text) data.setData("text/plain", text);
        if (html) data.setData("text/html", html);
        for (const file of files) data.items.add(file);
        const clipboardEvent = new ClipboardEvent("paste", { clipboardData: data });
        if (html) editor.view.pasteHTML(html, clipboardEvent);
        else editor.view.pasteText(text, clipboardEvent);
      }
    };
    const command = (run: () => unknown) => () => {
      if (restore() && editable) run();
    };
    const items: ContextMenuItem[] = [
      {
        label: "撤销",
        icon: Undo2,
        shortcut: `${modKey} Z`,
        disabled: !editable || !editor.can().undo(),
        onSelect: command(() => editor.commands.undo()),
      },
      {
        label: "重做",
        icon: Redo2,
        shortcut: `${modKey} ⇧ Z`,
        disabled: !editable || !editor.can().redo(),
        onSelect: command(() => editor.commands.redo()),
      },
      {
        label: "剪切",
        icon: Scissors,
        shortcut: `${modKey} X`,
        separator: true,
        disabled: !editable || !hasSelection,
        onSelect: () => copy(true),
      },
      {
        label: "复制",
        icon: Copy,
        shortcut: `${modKey} C`,
        disabled: !hasSelection,
        onSelect: () => copy(),
      },
      {
        label: "粘贴",
        icon: ClipboardPaste,
        shortcut: `${modKey} V`,
        disabled: !editable,
        onSelect: () => paste(),
      },
      { label: "粘贴为纯文本", icon: FileText, disabled: !editable, onSelect: () => paste(true) },
      {
        label: "全选正文",
        icon: TextSelect,
        shortcut: `${modKey} A`,
        separator: true,
        onSelect: () => {
          if (restore()) editor.commands.selectAll();
        },
      },
    ];
    if (hasSelection && editable)
      items.push(
        {
          label: "加粗",
          icon: Bold,
          shortcut: `${modKey} B`,
          separator: true,
          onSelect: command(() => editor.commands.toggleBold()),
        },
        {
          label: "斜体",
          icon: Italic,
          shortcut: `${modKey} I`,
          onSelect: command(() => editor.commands.toggleItalic()),
        },
        {
          label: "清除文字格式",
          icon: RemoveFormatting,
          onSelect: command(() =>
            editor
              .chain()
              .focus()
              .command(({ tr, state }) => {
                for (const name of Object.keys(state.schema.marks)) {
                  if (name === "noteAnnotation") continue;
                  tr.removeMark(state.selection.from, state.selection.to, state.schema.marks[name]);
                }
                return true;
              })
              .run(),
          ),
        },
      );
    let containsCode = false;
    doc.nodesBetween(selection.from, selection.to, (node) => {
      if (
        node.type.name === "codeBlock" ||
        (node.isText && node.marks.some((mark) => mark.type.name === "code"))
      ) {
        containsCode = true;
        return false;
      }
    });
    const annotationIds = new Set(annotationIdsInRange(doc, selection.from, selection.to));
    if (!hasSelection) {
      const marks = editor.state.storedMarks ?? selection.$from.marks();
      for (const mark of marks) {
        if (mark.type.name === "noteAnnotation" && typeof mark.attrs.id === "string")
          annotationIds.add(mark.attrs.id);
      }
      for (const mark of selection.$from.nodeAfter?.marks ?? []) {
        if (mark.type.name === "noteAnnotation" && typeof mark.attrs.id === "string")
          annotationIds.add(mark.attrs.id);
      }
    }

    if (hasSelection && editable && !containsCode) {
      const colors = new Set<string>();
      doc.nodesBetween(selection.from, selection.to, (node) => {
        if (!node.isText) return;
        const highlight = node.marks.find((mark) => mark.type.name === "noteHighlight");
        if (highlight) colors.add(normalizeHighlightColor(highlight.attrs.color));
      });
      const activeColor = colors.size === 1 ? [...colors][0] : null;
      items.push({
        label: "高亮颜色",
        icon: Highlighter,
        separator: true,
        swatches: HIGHLIGHT_COLORS.map((color) => ({
          label: HIGHLIGHT_COLOR_LABELS[color],
          value: color,
          color: `var(--note-highlight-${color}, ${HIGHLIGHT_COLOR_VALUES[color]})`,
          active: activeColor === color,
          onSelect: command(() => editor.chain().focus().setMark("noteHighlight", { color }).run()),
        })),
        onSelect: () => {},
      });
      if (colors.size > 0) {
        items.push({
          label: "清除高亮",
          icon: Eraser,
          onSelect: command(() => editor.commands.unsetMark("noteHighlight")),
        });
      }
    }

    if (editable && !containsCode) {
      if (hasSelection && annotationIds.size === 0) {
        items.push({
          label: "添加批注",
          icon: MessageSquarePlus,
          separator: true,
          onSelect: command(() => onAddAnnotation(selection.from, selection.to)),
        });
      } else if (annotationIds.size === 1) {
        const id = [...annotationIds][0]!;
        items.push(
          {
            label: "编辑批注",
            icon: MessageSquareText,
            separator: true,
            onSelect: command(() => onEditAnnotation(id)),
          },
          {
            label: "删除批注",
            icon: Trash2,
            onSelect: command(() => onDeleteAnnotation([id])),
          },
        );
      } else if (annotationIds.size > 1) {
        items.push({
          label: "删除所选批注",
          icon: Trash2,
          separator: true,
          onSelect: command(() => onDeleteAnnotation([...annotationIds])),
        });
      }
    }
    openMenu(event, items, "正文编辑");
  };
  return { onContextMenu, menu };
}

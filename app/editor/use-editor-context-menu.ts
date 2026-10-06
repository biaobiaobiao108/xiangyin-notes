import { useEffect, useRef, type MouseEvent } from "react";
import type { Editor } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Copy, Scissors, ClipboardPaste, Undo2, Redo2, TextSelect, Bold, Italic, RemoveFormatting, FileText } from "lucide-react";
import { textFieldMenuItems, useContextMenu, type ContextMenuItem } from "../context-menu";
import { modKey } from "../platform";
import { pastePlainTextIntoCodeBlock } from "./code-block-paste";

function clipboardError(action: "copy" | "paste") {
  return new Error(`浏览器未允许${action === "copy" ? "写入" : "读取"}剪贴板，请使用 ${modKey}+${action === "copy" ? "C" : "V"}。`);
}

export function useEditorContextMenu({ editor, noteId, locked, deleted, onTitleChange, noteActions }: { editor: Editor | null; noteId: string; locked: boolean; deleted: boolean; onTitleChange: (title: string) => void; noteActions: ContextMenuItem[] }) {
  const { openMenu, closeMenu, menu } = useContextMenu();
  const contextRef = useRef({ noteId, locked, deleted });
  contextRef.current = { noteId, locked, deleted };
  useEffect(() => { closeMenu(); }, [noteId, locked, deleted, closeMenu]);

  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!(event.target instanceof HTMLElement)) return;
    const field = event.target.closest("textarea");
    if (field) {
      openMenu(event, textFieldMenuItems(field, onTitleChange, () => contextRef.current.noteId === noteId && !contextRef.current.locked && !contextRef.current.deleted), "标题编辑");
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
    const valid = () => !editor.isDestroyed && editor.state.doc === doc && contextRef.current.noteId === noteId && !contextRef.current.locked;
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
          await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([dom.innerHTML], { type: "text/html" }) })]);
        } else await navigator.clipboard.writeText(text);
      } catch { throw clipboardError("copy"); }
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
            if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
            if (item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
            const imageType = item.types.find((type) => /^image\/(png|jpeg|webp|gif)$/.test(type));
            if (imageType && !html) files.push(new File([await item.getType(imageType)], `粘贴图片.${imageType.split("/")[1]}`, { type: imageType }));
          }
        } else text = await navigator.clipboard.readText();
      } catch { throw clipboardError("paste"); }
      // A delayed permission prompt must never paste into another note or overwrite newer edits.
      if (!restore() || !editor.isEditable) return;
      if (plain) {
        if (!text || pastePlainTextIntoCodeBlock(editor.view, text)) return;
        const paragraphs = text.replace(/\r\n?/g, "\n").split("\n").map((line) => editor.schema.nodes.paragraph!.create(null, line ? editor.schema.text(line) : undefined));
        const slice = Slice.maxOpen(Fragment.fromArray(paragraphs));
        editor.view.dispatch(editor.state.tr.replaceSelection(slice).setMeta("uiEvent", "paste").scrollIntoView());
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
    const command = (run: () => unknown) => () => { if (restore() && editable) run(); };
    const items: ContextMenuItem[] = [
      { label: "撤销", icon: Undo2, shortcut: `${modKey} Z`, disabled: !editable || !editor.can().undo(), onSelect: command(() => editor.commands.undo()) },
      { label: "重做", icon: Redo2, shortcut: `${modKey} ⇧ Z`, disabled: !editable || !editor.can().redo(), onSelect: command(() => editor.commands.redo()) },
      { label: "剪切", icon: Scissors, shortcut: `${modKey} X`, separator: true, disabled: !editable || !hasSelection, onSelect: () => copy(true) },
      { label: "复制", icon: Copy, shortcut: `${modKey} C`, disabled: !hasSelection, onSelect: () => copy() },
      { label: "粘贴", icon: ClipboardPaste, shortcut: `${modKey} V`, disabled: !editable, onSelect: () => paste() },
      { label: "粘贴为纯文本", icon: FileText, disabled: !editable, onSelect: () => paste(true) },
      { label: "全选正文", icon: TextSelect, shortcut: `${modKey} A`, separator: true, onSelect: () => { if (restore()) editor.commands.selectAll(); } },
    ];
    if (hasSelection && editable) items.push(
      { label: "加粗", icon: Bold, shortcut: `${modKey} B`, separator: true, onSelect: command(() => editor.commands.toggleBold()) },
      { label: "斜体", icon: Italic, shortcut: `${modKey} I`, onSelect: command(() => editor.commands.toggleItalic()) },
      { label: "清除文字格式", icon: RemoveFormatting, onSelect: command(() => editor.commands.unsetAllMarks()) },
    );
    openMenu(event, items, "正文编辑");
  };
  return { onContextMenu, menu };
}

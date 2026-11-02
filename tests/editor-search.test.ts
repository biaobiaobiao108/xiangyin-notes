import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { createMarkdownExtension } from "../app/editor/markdown-config";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { history } from "@tiptap/pm/history";
import {
  cycleSearchMatchIndex,
  findTextMatchSummary,
  findTextMatches,
  getSearchTerms,
  normalizeSearchMatchIndex,
  createSearchHighlightPlugin,
  searchHighlightPluginKey,
  findEditorReplaceMatches,
  replaceEditorSearchMatches,
} from "../app/editor-search";

describe("editor search", () => {
  test("querying, switching and clearing real editor highlights do not emit edits", () => {
    let updates = 0;
    const editor = new Editor({
      element: null,
      extensions: [StarterKit, createMarkdownExtension()],
      content: "Find this phrase and this phrase again",
      contentType: "markdown",
      onUpdate: () => updates++,
    });
    editor.registerPlugin(createSearchHighlightPlugin());
    try {
      const original = editor.state.doc;
      const dispatchMeta = (
        meta: { type: "query"; query: string } | { type: "activeIndex"; index: number },
      ) => editor.view.dispatch(editor.state.tr.setMeta(searchHighlightPluginKey, meta));

      dispatchMeta({ type: "query", query: "phrase" });
      expect(searchHighlightPluginKey.getState(editor.state)?.decorations.find()).toHaveLength(2);
      dispatchMeta({ type: "activeIndex", index: 1 });
      expect(searchHighlightPluginKey.getState(editor.state)?.activeIndex).toBe(1);
      dispatchMeta({ type: "query", query: "" });
      expect(searchHighlightPluginKey.getState(editor.state)?.decorations.find()).toHaveLength(0);
      expect(editor.state.doc.eq(original)).toBe(true);
      expect(updates).toBe(0);
    } finally {
      editor.destroy();
    }
  });

  test("literal replacement keeps adjacent matches separate", () => {
    const editor = new Editor({
      element: null,
      extensions: [StarterKit],
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "aaa" }] }],
      },
    });
    try {
      const { transaction, count } = replaceEditorSearchMatches(editor.state, "a", "b");
      expect(count).toBe(3);
      expect(transaction.doc.textContent).toBe("bbb");
    } finally {
      editor.destroy();
    }
  });

  test("finds every Chinese match in document order", () => {
    expect(findTextMatches("绝对不是绝缘，绝对。绝对", "绝对")).toEqual([
      { start: 0, end: 2 },
      { start: 7, end: 9 },
      { start: 10, end: 12 },
    ]);
  });

  test("matches Latin text without case sensitivity", () => {
    expect(findTextMatches("Search the SEARCH result", "search")).toEqual([
      { start: 0, end: 6 },
      { start: 11, end: 17 },
    ]);
  });

  test("maps Unicode lowercase expansions back to original text offsets", () => {
    expect(findTextMatches("İfoo İFOO", "foo")).toEqual([
      { start: 1, end: 4 },
      { start: 6, end: 9 },
    ]);
    expect(findTextMatches("İ", "i")).toEqual([{ start: 0, end: 1 }]);
  });

  test("limits stored matches while reporting the exact hit count", () => {
    const summary = findTextMatchSummary("hit ".repeat(2_000), "hit", 3);
    expect(summary.totalMatchCount).toBe(2_000);
    expect(summary.matches).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  test("splits Latin queries into searchable terms and ignores punctuation", () => {
    expect(getSearchTerms("quiet,  THINKING")).toEqual(["quiet", "thinking"]);
    expect(findTextMatches("Quiet thinking keeps thinking clear", "quiet, thinking")).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 14 },
      { start: 21, end: 29 },
    ]);
  });

  test("deduplicates overlapping matches from repeated terms", () => {
    expect(findTextMatches("foobar foo", "foo foobar")).toEqual([
      { start: 0, end: 6 },
      { start: 7, end: 10 },
    ]);
  });

  test("returns no match for an empty or punctuation-only query", () => {
    expect(findTextMatches("anything", "")).toEqual([]);
    expect(findTextMatches("anything", "!!!")).toEqual([]);
  });

  test("normalizes and cycles match indexes with wraparound", () => {
    expect(normalizeSearchMatchIndex(0, 3)).toBe(0);
    expect(normalizeSearchMatchIndex(-1, 3)).toBe(2);
    expect(normalizeSearchMatchIndex(4, 3)).toBe(1);
    expect(normalizeSearchMatchIndex(4, 0)).toBe(0);
    expect(cycleSearchMatchIndex(0, 3, -1)).toBe(2);
    expect(cycleSearchMatchIndex(2, 3, 1)).toBe(0);
    expect(cycleSearchMatchIndex(1, 1, 1)).toBe(0);
  });

  test("literal replacement matches across inline marks and stays within each text block", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { content: "inline*", group: "block" },
        text: { group: "inline" },
      },
      marks: { strong: {} },
    });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("A "),
        schema.text("Fo", [schema.mark("strong")]),
        schema.text("O", [schema.mark("strong")]),
        schema.text(" bar"),
      ]),
      schema.node("paragraph", null, [schema.text("foo bar")]),
    ]);
    expect(findEditorReplaceMatches(doc, "foo bar")).toEqual([
      { from: 3, to: 10 },
      { from: 12, to: 19 },
    ]);
    expect(findEditorReplaceMatches(doc, "FOO")).toEqual([
      { from: 3, to: 6 },
      { from: 12, to: 15 },
    ]);
  });

  test("replaces every literal match in one transaction, including more than 500", () => {
    const editor = new Editor({
      element: null,
      extensions: [StarterKit, createMarkdownExtension()],
      content: "hit ".repeat(700),
      contentType: "markdown",
    });
    editor.registerPlugin(history());
    try {
      const { transaction, count } = replaceEditorSearchMatches(editor.state, "HIT", "done");
      expect(count).toBe(700);
      editor.view.dispatch(transaction);
      expect(editor.state.doc.textContent).toBe("done ".repeat(700));
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.textContent).toBe("hit ".repeat(700));
    } finally {
      editor.destroy();
    }
  });

  test("literal highlight mode tracks replacement query text and updates after edits", () => {
    const editor = new Editor({
      element: null,
      extensions: [StarterKit, createMarkdownExtension()],
      content: "foo food",
      contentType: "markdown",
    });
    editor.registerPlugin(createSearchHighlightPlugin());
    try {
      editor.view.dispatch(
        editor.state.tr.setMeta(searchHighlightPluginKey, {
          type: "query",
          query: "foo",
          literal: true,
        }),
      );
      const state = searchHighlightPluginKey.getState(editor.state);
      expect(state?.literal).toBe(true);
      expect(state?.totalMatchCount).toBe(2);
      const { transaction } = replaceEditorSearchMatches(editor.state, "foo", "x");
      editor.view.dispatch(transaction);
      expect(searchHighlightPluginKey.getState(editor.state)?.totalMatchCount).toBe(0);
    } finally {
      editor.destroy();
    }
  });
});

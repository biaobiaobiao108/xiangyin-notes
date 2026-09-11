import { describe, expect, test } from "bun:test";
import { parseCreateNoteCommand, parseSearchPrefixCommand } from "../app/command-parser";
import type { Notebook } from "../shared/types";

const notebook = (id: string, name: string): Notebook => ({ id, name, color: "#d96245", isSystem: false, count: 0, updatedAt: 0 });

describe("create note command parser", () => {
  test("parses a named note in a notebook", () => {
    expect(parseCreateNoteCommand("新建 测试 功能测试", [notebook("notebook-1", "测试")])).toEqual({
      kind: "match",
      command: { notebookId: "notebook-1", notebookName: "测试", title: "功能测试" },
    });
  });

  test("keeps spaces inside notebook names and note titles", () => {
    expect(parseCreateNoteCommand("  新建  项目 资料   周五 复盘  ", [notebook("notebook-1", "项目 资料")])).toEqual({
      kind: "match",
      command: { notebookId: "notebook-1", notebookName: "项目 资料", title: "周五 复盘" },
    });
  });

  test("uses the longest notebook name when names share a prefix", () => {
    expect(parseCreateNoteCommand("新建 项目 资料 会议记录", [notebook("short", "项目"), notebook("long", "项目 资料")])).toEqual({
      kind: "match",
      command: { notebookId: "long", notebookName: "项目 资料", title: "会议记录" },
    });
  });

  test("reports unknown notebooks and missing titles without creating a command", () => {
    expect(parseCreateNoteCommand("新建 不存在 功能测试", [notebook("notebook-1", "测试")])).toEqual({ kind: "error", message: "找不到这个笔记本，请输入已有笔记本名称" });
    expect(parseCreateNoteCommand("新建 测试", [notebook("notebook-1", "测试")])).toEqual({ kind: "error", message: "请输入笔记标题" });
  });

  test("rejects titles longer than the backend limit", () => {
    expect(parseCreateNoteCommand(`新建 测试 ${"字".repeat(201)}`, [notebook("notebook-1", "测试")])).toEqual({ kind: "error", message: "笔记标题不能超过 200 个字符" });
  });

  test("leaves the existing static new-note command and unrelated queries alone", () => {
    expect(parseCreateNoteCommand("新建笔记", [notebook("notebook-1", "测试")])).toBeNull();
    expect(parseCreateNoteCommand("搜索 功能测试", [notebook("notebook-1", "测试")])).toBeNull();
  });
});

describe("search prefix parser", () => {
  test("parses in-note search prefixes", () => {
    expect(parseSearchPrefixCommand("搜索 关键词")).toEqual({ scope: "in-note", term: "关键词" });
    expect(parseSearchPrefixCommand("查找:重点 内容")).toEqual({ scope: "in-note", term: "重点 内容" });
    expect(parseSearchPrefixCommand("搜索：全角冒号")).toEqual({ scope: "in-note", term: "全角冒号" });
    expect(parseSearchPrefixCommand("find  test term")).toEqual({ scope: "in-note", term: "test term" });
    expect(parseSearchPrefixCommand("FIND uppercase")).toEqual({ scope: "in-note", term: "uppercase" });
    expect(parseSearchPrefixCommand("   搜索  缩进文本  ")).toEqual({ scope: "in-note", term: "缩进文本" });
    expect(parseSearchPrefixCommand("搜索 ")).toEqual({ scope: "in-note", term: "" });
  });

  test("parses global search prefixes", () => {
    expect(parseSearchPrefixCommand("全局搜索 笔记")).toEqual({ scope: "global", term: "笔记" });
    expect(parseSearchPrefixCommand("all:my note")).toEqual({ scope: "global", term: "my note" });
    expect(parseSearchPrefixCommand("ALL uppercase")).toEqual({ scope: "global", term: "uppercase" });
    expect(parseSearchPrefixCommand("全局 架构设计")).toEqual({ scope: "global", term: "架构设计" });
    expect(parseSearchPrefixCommand("global something")).toEqual({ scope: "global", term: "something" });
  });

  test("returns null when no valid prefix delimiter is present", () => {
    expect(parseSearchPrefixCommand("搜索")).toBeNull();
    expect(parseSearchPrefixCommand("搜索笔记")).toBeNull();
    expect(parseSearchPrefixCommand("全局搜索")).toBeNull();
    expect(parseSearchPrefixCommand("全局搜索笔记")).toBeNull();
    expect(parseSearchPrefixCommand("普通搜索文本")).toBeNull();
    expect(parseSearchPrefixCommand("")).toBeNull();
  });
});



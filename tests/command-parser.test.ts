import { describe, expect, test } from "bun:test";
import { parseCreateNoteCommand, parseMoveNoteCommand, parseSearchPrefixCommand } from "../app/command-parser";
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
    expect(parseSearchPrefixCommand("全局搜索 #Tag")).toEqual({ scope: "global", term: "#Tag" });
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

describe("move note command parser", () => {
  const books = [
    notebook("nb-1", "收件箱"),
    notebook("nb-2", "日记"),
    notebook("nb-3", "工作日记"),
    notebook("nb-4", "生活"),
  ];

  test("lists all notebooks when prefix has no remainder", () => {
    expect(parseMoveNoteCommand("移动至", books)).toEqual({
      kind: "list",
      queryText: "",
      matches: books,
    });
    expect(parseMoveNoteCommand("移动至 ", books)).toEqual({
      kind: "list",
      queryText: "",
      matches: books,
    });
    expect(parseMoveNoteCommand("移动到", books)).toEqual({
      kind: "list",
      queryText: "",
      matches: books,
    });
    expect(parseMoveNoteCommand("move to", books)).toEqual({
      kind: "list",
      queryText: "",
      matches: books,
    });
  });

  test("filters matching notebooks with exact match first", () => {
    const res = parseMoveNoteCommand("移动至 日记", books);
    expect(res?.kind).toBe("list");
    if (res?.kind === "list") {
      expect(res.queryText).toBe("日记");
      expect(res.matches.map((m) => m.name)).toEqual(["日记", "工作日记"]);
    }
  });

  test("supports '移动' and colon delimiters", () => {
    const res = parseMoveNoteCommand("移动:生活", books);
    expect(res?.kind).toBe("list");
    if (res?.kind === "list") {
      expect(res.queryText).toBe("生活");
      expect(res.matches.map((m) => m.name)).toEqual(["生活"]);
    }

    const res2 = parseMoveNoteCommand("移动 工作", books);
    expect(res2?.kind).toBe("list");
    if (res2?.kind === "list") {
      expect(res2.matches.map((m) => m.name)).toEqual(["工作日记"]);
    }
  });

  test("reports error when no matching notebook exists", () => {
    expect(parseMoveNoteCommand("移动至 不存在", books)).toEqual({
      kind: "error",
      message: "找不到名称包含“不存在”的笔记本",
    });
  });

  test("returns null for non-move queries and lone '移动' without space", () => {
    expect(parseMoveNoteCommand("移动", books)).toBeNull();
    expect(parseMoveNoteCommand("新建笔记", books)).toBeNull();
    expect(parseMoveNoteCommand("普通搜索", books)).toBeNull();
  });
});



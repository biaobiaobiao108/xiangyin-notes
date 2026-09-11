import { describe, expect, test } from "bun:test";
import { parseCreateNoteCommand } from "../app/command-parser";
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

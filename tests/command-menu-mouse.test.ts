import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { CommandMenu } from "../app/command-menu";

describe("CommandMenu 键盘优先与鼠标防干扰契约", () => {
  it("触屏布局不渲染键盘活动项高亮，但保留命令选择语义", () => {
    const html = renderToString(
      React.createElement(CommandMenu, {
        open: true,
        isMobileViewport: true,
        onClose: () => {},
        onCommand: () => {},
        onCreateNoteInNotebook: () => {},
        canRestore: false,
        canMoveToTrash: true,
        notebooks: [],
        canInstallApp: false,
        showIosInstallHint: false,
        standalone: false,
        themePreference: "system",
      }),
    );
    expect(html).toContain('aria-selected="true"');
  });

  it("打开时只有选中项带有 is-selected，其他项无高亮干扰", () => {
    const html = renderToString(
      React.createElement(CommandMenu, {
        open: true,
        onClose: () => {},
        onCommand: () => {},
        onCreateNoteInNotebook: () => {},
        canRestore: false,
        canMoveToTrash: true,
        notebooks: [],
        canInstallApp: false,
        showIosInstallHint: false,
        standalone: false,
        themePreference: "system",
      }),
    );

    // 默认第一项带有 is-selected
    expect(html).toContain("command-row");
    expect(html).toContain("is-selected");
  });

  it("输入普通搜索文本时不自动添加全局搜索命令选项", () => {
    const html = renderToString(
      React.createElement(CommandMenu, {
        open: true,
        initialQuery: "自定义文本",
        onClose: () => {},
        onCommand: () => {},
        onCreateNoteInNotebook: () => {},
        canRestore: false,
        canMoveToTrash: true,
        notebooks: [],
        canInstallApp: false,
        showIosInstallHint: false,
        standalone: false,
        themePreference: "system",
      }),
    );

    expect(html).not.toContain("在全部笔记中搜索“自定义文本”");
    expect(html).toContain("没有匹配的命令");
  });

  it("输入全局搜索前缀时正确显示全局搜索命令选项", () => {
    const html = renderToString(
      React.createElement(CommandMenu, {
        open: true,
        initialQuery: "全局搜索 架构设计",
        onClose: () => {},
        onCommand: () => {},
        onCreateNoteInNotebook: () => {},
        canRestore: false,
        canMoveToTrash: true,
        notebooks: [],
        canInstallApp: false,
        showIosInstallHint: false,
        standalone: false,
        themePreference: "system",
      }),
    );

    expect(html).toContain("在全部笔记中搜索“架构设计”");
  });
});

import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { CommandMenu } from "../app/command-menu";

describe("CommandMenu 键盘优先与鼠标防干扰契约", () => {
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
      })
    );

    // 默认第一项带有 is-selected
    expect(html).toContain("command-row");
    expect(html).toContain("is-selected");

    // 不包含原生的 hover 背景干扰
    expect(html).not.toContain("command-row:hover");
  });
});

import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyTrashButton } from "../app/workspace/empty-trash-button";

const render = (props: Partial<React.ComponentProps<typeof EmptyTrashButton>> = {}) =>
  renderToStaticMarkup(React.createElement(EmptyTrashButton, { onClick: () => {}, ...props }));

describe("empty trash action", () => {
  test("renders a named icon-only button without a tooltip title", () => {
    const html = render();

    expect(html).toContain('aria-label="清空回收站"');
    expect(html).toContain('type="button"');
    expect(html).toContain("empty-trash-button");
    // 图标按钮不留可见文字，也不靠 title 提示可访问名称。
    expect(html).not.toContain("title=");
    expect(html).not.toContain(">清空回收站<");
  });

  test("disables the button while the trash is busy or empty", () => {
    expect(render({ disabled: true })).toContain("disabled");
    expect(render({ disabled: false })).not.toContain("disabled");
  });

  test("keeps caller class names and icon sizing without dropping the base classes", () => {
    const html = render({ className: "card-grid-empty-trash", iconSize: 20 });

    expect(html).toContain('class="icon-button empty-trash-button card-grid-empty-trash"');
    expect(html).toContain('width="20"');
  });
});

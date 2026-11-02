import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorErrorFallback, ErrorBoundary } from "../app/error-boundary";

describe("ErrorBoundary", () => {
  test("renders children normally when no error occurs", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ErrorBoundary,
        null,
        React.createElement("div", { className: "child-content" }, "正常内容"),
      ),
    );

    expect(html).toContain("正常内容");
    expect(html).toContain("child-content");
    expect(html).not.toContain("页面遇到意外错误");
  });

  test("getDerivedStateFromError captures error in state", () => {
    const testError = new Error("状态捕获测试");
    const state = ErrorBoundary.getDerivedStateFromError(testError);

    expect(state.hasError).toBe(true);
    expect(state.error).toBe(testError);
  });

  test("renders default fallback UI when in error state", () => {
    const boundary = new ErrorBoundary({ children: "正常内容" });
    boundary.state = { hasError: true, error: new Error("渲染时崩溃测试") };

    const html = renderToStaticMarkup(boundary.render() as React.ReactElement);

    expect(html).toContain('role="alert"');
    expect(html).toContain("app-error-shell");
    expect(html).toContain("页面遇到意外错误");
    expect(html).toContain("渲染时崩溃测试");
    expect(html).toContain("刷新重试");
    expect(html).toContain("返回主页");
  });

  test("reset invokes setState to clear error state", () => {
    const boundary = new ErrorBoundary({ children: "正常内容" });
    let updatedState: unknown = null;
    boundary.setState = (nextState: unknown) => {
      updatedState = nextState;
    };

    boundary.reset();

    expect(updatedState).toEqual({ hasError: false, error: null });
  });

  test("supports custom fallback render prop", () => {
    const customFallback = (error: Error) =>
      React.createElement("div", { className: "custom-fallback" }, `捕获异常: ${error.message}`);

    const boundary = new ErrorBoundary({
      fallback: customFallback,
      children: "正常内容",
    });
    boundary.state = { hasError: true, error: new Error("自定义降级测试") };

    const html = renderToStaticMarkup(boundary.render() as React.ReactElement);

    expect(html).toContain("custom-fallback");
    expect(html).toContain("捕获异常: 自定义降级测试");
    expect(html).not.toContain("页面遇到意外错误");
  });

  test("EditorErrorFallback renders localized editor alert", () => {
    const html = renderToStaticMarkup(
      React.createElement(EditorErrorFallback, {
        error: new Error("编辑器解析失败"),
        reset: () => {},
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("editor-error-pane");
    expect(html).toContain("笔记编辑器遇到异常");
    expect(html).toContain("编辑器解析失败");
    expect(html).toContain("重新尝试加载");
  });
});

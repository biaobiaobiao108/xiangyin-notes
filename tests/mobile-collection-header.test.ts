import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileCollectionHeader } from "../app/workspace/mobile-collection-header";

test("shows the search result total in the collection header", () => {
  const html = renderToStaticMarkup(
    React.createElement(MobileCollectionHeader, {
      heading: "搜索结果",
      total: 6,
      shown: 6,
      query: "良子",
      onBack: () => {},
    }),
  );

  expect(html).toContain("包含“良子”的笔记 · 共 6 篇");
  expect(html).not.toContain("已显示");
});

test("shows loaded progress when search results are truncated", () => {
  const html = renderToStaticMarkup(
    React.createElement(MobileCollectionHeader, {
      heading: "搜索结果",
      total: 120,
      shown: 100,
      query: "良子",
      onBack: () => {},
    }),
  );

  expect(html).toContain("包含“良子”的笔记 · 共 120 篇");
  expect(html).toContain("已显示 100 篇");
});

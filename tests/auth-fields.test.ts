import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Field, PasswordField } from "../app/auth";

test("associates the username label with its input", () => {
  const html = renderToStaticMarkup(
    createElement(Field, {
      label: "用户名",
      value: "owner",
      onChange: () => undefined,
      placeholder: "你的用户名",
      autoComplete: "username",
    }),
  );
  expect(html).toContain('<label for="auth-username">用户名</label>');
  expect(html).toContain('id="auth-username"');
});

test("keeps the password toggle outside the input label", () => {
  const html = renderToStaticMarkup(
    createElement(PasswordField, {
      label: "密码",
      value: "secret",
      onChange: () => undefined,
      show: false,
      onToggle: () => undefined,
      autoComplete: "current-password",
    }),
  );
  expect(html).toContain('<label for="current-password">密码</label>');
  expect(html).toContain('placeholder="你的密码"');
  expect(html).not.toContain("至少 12 个字符");
  expect(html.indexOf('<button type="button"')).toBeGreaterThan(html.indexOf("</label>"));
});

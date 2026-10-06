import { afterEach, expect, test } from "bun:test";
import { textFieldMenuItems } from "../app/context-menu";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

function field() {
  return { value: "前文选区后文", selectionStart: 2, selectionEnd: 4, maxLength: 200, readOnly: false, disabled: false, isConnected: true, focus() {}, setSelectionRange() {}, select() {} } as unknown as HTMLTextAreaElement;
}
function clipboard(api: Partial<Clipboard>) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: api } });
}

test("menu paste replaces only the captured text selection and respects title limits", async () => {
  clipboard({ readText: async () => "新\n文字" });
  const input = field();
  input.maxLength = 7;
  let value = input.value;
  await textFieldMenuItems(input, (next) => { value = next; }).find((item) => item.label === "粘贴")!.onSelect();
  expect(value).toBe("前文新 文字后");
});

test("delayed paste never overwrites a changed field or a switched note", async () => {
  let resolveRead!: (text: string) => void;
  clipboard({ readText: () => new Promise<string>((resolve) => { resolveRead = resolve; }) });
  for (const switchNote of [false, true]) {
    const input = field();
    let current = true;
    let changed = false;
    const paste = textFieldMenuItems(input, () => { changed = true; }, () => current).find((item) => item.label === "粘贴")!;
    const pending = paste.onSelect();
    if (switchNote) current = false;
    else input.value = "新的草稿";
    resolveRead("旧剪贴板");
    await pending;
    expect(changed).toBe(false);
  }
});

test("denied clipboard write never deletes the cut selection", async () => {
  clipboard({ writeText: async () => { throw new Error("NotAllowedError"); } });
  let changed = false;
  const cut = textFieldMenuItems(field(), () => { changed = true; }).find((item) => item.label === "剪切")!;
  await expect(cut.onSelect()).rejects.toThrow("浏览器未允许写入剪贴板");
  expect(changed).toBe(false);
});

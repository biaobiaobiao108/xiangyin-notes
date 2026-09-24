import { describe, expect, test } from "bun:test";
import { readThemePreference, resolveTheme, THEME_STORAGE_KEY, writeThemePreference } from "../app/theme";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(THEME_STORAGE_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("theme preference", () => {
  test("defaults to system and reads each supported mode", () => {
    expect(readThemePreference(memoryStorage())).toBe("system");
    expect(readThemePreference(memoryStorage("light"))).toBe("light");
    expect(readThemePreference(memoryStorage("dark"))).toBe("dark");
    expect(readThemePreference(memoryStorage("system"))).toBe("system");
  });

  test("falls back to system for unknown values or storage errors", () => {
    expect(readThemePreference(memoryStorage("sepia"))).toBe("system");
    expect(readThemePreference({ getItem: () => { throw new Error("blocked"); }, setItem: () => {} })).toBe("system");
  });

  test("persists choices and tolerates unavailable storage", () => {
    const storage = memoryStorage();
    writeThemePreference("dark", storage);
    expect(readThemePreference(storage)).toBe("dark");
    expect(() => writeThemePreference("light", { getItem: () => null, setItem: () => { throw new Error("blocked"); } })).not.toThrow();
  });

  test("resolves system mode dynamically and keeps explicit choices fixed", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

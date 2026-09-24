import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const THEME_STORAGE_KEY = "xiangying_theme_preference";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function getThemeStorage(): ThemeStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function readThemePreference(storage: ThemeStorage | undefined = getThemeStorage()): ThemePreference {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY) ?? null;
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function writeThemePreference(preference: ThemePreference, storage: ThemeStorage | undefined = getThemeStorage()): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Keep the in-memory preference usable when browser storage is unavailable.
  }
}

export function resolveTheme(preference: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemIsDark ? "dark" : "light") : preference;
}

export function applyThemeToDocument(document: Document, preference: ThemePreference, systemIsDark: boolean): void {
  const resolvedTheme = resolveTheme(preference, systemIsDark);
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themePreference = preference;

  const colorSchemeMeta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (colorSchemeMeta) colorSchemeMeta.content = preference === "system" ? "light dark" : resolvedTheme;

  const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.content = resolvedTheme === "dark" ? "#1a1b26" : "#f6f4ef";
}

function getSystemThemeIsDark(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readThemePreference());
  const [systemIsDark, setSystemIsDark] = useState(getSystemThemeIsDark);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let media: MediaQueryList;
    try {
      media = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }

    const onChange = (event: MediaQueryListEvent) => setSystemIsDark(event.matches);
    setSystemIsDark(media.matches);
    if (media.addEventListener) {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, []);

  useEffect(() => {
    applyThemeToDocument(document, preference, systemIsDark);
  }, [preference, systemIsDark]);

  const setPreference = useCallback((next: ThemePreference) => {
    writeThemePreference(next);
    setPreferenceState(next);
    if (typeof document !== "undefined") applyThemeToDocument(document, next, getSystemThemeIsDark());
  }, []);

  const value = useMemo(() => ({ preference, setPreference }), [preference, setPreference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemePreference(): ThemeContextValue {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useThemePreference must be used inside ThemeProvider");
  return theme;
}

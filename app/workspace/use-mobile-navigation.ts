import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteView } from "../../shared/types";
import type { NoteSort } from "./helpers";

export type MobilePage = "home" | "list" | "editor";
export type MobileListContext = {
  view: NoteView;
  notebookId?: string;
  query: string;
  sort: NoteSort;
  noteId: string | null;
  searchOrigin: { view: NoteView; notebookId?: string } | null;
};
type NavigationEntry = { session: string; page: MobilePage; depth: number; context: MobileListContext };
const ENTRY_KEY = "xiangyingMobile";
const MOBILE_VIEWPORT = "(max-width: 900px)";

/** Keep React Router's history fields intact; entries contain metadata, never note bodies. */
export class MobileNavigationHistory {
  private entry: NavigationEntry;
  constructor(private history: Pick<History, "state" | "pushState" | "replaceState" | "go">, context: MobileListContext, private session: string) {
    this.entry = { session, page: "home", depth: 0, context };
    this.write(false);
  }
  get page() { return this.entry.page; }
  private write(push: boolean) {
    const state = { ...this.history.state, [ENTRY_KEY]: this.entry };
    if (push) this.history.pushState(state, "");
    else this.history.replaceState(state, "");
  }
  update(context: MobileListContext) {
    this.entry = { ...this.entry, context };
    this.write(false);
  }
  open(page: Exclude<MobilePage, "home">, context: MobileListContext) {
    if (this.entry.page === page) { this.update(context); return; }
    // Direct links and home compose still have a real list entry to return to.
    if (page === "editor" && this.entry.page === "home") this.open("list", context);
    this.entry = { session: this.session, page, depth: this.entry.depth + 1, context };
    this.write(true);
  }
  back() {
    if (this.entry.depth > 0) this.history.go(-1);
  }
  home() {
    if (this.entry.depth > 0) this.history.go(-this.entry.depth);
  }
  restore(state: unknown): NavigationEntry | null {
    const entry = state && typeof state === "object" ? (state as Record<string, unknown>)[ENTRY_KEY] as NavigationEntry | undefined : undefined;
    if (!entry || entry.session !== this.session || !["home", "list", "editor"].includes(entry.page)) return null;
    this.entry = entry;
    return entry;
  }
}

export function useMobileNavigation(context: MobileListContext, onRestore: (context: MobileListContext, page: MobilePage) => void) {
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.matchMedia(MOBILE_VIEWPORT).matches);
  const [mobilePage, setMobilePage] = useState<MobilePage>("home");
  const historyRef = useRef<MobileNavigationHistory | null>(null);
  const contextRef = useRef(context);
  const restoreRef = useRef(onRestore);
  const enabledRef = useRef(isMobileViewport);
  contextRef.current = context;
  restoreRef.current = onRestore;
  enabledRef.current = isMobileViewport;

  const ensureHistory = useCallback(() => {
    if (!historyRef.current) historyRef.current = new MobileNavigationHistory(window.history, contextRef.current, crypto.randomUUID());
    return historyRef.current;
  }, []);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_VIEWPORT);
    const update = () => {
      setIsMobileViewport(media.matches);
      if (media.matches && !historyRef.current) {
        const navigation = ensureHistory();
        if (contextRef.current.noteId) navigation.open("editor", contextRef.current);
        setMobilePage(navigation.page);
      }
    };
    // A normal mobile launch always starts at home, even when notes auto-select.
    if (media.matches) ensureHistory();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [ensureHistory]);
  useEffect(() => {
    if (isMobileViewport) ensureHistory().update(context);
  }, [context.view, context.notebookId, context.query, context.sort, context.noteId, context.searchOrigin, isMobileViewport, ensureHistory]);
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const entry = historyRef.current?.restore(event.state);
      if (!entry) return;
      restoreRef.current(entry.context, entry.page);
      setMobilePage(entry.page);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const openMobileList = useCallback((next?: Partial<MobileListContext>) => {
    if (!enabledRef.current) return;
    ensureHistory().open("list", { ...contextRef.current, ...next });
    setMobilePage("list");
  }, [ensureHistory]);
  const openMobileNote = useCallback((next?: Partial<MobileListContext>) => {
    if (!enabledRef.current) return;
    ensureHistory().open("editor", { ...contextRef.current, ...next });
    setMobilePage("editor");
  }, [ensureHistory]);
  const backMobilePage = useCallback(() => { if (enabledRef.current) ensureHistory().back(); }, [ensureHistory]);
  const openMobileHome = useCallback(() => { if (enabledRef.current) ensureHistory().home(); }, [ensureHistory]);
  return { isMobileViewport, mobilePage, openMobileList, openMobileNote, backMobilePage, openMobileHome };
}

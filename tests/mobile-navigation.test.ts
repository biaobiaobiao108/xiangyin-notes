import { describe, expect, test } from "bun:test";
import { MobileNavigationHistory, type MobileListContext } from "../app/workspace/use-mobile-navigation";

class TestHistory {
  entries: unknown[] = [{ idx: 2, key: "router-key", usr: { retained: true } }];
  index = 0;
  get state() { return this.entries[this.index]; }
  replaceState(state: unknown) { this.entries[this.index] = structuredClone(state); }
  pushState(state: unknown) { this.entries.splice(++this.index); this.entries.push(structuredClone(state)); }
  go(delta: number) { this.index += delta; }
}
const context: MobileListContext = { view: "all", query: "", sort: "updated", noteId: null, searchOrigin: null };

describe("mobile page navigation", () => {
  test("home → notebook list → note; browser back and forward retain the list context", () => {
    const history = new TestHistory();
    const navigation = new MobileNavigationHistory(history, context, "session");
    const list = { ...context, notebookId: "work", sort: "title" as const, query: "#设计", searchOrigin: { view: "all" as const, notebookId: "work" } };
    navigation.open("list", list);
    navigation.open("editor", { ...list, noteId: "note-1" });
    navigation.back();
    const restored = navigation.restore(history.state);
    expect(restored?.page).toBe("list");
    expect(restored?.context).toEqual(list);
    history.go(1);
    expect(navigation.restore(history.state)?.context.noteId).toBe("note-1");
    navigation.home();
    expect(navigation.restore(history.state)?.page).toBe("home");
    expect(history.index).toBe(0);
  });
  test("home compose and direct note links insert a real list return destination", () => {
    const history = new TestHistory();
    const navigation = new MobileNavigationHistory(history, context, "session");
    navigation.open("editor", { ...context, view: "trash", noteId: "deleted-note" });
    expect(history.entries).toHaveLength(3);
    navigation.back();
    expect(navigation.restore(history.state)?.context.view).toBe("trash");
    navigation.back();
    expect(navigation.restore(history.state)?.page).toBe("home");
  });
  test("typing search and sorting replace the list entry without growing history", () => {
    const history = new TestHistory();
    const navigation = new MobileNavigationHistory(history, context, "session");
    navigation.open("list", context);
    for (const query of ["设", "设计", "设计笔记", ""]) navigation.open("list", { ...context, query });
    navigation.update({ ...context, sort: "created" });
    expect(history.entries).toHaveLength(2);
    expect((history.state as { idx: number; key: string; usr: unknown }).idx).toBe(2);
    expect((history.state as { key: string }).key).toBe("router-key");
    expect((history.state as { usr: unknown }).usr).toEqual({ retained: true });
  });
  test("reload starts at home while preserving the history base and Router fields", () => {
    const history = new TestHistory();
    const navigation = new MobileNavigationHistory(history, context, "old-session");
    navigation.open("editor", { ...context, noteId: "note" });
    const reloaded = new MobileNavigationHistory(history, context, "new-session");
    expect(reloaded.page).toBe("home");
    expect(history.state).toMatchObject({ idx: 2, key: "router-key", usr: { retained: true }, xiangyingMobile: { session: "old-session", page: "home", depth: 2 } });
    reloaded.home();
    expect(history.index).toBe(0);
    expect(reloaded.restore(history.state)?.page).toBe("home");
  });
  test("reload then browser back can open another list and return back or home", () => {
    const history = new TestHistory();
    const navigation = new MobileNavigationHistory(history, context, "old-session");
    navigation.open("editor", { ...context, noteId: "note" });
    const reloaded = new MobileNavigationHistory(history, context, "new-session");
    history.go(-1);
    expect(reloaded.restore(history.state)?.page).toBe("list");
    reloaded.open("list", { ...context, notebookId: "another" });
    reloaded.back();
    expect(reloaded.restore(history.state)?.page).toBe("home");
    reloaded.open("list", { ...context, notebookId: "another" });
    reloaded.open("editor", { ...context, noteId: "another-note" });
    reloaded.home();
    expect(history.index).toBe(0);
    expect(reloaded.restore(history.state)?.page).toBe("home");
  });
  test("repeated reloads preserve browser forward and an accurate home destination", () => {
    const history = new TestHistory();
    const navigation = new MobileNavigationHistory(history, context, "first-session");
    navigation.open("editor", { ...context, noteId: "note" });
    new MobileNavigationHistory(history, context, "second-session");
    const reloaded = new MobileNavigationHistory(history, context, "third-session");
    history.go(-1);
    expect(reloaded.restore(history.state)?.page).toBe("list");
    history.go(1);
    expect(reloaded.restore(history.state)?.page).toBe("home");
    reloaded.open("list", context);
    reloaded.home();
    expect(history.index).toBe(0);
    expect(reloaded.restore(history.state)?.page).toBe("home");
  });
  test("foreign and malformed history states are ignored", () => {
    const history = new TestHistory();
    const reloaded = new MobileNavigationHistory(history, context, "session");
    expect(reloaded.restore({ xiangyingMobile: { session: "foreign", page: "editor", depth: 1, context } })).toBeNull();
    expect(reloaded.restore({ xiangyingMobile: { session: "session", page: "editor", depth: -1, context } })).toBeNull();
    expect(reloaded.restore(null)).toBeNull();
    expect(reloaded.restore({ idx: 1 })).toBeNull();
    reloaded.back();
    expect(history.index).toBe(0);
  });
});

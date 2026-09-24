import { describe, expect, test } from "bun:test";
import { handleWorkspaceKeyDown } from "../app/workspace/use-workspace-shortcuts";

describe("workspace shortcuts Escape handling", () => {
  test("exits focus mode even when defaultPrevented is true (e.g. from ProseMirror in note body)", () => {
    let focusExited = false;
    let defaultPreventedCalled = false;

    const fakeEvent = {
      key: "Escape",
      defaultPrevented: true, // ProseMirror called preventDefault in captureKeyDown
      preventDefault() {
        defaultPreventedCalled = true;
      },
      target: {
        closest: () => null,
      },
    } as any;

    handleWorkspaceKeyDown(fakeEvent, {
      focusMode: true,
      hasModalOpen: false,
      outlineOpen: false,
      isCardEditing: false,
      hasSelection: false,
      handlers: {
        toggleSidebar: () => {},
        toggleFocusMode: () => {},
        toggleTypewriterMode: () => {},
        exitFocusMode: () => {
          focusExited = true;
        },
        openCommandMenu: () => {},
      },
    });

    expect(focusExited).toBe(true);
    expect(defaultPreventedCalled).toBe(true);
  });

  test("exits card editing when in card edit mode", () => {
    let cardEditingExited = false;

    const fakeEvent = {
      key: "Escape",
      defaultPrevented: true,
      preventDefault() {},
      target: {
        closest: () => null,
      },
    } as any;

    handleWorkspaceKeyDown(fakeEvent, {
      focusMode: false,
      hasModalOpen: false,
      outlineOpen: false,
      isCardEditing: true,
      hasSelection: false,
      handlers: {
        toggleSidebar: () => {},
        toggleFocusMode: () => {},
        toggleTypewriterMode: () => {},
        exitFocusMode: () => {},
        openCommandMenu: () => {},
        onExitCardEditing: () => {
          cardEditingExited = true;
        },
      },
    });

    expect(cardEditingExited).toBe(true);
  });

  test("closes outline first before exiting card editing", () => {
    let outlineClosed = false;
    let cardEditingExited = false;

    const fakeEvent = {
      key: "Escape",
      defaultPrevented: true,
      preventDefault() {},
      target: {
        closest: () => null,
      },
    } as any;

    handleWorkspaceKeyDown(fakeEvent, {
      focusMode: false,
      hasModalOpen: false,
      outlineOpen: true,
      isCardEditing: true,
      hasSelection: false,
      handlers: {
        toggleSidebar: () => {},
        toggleFocusMode: () => {},
        toggleTypewriterMode: () => {},
        exitFocusMode: () => {},
        openCommandMenu: () => {},
        closeOutline: () => {
          outlineClosed = true;
        },
        onExitCardEditing: () => {
          cardEditingExited = true;
        },
      },
    });

    expect(outlineClosed).toBe(true);
    expect(cardEditingExited).toBe(false);
  });

  test("ignores Escape when user is composing in IME", () => {
    let focusExited = false;

    const fakeEvent = {
      key: "Escape",
      isComposing: true,
      keyCode: 229,
      defaultPrevented: true,
      preventDefault() {},
      target: {
        closest: () => null,
      },
    } as any;

    handleWorkspaceKeyDown(fakeEvent, {
      focusMode: true,
      hasModalOpen: false,
      handlers: {
        toggleSidebar: () => {},
        toggleFocusMode: () => {},
        toggleTypewriterMode: () => {},
        exitFocusMode: () => {
          focusExited = true;
        },
        openCommandMenu: () => {},
      },
    });

    expect(focusExited).toBe(false);
  });

  test("does not intercept Escape when a modal dialog is open", () => {
    let focusExited = false;

    const fakeEvent = {
      key: "Escape",
      defaultPrevented: false,
      preventDefault() {},
      target: {
        closest: () => null,
      },
    } as any;

    handleWorkspaceKeyDown(fakeEvent, {
      focusMode: true,
      hasModalOpen: true,
      handlers: {
        toggleSidebar: () => {},
        toggleFocusMode: () => {},
        toggleTypewriterMode: () => {},
        exitFocusMode: () => {
          focusExited = true;
        },
        openCommandMenu: () => {},
      },
    });

    expect(focusExited).toBe(false);
  });
});

describe("workspace shortcuts on macOS keyboard layouts", () => {
  test("recognizes Option+V by physical key when Safari reports an alternate character", () => {
    let layoutToggled = false;
    let defaultPrevented = false;
    const event = {
      key: "√",
      code: "KeyV",
      altKey: true,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      defaultPrevented: false,
      preventDefault() { defaultPrevented = true; },
    } as any;

    handleWorkspaceKeyDown(event, {
      focusMode: false,
      hasModalOpen: false,
      handlers: {
        toggleSidebar() {},
        toggleFocusMode() {},
        toggleTypewriterMode() {},
        exitFocusMode() {},
        openCommandMenu() {},
        toggleViewLayout() { layoutToggled = true; },
      },
    });

    expect(layoutToggled).toBe(true);
    expect(defaultPrevented).toBe(true);
  });

  test("recognizes Option+Shift+T by physical key when Safari reports an alternate character", () => {
    let typewriterToggled = false;
    let defaultPrevented = false;
    const event = {
      key: "™",
      code: "KeyT",
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      defaultPrevented: false,
      preventDefault() { defaultPrevented = true; },
    } as any;

    handleWorkspaceKeyDown(event, {
      focusMode: false,
      hasModalOpen: false,
      handlers: {
        toggleSidebar() {},
        toggleFocusMode() {},
        toggleTypewriterMode() { typewriterToggled = true; },
        exitFocusMode() {},
        openCommandMenu() {},
      },
    });

    expect(typewriterToggled).toBe(true);
    expect(defaultPrevented).toBe(true);
  });
});

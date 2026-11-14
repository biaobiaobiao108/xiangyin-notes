import { describe, expect, test } from "bun:test";
import { handleKanbanCardKeyDown } from "../app/workspace/kanban-card-keyboard";

function keyboardEvent(key: string, target: EventTarget, currentTarget: HTMLElement) {
  const calls = { prevented: false, stopped: false };
  return {
    event: {
      key,
      target,
      currentTarget,
      preventDefault: () => {
        calls.prevented = true;
      },
      stopPropagation: () => {
        calls.stopped = true;
      },
    },
    calls,
  };
}

describe("Kanban card keyboard activation", () => {
  for (const key of ["Enter", " "]) {
    test(`${key === " " ? "Space" : key} opens a focused card and prevents default`, () => {
      const card = {} as HTMLElement;
      const { event, calls } = keyboardEvent(key, card, card);
      let opened = false;

      handleKanbanCardKeyDown(event, () => {
        opened = true;
      });

      expect(opened).toBe(true);
      expect(calls).toEqual({ prevented: true, stopped: false });
    });

    test(`${key === " " ? "Space" : key} on a child button does not open the card`, () => {
      const card = {} as HTMLElement;
      const button = {} as EventTarget;
      const { event, calls } = keyboardEvent(key, button, card);
      let opened = false;

      handleKanbanCardKeyDown(event, () => {
        opened = true;
      });

      expect(opened).toBe(false);
      expect(calls).toEqual({ prevented: false, stopped: true });
    });
  }

  test("leaves unrelated key events alone", () => {
    const card = {} as HTMLElement;
    const { event, calls } = keyboardEvent("ArrowDown", card, card);
    let opened = false;

    handleKanbanCardKeyDown(event, () => {
      opened = true;
    });

    expect(opened).toBe(false);
    expect(calls).toEqual({ prevented: false, stopped: false });
  });
});

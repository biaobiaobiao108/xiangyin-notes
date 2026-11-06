import { expect, test } from "bun:test";
import { relativeDate } from "../app/format";

test("relative dates include the year for notes from a previous year", () => {
  const previousYear = new Date();
  previousYear.setFullYear(previousYear.getFullYear() - 1);
  expect(relativeDate(Math.floor(previousYear.getTime() / 1000))).toContain(
    String(previousYear.getFullYear()),
  );
});

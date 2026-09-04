import { expect, test } from "vitest";
import {
  formatTimeString,
  journalDateStamp,
  journalTitle,
  parseLocalDate,
  sluggify,
} from "./denote.ts";

// Wednesday 20 August 2025, 12:38 -- the date behind a real entry in the
// library this was built against.
const wed = new Date(2025, 7, 20, 12, 38);

test("the symbolic formats match denote-journal's own patterns", () => {
  expect(journalTitle(wed, "day")).toBe("Wednesday");
  expect(journalTitle(wed, "day-date-month-year")).toBe(
    "Wednesday 20 August 2025",
  );
  // The default.
  expect(journalTitle(wed, "day-date-month-year-24h")).toBe(
    "Wednesday 20 August 2025 12:38",
  );
  expect(journalTitle(wed, "day-date-month-year-12h")).toBe(
    "Wednesday 20 August 2025 12:38 PM",
  );
});

test("the default title sluggifies to the real library's file name", () => {
  // 20250820T123820--wednesday-20-august-2025-1238__journal.org
  const title = journalTitle(wed, "day-date-month-year-24h");
  expect(sluggify("title", title)).toBe("wednesday-20-august-2025-1238");
});

test("a single-digit day is space-padded by %e, and the run collapses", () => {
  // `%e` pads with a space, so the title carries two spaces -- Emacs does the
  // same -- and sluggification collapses them to one hyphen.
  const fourth = new Date(2026, 8, 4, 9, 5);
  expect(journalTitle(fourth, "day-date-month-year")).toBe(
    "Friday  4 September 2026",
  );
  expect(sluggify("title", journalTitle(fourth, "day-date-month-year"))).toBe(
    "friday-4-september-2026",
  );
});

test("a custom format-time-string pattern is honoured", () => {
  // The example from denote-journal-title-format's own docstring.
  expect(formatTimeString("Week %V on %A %e %B %Y at %H:%M", wed)).toContain(
    "on Wednesday 20 August 2025 at 12:38",
  );
  // An unsupported specifier is left visible rather than silently dropped.
  expect(formatTimeString("%V", wed)).toBe("%V");
});

test("12-hour format wraps midnight and noon the way Emacs does", () => {
  expect(
    journalTitle(new Date(2025, 7, 20, 0, 5), "day-date-month-year-12h"),
  ).toBe("Wednesday 20 August 2025 12:05 AM");
  expect(
    journalTitle(new Date(2025, 7, 20, 12, 5), "day-date-month-year-12h"),
  ).toBe("Wednesday 20 August 2025 12:05 PM");
});

test("the date stamp is the identifier prefix entries for a day share", () => {
  expect(journalDateStamp(wed)).toBe("20250820");
  expect(journalDateStamp(new Date(2026, 0, 1))).toBe("20260101");
});

test("a YYYY-MM-DD string is read as a local date, not UTC midnight", () => {
  // `new Date("2026-09-04")` is UTC midnight, which is 3 September in every
  // zone west of Greenwich -- so `Journal: Today` would open yesterday.
  const local = parseLocalDate("2026-09-04");
  expect(local.getFullYear()).toBe(2026);
  expect(local.getMonth()).toBe(8);
  expect(local.getDate()).toBe(4);
  expect(journalDateStamp(local)).toBe("20260904");
  // Which is the whole point: the stamp must survive the round trip.
  expect(journalDateStamp(parseLocalDate("2026-01-01"))).toBe("20260101");
});

import { describe, expect, it } from "vitest";
import { milliseconds, percent, timeAgo } from "./format";

const NOW = new Date("2026-11-11T12:00:00Z");

describe("timeAgo", () => {
  it.each([
    ["2026-11-11T11:59:40Z", "just now"],
    ["2026-11-11T11:57:00Z", "3 minutes ago"],
    ["2026-11-11T10:00:00Z", "2 hours ago"],
    ["2026-11-10T12:00:00Z", "yesterday"],
    ["2026-11-11T12:30:00Z", "in 30 minutes"],
  ])("%s -> %s", (iso, expected) => {
    expect(timeAgo(iso, NOW)).toBe(expected);
  });

  it("says never when there is no date", () => {
    expect(timeAgo(null, NOW)).toBe("never");
  });
});

describe("percent", () => {
  it("shows a dash when there were no attempts", () => {
    expect(percent(null)).toBe("—");
  });

  it.each([
    [1, "100%"],
    [0, "0%"],
    [0.5, "50.0%"],
    [0.9731, "97.3%"],
  ])("%s -> %s", (rate, expected) => {
    expect(percent(rate)).toBe(expected);
  });
});

describe("milliseconds", () => {
  it.each([
    [null, "—"],
    [42, "42 ms"],
    [999, "999 ms"],
    [1500, "1.5 s"],
  ])("%s -> %s", (value, expected) => {
    expect(milliseconds(value)).toBe(expected);
  });
});

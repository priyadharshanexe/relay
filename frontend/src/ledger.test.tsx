/** The "dispatch ledger" redesign: verdict line, tracker, theme and counters. */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { axisTop } from "./components/charts";
import { groupStops, labelled, mergeCollidingLabels, nextNote, stopsOf } from "./components/Tracker";
import { attemptTime } from "./lib/time";
import { CountUp } from "./components/ui";
import { storedTheme, useTheme } from "./lib/theme";
import type { DeliveryDetail, Overview } from "./lib/types";
import { verdict } from "./pages/OverviewPage";
import { emptyOverview } from "./test/helpers";

function overview(changes: Partial<Overview> & { dead?: number; retrying?: number }): Overview {
  const { dead = 0, retrying = 0, ...rest } = changes;
  const base = emptyOverview();
  return {
    ...base,
    attempts: 100,
    successes: 100,
    success_rate: 1,
    deliveries_by_status: { ...base.deliveries_by_status, dead, retrying, succeeded: 100 },
    ...rest,
  };
}

describe("the overview verdict", () => {
  it("says delivery is normal when everything is accepted", () => {
    expect(verdict(overview({}))).toEqual({
      tone: "ok",
      headline: "Delivering normally",
      detail: "100% of attempts accepted in the last 24 hours.",
    });
  });

  it("calls out retries", () => {
    const result = verdict(overview({ retrying: 3, successes: 97, success_rate: 0.97 }));
    expect(result.tone).toBe("warn");
    expect(result.headline).toBe("Delivering, with retries");
    expect(result.detail).toBe("97.0% of attempts accepted in the last 24 hours; 3 retrying.");
  });

  it("says deliveries are failing when there are dead letters", () => {
    const result = verdict(overview({ dead: 1 }));
    expect(result.tone).toBe("bad");
    expect(result.detail).toContain("1 dead letter waiting");
  });

  it("says deliveries are failing when most attempts fail", () => {
    expect(verdict(overview({ successes: 50, success_rate: 0.5 })).tone).toBe("bad");
  });

  it("is idle with no attempts at all", () => {
    expect(verdict(emptyOverview()).tone).toBe("idle");
  });
});

function delivery(changes: Partial<DeliveryDetail>): DeliveryDetail {
  const created = "2026-03-10T12:00:00Z";
  return {
    id: "d1",
    event_id: "e1",
    event_type: "order.paid",
    endpoint_id: "ep1",
    endpoint_url: "https://hooks.example.com/",
    status: "retrying",
    attempts: 2,
    next_attempt_at: "2026-03-10T12:12:00Z",
    last_error: null,
    created_at: created,
    updated_at: created,
    payload: {},
    endpoint_status: "active",
    endpoint_breaker_state: "closed",
    attempt_log: [1, 2].map((number) => ({
      id: `a${number}`,
      attempt_number: number,
      started_at: number === 1 ? created : "2026-03-10T12:02:00Z",
      duration_ms: 20,
      status_code: 500,
      error_kind: "http_status" as const,
      response_snippet: null,
      request_headers: {},
      response_headers: null,
    })),
    ...changes,
  };
}

describe("the delivery tracker", () => {
  it("has a stop for creation, each attempt, and what comes next", () => {
    const stops = stopsOf(delivery({}), new Date("2026-03-10T12:05:00Z").getTime());
    expect(stops.map((stop) => [stop.kind, stop.label, stop.at / 1000])).toEqual([
      ["created", "Created", 0],
      ["failed", "#1", 0],
      ["failed", "#2", 120],
      ["next", "Next", 720],
    ]);
  });

  it("ends at the dead-letter queue when the attempts run out", () => {
    const stops = stopsOf(delivery({ status: "dead" }));
    expect(stops.at(-1)).toMatchObject({ kind: "dead", label: "Dead letter" });
  });

  it("ends at the last attempt once delivered", () => {
    const stops = stopsOf(delivery({ status: "succeeded" }));
    expect(stops.at(-1)?.kind).toBe("failed");
    expect(stops).toHaveLength(3);
  });

  it("labels only the stops with room, and always the last one", () => {
    expect(labelled([0, 1, 2, 40, 100])).toEqual([true, false, false, true, true]);
    // The last stop is too close to the one before: that one gives way.
    expect(labelled([0, 50, 53])).toEqual([true, false, true]);
    // ...unless it is the first.
    expect(labelled([0, 3])).toEqual([true, true]);
  });
});

function ThemeProbe() {
  const [theme, toggle] = useTheme();
  return (
    <button type="button" onClick={toggle}>
      {theme}
    </button>
  );
}

describe("the theme", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("is light by default and switches to dark, remembered for next time", async () => {
    const user = userEvent.setup();
    render(<ThemeProbe />);
    expect(screen.getByRole("button")).toHaveTextContent("light");

    await user.click(screen.getByRole("button"));

    expect(screen.getByRole("button")).toHaveTextContent("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(storedTheme()).toBe("dark");
  });
});

describe("counting figures", () => {
  it("show their final value at once when motion is reduced", () => {
    render(<CountUp value={1234} />);
    expect(screen.getByText("1,234")).toBeInTheDocument();
  });
});

describe("tracker groups and notes (review fixes)", () => {
  it("merges stops closer than the threshold into one, labelled with the range", () => {
    const stops = stopsOf(
      delivery({
        status: "dead",
        attempt_log: [1, 2, 3, 4, 5].map((number) => ({
          id: `a${number}`,
          attempt_number: number,
          started_at: `2026-03-10T12:0${number}:00Z`,
          duration_ms: 10,
          status_code: 500,
          error_kind: "http_status" as const,
          response_snippet: null,
          request_headers: {},
          response_headers: null,
        })),
      }),
    );
    // Created, #1-#4 bunched at the start, #5 far out, then the dead letter.
    const positions = [0, 1, 2, 3, 4, 60, 60];
    const groups = groupStops(stops, positions, 5);
    expect(groups.map((group) => group.label)).toEqual(["#1–#4", "#5", "Dead letter"]);
    expect(groups[0]?.kind).toBe("failed");
    // The end stop never joins a group, even when it sits on the last attempt.
    expect(groups.at(-1)?.stops).toHaveLength(1);
  });

  it("counts the next attempt from now, from the same next_attempt_at as the text", () => {
    const now = new Date("2026-03-10T20:00:00Z").getTime();
    const waiting = delivery({ next_attempt_at: "2026-03-11T01:00:00Z" });
    expect(nextNote(waiting, now)).toBe("next in 5 h");
  });

  it("says on hold when the endpoint is holding deliveries back", () => {
    const now = new Date("2026-03-10T20:00:00Z").getTime();
    const held = delivery({ next_attempt_at: "2026-03-11T01:00:00Z", endpoint_breaker_state: "open" });
    expect(nextNote(held, now)).toBe("on hold · next in 5 h");
    expect(nextNote({ ...held, endpoint_breaker_state: "closed", endpoint_status: "paused" }, now)).toContain("on hold");
  });

  it("has no note once the delivery is finished", () => {
    expect(nextNote(delivery({ status: "succeeded" }))).toBeNull();
  });
});

describe("chart axes and times (review fixes)", () => {
  it("leave headroom above the tallest value", () => {
    expect(axisTop([80])).toBe(100); // 80 x 1.15 = 92 -> 100
    expect(axisTop([7])).toBe(10); // 8.05 -> 10, not 8
    expect(axisTop([])).toBe(4);
  });

  it("date an attempt time that is not from today", () => {
    const now = new Date("2026-03-11T09:00:00");
    expect(attemptTime("2026-03-11T08:30:00", now)).not.toMatch(/,/);
    expect(attemptTime("2026-03-10T21:36:01", now)).toMatch(/10.*21:36:01/);
  });
});

describe("tracker labels never overlap (review fix)", () => {
  function group(label: string, position: number, kind: "failed" | "next" = "failed") {
    const numbers = label.replace(/#/g, "").split("–").map(Number);
    const stops = numbers.map((n) => ({ key: `a${n}`, at: n, kind, label: `#${n}`, title: `Attempt ${n}` }));
    return { stops, position, kind, label, title: label };
  }

  it("merges two groups whose labels would touch, even when their dots are apart", () => {
    // 1000 px wide: the dots are 50 px apart, but "#1–#2" and "#3–#4" each need ~36 px.
    const merged = mergeCollidingLabels([group("#1–#2", 0), group("#3–#4", 5), group("#5", 40)], 1000);
    expect(merged.map((g) => g.label)).toEqual(["#1–#4", "#5"]);
  });

  it("leaves groups alone when their labels have room", () => {
    const kept = mergeCollidingLabels([group("#1–#2", 0), group("#3", 30), group("#4", 60)], 1000);
    expect(kept.map((g) => g.label)).toEqual(["#1–#2", "#3", "#4"]);
  });

  it("keeps merging while a grown label still touches its neighbour", () => {
    const merged = mergeCollidingLabels([group("#1", 0), group("#2", 2), group("#3", 4), group("#4", 50)], 1000);
    expect(merged.map((g) => g.label)).toEqual(["#1–#3", "#4"]);
  });

  it("never merges the next-attempt stop", () => {
    const groups = mergeCollidingLabels([group("#1", 0), { ...group("#9", 1, "next"), label: "Next" }], 1000);
    expect(groups.map((g) => g.label)).toEqual(["#1", "Next"]);
  });
});

/** The delivery map's logic: outcomes, layout and the breaker-cut marker. */
import { describe, expect, it } from "vitest";
import { curveMidpoint, layoutFor, outcomeOf } from "./components/DeliveryMap";

describe("the delivery map", () => {
  it("turns a live attempt into a packet outcome", () => {
    expect(outcomeOf({ error_kind: null, status: "succeeded" })).toBe("ok");
    expect(outcomeOf({ error_kind: "http_status", status: "retrying" })).toBe("retry");
    expect(outcomeOf({ error_kind: "timeout", status: "dead" })).toBe("dead");
  });

  it("lays endpoints out across on a wide screen and along the bottom on a phone", () => {
    const wide = layoutFor(3, false);
    expect(wide.endpoints.every((e) => e.x === wide.endpoints[0]?.x)).toBe(true);
    expect(new Set(wide.endpoints.map((e) => e.y)).size).toBe(3);
    expect(wide.routes).toHaveLength(3);

    const phone = layoutFor(3, true);
    expect(phone.width).toBeLessThan(wide.width);
    expect(new Set(phone.endpoints.map((e) => e.y)).size).toBe(1);
  });

  it("centres a single endpoint on the hub's line", () => {
    const one = layoutFor(1, false);
    expect(one.endpoints[0]?.y).toBe(one.hub.y);
  });

  it("finds the middle of a route curve for the breaker-cut marker", () => {
    expect(curveMidpoint("M 0 0 C 0 0 8 8 8 8")).toEqual({ x: 4, y: 4 });
  });
});

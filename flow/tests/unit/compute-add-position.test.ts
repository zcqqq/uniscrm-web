import { describe, it, expect } from "vitest";
import { computeAddPosition } from "../../frontend/lib/compute-add-position";

describe("computeAddPosition", () => {
  it("returns the desired position unchanged when there are no existing nodes", () => {
    expect(computeAddPosition({ x: 100, y: 100 }, [])).toEqual({ x: 100, y: 100 });
  });

  it("returns the desired position unchanged when an existing node is far away", () => {
    const existing = [{ position: { x: 1000, y: 1000 } }];
    expect(computeAddPosition({ x: 100, y: 100 }, existing)).toEqual({ x: 100, y: 100 });
  });

  it("nudges diagonally until clear when an existing node sits exactly at the desired position", () => {
    // desired=(100,100) coincides with the node, so dy clears the 100px threshold (the binding
    // constraint, since NODE_HEIGHT 100 < NODE_WIDTH 200) after 3 nudges: dy = 0, 40, 80, 120 —
    // the first value >= 100 is at nudge 3, landing on (220, 220).
    const existing = [{ position: { x: 100, y: 100 } }];
    expect(computeAddPosition({ x: 100, y: 100 }, existing)).toEqual({ x: 220, y: 220 });
  });

  it("nudges diagonally until clear when an existing node is within the footprint but off-center", () => {
    // dy starts at 35 (65 -> 100), then |65-140|=75 (still <100), then |65-180|=115 (clears) —
    // 2 nudges, landing on (180, 180).
    const existing = [{ position: { x: 100, y: 65 } }];
    expect(computeAddPosition({ x: 100, y: 100 }, existing)).toEqual({ x: 180, y: 180 });
  });

  it("does not nudge when an existing node is just outside the 200x100 footprint", () => {
    const existing = [{ position: { x: 300, y: 100 } }];
    expect(computeAddPosition({ x: 100, y: 100 }, existing)).toEqual({ x: 100, y: 100 });
  });

  it("keeps nudging past multiple nodes placed diagonally in its path", () => {
    // Each node in turn keeps the position colliding for longer than a single node would:
    // node at (100,100) stops blocking once dy>=100 (nudge 3), but by then the position has
    // reached (220,220), which collides with the node at (140,140) (dy=80) — and that in turn
    // hands off to the node at (180,180) once (220,220)'s dy clears it too. Final clear point
    // is (300,300), reached after 5 nudges.
    const existing = [
      { position: { x: 100, y: 100 } },
      { position: { x: 140, y: 140 } },
      { position: { x: 180, y: 180 } },
    ];
    expect(computeAddPosition({ x: 100, y: 100 }, existing)).toEqual({ x: 300, y: 300 });
  });

  it("stops after 20 nudges even if still colliding, instead of looping forever", () => {
    const existing = Array.from({ length: 30 }, (_, i) => ({
      position: { x: 100 + i * 40, y: 100 + i * 40 },
    }));
    expect(computeAddPosition({ x: 100, y: 100 }, existing)).toEqual({ x: 900, y: 900 });
  });
});

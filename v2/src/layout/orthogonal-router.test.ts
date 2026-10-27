import { describe, expect, it } from "vitest";
import { isOrthogonalRouteClear, routeOrthogonalAvoidingObstacles } from "./orthogonal-router";

describe("obstacle-aware orthogonal router", () => {
  it("routes around an intervening node while preserving the requested clearance", () => {
    const obstacles = [{ x: 40, y: 30, width: 30, height: 40 }];
    const route = routeOrthogonalAvoidingObstacles(
      { x: 10, y: 50 },
      { x: 100, y: 50 },
      obstacles,
      { clearance: 8 }
    );

    expect(route).not.toBeNull();
    expect(route!.length).toBeGreaterThan(2);
    expect(route!.every((point, index) => index === 0 ||
      Math.abs(point.x - route![index - 1].x) <= 0.01 ||
      Math.abs(point.y - route![index - 1].y) <= 0.01)).toBe(true);
    expect(isOrthogonalRouteClear(route!, obstacles, 8)).toBe(true);
  });

  it("uses a direct segment when it is already safe", () => {
    const route = routeOrthogonalAvoidingObstacles(
      { x: 10, y: 10 },
      { x: 100, y: 10 },
      [{ x: 30, y: 40, width: 20, height: 20 }]
    );

    expect(route).toEqual([{ x: 10, y: 10 }, { x: 100, y: 10 }]);
  });

  it("uses one right-angle bend when a clear path has diagonal endpoints", () => {
    const route = routeOrthogonalAvoidingObstacles(
      { x: 10, y: 10 },
      { x: 100, y: 60 },
      []
    );

    expect(route).not.toBeNull();
    expect(route).toHaveLength(3);
    expect(route!.every((point, index) => index === 0 ||
      Math.abs(point.x - route![index - 1].x) <= 0.01 ||
      Math.abs(point.y - route![index - 1].y) <= 0.01)).toBe(true);
  });

  it("returns null when an endpoint is inside an unrelated obstacle", () => {
    expect(routeOrthogonalAvoidingObstacles(
      { x: 45, y: 45 },
      { x: 100, y: 45 },
      [{ x: 30, y: 30, width: 30, height: 30 }]
    )).toBeNull();
  });

  it("rejects diagonal and obstacle-crossing routes during validation", () => {
    const obstacle = [{ x: 40, y: 30, width: 30, height: 40 }];
    expect(isOrthogonalRouteClear([{ x: 0, y: 0 }, { x: 10, y: 10 }], [])).toBe(false);
    expect(isOrthogonalRouteClear([{ x: 0, y: 50 }, { x: 100, y: 50 }], obstacle)).toBe(false);
  });
});

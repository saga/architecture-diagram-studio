export interface OrthogonalRoutePoint {
  x: number;
  y: number;
}

export interface OrthogonalRouteObstacle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OrthogonalRouteOptions {
  /** Minimum clearance between a route segment and an obstacle. */
  clearance?: number;
  /** Added cost for each direction change, measured in the same units as distance. */
  bendPenalty?: number;
  /** Maximum number of points returned after collinear simplification. */
  maxPoints?: number;
  /** Optional rectangle that every route point and segment must remain inside. */
  bounds?: { x: number; y: number; width: number; height: number };
}

interface ExpandedObstacle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface HeapEntry {
  state: number;
  score: number;
}

class MinHeap {
  private readonly items: HeapEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: HeapEntry): void {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].score <= item.score) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop(): HeapEntry | undefined {
    if (this.items.length === 0) return undefined;
    const first = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length === 0) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.items.length) break;
      let child = left;
      if (right < this.items.length && this.items[right].score < this.items[left].score) child = right;
      if (this.items[child].score >= last.score) break;
      this.items[index] = this.items[child];
      index = child;
    }
    this.items[index] = last;
    return first;
  }
}

const EPSILON = 0.01;

function uniqueSorted(values: number[]): number[] {
  values.sort((left, right) => left - right);
  const result: number[] = [];
  for (const value of values) {
    if (result.length === 0 || Math.abs(value - result[result.length - 1]) > EPSILON) result.push(value);
  }
  return result;
}

function isInsideObstacle(point: OrthogonalRoutePoint, obstacles: ExpandedObstacle[]): boolean {
  return obstacles.some((obstacle) =>
    point.x > obstacle.left + EPSILON && point.x < obstacle.right - EPSILON &&
    point.y > obstacle.top + EPSILON && point.y < obstacle.bottom - EPSILON
  );
}

function segmentIsClear(
  start: OrthogonalRoutePoint,
  end: OrthogonalRoutePoint,
  obstacles: ExpandedObstacle[]
): boolean {
  if (Math.abs(start.x - end.x) <= EPSILON) {
    const low = Math.min(start.y, end.y);
    const high = Math.max(start.y, end.y);
    return !obstacles.some((obstacle) =>
      start.x > obstacle.left + EPSILON && start.x < obstacle.right - EPSILON &&
      high > obstacle.top + EPSILON && low < obstacle.bottom - EPSILON
    );
  }
  if (Math.abs(start.y - end.y) <= EPSILON) {
    const low = Math.min(start.x, end.x);
    const high = Math.max(start.x, end.x);
    return !obstacles.some((obstacle) =>
      start.y > obstacle.top + EPSILON && start.y < obstacle.bottom - EPSILON &&
      high > obstacle.left + EPSILON && low < obstacle.right - EPSILON
    );
  }
  return false;
}

function simplifyPath(points: OrthogonalRoutePoint[]): OrthogonalRoutePoint[] {
  const result: OrthogonalRoutePoint[] = [];
  for (const rawPoint of points) {
    const point = { x: rawPoint.x, y: rawPoint.y };
    const previous = result[result.length - 1];
    if (previous && Math.abs(point.x - previous.x) <= EPSILON &&
        Math.abs(point.y - previous.y) <= EPSILON) continue;

    if (result.length >= 2) {
      const before = result[result.length - 2];
      const middle = result[result.length - 1];
      const horizontal = Math.abs(before.y - middle.y) <= EPSILON &&
        Math.abs(middle.y - point.y) <= EPSILON &&
        (middle.x - before.x) * (point.x - middle.x) > 0;
      const vertical = Math.abs(before.x - middle.x) <= EPSILON &&
        Math.abs(middle.x - point.x) <= EPSILON &&
        (middle.y - before.y) * (point.y - middle.y) > 0;
      if (horizontal || vertical) result.pop();
    }
    result.push(point);
  }
  return result;
}

/**
 * Routes between two points on an orthogonal visibility grid. Obstacles are expanded by
 * the requested clearance and represented as impassable rectangles. The search minimizes
 * Manhattan distance plus a bend penalty; null means no safe route could be found.
 */
export function routeOrthogonalAvoidingObstacles(
  start: OrthogonalRoutePoint,
  end: OrthogonalRoutePoint,
  sourceObstacles: OrthogonalRouteObstacle[],
  options: OrthogonalRouteOptions = {}
): OrthogonalRoutePoint[] | null {
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;
  if (Math.abs(start.x - end.x) <= EPSILON && Math.abs(start.y - end.y) <= EPSILON) {
    return [{ x: start.x, y: start.y }];
  }

  const clearance = Math.max(0, options.clearance ?? 10);
  const bendPenalty = Math.max(0, options.bendPenalty ?? 24);
  const maxPoints = Math.max(2, options.maxPoints ?? 100);
  const bounds = options.bounds && [options.bounds.x, options.bounds.y, options.bounds.width, options.bounds.height].every(Number.isFinite) &&
      options.bounds.width > 0 && options.bounds.height > 0
    ? {
        left: options.bounds.x,
        top: options.bounds.y,
        right: options.bounds.x + options.bounds.width,
        bottom: options.bounds.y + options.bounds.height
      }
    : undefined;
  if (options.bounds && !bounds) return null;
  if (bounds && (
    start.x < bounds.left - EPSILON || start.x > bounds.right + EPSILON ||
    start.y < bounds.top - EPSILON || start.y > bounds.bottom + EPSILON ||
    end.x < bounds.left - EPSILON || end.x > bounds.right + EPSILON ||
    end.y < bounds.top - EPSILON || end.y > bounds.bottom + EPSILON
  )) return null;
  const obstacles = sourceObstacles
    .filter((obstacle) =>
      [obstacle.x, obstacle.y, obstacle.width, obstacle.height].every(Number.isFinite) &&
      obstacle.width > 0 && obstacle.height > 0
    )
    .map((obstacle) => ({
      left: obstacle.x - clearance,
      top: obstacle.y - clearance,
      right: obstacle.x + obstacle.width + clearance,
      bottom: obstacle.y + obstacle.height + clearance
    }));

  if (isInsideObstacle(start, obstacles) || isInsideObstacle(end, obstacles)) return null;

  const clippedX = obstacles.flatMap((obstacle) => [obstacle.left, obstacle.right])
    .map((value) => bounds ? Math.max(bounds.left, Math.min(bounds.right, value)) : value);
  const clippedY = obstacles.flatMap((obstacle) => [obstacle.top, obstacle.bottom])
    .map((value) => bounds ? Math.max(bounds.top, Math.min(bounds.bottom, value)) : value);
  const xs = uniqueSorted([
    start.x, end.x,
    ...(bounds ? [bounds.left, bounds.right] : []),
    ...clippedX
  ]).filter((value) => !bounds || (value >= bounds.left - EPSILON && value <= bounds.right + EPSILON));
  const ys = uniqueSorted([
    start.y, end.y,
    ...(bounds ? [bounds.top, bounds.bottom] : []),
    ...clippedY
  ]).filter((value) => !bounds || (value >= bounds.top - EPSILON && value <= bounds.bottom + EPSILON));
  const nearestCoordinateIndex = (values: number[], target: number): number | undefined => {
    let low = 0;
    let high = values.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const value = values[middle];
      if (Math.abs(value - target) <= EPSILON) return middle;
      if (value < target) low = middle + 1;
      else high = middle - 1;
    }
    return undefined;
  };
  // Coincident obstacle edges can be merged with an endpoint at sub-pixel precision.
  // Resolve such coordinates by proximity rather than failing the entire layout.
  const startX = nearestCoordinateIndex(xs, start.x);
  const startY = nearestCoordinateIndex(ys, start.y);
  const endX = nearestCoordinateIndex(xs, end.x);
  const endY = nearestCoordinateIndex(ys, end.y);
  if (startX === undefined || startY === undefined || endX === undefined || endY === undefined) return null;
  const snappedEnd = { x: xs[endX], y: ys[endY] };

  const xCount = xs.length;
  const yCount = ys.length;
  const pointCount = xCount * yCount;
  const stateCount = pointCount * 3;
  const startNode = startY * xCount + startX;
  const endNode = endY * xCount + endX;
  const startState = startNode * 3;
  const bestCost = new Float64Array(stateCount);
  bestCost.fill(Number.POSITIVE_INFINITY);
  const previousState = new Int32Array(stateCount);
  previousState.fill(-1);
  const closed = new Uint8Array(stateCount);
  const queue = new MinHeap();
  const pointAt = (node: number): OrthogonalRoutePoint => ({
    x: xs[node % xCount],
    y: ys[Math.floor(node / xCount)]
  });
  const heuristic = (node: number): number => {
    const point = pointAt(node);
    return Math.abs(point.x - snappedEnd.x) + Math.abs(point.y - snappedEnd.y);
  };
  const enqueue = (fromState: number, nextNode: number, direction: 1 | 2, distance: number): void => {
    const oldDirection = fromState % 3;
    const nextState = nextNode * 3 + direction;
    if (closed[nextState]) return;
    const nextCost = bestCost[fromState] + distance +
      (oldDirection !== 0 && oldDirection !== direction ? bendPenalty : 0);
    if (nextCost >= bestCost[nextState]) return;
    bestCost[nextState] = nextCost;
    previousState[nextState] = fromState;
    queue.push({ state: nextState, score: nextCost + heuristic(nextNode) });
  };

  bestCost[startState] = 0;
  queue.push({ state: startState, score: heuristic(startNode) });
  let finalState = -1;

  while (queue.size > 0) {
    const current = queue.pop()!;
    const state = current.state;
    if (closed[state]) continue;
    closed[state] = 1;
    const node = Math.floor(state / 3);
    if (node === endNode) {
      finalState = state;
      break;
    }

    const ix = node % xCount;
    const iy = Math.floor(node / xCount);
    const here = pointAt(node);
    const candidates: Array<{ x: number; y: number; direction: 1 | 2 }> = [];
    if (ix > 0) candidates.push({ x: ix - 1, y: iy, direction: 1 });
    if (ix + 1 < xCount) candidates.push({ x: ix + 1, y: iy, direction: 1 });
    if (iy > 0) candidates.push({ x: ix, y: iy - 1, direction: 2 });
    if (iy + 1 < yCount) candidates.push({ x: ix, y: iy + 1, direction: 2 });

    for (const candidate of candidates) {
      const nextNode = candidate.y * xCount + candidate.x;
      const nextPoint = pointAt(nextNode);
      if (isInsideObstacle(nextPoint, obstacles) ||
          (bounds && (nextPoint.x < bounds.left - EPSILON || nextPoint.x > bounds.right + EPSILON ||
            nextPoint.y < bounds.top - EPSILON || nextPoint.y > bounds.bottom + EPSILON)) ||
          !segmentIsClear(here, nextPoint, obstacles)) continue;
      const distance = Math.abs(nextPoint.x - here.x) + Math.abs(nextPoint.y - here.y);
      enqueue(state, nextNode, candidate.direction, distance);
    }
  }

  if (finalState < 0) return null;
  const reversed: OrthogonalRoutePoint[] = [];
  let state = finalState;
  while (state >= 0) {
    reversed.push(pointAt(Math.floor(state / 3)));
    state = previousState[state];
  }
  const points = simplifyPath(reversed.reverse());
  return points.length <= maxPoints ? points : null;
}

/** True when all route segments are axis-aligned and avoid the supplied obstacle boxes. */
export function isOrthogonalRouteClear(
  points: OrthogonalRoutePoint[],
  sourceObstacles: OrthogonalRouteObstacle[],
  clearance = 0,
  bounds?: { x: number; y: number; width: number; height: number }
): boolean {
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;
  if (bounds && points.some((point) =>
    point.x < bounds.x - EPSILON || point.x > bounds.x + bounds.width + EPSILON ||
    point.y < bounds.y - EPSILON || point.y > bounds.y + bounds.height + EPSILON
  )) return false;
  const obstacles = sourceObstacles.map((obstacle) => ({
    left: obstacle.x - clearance,
    top: obstacle.y - clearance,
    right: obstacle.x + obstacle.width + clearance,
    bottom: obstacle.y + obstacle.height + clearance
  }));
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (Math.abs(start.x - end.x) > EPSILON && Math.abs(start.y - end.y) > EPSILON) return false;
    if (!segmentIsClear(start, end, obstacles)) return false;
  }
  return true;
}

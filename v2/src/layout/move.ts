import type { DiagramDocument, Point } from "../model/types";
import { routeRelations } from "./routing";

/**
 * Moves one node to the requested spot and locks it, re-routing its relations.
 *
 * Deliberately kept free of the layout engines: the canvas applies a drop with this function, so it has to
 * run in the browser without pulling ELK into the initial bundle.
 */
export function moveNode(document: DiagramDocument, id: string, x: number, y: number): DiagramDocument {
  const moving = document.nodes.find((node) => node.id === id);
  if (!moving) return document;
  const others = document.nodes.filter((node) => node.id !== id);
  let chosenX = Math.max(20, Math.round(x / 4) * 4);
  let chosenY = Math.max(20, Math.round(y / 4) * 4);

  const isFree = (candidateX: number, candidateY: number) => !others.some((other) =>
    candidateX < other.x + other.width + 14 &&
    candidateX + moving.width + 14 > other.x &&
    candidateY < other.y + other.height + 14 &&
    candidateY + moving.height + 14 > other.y
  );

  if (!isFree(chosenX, chosenY)) {
    const originX = chosenX, originY = chosenY;
    const step = 8;
    let found = false;
    for (let radius = 1; radius <= 60 && !found; radius++) {
      const candidates: Point[] = [];
      for (let dx = -radius; dx <= radius; dx++) {
        candidates.push({ x: originX + dx * step, y: originY - radius * step });
        candidates.push({ x: originX + dx * step, y: originY + radius * step });
      }
      for (let dy = -radius + 1; dy < radius; dy++) {
        candidates.push({ x: originX - radius * step, y: originY + dy * step });
        candidates.push({ x: originX + radius * step, y: originY + dy * step });
      }
      for (const candidate of candidates) {
        const candidateX = Math.max(20, candidate.x);
        const candidateY = Math.max(20, candidate.y);
        if (isFree(candidateX, candidateY)) {
          chosenX = candidateX;
          chosenY = candidateY;
          found = true;
          break;
        }
      }
    }
  }

  const nodes = document.nodes.map((node) => node.id === id
    ? { ...node, x: chosenX, y: chosenY, layoutHints: { ...(node.layoutHints || {}), locked: true } }
    : node);
  return routeRelations({ ...document, nodes });
}

export function clearNodeLocks(document: DiagramDocument): DiagramDocument {
  return { ...document, nodes: document.nodes.map((node) => ({ ...node, layoutHints: { ...(node.layoutHints || {}), locked: false } })) };
}

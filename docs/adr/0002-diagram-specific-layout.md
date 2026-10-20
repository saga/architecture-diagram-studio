# ADR 0002: Diagram-type-specific layout

- Status: Accepted
- Date: 2026-10-20

## Context
C4 views emphasize hierarchy, containment, and dependency readability. Sequence diagrams enforce participant and temporal ordering. A generic graph layout cannot satisfy both sets of invariants.

## Decision
Use a layered graph layout such as ELK for C4 and dependency views. Implement sequence layout separately using participant columns, ordered message rows, activation intervals, and structured fragments.

## Consequences
- The editor can share interaction primitives without sharing all layout algorithms.
- Sequence semantics remain stable during layout.
- Layout fixtures must be maintained per diagram type.
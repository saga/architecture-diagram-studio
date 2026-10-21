import type { Dispatch, SetStateAction } from "react";
import type { DiagramDocument, DiagramNode, SequenceFragment, VisualRole } from "../model/types";
import { requestServerSequenceNormalize } from "../api/diagram-operations";

function newId(prefix: string): string { return prefix + "-" + Math.random().toString(36).slice(2, 8); }
interface Options {
  document: DiagramDocument;
  selectedNode: DiagramNode | null;
  selectedRelationId: string | null;
  relationTargetId: string;
  relationLabel: string;
  relationLabelDrafts: Record<string, string>;
  setSelectedNodeId: Dispatch<SetStateAction<string | null>>;
  setSelectedRelationId: Dispatch<SetStateAction<string | null>>;
  setRelationLabel: (value: string) => void;
  setRelationLabelDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setLastAction: (message: string) => void;
  commitDocument: (next: DiagramDocument, action: string, preservedNativeXml?: string) => void;
  runLayout: (source?: DiagramDocument) => Promise<void>;
}
export function useDiagramEditing(options: Options) {
  const {
    document, selectedNode, selectedRelationId, relationTargetId, relationLabel, relationLabelDrafts,
    setSelectedNodeId, setSelectedRelationId, setRelationLabel, setRelationLabelDrafts, setLastAction,
    commitDocument, runLayout
  } = options;
  function addSequenceFragment() {
    if (document.kind !== "sequence") return;
    const maxOrder = Math.max(0, document.relations.length - 1);
    const startOrder = Math.min(1, maxOrder);
    const fragment: SequenceFragment = {
      id: newId("fragment"),
      kind: "alt",
      label: "Condition branch",
      startOrder,
      endOrder: Math.min(maxOrder, startOrder + 2)
    };
    const next: DiagramDocument = {
      ...document,
      sequence: {
        participants: document.sequence?.participants || document.nodes.map((node) => node.id),
        fragments: [...(document.sequence?.fragments || []), fragment]
      }
    };
    commitDocument(next, "Added an alt sequence fragment");
  }

  function updateSequenceFragment(fragmentId: string, patch: Partial<SequenceFragment>) {
    if (document.kind !== "sequence") return;
    const maxOrder = Math.max(0, document.relations.length - 1);
    const fragments = (document.sequence?.fragments || []).map((fragment) => {
      if (fragment.id !== fragmentId) return fragment;
      const updated = { ...fragment, ...patch };
      let startOrder = Math.max(0, Math.min(maxOrder, Math.floor(updated.startOrder)));
      let endOrder = Math.max(0, Math.min(maxOrder, Math.floor(updated.endOrder)));
      if (startOrder > endOrder) {
        if (patch.startOrder !== undefined) endOrder = startOrder;
        else startOrder = endOrder;
      }
      return { ...updated, startOrder, endOrder };
    });
    const next: DiagramDocument = {
      ...document,
      sequence: {
        participants: document.sequence?.participants || document.nodes.map((node) => node.id),
        fragments
      }
    };
    commitDocument(next, "Sequence fragment updated");
  }

  function removeSequenceFragment(fragmentId: string) {
    if (document.kind !== "sequence") return;
    const next: DiagramDocument = {
      ...document,
      sequence: {
        participants: document.sequence?.participants || document.nodes.map((node) => node.id),
        fragments: (document.sequence?.fragments || []).filter((fragment) => fragment.id !== fragmentId)
      }
    };
    commitDocument(next, "Sequence fragment deleted");
  }

  async function changeRelationEndpoints(relationId: string, source: string, target: string) {
    if (!source || !target || source === target) {
      setLastAction("A relation needs two different endpoints");
      return;
    }
    const current = document.relations.find((relation) => relation.id === relationId);
    if (!current || (current.source === source && current.target === target)) return;
    const next = await requestServerSequenceNormalize({
      ...document,
      relations: document.relations.map((relation) => relation.id === relationId
        ? { ...relation, source, target, points: [] }
        : relation)
    });
    commitDocument(next, "Relation endpoints updated");
    if (document.kind !== "sequence") void runLayout(next);
  }

  function changeNode(patch: Partial<DiagramNode>) {
    if (!selectedNode) return;
    const next = {
      ...document,
      nodes: document.nodes.map((node) => {
        if (node.id !== selectedNode.id) return node;
        if (patch.role === undefined) return { ...node, ...patch };
        const nextRole = patch.role;
        let layoutHints = { ...(node.layoutHints || {}) };
        if (
          (node.role === "external" || node.role === "vendor") &&
          layoutHints.preferredSide === "RIGHT" &&
          nextRole !== "external" && nextRole !== "vendor"
        ) {
          delete layoutHints.preferredSide;
        }
        if (
          (node.role === "storage" || node.role === "data") &&
          layoutHints.preferredSide === "BOTTOM" &&
          nextRole !== "storage" && nextRole !== "data"
        ) {
          delete layoutHints.preferredSide;
        }
        if ((nextRole === "external" || nextRole === "vendor") && !layoutHints.preferredSide) {
          layoutHints.preferredSide = "RIGHT";
        }
        if ((nextRole === "storage" || nextRole === "data") && !layoutHints.preferredSide) {
          layoutHints.preferredSide = "BOTTOM";
        }
        const visualRole: VisualRole = nextRole === "external" || nextRole === "vendor"
          ? "external"
          : node.visualRole === "external" ? "secondary" : node.visualRole;
        return { ...node, ...patch, visualRole, layoutHints };
      })
    };
    commitDocument(next, "Node properties updated");
  }

  function addNode(role: DiagramNode["role"]) {
    const id = newId(role);
    const node: DiagramNode = {
      id,
      name: role === "storage" ? "New data store" : role === "external" ? "External system" : role === "decision" ? "Decision" : "New component",
      role, visualRole: role === "external" ? "external" : "secondary",
      x: 80 + (document.nodes.length % 4) * 36, y: 90 + (document.nodes.length % 5) * 30,
      width: role === "decision" ? 156 : role === "actor" ? 154 : 190, height: role === "decision" ? 84 : 82, layoutHints: {}
    };
    const next = { ...document, nodes: [...document.nodes, node] };
    setSelectedNodeId(id);
    commitDocument(next, "Added node: " + node.name);
    void runLayout(next);
  }

  async function addRelation() {
    if (!selectedNode || !relationTargetId || relationTargetId === selectedNode.id) return;
    const alreadyExists = document.relations.some((relation) =>
      relation.source === selectedNode.id && relation.target === relationTargetId && relation.label === relationLabel.trim()
    );
    if (alreadyExists) {
      setLastAction("That relation already exists");
      return;
    }
    const next = await requestServerSequenceNormalize({
      ...document,
      relations: [...document.relations, {
        id: newId("relation"),
        source: selectedNode.id,
        target: relationTargetId,
        label: relationLabel.trim(),
        kind: document.kind === "sequence" ? "call" : "flow",
        sequenceOrder: document.kind === "sequence" ? document.relations.length : undefined,
        points: []
      }]
    });
    setRelationLabel("");
    commitDocument(next, "Linked " + selectedNode.name + " → " + (document.nodes.find((node) => node.id === relationTargetId)?.name || relationTargetId));
    if (document.kind !== "sequence") void runLayout(next);
  }

  function commitRelationLabel(relationId: string) {
    const current = document.relations.find((relation) => relation.id === relationId);
    if (!current) return;
    const label = relationLabelDrafts[relationId] ?? current.label;
    setRelationLabelDrafts((drafts) => {
      const next = { ...drafts };
      delete next[relationId];
      return next;
    });
    if (label === current.label) return;
    const next = {
      ...document,
      relations: document.relations.map((relation) => relation.id === relationId ? { ...relation, label } : relation)
    };
    commitDocument(next, "Relation label updated");
  }

  async function removeRelation(relationId: string) {
    if (selectedRelationId === relationId) setSelectedRelationId(null);
    const next = await requestServerSequenceNormalize({ ...document, relations: document.relations.filter((relation) => relation.id !== relationId) });
    setRelationLabelDrafts((drafts) => {
      const updated = { ...drafts };
      delete updated[relationId];
      return updated;
    });
    commitDocument(next, "Relation removed");
  }

  function reverseRelation(relationId: string) {
    const next = {
      ...document,
      relations: document.relations.map((relation) => relation.id === relationId
        ? { ...relation, source: relation.target, target: relation.source, points: [] }
        : relation)
    };
    commitDocument(next, "Relation direction reversed");
    if (document.kind !== "sequence") void runLayout(next);
  }

  function updateRelationStyle(
    relationId: string,
    patch: { dashed?: boolean; routing?: "orthogonal" | "polyline" | "curved" | undefined }
  ) {
    const routingChanged = Object.prototype.hasOwnProperty.call(patch, "routing");
    const next: DiagramDocument = {
      ...document,
      relations: document.relations.map((relation) => relation.id === relationId
        ? { ...relation, ...patch, points: routingChanged ? [] : relation.points }
        : relation)
    };
    if (routingChanged && document.kind !== "sequence") {
      void runLayout(next);
      return;
    }
    commitDocument(next, routingChanged ? "Relation routing updated" : "Relation line style updated");
  }

  async function removeNodeById(nodeId: string) {
    setSelectedRelationId(null);
    const next = await requestServerSequenceNormalize({
      ...document,
      nodes: document.nodes.filter((node) => node.id !== nodeId),
      relations: document.relations.filter((relation) => relation.source !== nodeId && relation.target !== nodeId),
      boundaries: document.boundaries.map((boundary) => ({ ...boundary, members: boundary.members.filter((id) => id !== nodeId) })),
      flow: document.flow ? { ...document.flow, primaryPath: document.flow.primaryPath.filter((id) => id !== nodeId) } : undefined,
      sequence: document.sequence ? { ...document.sequence, participants: document.sequence.participants.filter((id) => id !== nodeId) } : undefined
    });
    setSelectedNodeId(next.nodes[0]?.id || null);
    commitDocument(next, "Node and its relations removed");
  }

  async function removeSelectedNode() {
    if (!selectedNode) return;
    await removeNodeById(selectedNode.id);
  }


  return {
    addSequenceFragment, updateSequenceFragment, removeSequenceFragment, changeRelationEndpoints,
    changeNode, addNode, addRelation, commitRelationLabel, removeRelation, reverseRelation,
    updateRelationStyle, removeNodeById, removeSelectedNode
  };
}

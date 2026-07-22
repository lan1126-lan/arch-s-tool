export type PointLike = { x: number; y: number };
export type DisplaySource = "manual" | "verified";

export type AuditableDimension = {
  id: string;
  start: PointLike;
  end: PointLike;
  displayMm?: number;
  displaySource?: DisplaySource;
};

export type AuditChange = {
  id: string;
  beforeMm: number;
  afterMm: number;
  reason: string;
};

export type AuditPreview = {
  values: Record<string, number>;
  changes: AuditChange[];
  duplicateGroups: number;
  chainRelations: number;
  protectedManual: number;
  conflictIds: string[];
  conflictMessages: string[];
};

type Axis = "horizontal" | "vertical";
type Endpoint = { lineId: string; side: "start" | "end"; value: number };
type Node = { id: number; raw: number; endpointKeys: string[] };
type Edge = { line: AuditableDimension; a: number; b: number; axis: Axis };

const endpointKey = (lineId: string, side: "start" | "end") => `${lineId}:${side}`;
const roundTo = (value: number, step: number) => Math.round(value / step) * step;

function axisOf(line: AuditableDimension): Axis {
  return Math.abs(line.end.x - line.start.x) >= Math.abs(line.end.y - line.start.y)
    ? "horizontal"
    : "vertical";
}

function coordinate(point: PointLike, axis: Axis, scaleMmPerPixel: number) {
  return (axis === "horizontal" ? point.x : point.y) * scaleMmPerPixel;
}

function clusterEndpoints(endpoints: Endpoint[], toleranceMm: number) {
  const sorted = endpoints.slice().sort((a, b) => a.value - b.value);
  const nodes: Node[] = [];
  const lookup = new Map<string, number>();

  for (const endpoint of sorted) {
    const current = nodes[nodes.length - 1];
    if (!current || Math.abs(endpoint.value - current.raw) > toleranceMm) {
      nodes.push({
        id: nodes.length,
        raw: endpoint.value,
        endpointKeys: [endpointKey(endpoint.lineId, endpoint.side)],
      });
      lookup.set(endpointKey(endpoint.lineId, endpoint.side), nodes.length - 1);
      continue;
    }

    const count = current.endpointKeys.length;
    current.raw = (current.raw * count + endpoint.value) / (count + 1);
    current.endpointKeys.push(endpointKey(endpoint.lineId, endpoint.side));
    lookup.set(endpointKey(endpoint.lineId, endpoint.side), current.id);
  }

  return { nodes, lookup };
}

function componentNodes(nodes: Node[], edges: Edge[]) {
  const adjacency = new Map<number, number[]>();
  for (const node of nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    adjacency.get(edge.a)?.push(edge.b);
    adjacency.get(edge.b)?.push(edge.a);
  }

  const components: number[][] = [];
  const seen = new Set<number>();
  for (const node of nodes) {
    if (seen.has(node.id) || !adjacency.get(node.id)?.length) continue;
    const stack = [node.id];
    const component: number[] = [];
    seen.add(node.id);
    while (stack.length) {
      const id = stack.pop()!;
      component.push(id);
      for (const next of adjacency.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    components.push(component);
  }
  return components;
}

function relationStats(edges: Edge[]) {
  const pairCounts = new Map<string, number>();
  for (const edge of edges) {
    const key = `${Math.min(edge.a, edge.b)}:${Math.max(edge.a, edge.b)}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const duplicateGroups = Array.from(pairCounts.values()).filter(count => count > 1).length;
  const chainIds = new Set<string>();

  for (const target of edges) {
    const low = Math.min(target.a, target.b), high = Math.max(target.a, target.b);
    const adjacency = new Map<number, { node: number; edgeId: string }[]>();
    for (const edge of edges) {
      if (edge.line.id === target.line.id) continue;
      const edgeLow = Math.min(edge.a, edge.b), edgeHigh = Math.max(edge.a, edge.b);
      if (edgeLow < low || edgeHigh > high || (edgeLow === low && edgeHigh === high)) continue;
      adjacency.set(edge.a, [...(adjacency.get(edge.a) ?? []), { node: edge.b, edgeId: edge.line.id }]);
      adjacency.set(edge.b, [...(adjacency.get(edge.b) ?? []), { node: edge.a, edgeId: edge.line.id }]);
    }

    const queue: { node: number; depth: number }[] = [{ node: target.a, depth: 0 }];
    const seen = new Set([target.a]);
    while (queue.length) {
      const current = queue.shift()!;
      if (current.node === target.b && current.depth >= 2) {
        chainIds.add(target.line.id);
        break;
      }
      for (const next of adjacency.get(current.node) ?? []) {
        if (seen.has(next.node)) continue;
        seen.add(next.node);
        queue.push({ node: next.node, depth: current.depth + 1 });
      }
    }
  }

  return { duplicateGroups, chainIds };
}

export function measuredMillimeters(line: AuditableDimension, scaleMmPerPixel: number) {
  return Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y) * scaleMmPerPixel;
}

export function displayedMillimeters(line: AuditableDimension, scaleMmPerPixel: number) {
  return line.displayMm ?? measuredMillimeters(line, scaleMmPerPixel);
}

export function auditDimensions(
  dimensions: AuditableDimension[],
  scaleMmPerPixel: number,
  roundingStepMm: number,
  preserveManual: boolean,
): AuditPreview {
  const step = Math.max(1, roundingStepMm);
  const toleranceMm = Math.min(30, Math.max(12, step * 1.5));
  const values: Record<string, number> = {};
  const conflictIds = new Set<string>();
  let duplicateGroups = 0;
  let chainRelations = 0;

  for (const axis of ["horizontal", "vertical"] as Axis[]) {
    const lines = dimensions.filter(line => axisOf(line) === axis);
    const endpoints: Endpoint[] = lines.flatMap(line => [
      { lineId: line.id, side: "start" as const, value: coordinate(line.start, axis, scaleMmPerPixel) },
      { lineId: line.id, side: "end" as const, value: coordinate(line.end, axis, scaleMmPerPixel) },
    ]);
    const { nodes, lookup } = clusterEndpoints(endpoints, toleranceMm);
    const edges: Edge[] = lines.map(line => ({
      line,
      a: lookup.get(endpointKey(line.id, "start"))!,
      b: lookup.get(endpointKey(line.id, "end"))!,
      axis,
    })).filter(edge => edge.a !== edge.b);

    const stats = relationStats(edges);
    duplicateGroups += stats.duplicateGroups;
    chainRelations += stats.chainIds.size;
    const nodeById = new Map(nodes.map(node => [node.id, node]));

    for (const component of componentNodes(nodes, edges)) {
      const componentSet = new Set(component);
      const componentEdges = edges.filter(edge => componentSet.has(edge.a) && componentSet.has(edge.b));
      const baseRaw = Math.min(...component.map(id => nodeById.get(id)!.raw));
      const corrected = new Map<number, number>();
      const lockAdjacency = new Map<number, { node: number; delta: number; lineId: string }[]>();
      const lockedEdges = componentEdges.filter(edge =>
        preserveManual && edge.line.displaySource === "manual" && edge.line.displayMm !== undefined,
      );

      for (const edge of lockedEdges) {
        const aRaw = nodeById.get(edge.a)!.raw, bRaw = nodeById.get(edge.b)!.raw;
        const delta = (bRaw >= aRaw ? 1 : -1) * edge.line.displayMm!;
        lockAdjacency.set(edge.a, [...(lockAdjacency.get(edge.a) ?? []), { node: edge.b, delta, lineId: edge.line.id }]);
        lockAdjacency.set(edge.b, [...(lockAdjacency.get(edge.b) ?? []), { node: edge.a, delta: -delta, lineId: edge.line.id }]);
      }

      const processedLocks = new Set<number>();
      for (const start of lockAdjacency.keys()) {
        if (processedLocks.has(start)) continue;
        const relative = new Map<number, number>([[start, 0]]);
        const queue = [start];
        const groupNodes: number[] = [];
        const groupLineIds = new Set<string>();
        let conflict = false;
        processedLocks.add(start);

        while (queue.length) {
          const current = queue.shift()!;
          groupNodes.push(current);
          for (const link of lockAdjacency.get(current) ?? []) {
            groupLineIds.add(link.lineId);
            const expected = relative.get(current)! + link.delta;
            if (relative.has(link.node)) {
              if (Math.abs(relative.get(link.node)! - expected) > 0.5) conflict = true;
              continue;
            }
            relative.set(link.node, expected);
            processedLocks.add(link.node);
            queue.push(link.node);
          }
        }

        if (conflict) groupLineIds.forEach(id => conflictIds.add(id));
        const idealShift = groupNodes.reduce((sum, id) =>
          sum + (nodeById.get(id)!.raw - baseRaw - relative.get(id)!), 0) / groupNodes.length;
        const shift = roundTo(idealShift, step);
        groupNodes.forEach(id => corrected.set(id, relative.get(id)! + shift));
      }

      for (const id of component) {
        if (!corrected.has(id)) corrected.set(id, roundTo(nodeById.get(id)!.raw - baseRaw, step));
      }

      const ordered = component.slice().sort((a, b) => nodeById.get(a)!.raw - nodeById.get(b)!.raw);
      for (let index = 1; index < ordered.length; index++) {
        if (corrected.get(ordered[index])! + 0.5 < corrected.get(ordered[index - 1])!) {
          lockedEdges.forEach(edge => conflictIds.add(edge.line.id));
        }
      }

      for (const edge of componentEdges) {
        values[edge.line.id] = Math.abs(corrected.get(edge.b)! - corrected.get(edge.a)!);
      }
    }

    for (const edge of edges) {
      if (values[edge.line.id] === undefined) {
        values[edge.line.id] = roundTo(measuredMillimeters(edge.line, scaleMmPerPixel), step);
      }
    }
  }

  for (const line of dimensions) {
    if (values[line.id] === undefined) {
      values[line.id] = roundTo(measuredMillimeters(line, scaleMmPerPixel), step);
    }
    if (preserveManual && line.displaySource === "manual" && line.displayMm !== undefined) {
      values[line.id] = line.displayMm;
    }
  }

  const allEdgesForReasons = dimensions.map(line => {
    const axis = axisOf(line);
    return { line, axis };
  });
  const pairSignature = (line: AuditableDimension) => {
    const axis = axisOf(line);
    const start = coordinate(line.start, axis, scaleMmPerPixel);
    const end = coordinate(line.end, axis, scaleMmPerPixel);
    return `${axis}:${roundTo(Math.min(start, end), toleranceMm)}:${roundTo(Math.max(start, end), toleranceMm)}`;
  };
  const pairFrequency = new Map<string, number>();
  allEdgesForReasons.forEach(({ line }) => pairFrequency.set(pairSignature(line), (pairFrequency.get(pairSignature(line)) ?? 0) + 1));

  const changes = dimensions.flatMap(line => {
    const beforeMm = displayedMillimeters(line, scaleMmPerPixel);
    const afterMm = values[line.id];
    if (Math.abs(beforeMm - afterMm) < 0.5) return [];
    const duplicated = (pairFrequency.get(pairSignature(line)) ?? 0) > 1;
    const reason = duplicated ? "同端点尺寸一致" : "取整并保持尺寸关系";
    return [{ id: line.id, beforeMm, afterMm, reason }];
  });

  return {
    values,
    changes,
    duplicateGroups,
    chainRelations,
    protectedManual: preserveManual ? dimensions.filter(line => line.displaySource === "manual").length : 0,
    conflictIds: Array.from(conflictIds),
    conflictMessages: conflictIds.size
      ? ["手动尺寸之间存在矛盾，无法同时满足。请修改或恢复标红尺寸后重新核准。"]
      : [],
  };
}

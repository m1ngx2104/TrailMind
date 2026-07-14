// Chinese Postman-style route optimizer: given a set of trail way segments,
// find the shortest walk that covers every included segment at least once
// and returns to its start. No Express/HTTP concerns here — trailController
// orchestrates fetching Overpass data and elevation lookups, and calls into
// this module for the pure graph/routing work.

const EARTH_RADIUS_KM = 6371;

const calcDistanceKm = (lat1, lon1, lat2, lon2) => {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

const CLOSURE_THRESHOLD_KM = 0.05; // 50 meters, per spec

// Nodes = clusters of way endpoints within 50m of each other.
// Edges = the ways themselves, traversable in either direction.
const buildTrailGraph = (ways) => {
  const endpoints = [];
  ways.forEach((way) => {
    const geom = way.geometry;
    endpoints.push({ lat: geom[0].lat, lon: geom[0].lon });
    endpoints.push({ lat: geom[geom.length - 1].lat, lon: geom[geom.length - 1].lon });
  });

  const uf = new UnionFind(endpoints.length);
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      if (calcDistanceKm(endpoints[i].lat, endpoints[i].lon, endpoints[j].lat, endpoints[j].lon) <= CLOSURE_THRESHOLD_KM) {
        uf.union(i, j);
      }
    }
  }

  const graph = new Map();
  ways.forEach((way, wayIndex) => {
    const geom = way.geometry;
    let distanceKm = 0;
    for (let i = 1; i < geom.length; i++) {
      distanceKm += calcDistanceKm(geom[i - 1].lat, geom[i - 1].lon, geom[i].lat, geom[i].lon);
    }
    const startCluster = uf.find(wayIndex * 2);
    const endCluster = uf.find(wayIndex * 2 + 1);

    if (!graph.has(startCluster)) graph.set(startCluster, []);
    if (!graph.has(endCluster)) graph.set(endCluster, []);

    graph.get(startCluster).push({ toCluster: endCluster, wayIndex, distanceKm, coordinates: geom });
    graph.get(endCluster).push({ toCluster: startCluster, wayIndex, distanceKm, coordinates: [...geom].reverse() });
  });

  return graph;
};

// Node-level tags (trailhead/entrance) aren't available here — the Overpass
// query fetches way geometry only, not node tags — so the practical
// fallback (most-connected node = most "central") is used whenever no
// parking-lot start node is given, or the given one isn't usable.
const pickBestStartNode = (graph) => {
  let best = null;
  let bestDegree = -1;
  for (const [cluster, edges] of graph) {
    if (edges.length > bestDegree) {
      bestDegree = edges.length;
      best = cluster;
    }
  }
  return best;
};

// Standard Dijkstra over the cluster graph. Edge cost is haversine distance.
// Used for matching odd-degree nodes (Chinese Postman) and for the
// post-time-budget-trim path back to start.
const dijkstra = (graph, startCluster, targetCluster) => {
  const dist = new Map([[startCluster, 0]]);
  const prev = new Map();
  const visited = new Set();
  const queue = [[0, startCluster]];

  while (queue.length > 0) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, cluster] = queue.shift();
    if (visited.has(cluster)) continue;
    visited.add(cluster);
    if (cluster === targetCluster) break;

    for (const edge of graph.get(cluster) || []) {
      const next = d + edge.distanceKm;
      if (!dist.has(edge.toCluster) || next < dist.get(edge.toCluster)) {
        dist.set(edge.toCluster, next);
        prev.set(edge.toCluster, { edge, fromCluster: cluster });
        queue.push([next, edge.toCluster]);
      }
    }
  }

  if (!dist.has(targetCluster)) return null;

  const edges = [];
  let cur = targetCluster;
  while (cur !== startCluster) {
    const step = prev.get(cur);
    edges.push(step.edge);
    cur = step.fromCluster;
  }
  edges.reverse();

  return {
    wayIndices: edges.map((e) => e.wayIndex),
    totalDistance: edges.reduce((s, e) => s + e.distanceKm, 0),
    edges
  };
};

// ─── Connected components ───────────────────────────────────────────────

// A true Eulerian circuit can only cover one connected component — trails
// in a separate, unconnected cluster can't be woven into the same
// continuous walk. The router picks whichever component the start node
// belongs to (falling back to the largest one otherwise).
const findConnectedComponents = (graph) => {
  const seen = new Set();
  const components = [];
  for (const node of graph.keys()) {
    if (seen.has(node)) continue;
    const component = new Set();
    const stack = [node];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (component.has(cur)) continue;
      component.add(cur);
      seen.add(cur);
      for (const edge of graph.get(cur) || []) {
        if (!component.has(edge.toCluster)) stack.push(edge.toCluster);
      }
    }
    components.push(component);
  }
  return components;
};

// ─── Edge-level filters ──────────────────────────────────────────────────

const DIFFICULTY_ORDER = ['Easy', 'Moderate', 'Hard', 'Expert'];

// OSM's sac_scale tag as a coarse difficulty proxy — real per-segment
// difficulty would need an elevation-gain API call per way, which doesn't
// exist anywhere in this pipeline today (elevation is fetched once for the
// whole finished route, same as the old loop system). sac_scale is rare on
// ordinary urban/suburban park paths, so most ways fall back to Easy here;
// the route's real, displayed difficulty is still computed downstream from
// actual elevation data, same as before.
const SAC_SCALE_DIFFICULTY = {
  hiking: 'Easy',
  mountain_hiking: 'Moderate',
  demanding_mountain_hiking: 'Hard',
  alpine_hiking: 'Hard',
  demanding_alpine_hiking: 'Expert',
  difficult_alpine_hiking: 'Expert',
};

const wayDifficultyProxy = (way) => SAC_SCALE_DIFFICULTY[way.tags?.sac_scale] || 'Easy';

// Which ways survive the user's filters, before any routing happens.
// difficulty is a single ceiling ("nothing harder than this"); activity
// currently only narrows for Trail Running (mirrors the existing
// difficulty/length cutoff trailController already uses to decide whether a
// loop counts as runnable elsewhere in the app).
const filterWaysForRoute = (ways, filters) => {
  return ways.filter((way) => {
    if (filters.difficulty) {
      const maxLevel = DIFFICULTY_ORDER.indexOf(filters.difficulty);
      if (maxLevel >= 0 && DIFFICULTY_ORDER.indexOf(wayDifficultyProxy(way)) > maxLevel) return false;
    }
    if (filters.activity === 'Trail Running') {
      if (DIFFICULTY_ORDER.indexOf(wayDifficultyProxy(way)) > DIFFICULTY_ORDER.indexOf('Moderate')) return false;
    }
    return true;
  });
};

// ─── Odd-degree node matching (Chinese Postman) ─────────────────────────

const findOddDegreeNodes = (graph, component) => {
  return [...component].filter((node) => (graph.get(node) || []).length % 2 !== 0);
};

const pairDistance = (graph, a, b) => {
  const path = dijkstra(graph, a, b);
  return path ? path.totalDistance : Infinity;
};

// Minimum weight perfect matching via memoized search over the *set* of
// remaining odd nodes — exponential in the number of odd nodes, but the
// memoization (keyed on the remaining set, which has a canonical ordering
// since removals preserve relative order) turns this into roughly O(2^n * n)
// rather than the (2n-1)!! pairings naive brute-force enumeration would
// produce. That distinction matters: raw enumeration hits ~650 million
// pairings at 20 nodes and would never finish; this stays fast well past
// that. EXACT_MATCHING_MAX_NODES is still capped for safety margin.
const EXACT_MATCHING_MAX_NODES = 16;

const exactMinimumMatching = (graph, oddNodes) => {
  const memo = new Map();
  const solve = (remaining) => {
    if (remaining.length === 0) return { cost: 0, pairs: [] };
    const key = remaining.join(',');
    if (memo.has(key)) return memo.get(key);

    const [first, ...rest] = remaining;
    let best = null;
    for (let i = 0; i < rest.length; i++) {
      const partner = rest[i];
      const others = [...rest.slice(0, i), ...rest.slice(i + 1)];
      const sub = solve(others);
      const cost = pairDistance(graph, first, partner) + sub.cost;
      if (!best || cost < best.cost) {
        best = { cost, pairs: [[first, partner], ...sub.pairs] };
      }
    }
    memo.set(key, best);
    return best;
  };
  return solve(oddNodes).pairs;
};

// Greedy nearest-neighbor fallback for busier trail networks — not
// guaranteed minimum weight, but keeps route generation fast.
const greedyMatching = (graph, oddNodes) => {
  const remaining = [...oddNodes];
  const pairs = [];
  while (remaining.length > 0) {
    const a = remaining.shift();
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = pairDistance(graph, a, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const [b] = remaining.splice(bestIdx, 1);
    pairs.push([a, b]);
  }
  return pairs;
};

const minimumWeightMatching = (graph, oddNodes) => {
  if (oddNodes.length === 0) return [];
  return oddNodes.length <= EXACT_MATCHING_MAX_NODES
    ? exactMinimumMatching(graph, oddNodes)
    : greedyMatching(graph, oddNodes);
};

// ─── Eulerian circuit (Hierholzer's algorithm) ──────────────────────────

// One "edge instance" per required traversal: each way once, plus one
// extra instance per way duplicated by the matching step (deadhead
// coverage — a way can end up duplicated more than once if multiple
// matched pairs' shortest paths both cross it). Each instance is
// registered at BOTH endpoints so the walk can depart from either one, but
// shares a single `used` flag between its two directions so consuming it
// from one side removes it from the other side too.
const buildEulerianEdgeInstances = (graph, duplicateWayIndices) => {
  const perNode = new Map();
  for (const node of graph.keys()) perNode.set(node, []);

  const addInstance = (fromNode, toNode, wayIndex, distanceKm, coordinates) => {
    const used = { value: false };
    perNode.get(fromNode).push({ toCluster: toNode, wayIndex, distanceKm, coordinates, used });
    perNode.get(toNode).push({ toCluster: fromNode, wayIndex, distanceKm, coordinates: [...coordinates].reverse(), used });
  };

  const seenWay = new Set();
  for (const [node, edges] of graph) {
    for (const edge of edges) {
      if (seenWay.has(edge.wayIndex)) continue;
      seenWay.add(edge.wayIndex);
      addInstance(node, edge.toCluster, edge.wayIndex, edge.distanceKm, edge.coordinates);
    }
  }

  duplicateWayIndices.forEach((wayIndex) => {
    for (const [node, edges] of graph) {
      const found = edges.find((e) => e.wayIndex === wayIndex);
      if (found) {
        addInstance(node, found.toCluster, found.wayIndex, found.distanceKm, found.coordinates);
        break;
      }
    }
  });

  return perNode;
};

// Standard node-stack Hierholzer's walk, tracking the edge instance used to
// arrive at each stack frame alongside it so the finished circuit is a
// sequence of edges (not just nodes). Always starts and ends at startNode —
// that's inherent to how an Eulerian circuit works, so there's no separate
// "rotate to start" step needed.
const findEulerianCircuit = (perNode, startNode) => {
  const nodeStack = [startNode];
  const edgeStack = [];
  const circuitEdges = [];

  while (nodeStack.length > 0) {
    const current = nodeStack[nodeStack.length - 1];
    const candidates = perNode.get(current) || [];

    let next = null;
    while (candidates.length > 0) {
      const candidate = candidates[candidates.length - 1];
      if (candidate.used.value) {
        candidates.pop(); // already consumed from the other endpoint — discard
        continue;
      }
      next = candidate;
      break;
    }

    if (next) {
      next.used.value = true;
      candidates.pop();
      nodeStack.push(next.toCluster);
      edgeStack.push(next);
    } else {
      nodeStack.pop();
      if (edgeStack.length > 0) circuitEdges.push(edgeStack.pop());
    }
  }

  circuitEdges.reverse();
  return circuitEdges;
};

// ─── Time budget trimming ────────────────────────────────────────────────

const PACE_MPH = 2;
const KM_PER_MI = 1.60934;

// Simplified relative to a full priority-based trim + re-match: walks the
// finished circuit until the time budget is spent, then paths directly back
// to start from wherever it stopped. A true "remove lowest-priority segments
// first, then re-run odd-degree matching" pass would need to re-solve
// matching after every removal — meaningfully more complex and more likely
// to introduce subtle bugs (disconnected remainders, infinite loops) for a
// trim step that's already a secondary concern next to full coverage.
const applyTimeBudget = (circuitEdges, graph, startNode, maxTimeMinutes) => {
  if (maxTimeMinutes == null) return circuitEdges;

  const budgetKm = (maxTimeMinutes / 60) * PACE_MPH * KM_PER_MI;
  let cumulative = 0;
  let cutIndex = circuitEdges.length;
  for (let i = 0; i < circuitEdges.length; i++) {
    cumulative += circuitEdges[i].distanceKm;
    if (cumulative > budgetKm) {
      cutIndex = i;
      break;
    }
  }
  if (cutIndex === circuitEdges.length) return circuitEdges; // already within budget

  const trimmed = circuitEdges.slice(0, cutIndex);
  const cutoffNode = cutIndex > 0 ? circuitEdges[cutIndex - 1].toCluster : startNode;

  const pathBack = dijkstra(graph, cutoffNode, startNode);
  if (pathBack) trimmed.push(...pathBack.edges);

  return trimmed;
};

// ─── Route assembly ──────────────────────────────────────────────────────

// Concatenates edge geometries in circuit order into one continuous
// polyline, and separately buckets any *repeated* traversal of a way
// (deadhead) into its own runs. deadheadGeometry is an array of separate
// point-arrays rather than one flat list — deadhead runs aren't always
// contiguous within the circuit, and flattening them into a single polyline
// would draw a spurious straight line connecting unrelated repeated
// stretches on the map.
const assembleRoute = (circuitEdges, ways) => {
  const geometryPoints = [];
  const deadheadSegments = [];
  let currentDeadheadRun = null;

  const seenWayIndex = new Set();
  const namedTrails = new Set();
  let totalDistanceKm = 0;
  let deadheadDistanceKm = 0;

  circuitEdges.forEach((edge, i) => {
    const points = i === 0 ? edge.coordinates : edge.coordinates.slice(1);
    geometryPoints.push(...points);
    totalDistanceKm += edge.distanceKm;

    const way = ways[edge.wayIndex];
    if (way?.name) namedTrails.add(way.name);

    const isRepeat = seenWayIndex.has(edge.wayIndex);
    seenWayIndex.add(edge.wayIndex);

    if (isRepeat) {
      deadheadDistanceKm += edge.distanceKm;
      if (!currentDeadheadRun) {
        currentDeadheadRun = [];
        deadheadSegments.push(currentDeadheadRun);
      }
      currentDeadheadRun.push(...edge.coordinates);
    } else {
      currentDeadheadRun = null; // breaks the run
    }
  });

  const first = geometryPoints[0];
  const last = geometryPoints[geometryPoints.length - 1];
  const closureGapMeters = (first && last) ? calcDistanceKm(first.lat, first.lon, last.lat, last.lon) * 1000 : 0;

  const totalDistanceMi = totalDistanceKm * 0.621371;
  const deadheadDistanceMi = deadheadDistanceKm * 0.621371;

  return {
    geometry: geometryPoints.map((p) => [p.lat, p.lon]),
    totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
    totalDistanceMi: Math.round(totalDistanceMi * 100) / 100,
    estimatedTimeMinutes: Math.round((totalDistanceMi / PACE_MPH) * 60),
    segmentCount: seenWayIndex.size,
    deadheadDistanceKm: Math.round(deadheadDistanceKm * 100) / 100,
    deadheadDistanceMi: Math.round(deadheadDistanceMi * 100) / 100,
    deadheadGeometry: deadheadSegments.map((seg) => seg.map((p) => [p.lat, p.lon])),
    namedTrails: [...namedTrails],
    isClosedLoop: closureGapMeters <= 50,
  };
};

// ─── Main entry point ────────────────────────────────────────────────────

// ways -> a single route (geometry + coverage stats) that walks every
// included way at least once and returns to its start. Elevation gain and
// difficulty aren't computed here — same as the old system, that needs a
// network call trailController makes once against the finished route.
//
// `startNodeId`, when given (from a selected parking lot), anchors the
// route's start/end. If it isn't part of the trail network at all in this
// filtered graph, or sits in a small disconnected sliver of it, the router
// falls back to the best-connected node in the main component instead of
// fabricating a non-trail "connector" path — there's no pedestrian
// connectivity data in this pipeline beyond the trail ways themselves, so a
// literal connector segment would just be an invented straight line.
const findOptimalParkRoute = (ways, filters = {}, startNodeId = null) => {
  const filteredWays = filterWaysForRoute(ways, filters);
  if (filteredWays.length === 0) return null;

  const graph = buildTrailGraph(filteredWays);
  if (graph.size === 0) return null;

  const components = findConnectedComponents(graph);
  let component = components.reduce((a, b) => (b.size > a.size ? b : a), components[0]);

  if (startNodeId != null && graph.has(startNodeId)) {
    const owning = components.find((c) => c.has(startNodeId));
    if (owning && owning.size > 1) component = owning;
  }

  const componentGraph = new Map([...graph].filter(([node]) => component.has(node)));

  const actualStartNode = (startNodeId != null && component.has(startNodeId))
    ? startNodeId
    : pickBestStartNode(componentGraph);
  if (actualStartNode == null) return null;

  const oddNodes = findOddDegreeNodes(componentGraph, component);
  const matchedPairs = minimumWeightMatching(componentGraph, oddNodes);

  const duplicateWayIndices = [];
  for (const [a, b] of matchedPairs) {
    const path = dijkstra(componentGraph, a, b);
    if (path) duplicateWayIndices.push(...path.wayIndices);
  }

  const edgeInstances = buildEulerianEdgeInstances(componentGraph, duplicateWayIndices);
  let circuitEdges = findEulerianCircuit(edgeInstances, actualStartNode);
  if (circuitEdges.length === 0) return null;

  circuitEdges = applyTimeBudget(circuitEdges, componentGraph, actualStartNode, filters.maxTimeMinutes);

  return assembleRoute(circuitEdges, filteredWays);
};

module.exports = { findOptimalParkRoute, calcDistanceKm, buildTrailGraph };

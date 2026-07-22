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

// ─── Trail length + routing strategy selection ──────────────────────────

const wayLengthKm = (way) => {
  const geom = way.geometry;
  let total = 0;
  for (let i = 1; i < geom.length; i++) {
    total += calcDistanceKm(geom[i - 1].lat, geom[i - 1].lon, geom[i].lat, geom[i].lon);
  }
  return total;
};

const sumWaysDistanceKm = (ways) => ways.reduce((sum, w) => sum + wayLengthKm(w), 0);

// Full coverage (stitch every disconnected component into one walk) is fine
// for small trail networks, but for a large, heavily fragmented park it
// produces routes nobody would actually walk (East Fork State Park: 23
// components, 68 miles). Past a size/length threshold, cap the route to a
// budget-sized subnetwork instead of covering everything.
const selectRoutingStrategy = (sizeClass, totalTrailKm) => {
  if (sizeClass == null) return 'full_coverage'; // backward-compat default for callers that don't pass a size tier
  if (sizeClass === 'tiny' || sizeClass === 'small') return 'full_coverage';
  if (sizeClass === 'medium') return totalTrailKm <= 16 ? 'full_coverage' : 'budget_subnetwork';
  return 'budget_subnetwork'; // large
};

// ─── Multi-component routing ─────────────────────────────────────────────

// A cluster's own location is just the departure point of any edge leaving
// it — buildTrailGraph always registers that point as coordinates[0] of the
// edges it stores at that cluster.
const nodeLocation = (graph, node) => {
  const point = (graph.get(node) || [])[0]?.coordinates?.[0];
  return point ? { lat: point.lat, lon: point.lon } : null;
};

// Nearest node (by straight-line distance) in `component` to a given point —
// used to pick where a road-crossing connector should re-enter the next
// disconnected trail cluster.
const findClosestNodeInComponent = (graph, component, fromLat, fromLon) => {
  let best = null;
  for (const node of component) {
    const loc = nodeLocation(graph, node);
    if (!loc) continue;
    const distanceKm = calcDistanceKm(fromLat, fromLon, loc.lat, loc.lon);
    if (!best || distanceKm < best.distanceKm) best = { node, lat: loc.lat, lon: loc.lon, distanceKm };
  }
  return best;
};

// Full single-component Chinese Postman pipeline (matching -> Eulerian
// circuit -> time-budget trim), parameterized by which component and which
// node to start from. This is exactly what findOptimalParkRoute used to do
// inline for the one component it picked — factored out so it can be run
// once per disconnected component.
const runComponentCircuit = (graph, component, requestedStartNode, filters) => {
  const componentGraph = new Map([...graph].filter(([node]) => component.has(node)));

  const actualStartNode = (requestedStartNode != null && component.has(requestedStartNode))
    ? requestedStartNode
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

  return { actualStartNode, circuitEdges };
};

// ways -> a single route (geometry + coverage stats) that walks every
// included way at least once and returns to its start. Elevation gain and
// difficulty aren't computed here — same as the old system, that needs a
// network call trailController makes once against the finished route.
//
// `startNodeId`, when given (from a selected parking lot), anchors the
// route's start/end. A trail network can be split into multiple disconnected
// components (e.g. a park bisected by a road with no mapped footpath
// crossing it) — a true Eulerian circuit still can't span components, but
// rather than silently dropping every component except the anchor's, each
// remaining component gets its own circuit, stitched together with
// straight-line "road crossing" connector segments ordered by nearest-next
// proximity. Distances/time/segment counts are combined across all of them;
// the anchor component's own geometry stays in `geometry` for backward
// compatibility (the overwhelmingly common case is a single component, where
// additionalLoops/connectorSegments both come back empty).
const findFullCoverageRoute = (graph, components, startNodeId, filters, filteredWays) => {
  let anchorComponent = components.reduce((a, b) => (b.size > a.size ? b : a), components[0]);
  if (startNodeId != null && graph.has(startNodeId)) {
    const owning = components.find((c) => c.has(startNodeId));
    if (owning && owning.size > 1) anchorComponent = owning;
  }

  const anchorRun = runComponentCircuit(graph, anchorComponent, startNodeId, filters);
  if (!anchorRun) return null;

  const anchorRoute = assembleRoute(anchorRun.circuitEdges, filteredWays);
  const anchorLocation = nodeLocation(graph, anchorRun.actualStartNode);

  const additionalLoops = [];
  const connectorSegments = [];
  let combinedDistanceKm = anchorRoute.totalDistanceKm;
  let combinedDeadheadKm = anchorRoute.deadheadDistanceKm;
  let combinedSegmentCount = anchorRoute.segmentCount;
  let combinedCoveredTrailKm = anchorRoute.totalDistanceKm - anchorRoute.deadheadDistanceKm;
  const combinedNamedTrails = new Set(anchorRoute.namedTrails);

  let currentLocation = anchorLocation;
  const unvisited = components.filter((c) => c !== anchorComponent);

  while (unvisited.length > 0) {
    let bestIdx = -1;
    let bestEntry = null;
    unvisited.forEach((component, idx) => {
      const candidate = findClosestNodeInComponent(graph, component, currentLocation.lat, currentLocation.lon);
      if (candidate && (!bestEntry || candidate.distanceKm < bestEntry.distanceKm)) {
        bestEntry = candidate;
        bestIdx = idx;
      }
    });
    if (bestIdx === -1) break; // no remaining component has a locatable node

    const component = unvisited.splice(bestIdx, 1)[0];
    const run = runComponentCircuit(graph, component, bestEntry.node, filters);
    if (!run) continue; // this component can't form any circuit — skip it

    connectorSegments.push({
      from: { lat: currentLocation.lat, lon: currentLocation.lon },
      to: { lat: bestEntry.lat, lon: bestEntry.lon },
      distanceMi: Math.round(bestEntry.distanceKm * 0.621371 * 100) / 100,
      type: 'road_connector'
    });
    combinedDistanceKm += bestEntry.distanceKm;

    const loopRoute = assembleRoute(run.circuitEdges, filteredWays);
    additionalLoops.push(loopRoute.geometry);
    combinedDistanceKm += loopRoute.totalDistanceKm;
    combinedDeadheadKm += loopRoute.deadheadDistanceKm;
    combinedSegmentCount += loopRoute.segmentCount;
    combinedCoveredTrailKm += loopRoute.totalDistanceKm - loopRoute.deadheadDistanceKm;
    loopRoute.namedTrails.forEach((n) => combinedNamedTrails.add(n));

    currentLocation = nodeLocation(graph, run.actualStartNode);
  }

  // One last connector back to the true start if the walk ended up in a
  // different component's entry point.
  if (currentLocation !== anchorLocation) {
    const backKm = calcDistanceKm(currentLocation.lat, currentLocation.lon, anchorLocation.lat, anchorLocation.lon);
    connectorSegments.push({
      from: { lat: currentLocation.lat, lon: currentLocation.lon },
      to: { lat: anchorLocation.lat, lon: anchorLocation.lon },
      distanceMi: Math.round(backKm * 0.621371 * 100) / 100,
      type: 'road_connector'
    });
    combinedDistanceKm += backKm;
  }

  const combinedDistanceMi = combinedDistanceKm * 0.621371;

  return {
    ...anchorRoute,
    totalDistanceKm: Math.round(combinedDistanceKm * 100) / 100,
    totalDistanceMi: Math.round(combinedDistanceMi * 100) / 100,
    estimatedTimeMinutes: Math.round((combinedDistanceMi / PACE_MPH) * 60),
    segmentCount: combinedSegmentCount,
    deadheadDistanceKm: Math.round(combinedDeadheadKm * 100) / 100,
    deadheadDistanceMi: Math.round(combinedDeadheadKm * 0.621371 * 100) / 100,
    namedTrails: [...combinedNamedTrails],
    additionalLoops,
    connectorSegments,
    coveredTrailKm: Math.round(combinedCoveredTrailKm * 100) / 100,
  };
};

// ─── Budget-constrained subnetwork (large/fragmented parks) ─────────────

// Scores a way for priority inclusion when the full trail network is too
// large to cover completely within the time budget. Higher score = included
// first. The waterway/viewpoint tag bonuses are inert on real data today —
// extractWays (trailController.js) only captures surface/bicycle/sac_scale,
// not waterway/natural tags — left in so they activate for free if that
// ever changes; name-substring bonuses (lake/beach/scenic) work now since
// `name` is already populated.
const scoreWay = (way, distFromStartKm) => {
  let score = 0;
  if (way.name) score += 100;
  score += Math.max(0, 50 - distFromStartKm * 10);
  if (way.tags?.waterway) score += 30;
  if (way.tags?.natural === 'viewpoint') score += 25;
  const lowerName = way.name?.toLowerCase() || '';
  if (lowerName.includes('lake')) score += 20;
  if (lowerName.includes('beach')) score += 20;
  if (lowerName.includes('scenic')) score += 15;
  if (way.name && wayLengthKm(way) > 0.5) score += 10;
  return score;
};

// Full Dijkstra from one source to every reachable node, retaining enough
// state (`prev`) to reconstruct the path to any of them afterward — the
// existing `dijkstra` helper stops as soon as it reaches one specific target.
const dijkstraFromSource = (graph, startCluster) => {
  const dist = new Map([[startCluster, 0]]);
  const prev = new Map();
  const visited = new Set();
  const queue = [[0, startCluster]];

  while (queue.length > 0) {
    queue.sort((a, b) => a[0] - b[0]);
    const [d, cluster] = queue.shift();
    if (visited.has(cluster)) continue;
    visited.add(cluster);

    for (const edge of graph.get(cluster) || []) {
      const next = d + edge.distanceKm;
      if (!dist.has(edge.toCluster) || next < dist.get(edge.toCluster)) {
        dist.set(edge.toCluster, next);
        prev.set(edge.toCluster, { edge, fromCluster: cluster });
        queue.push([next, edge.toCluster]);
      }
    }
  }

  const pathTo = (targetCluster) => {
    if (!dist.has(targetCluster)) return null;
    const edges = [];
    let cur = targetCluster;
    while (cur !== startCluster) {
      const step = prev.get(cur);
      if (!step) break;
      edges.push(step.edge);
      cur = step.fromCluster;
    }
    edges.reverse();
    return edges;
  };

  return { dist, pathTo };
};

// Selects a budget-sized subset of ways (highest-scored first, always
// pulling in the connecting path back to start so the subnetwork stays one
// connected piece), then runs the same Chinese Postman pipeline on just that
// subset. Any other, separately-disconnected trail clusters are only added
// afterward as optional out-and-back detours if budget remains — this is
// what actually bounds route length for large, fragmented parks, instead of
// findFullCoverageRoute's "stitch every component in" approach that produced
// a 68-mile route for East Fork State Park.
const findBudgetSubnetwork = (graph, ways, startNodeId, timeBudgetMinutes, filters) => {
  const actualStartNode = (startNodeId != null && graph.has(startNodeId))
    ? startNodeId
    : pickBestStartNode(graph);
  if (actualStartNode == null) return null;

  const { dist: distanceFromStart, pathTo } = dijkstraFromSource(graph, actualStartNode);

  // One scored candidate per way (via its closer-to-start directed
  // instance) — a way's two directions are the same physical trail segment
  // and should only be selected once. Nodes with no recorded distance are in
  // a different component than start and are handled later, separately.
  const wayCandidates = new Map();
  for (const [node, edges] of graph) {
    const d = distanceFromStart.get(node);
    if (d == null) continue;
    for (const edge of edges) {
      const existing = wayCandidates.get(edge.wayIndex);
      if (!existing || d < existing.distFromStart) {
        wayCandidates.set(edge.wayIndex, { edge, fromNode: node, distFromStart: d });
      }
    }
  }

  const scored = [...wayCandidates.entries()]
    .map(([wayIndex, c]) => ({ wayIndex, ...c, score: scoreWay(ways[wayIndex], c.distFromStart) }))
    .sort((a, b) => b.score - a.score);

  const distanceBudgetKm = (timeBudgetMinutes / 60) * PACE_MPH * KM_PER_MI;

  const selectedWayIndices = new Set();
  let budgetUsed = 0;

  for (const { wayIndex, edge, fromNode } of scored) {
    if (selectedWayIndices.has(wayIndex)) continue;

    // A way's connecting path back to start can itself cost more than the
    // way does (a distant, high-scoring named trail can sit at the end of a
    // long unselected corridor) — check the *whole* addition against budget
    // before committing any of it, not just the way's own distance. Without
    // this, budget was only enforced on the primary edge while its pulled-in
    // connector ways were added unconditionally, letting selection balloon
    // well past the intended cap (verified: a 292min/~15.7km budget produced
    // 23.76km of selected trail before this fix).
    const pathEdges = (pathTo(fromNode) || []).filter((e) => !selectedWayIndices.has(e.wayIndex));
    const pathCostKm = pathEdges.reduce((sum, e) => sum + e.distanceKm, 0);
    const totalCostKm = edge.distanceKm + pathCostKm;

    if (budgetUsed + totalCostKm > distanceBudgetKm * 1.1) continue;

    selectedWayIndices.add(wayIndex);
    budgetUsed += edge.distanceKm;
    for (const connectorEdge of pathEdges) {
      selectedWayIndices.add(connectorEdge.wayIndex);
      budgetUsed += connectorEdge.distanceKm;
    }
  }

  if (selectedWayIndices.size === 0) return null;

  const subnetworkWays = ways.filter((_, i) => selectedWayIndices.has(i));
  const subgraph = buildTrailGraph(subnetworkWays);
  if (subgraph.size === 0) return null;

  // wayIndex values on subgraph's edges are indices into subnetworkWays, not
  // the original `ways` — and subgraph's own cluster ids are a fresh
  // UnionFind numbering unrelated to the original graph's, so the start
  // node has to be re-located by nearest-point match rather than by id.
  const startLoc = nodeLocation(graph, actualStartNode);
  const remapped = findClosestNodeInComponent(subgraph, new Set(subgraph.keys()), startLoc.lat, startLoc.lon);
  const remappedStart = remapped ? remapped.node : pickBestStartNode(subgraph);
  if (remappedStart == null) return null;

  const mainRun = runComponentCircuit(subgraph, new Set(subgraph.keys()), remappedStart, filters);
  if (!mainRun) return null;

  const mainRoute = assembleRoute(mainRun.circuitEdges, subnetworkWays);
  const mainLocation = nodeLocation(subgraph, mainRun.actualStartNode);

  const additionalLoops = [];
  const connectorSegments = [];
  let combinedDistanceKm = mainRoute.totalDistanceKm;
  let combinedDeadheadKm = mainRoute.deadheadDistanceKm;
  let combinedSegmentCount = mainRoute.segmentCount;
  let combinedCoveredTrailKm = mainRoute.totalDistanceKm - mainRoute.deadheadDistanceKm;
  const combinedNamedTrails = new Set(mainRoute.namedTrails);

  // Other, separately-disconnected clusters only get added as optional
  // out-and-back detours while budget remains — this is the piece that
  // actually caps route length instead of stitching every component in.
  const allComponents = findConnectedComponents(graph);
  const startComponent = allComponents.find((c) => c.has(actualStartNode));
  const otherComponents = allComponents.filter((c) => c !== startComponent);

  for (const component of otherComponents) {
    const candidate = findClosestNodeInComponent(graph, component, mainLocation.lat, mainLocation.lon);
    if (!candidate) continue;

    const connectorCostKm = candidate.distanceKm * 2; // out and back
    if (combinedDistanceKm + connectorCostKm > distanceBudgetKm * 1.15) continue; // too far — skip

    const detourRun = runComponentCircuit(graph, component, candidate.node, filters);
    if (!detourRun) continue;

    const detourRoute = assembleRoute(detourRun.circuitEdges, ways);
    if (combinedDistanceKm + connectorCostKm + detourRoute.totalDistanceKm > distanceBudgetKm * 1.15) continue;

    connectorSegments.push({
      from: { lat: mainLocation.lat, lon: mainLocation.lon },
      to: { lat: candidate.lat, lon: candidate.lon },
      distanceMi: Math.round(candidate.distanceKm * 0.621371 * 100) / 100,
      type: 'road_connector'
    });
    additionalLoops.push(detourRoute.geometry);
    combinedDistanceKm += connectorCostKm + detourRoute.totalDistanceKm;
    combinedDeadheadKm += detourRoute.deadheadDistanceKm;
    combinedSegmentCount += detourRoute.segmentCount;
    combinedCoveredTrailKm += detourRoute.totalDistanceKm - detourRoute.deadheadDistanceKm;
    detourRoute.namedTrails.forEach((n) => combinedNamedTrails.add(n));
  }

  const combinedDistanceMi = combinedDistanceKm * 0.621371;

  return {
    ...mainRoute,
    totalDistanceKm: Math.round(combinedDistanceKm * 100) / 100,
    totalDistanceMi: Math.round(combinedDistanceMi * 100) / 100,
    estimatedTimeMinutes: Math.round((combinedDistanceMi / PACE_MPH) * 60),
    segmentCount: combinedSegmentCount,
    deadheadDistanceKm: Math.round(combinedDeadheadKm * 100) / 100,
    deadheadDistanceMi: Math.round(combinedDeadheadKm * 0.621371 * 100) / 100,
    namedTrails: [...combinedNamedTrails],
    additionalLoops,
    connectorSegments,
    coveredTrailKm: Math.round(combinedCoveredTrailKm * 100) / 100,
  };
};

// ─── Main entry point ────────────────────────────────────────────────────

// sizeClass + timeBudgetMinutes (both derived by trailController from the
// park's size tier — see PARK_SIZE_CONFIG/computeTimeBudget) pick between
// the two routing strategies above. Both are optional and default to the
// old always-full-coverage behavior for any caller that doesn't pass them.
const findOptimalParkRoute = (ways, filters = {}, startNodeId = null, sizeClass = null, timeBudgetMinutes = null) => {
  const filteredWays = filterWaysForRoute(ways, filters);
  if (filteredWays.length === 0) return null;

  const graph = buildTrailGraph(filteredWays);
  if (graph.size === 0) return null;

  const totalTrailKm = sumWaysDistanceKm(filteredWays);
  const strategy = selectRoutingStrategy(sizeClass, totalTrailKm);
  const totalParkTrailKm = Math.round(totalTrailKm * 100) / 100;

  if (strategy === 'budget_subnetwork' && timeBudgetMinutes != null) {
    const budgetRoute = findBudgetSubnetwork(graph, filteredWays, startNodeId, timeBudgetMinutes, filters);
    if (budgetRoute) {
      return { ...budgetRoute, routingStrategy: 'budget_subnetwork', totalParkTrailKm };
    }
    // Budget selection produced nothing usable (e.g. no reachable ways at
    // all) — fall through to full coverage rather than returning no route.
  }

  const components = findConnectedComponents(graph);
  const fullRoute = findFullCoverageRoute(graph, components, startNodeId, filters, filteredWays);
  if (!fullRoute) return null;

  return { ...fullRoute, routingStrategy: 'full_coverage', totalParkTrailKm };
};

module.exports = { findOptimalParkRoute, calcDistanceKm, buildTrailGraph };

class Heap {
  constructor() { this.items = []; }
  push(value) {
    const a = this.items;
    let i = a.length;
    a.push(value);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= value.f) break;
      a[i] = a[p]; i = p;
    }
    a[i] = value;
  }
  pop() {
    const a = this.items, first = a[0], last = a.pop();
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let child = i * 2 + 1;
        if (child + 1 < a.length && a[child + 1].f < a[child].f) child++;
        if (last.f <= a[child].f) break;
        a[i] = a[child]; i = child;
      }
      a[i] = last;
    }
    return first;
  }
}

export function localRoute(scene, start, target) {
  const world = scene.world, cell = 2, half = world.gridSize / 2 - 4;
  const size = Math.floor(half * 2 / cell) + 1;
  const decode = id => ({ x: id % size * cell - half, z: Math.floor(id / size) * cell - half });
  const encode = (x, z) => Math.round((z + half) / cell) * size + Math.round((x + half) / cell);
  const free = (x, z) => Math.abs(x) <= half && Math.abs(z) <= half && !world.colliders.some(c => Math.hypot(x - c.x, z - c.z) < c.radius + 0.9);
  const desired = target.kind === "base" ? { x: world.baseCoord.x, z: world.baseCoord.z + 16 } : scene.toLocal(target.lat, target.lon);
  let goal = null, best = Infinity;
  for (let x = desired.x - 10; x <= desired.x + 10; x += cell) {
    for (let z = desired.z - 10; z <= desired.z + 10; z += cell) {
      const p = decode(encode(x, z)), d = Math.hypot(p.x - desired.x, p.z - desired.z);
      if (free(p.x, p.z) && d < best) { goal = p; best = d; }
    }
  }
  if (!goal || target.kind === "sample" && best > 4.5) throw new Error("No hay acceso transitable al objetivo");
  const startId = encode(start.x, start.z), goalId = encode(goal.x, goal.z);
  const scores = new Float64Array(size * size); scores.fill(Infinity);
  const parents = new Int32Array(size * size); parents.fill(-1);
  const heights = new Float64Array(size * size); heights.fill(NaN);
  const height = id => Number.isNaN(heights[id]) ? heights[id] = world.getSmoothHeightAt(decode(id).x, decode(id).z) : heights[id];
  const heuristic = p => Math.hypot(p.x - goal.x, p.z - goal.z);
  const open = new Heap();
  scores[startId] = 0;
  open.push({ id: startId, g: 0, f: heuristic(start) });
  const dirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  let found = false;
  while (open.items.length) {
    const current = open.pop();
    if (current.g !== scores[current.id]) continue;
    if (current.id === goalId) { found = true; break; }
    const p = decode(current.id);
    for (const [dx, dz] of dirs) {
      const x = p.x + dx * cell, z = p.z + dz * cell;
      if (!free(x, z) || !free((p.x + x) / 2, (p.z + z) / 2)) continue;
      if (dx && dz && (!free(x, p.z) || !free(p.x, z))) continue;
      const id = encode(x, z), distance = Math.hypot(dx, dz) * cell;
      const grade = (height(id) - height(current.id)) / distance;
      const slope = Math.atan(grade) * 180 / Math.PI;
      if (slope > 24 || slope < -28) continue;
      const g = current.g + distance * (1 + Math.max(0, grade) * 9 + Math.abs(grade) * 2);
      if (g >= scores[id]) continue;
      scores[id] = g; parents[id] = current.id;
      open.push({ id, g, f: g + heuristic({ x, z }) });
    }
  }
  if (!found) throw new Error("No existe un corredor seguro entre los obstáculos y las pendientes");
  const nodes = [];
  for (let id = goalId; id !== -1; id = parents[id]) nodes.push(decode(id));
  nodes.reverse();
  nodes[0] = { x: start.x, z: start.z };
  return nodes.map(p => ({ ...scene.toLatLon(p.x, p.z), elevation_m: scene.surfaceElevation(p.x, p.z) }));
}

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

function smoothLocal(world, nodes) {
  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  const passable = (a, b) => {
    if (world.pathBlocked(a.x, a.z, b.x, b.z, 0.85)) return false;
    const steps = Math.max(1, Math.ceil(distance(a, b) / 0.35));
    let last = world.getSmoothHeightAt(a.x, a.z);
    for (let i = 1; i <= steps; i++) {
      const p = lerp(a, b, i / steps);
      const height = world.getSmoothHeightAt(p.x, p.z);
      if (Math.abs(height - last) > Math.tan(24 * Math.PI / 180) * distance(a, b) / steps + 0.0001) return false;
      last = height;
    }
    return true;
  };

  const path = [nodes[0]];
  // Round each corner locally; fall back to the verified corner when clearance is tight.
  for (let i = 1; i + 1 < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i], c = nodes[i + 1];
    const entry = lerp(b, a, 0.3), exit = lerp(b, c, 0.3);
    const curved = [entry];
    for (let j = 1; j <= 3; j++) {
      const t = j / 3;
      curved.push(lerp(lerp(entry, b, t), lerp(b, exit, t), t));
    }
    const nominal = [path.at(-1), ...curved, c];
    if (nominal.slice(1).every((point, j) => passable(nominal[j], point))) path.push(...curved);
    else path.push(b);
  }
  path.push(nodes.at(-1));
  const dense = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const steps = Math.max(1, Math.ceil(distance(a, b) / 0.70));
    for (let j = 1; j <= steps; j++) dense.push(lerp(a, b, j / steps));
  }
  return dense;
}

export function localRoute(scene, start, target) {
  const world = scene.world, cell = 1, half = world.gridSize / 2 - 4;
  const size = Math.floor(half * 2 / cell) + 1;
  const decode = id => ({ x: id % size * cell - half, z: Math.floor(id / size) * cell - half });
  const encode = (x, z) => Math.round((z + half) / cell) * size + Math.round((x + half) / cell);
  const clearance = new Int8Array(size * size);
  const free = (x, z) => {
    if (Math.abs(x) > half || Math.abs(z) > half) return false;
    const id = encode(x, z);
    if (!clearance[id]) clearance[id] = world.pathBlocked(x, z, x, z, 0.9) ? -1 : 1;
    return clearance[id] > 0;
  };
  const desired = target.kind === "base" ? { x: world.baseCoord.x, z: world.baseCoord.z + 16 } : scene.toLocal(target.lat, target.lon);
  let goal = null, best = Infinity;
  for (let x = desired.x - 10; x <= desired.x + 10; x += cell) {
    for (let z = desired.z - 10; z <= desired.z + 10; z += cell) {
      const p = decode(encode(x, z)), d = Math.hypot(p.x - desired.x, p.z - desired.z);
      if (free(p.x, p.z) && d < best) { goal = p; best = d; }
    }
  }
  if (!goal || target.kind === "sample" && best > 4.5) throw new Error("No hay acceso transitable al objetivo");
  let startCell = null, startDistance = Infinity;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const cellId = encode(start.x + dx * cell, start.z + dz * cell);
      const candidate = decode(cellId);
      const distance = Math.hypot(candidate.x - start.x, candidate.z - start.z);
      if (distance < startDistance && free(candidate.x, candidate.z) &&
          !world.pathBlocked(start.x, start.z, candidate.x, candidate.z)) {
        startCell = cellId; startDistance = distance;
      }
    }
  }
  if (startCell === null) throw new Error("El origen está bloqueado por el terreno local");
  const startId = startCell, goalId = encode(goal.x, goal.z);
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
      if (!free(x, z) || world.pathBlocked(p.x, p.z, x, z, 0.9)) continue;
      if (dx && dz && (!free(x, p.z) || !free(p.x, z))) continue;
      const id = encode(x, z), distance = Math.hypot(dx, dz) * cell;
      const grade = (height(id) - height(current.id)) / distance;
      const slope = Math.atan(grade) * 180 / Math.PI;
      if (Math.abs(slope) > 24) continue;
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
  if (startDistance > 0.001) nodes.unshift({ x: start.x, z: start.z });
  return (nodes.length > 2 ? smoothLocal(world, nodes) : nodes).map(p => ({
    ...scene.toLatLon(p.x, p.z), elevation_m: scene.surfaceElevation(p.x, p.z),
  }));
}

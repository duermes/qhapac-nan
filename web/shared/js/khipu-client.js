// Shared Khipu client state: one terrain/scenario model used by every interface.
import { api } from "./api.js";
import { Grid, bilinear, haversine } from "./geo.js";
import { decodeGrid } from "./raster.js";

const cache = new Map();

export async function loadRegion(key, stride = 1) {
  const ck = `${key}:${stride}`;
  if (cache.has(ck)) return cache.get(ck);
  const t = await api.terrain(key, { include_grid: true, stride });
  if (!t.available) return { available: false, key, message: t.message };
  const g = new Grid(t.geometry);
  const elev = decodeGrid(t.elevation);
  const region = {
    available: true, key, dataRegion: t.data_region, manifest: t.manifest, grid: g, elev, stride,
    focus: t.focus_regions, analytical: t.analytical_layers, unavailable: t.unavailable_layers,
    provenance: t.provenance, stats: t.elevation_stats,
    // elevation at lat/lon (bilinear over the decoded, possibly strided, grid)
    elevationAt(lat, lon) {
      if (!g.contains(lat, lon)) return null;
      const { r, c } = g.toRC(lat, lon);
      return bilinear(elev.data, elev.rows, elev.cols, r / stride, c / stride);
    },
    slopeAt(lat, lon) {
      const d = 60;
      const e0 = this.elevationAt(lat, lon);
      if (e0 == null) return null;
      const dLat = d / g.dy / g.pixels_per_degree, dLon = d / g.dxAt(lat) / g.pixels_per_degree;
      const ex = (this.elevationAt(lat, lon + dLon) - this.elevationAt(lat, lon - dLon)) / (2 * d);
      const ey = (this.elevationAt(lat + dLat, lon) - this.elevationAt(lat - dLat, lon)) / (2 * d);
      return Math.atan(Math.hypot(ex, ey)) * 180 / Math.PI;
    },
  };
  cache.set(ck, region);
  return region;
}

export async function loadScenario() {
  if (cache.has("scenario")) return cache.get("scenario");
  const s = await api.scenario();
  cache.set("scenario", s);
  return s;
}

export async function loadRecordedTraverse(regionKey) {
  const { official } = await api.officialRoutes(regionKey);
  return official[0]?.segments.flatMap((segment) => segment.paths) || [];
}

export function entitiesFrom(scenario, userAssets = []) {
  const ents = [];
  (scenario.assets || []).forEach((a) => ents.push({ ...a, provenance: "synthetic", source: "scenario" }));
  (scenario.pois || []).forEach((p) => ents.push({ ...p, provenance: "synthetic", source: "scenario" }));
  ents.push(...(scenario.science_points || []));
  userAssets.forEach((a) => ents.push({ ...a, source: "user" }));
  return ents;
}

export const isMobile = (e) => e && (e.kind === "rover" || e.kind === "astronaut");

export function nearest(entities, lat, lon, maxM = Infinity, filter = () => true) {
  let best = null, bd = maxM;
  for (const e of entities) {
    if (!filter(e)) continue;
    const d = haversine(lat, lon, e.lat, e.lon);
    if (d < bd) { bd = d; best = e; }
  }
  return best ? { entity: best, distance: bd } : null;
}

const layerRequests = new Map();
export function layerGrid(regionKey, id, params = {}) {
  const key = JSON.stringify([regionKey, id, params]);
  const previous = layerRequests.get(key);
  if (previous && Date.now() - previous.at < 15000) return previous.result;
  const result = fetchLayerGrid(regionKey, id, params);
  layerRequests.set(key, {at:Date.now(),result});
  if (layerRequests.size > 64) layerRequests.delete(layerRequests.keys().next().value);
  result.catch(() => layerRequests.delete(key));
  return result;
}
async function fetchLayerGrid(regionKey, id, params = {}) {
  const res = await api.layer(id, { region_key: regionKey, stride: 2, ...params });
  if (!res.available) return { ...res, grid: null };
  return { ...res, decoded: decodeGrid(res.grid) };
}

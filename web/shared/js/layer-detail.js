import { layerGrid } from "./khipu-client.js";
import { renderLayer } from "./raster.js";

export const LAYER_OVERVIEW_STRIDE = 4;

export function layerResolution(zoom) {
  return zoom < 3 ? 4 : zoom < 5 ? 3 : zoom < 7 ? 2 : 1;
}

export function layerViewport(map, view3d) {
  const { grid } = map.region;
  const zoom = view3d ? grid.dxC / Math.max(1e-9, view3d.metersPerPixel()) : map.cam.scale / map.minScale;
  const stride = layerResolution(zoom);
  if (stride === LAYER_OVERVIEW_STRIDE) return null;
  let corners;
  if (view3d) {
    const mpp = view3d.metersPerPixel();

    const { x, z } = view3d.controls.target;
    const { lat, lon } = grid.fromXZ(x, z);
    const { r, c } = grid.toRC(lat, lon);
    const w = view3d.el.clientWidth * mpp / grid.dxC;
    const h = view3d.el.clientHeight * mpp / grid.dy;
    corners = [{ col: c - w, row: r - h }, { col: c + w, row: r + h }];
  } else {
    corners = [[0, 0], [map.w, 0], [0, map.h], [map.w, map.h]].map(([x, y]) => map.toGrid(x, y));
  }
  const bounds = (values, size) => {
    const lo = Math.max(0, Math.floor(Math.min(...values) / 16) * 16 - 8);
    const hi = Math.min(size, Math.ceil(Math.max(...values) / 16) * 16 + 8);
    return [lo, Math.max(0, hi - lo)];
  };
  const [row, rows] = bounds(corners.map((p) => p.row), grid.rows);
  const [col, cols] = bounds(corners.map((p) => p.col), grid.cols);
  return rows && cols ? { row, col, rows, cols, stride } : null;
}

export function adaptiveLayers(getState, repaint) {
  let timer, lastSignature, revision = 0, busy = false, queued = null;
  const run = async (job) => {
    if (busy) { queued = job; return; }
    busy = true;
    try { await job(); }
    finally { busy = false; const latest = queued; queued = null; if (latest) run(latest); }
  };
  const details = new Map();
  return {
    details,
    update() {
      const { region, layers, window } = getState();
      const signature = JSON.stringify([region, window, layers.map(({ id, key }) => [id, key])]);
      if (lastSignature === signature) return;
      lastSignature = signature;
      clearTimeout(timer);
      const current = ++revision;
      const active = new Set(layers.map(({ id }) => id));
      let removed = false;
      for (const [id, tile] of details) {
        if (!window || !active.has(id) || layers.find((layer) => layer.id === id)?.key !== tile.key) {
          details.delete(id);
          removed = true;
        }
      }
      if (removed) queueMicrotask(repaint);
      if (!window || !layers.length) return;
      timer = setTimeout(() => run(async () => {
        let changed = false;
        for (const { id, key, params } of layers) {
          if (current !== revision) break;
          const tileKey = JSON.stringify([key, window]);
          if (details.get(id)?.tileKey === tileKey) continue;
          try {
            const tile = await layerGrid(region, id, { ...params, ...window });
            if (current !== revision || !tile.available || !tile.decoded) continue;
            details.set(id, { ...window, tileKey, key, width: window.cols, height: window.rows,
              canvas: renderLayer(tile.decoded, tile.layer.colormap, id, ...tile.color_domain, tile.layer.classes) });
            changed = true;
          } catch { /* retain the smoothed overview if the visible patch is unavailable */ }
        }
        if (current === revision && changed) repaint();
      }), 130);
    },
  };
}

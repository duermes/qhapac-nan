import { layerGrid } from "./khipu-client.js";
import { renderLayer } from "./raster.js";

export const LAYER_OVERVIEW_STRIDE = 4;

export function layerViewport(map, view3d) {
  const { grid } = map.region;
  if (!view3d && map.cam.scale < 5) return null;
  let corners;
  if (view3d) {
    const mpp = view3d.metersPerPixel();
    if (mpp > grid.dxC / 5) return null;
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
    if (hi - lo <= 256) return [lo, Math.max(0, hi - lo)];
    const center = Math.floor((lo + hi) / 32) * 16;
    return [center - 128, 256];
  };
  const [row, rows] = bounds(corners.map((p) => p.row), grid.rows);
  const [col, cols] = bounds(corners.map((p) => p.col), grid.cols);
  return rows && cols ? { row, col, rows, cols, stride: 1 } : null;
}

export function adaptiveLayers(getState, repaint) {
  let timer, lastSignature, revision = 0;
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
      timer = setTimeout(async () => {
        let changed = false;
        await Promise.all(layers.map(async ({ id, key, params }) => {
          const tileKey = JSON.stringify([key, window]);
          if (details.get(id)?.tileKey === tileKey) return;
          try {
            const tile = await layerGrid(region, id, { ...params, ...window });
            if (current !== revision || !tile.available || !tile.decoded) return;
            details.set(id, { ...window, tileKey, key, width: window.cols, height: window.rows,
              canvas: renderLayer(tile.decoded, tile.layer.colormap, id, ...tile.color_domain) });
            changed = true;
          } catch { /* retain the smoothed overview if the visible patch is unavailable */ }
        }));
        if (current === revision && changed) repaint();
      }, 130);
    },
  };
}

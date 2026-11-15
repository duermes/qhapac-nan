// Raster decoding, colormaps, hillshade and contour extraction (canvas, no deps).

export function decodeGrid(g) {
  if (!g) return null;
  const bin = atob(g.data);
  const n = g.rows * g.cols;
  const out = new Float32Array(n);
  const bounds = { min: g.min, max: g.max, stride: g.stride || 1, row: g.row || 0, col: g.col || 0,
    width: g.width ?? g.cols * (g.stride || 1), height: g.height ?? g.rows * (g.stride || 1) };
  if (!g.data) { out.fill(NaN); return { data: out, rows: g.rows, cols: g.cols, ...bounds }; }
  const top = g.nodata - 1;
  const span = (g.max - g.min) / top;
  if (g.encoding === "uint16") {
    for (let i = 0; i < n; i++) {
      const q = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      out[i] = q === g.nodata ? NaN : g.min + q * span;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const q = bin.charCodeAt(i);
      out[i] = q === g.nodata ? NaN : g.min + q * span;
    }
  }
  return { data: out, rows: g.rows, cols: g.cols, ...bounds };
}

const lerp = (a, b, t) => a + (b - a) * t;
function ramp(stops) {
  return (t) => {
    t = Math.min(1, Math.max(0, t));
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
        const f = (t - t0) / (t1 - t0 || 1);
        return [lerp(c0[0], c1[0], f), lerp(c0[1], c1[1], f), lerp(c0[2], c1[2], f)];
      }
    }
    return stops[stops.length - 1][1];
  };
}

// Scientific colormaps keep their own semantics (brand gold is not used for data).
export const COLORMAPS = {
  terrain: ramp([[0, [38, 52, 70]], [0.35, [70, 96, 92]], [0.6, [150, 132, 98]], [0.85, [190, 160, 130]], [1, [235, 225, 210]]]),
  slope: ramp([[0, [30, 120, 80]], [0.4, [190, 200, 60]], [0.66, [240, 160, 40]], [1, [215, 45, 40]]]),
  magma: ramp([[0, [10, 8, 30]], [0.35, [110, 30, 110]], [0.65, [230, 80, 70]], [1, [252, 230, 160]]]),
  viridis: ramp([[0, [68, 1, 84]], [0.33, [49, 104, 142]], [0.66, [53, 183, 121]], [1, [253, 231, 37]]]),
  thermal: ramp([[0, [40, 60, 160]], [0.5, [200, 200, 200]], [1, [200, 50, 40]]]),
  solar: ramp([[0, [20, 20, 30]], [0.5, [190, 120, 40]], [1, [255, 240, 170]]]),
  shadow: ramp([[0, [0, 0, 0]], [1, [10, 10, 40]]]),
  dust: ramp([[0, [120, 90, 60]], [1, [230, 180, 110]]]),
  telecom: ramp([[0, [200, 40, 40]], [0.4, [230, 160, 40]], [0.5, [220, 210, 80]], [1, [40, 170, 220]]]),
  traversability: ramp([[0, [190, 40, 40]], [0.5, [220, 190, 60]], [1, [40, 170, 100]]]),
  science: ramp([[0, [30, 20, 60]], [0.5, [120, 80, 200]], [1, [220, 190, 255]]]),
  diverging: ramp([[0, [200, 50, 50]], [0.5, [235, 235, 225]], [1, [120, 80, 220]]]),
  survival: ramp([[0, [40, 170, 110]], [0.5, [230, 180, 50]], [1, [210, 40, 50]]]),
  cost: ramp([[0, [40, 160, 110]], [0.3, [220, 200, 70]], [1, [200, 40, 50]]]),
  tiers: (t) => [[63, 191, 127], [232, 200, 61], [232, 130, 40], [224, 50, 50]][Math.round(t * 3)] || [224, 50, 50],
};

export const isCategoricalLayer = (id) => id === "hazard" || id === "shadow";

export function renderLayer(grid, colormap, id, lo, hi) {
  const cv = document.createElement("canvas");
  cv.width = grid.cols;
  cv.height = grid.rows;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(grid.cols, grid.rows);
  const cm = COLORMAPS[colormap] || COLORMAPS.viridis;
  const a = lo ?? grid.min, b = hi ?? grid.max;
  const span = b - a || 1;
  for (let i = 0; i < grid.data.length; i++) {
    const v = grid.data[i];
    if (!isFinite(v)) { img.data[4 * i + 3] = 0; continue; }
    const t = Math.max(0, Math.min(1, (v - a) / span));
    const [r, g, bl] = cm(t);
    img.data[4 * i] = r; img.data[4 * i + 1] = g; img.data[4 * i + 2] = bl;
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

export function drawLayer(ctx, layer) {
  const { canvas, detail, opacity, id, stride } = layer;
  const width = layer.width ?? canvas.width * stride;
  const height = layer.height ?? canvas.height * stride;
  ctx.save();
  ctx.imageSmoothingEnabled = !isCategoricalLayer(id);
  ctx.globalAlpha = opacity;
  if (detail) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.rect(detail.col, detail.row, detail.width, detail.height);
    ctx.clip("evenodd");
    ctx.drawImage(canvas, 0, 0, width, height);
    ctx.restore();
    ctx.drawImage(detail.canvas, detail.col, detail.row, detail.width, detail.height);
  } else {
    ctx.drawImage(canvas, 0, 0, width, height);
  }
  ctx.restore();
}

/** Hillshaded Martian relief from MOLA (sun from az/el, same as 3D light). */
export function hillshade(elev, rows, cols, dxM, dyM, sunAzDeg = 315, sunElDeg = 35, exaggeration = 3) {
  const cv = document.createElement("canvas");
  cv.width = cols; cv.height = rows;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(cols, rows);
  let lo = Infinity, hi = -Infinity;
  for (const v of elev) if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const az = sunAzDeg * Math.PI / 180, el = Math.max(2, sunElDeg) * Math.PI / 180;
  const sx = Math.cos(el) * Math.sin(az), sy = Math.cos(el) * Math.cos(az), sz = Math.sin(el);
  const at = (r, c) => elev[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const z = elev[i];
      if (!isFinite(z)) { img.data[4 * i + 3] = 0; continue; }
      const dzdx = (at(r, c + 1) - at(r, c - 1)) / (2 * dxM) * exaggeration;
      const dzdy = -(at(r + 1, c) - at(r - 1, c)) / (2 * dyM) * exaggeration; // north positive
      const nx = -dzdx, ny = -dzdy, nz = 1;
      const nl = Math.hypot(nx, ny, nz);
      const shade = Math.max(0, (nx * sx + ny * sy + nz * sz) / nl);
      const t = (z - lo) / (hi - lo || 1);
      // ochre basalt palette (Mars-like but muted), shaded
      const base = [lerp(86, 176, t), lerp(66, 140, t), lerp(54, 112, t)];
      const k = 0.35 + 0.85 * shade;
      img.data[4 * i] = Math.min(255, base[0] * k);
      img.data[4 * i + 1] = Math.min(255, base[1] * k);
      img.data[4 * i + 2] = Math.min(255, base[2] * k);
      img.data[4 * i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: cv, min: lo, max: hi };
}

/** Marching squares: Path2D in grid coordinates. Each cell only visits the
 *  iso-levels that actually cross it (O(cells + segments)). */
export function contourPath(elev, rows, cols, interval, scale = 1, win = null) {
  const path = new Path2D();
  const majorPath = new Path2D();
  const at = (r, c) => elev[r * cols + c];
  const P = (x, y) => [(x + 0.5) * scale, (y + 0.5) * scale];
  const r0 = win ? win.r0 : 0, r1 = win ? Math.min(win.r1, rows - 1) : rows - 1;
  const c0 = win ? win.c0 : 0, c1 = win ? Math.min(win.c1, cols - 1) : cols - 1;
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const a = at(r, c), b = at(r, c + 1), d = at(r + 1, c), e = at(r + 1, c + 1);
      if (!(isFinite(a) && isFinite(b) && isFinite(d) && isFinite(e))) continue;
      const lo = Math.min(a, b, d, e), hi = Math.max(a, b, d, e);
      for (let k = Math.ceil(lo / interval); k * interval <= hi; k++) {
        const level = k * interval;
        if (level === lo && level === hi) continue;
        const p = (k % 5 === 0) ? majorPath : path;
        const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (e > level ? 2 : 0) | (d > level ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const top = [c + (level - a) / (b - a), r];
        const right = [c + 1, r + (level - b) / (e - b)];
        const bottom = [c + (level - d) / (e - d), r + 1];
        const left = [c, r + (level - a) / (d - a)];
        const seg = (p1, p2) => { const u = P(p1[0], p1[1]), v = P(p2[0], p2[1]); p.moveTo(u[0], u[1]); p.lineTo(v[0], v[1]); };
        switch (idx) {
          case 1: case 14: seg(left, bottom); break;
          case 2: case 13: seg(bottom, right); break;
          case 3: case 12: seg(left, right); break;
          case 4: case 11: seg(top, right); break;
          case 5: seg(left, top); seg(bottom, right); break;
          case 6: case 9: seg(top, bottom); break;
          case 7: case 8: seg(left, top); break;
          case 10: seg(top, right); seg(left, bottom); break;
        }
      }
    }
  }
  return { minor: path, major: majorPath };
}

export const LEGEND_STOPS = (colormap, n = 6) => {
  const cm = COLORMAPS[colormap] || COLORMAPS.viridis;
  return Array.from({ length: n }, (_, i) => cm(i / (n - 1))).map(([r, g, b]) => `rgb(${r | 0},${g | 0},${b | 0})`);
};

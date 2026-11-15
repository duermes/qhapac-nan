// 2D cartographic renderer (Canvas). Shared by Hatun Wasi and Chaski.
// Camera in full-resolution grid cells: (cx, cy) centre, scale = screen px per cell, rot = radians.
import { haversine } from "./geo.js";
import { contourPath, drawLayer, hillshade } from "./raster.js";
import { ASSET_REGISTRY, markerKind, icon } from "./icons.js";

const iconCache = new Map();
function iconImage(name, color) {
  const k = `${name}|${color}`;
  if (iconCache.has(k)) return iconCache.get(k);
  const svg = icon(name).replace('stroke="currentColor"', `stroke="${color}"`).replace('class="icon"', 'xmlns="http://www.w3.org/2000/svg" width="24" height="24"');
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  iconCache.set(k, img);
  return img;
}

export class Map2D {
  constructor(canvas, region, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.region = region;
    this.g = region.grid;
    this.opts = { maxScale: Math.max(48, this.g.dxC * 100 / 30), contours: true, labels: true, trackUp: false, ...opts };
    this.layers = [];           // {id, canvas, opacity, visible, stride}
    this.routes = [];           // {id, points:[{lat,lon}], color, width, dash, segments, visible}
    this.entities = [];
    this.hazards = [];
    this.toponyms = [];
    this.beams = [];
    this.halos = [];            // {lat, lon, radius_m, color}
    this.selection = null;
    this.hidden = new Set();    // legend filters (entity kinds)
    this.cam = { cx: this.g.cols / 2, cy: this.g.rows / 2, scale: 1, rot: 0 };
    this.listeners = {};
    this.sun = { az: 315, el: 35 };
    this.buildBase();
    this.resize();
    this.fit();
    this.bind();
    new ResizeObserver(() => { this.resize(); this.draw(); }).observe(canvas);
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { (this.listeners[ev] || []).forEach((f) => f(...a)); }

  buildBase() {
    const e = this.region.elev;
    const s = this.region.stride;
    const hs = hillshade(e.data, e.rows, e.cols, this.g.dxC * s, this.g.dy * s, this.sun.az, this.sun.el);
    this.base = hs.canvas;
    this.contourCache = new Map();
  }

  setSun(az, el) {
    this.sun = { az, el };
    this.buildBase();
    this.draw();
  }

  /** Contour tiles (64x64 source cells) built lazily per interval; only visible tiles are drawn. */
  contourTile(interval, tr, tc) {
    const k = `${interval}:${tr}:${tc}`;
    let t = this.contourCache.get(k);
    if (!t) {
      const e = this.region.elev, T = 64;
      t = contourPath(e.data, e.rows, e.cols, interval, this.region.stride, { r0: tr * T, r1: tr * T + T + 1, c0: tc * T, c1: tc * T + T + 1 });
      this.contourCache.set(k, t);
    }
    return t;
  }

  visibleTiles() {
    const corners = [[0, 0], [this.w, 0], [0, this.h], [this.w, this.h]].map(([x, y]) => this.toGrid(x, y));
    const s = this.region.stride, T = 64 * s;
    const cmin = Math.max(0, Math.min(...corners.map((p) => p.col))), cmax = Math.min(this.g.cols, Math.max(...corners.map((p) => p.col)));
    const rmin = Math.max(0, Math.min(...corners.map((p) => p.row))), rmax = Math.min(this.g.rows, Math.max(...corners.map((p) => p.row)));
    const out = [];
    for (let tr = Math.floor(rmin / T); tr <= Math.floor(rmax / T); tr++)
      for (let tc = Math.floor(cmin / T); tc <= Math.floor(cmax / T); tc++) out.push([tr, tc]);
    return out;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.cv.clientWidth || 800, h = this.cv.clientHeight || 600;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.w = w; this.h = h;
    // cover: the map always fills the viewport (no empty borders)
    this.minScale = Math.max(w / this.g.cols, h / this.g.rows);
    this.clampCam();
  }

  fit() { this.cam = { ...this.cam, cx: this.g.cols / 2, cy: this.g.rows / 2, scale: this.minScale }; this.draw(); }

  clampCam() {
    const c = this.cam;
    c.scale = Math.min(Math.max(c.scale, this.minScale || 0.1), this.opts.maxScale);
    if (c.rot || this.opts.lockPan) {  // track-up: keep the centre inside the region
      c.cx = Math.min(Math.max(c.cx, 0), this.g.cols);
      c.cy = Math.min(Math.max(c.cy, 0), this.g.rows);
      return;
    }
    const hw = (this.w || 0) / 2 / c.scale, hh = (this.h || 0) / 2 / c.scale;
    c.cx = this.g.cols > 2 * hw ? Math.min(Math.max(c.cx, hw), this.g.cols - hw) : this.g.cols / 2;
    c.cy = this.g.rows > 2 * hh ? Math.min(Math.max(c.cy, hh), this.g.rows - hh) : this.g.rows / 2;
  }

  // grid (col,row) <-> screen
  toScreen(col, row) {
    const c = this.cam;
    let x = (col - c.cx) * c.scale, y = (row - c.cy) * c.scale;
    if (c.rot) { const cs = Math.cos(c.rot), sn = Math.sin(c.rot); [x, y] = [x * cs - y * sn, x * sn + y * cs]; }
    return { x: x + this.w / 2, y: y + this.h / 2 };
  }
  toGrid(x, y) {
    const c = this.cam;
    let dx = x - this.w / 2, dy = y - this.h / 2;
    if (c.rot) { const cs = Math.cos(-c.rot), sn = Math.sin(-c.rot); [dx, dy] = [dx * cs - dy * sn, dx * sn + dy * cs]; }
    return { col: c.cx + dx / c.scale, row: c.cy + dy / c.scale };
  }
  llToScreen(lat, lon) { const { r, c } = this.g.toRC(lat, lon); return this.toScreen(c + 0.5, r + 0.5); }
  screenToLL(x, y) { const { col, row } = this.toGrid(x, y); return this.g.toLL(row - 0.5, col - 0.5); }

  zoomAt(factor, sx = this.w / 2, sy = this.h / 2) {
    if (this.opts.lockPan) { sx = this.w / 2; sy = this.h / 2; }
    const before = this.toGrid(sx, sy);
    this.cam.scale *= factor;
    this.clampCam();
    const after = this.toGrid(sx, sy);
    this.cam.cx += before.col - after.col;  // keep the point under the cursor fixed (no drift)
    this.cam.cy += before.row - after.row;
    this.clampCam();
    this.draw();
    this.emit("camera", this.cam);
  }

  focusOn(lat, lon, scale) {
    const { r, c } = this.g.toRC(lat, lon);
    this.cam.cx = c + 0.5; this.cam.cy = r + 0.5;
    if (scale) this.cam.scale = scale;
    this.clampCam();
    this.draw();
    this.emit("camera", this.cam);
  }

  fitBBox(b) {
    const a = this.g.toRC(b.lat_max, b.lon_min), z = this.g.toRC(b.lat_min, b.lon_max);
    this.cam.cx = (a.c + z.c) / 2 + 0.5; this.cam.cy = (a.r + z.r) / 2 + 0.5;
    this.cam.scale = Math.min(this.w / Math.max(1, z.c - a.c), this.h / Math.max(1, z.r - a.r)) * 0.9;
    this.clampCam();
    this.draw();
    this.emit("camera", this.cam);
  }

  metersPerPixel() { return this.g.dxC / this.cam.scale; }

  bind() {
    const cv = this.cv;
    let down = null, dragEnt = null, moved = false;
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    cv.addEventListener("pointerdown", (e) => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      down = { x, y, cx: this.cam.cx, cy: this.cam.cy };
      moved = false;
      const hit = this.hitEntity(x, y);
      dragEnt = hit && hit.draggable && !hit.locked ? hit : null;
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointermove", (e) => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const ll = this.screenToLL(x, y);
      this.emit("hover", ll, x, y);
      if (!down) return;
      if (Math.hypot(x - down.x, y - down.y) > 4) moved = true; // click vs drag threshold
      if (!moved) return;
      if (dragEnt) {
        dragEnt.lat = ll.lat; dragEnt.lon = ll.lon;
        this.emit("entitydrag", dragEnt, ll);
        this.draw();
      } else if (!this.opts.lockPan) {
        const a = this.toGrid(down.x, down.y), b = this.toGrid(x, y);
        this.cam.cx += a.col - b.col; this.cam.cy += a.row - b.row;
        this.clampCam();
        down.x = x; down.y = y;
        this.draw();
        this.emit("camera", this.cam);
      }
    });
    cv.addEventListener("pointerup", (e) => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (down && !moved) {
        const hit = this.hitEntity(x, y);
        this.emit("click", this.screenToLL(x, y), hit, { x, y });
      } else if (dragEnt && moved) {
        this.emit("entitydrop", dragEnt, this.screenToLL(x, y));
      }
      down = null; dragEnt = null;
    });
  }

  hitEntity(x, y) {
    let best = null, bd = 14;
    for (const e of this.entities) {
      if (this.hidden.has(markerKind(e))) continue;
      const p = this.llToScreen(e.lat, e.lon);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  contourInterval() {
    const mpp = this.metersPerPixel();
    if (mpp > 600) return 500;
    if (mpp > 300) return 250;
    if (mpp > 120) return 100;
    if (mpp > 40) return 50;
    return 25;
  }

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.render(); });
  }

  render() {
    const ctx = this.ctx, c = this.cam, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b100d";
    ctx.fillRect(0, 0, this.w, this.h);
    // world transform: grid cells -> screen
    const o = this.toScreen(0, 0);
    const cs = Math.cos(c.rot) * c.scale, sn = Math.sin(c.rot) * c.scale;
    ctx.setTransform(dpr * cs, dpr * sn, -dpr * sn, dpr * cs, dpr * o.x, dpr * o.y);
    ctx.imageSmoothingEnabled = true;
    const s = this.region.stride;
    ctx.drawImage(this.base, 0, 0, this.base.width * s, this.base.height * s);
    // analytical layers: non-destructive alpha blending
    for (const L of this.layers) {
      if (!L.visible || !L.canvas) continue;
      drawLayer(ctx, L);
    }
    ctx.globalAlpha = 1;
    if (this.opts.contours) {
      const iv = this.contourInterval();
      const tiles = this.visibleTiles().map(([tr, tc]) => this.contourTile(iv, tr, tc));
      ctx.lineWidth = 0.8 / c.scale;  // constant perceptual width at any zoom
      ctx.strokeStyle = this.opts.contourColor || "rgba(243,235,220,0.28)";
      tiles.forEach((t) => ctx.stroke(t.minor));
      ctx.lineWidth = 1.5 / c.scale;
      ctx.strokeStyle = this.opts.contourMajor || "rgba(243,235,220,0.5)";
      tiles.forEach((t) => ctx.stroke(t.major));
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawHazards(ctx);
    this.drawHalos(ctx);
    this.drawBeams(ctx);
    this.drawRecordedTraverse(ctx);
    this.drawRoutes(ctx);
    this.drawEntities(ctx);
    if (this.opts.labels) this.drawLabels(ctx);
    this.emit("render", this);
  }

  pxPerMeter() { return this.cam.scale / this.g.dxC; }

  drawHazards(ctx) {
    for (const h of this.hazards) {
      if (this.hidden.has("hazard")) continue;
      const p = this.llToScreen(h.lat, h.lon);
      const r = h.radius_m * this.pxPerMeter();
      const grad = ctx.createRadialGradient(p.x, p.y, r * 0.1, p.x, p.y, r);
      const forb = (h.tier === "forbidden" || h.tier === 3);
      grad.addColorStop(0, forb ? "rgba(224,83,74,0.38)" : "rgba(232,163,61,0.30)");
      grad.addColorStop(1, forb ? "rgba(224,83,74,0.10)" : "rgba(232,163,61,0.06)");
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = forb ? "rgba(224,83,74,0.9)" : "rgba(232,163,61,0.85)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  drawHalos(ctx) {
    for (const h of this.halos) {
      const p = this.llToScreen(h.lat, h.lon);
      const r = Math.max(9, h.radius_m * this.pxPerMeter());
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      grad.addColorStop(0, h.color || "rgba(79,208,196,0.35)");
      grad.addColorStop(1, "rgba(79,208,196,0)");
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  drawBeams(ctx) {
    for (const beam of this.beams) {
      const p = this.llToScreen(beam.lat, beam.lon);
      const radius = Math.max(24, beam.length_m * this.pxPerMeter());
      const a = (beam.heading - 90) * Math.PI / 180 + this.cam.rot;
      const arc = beam.halfAngle * Math.PI / 180;
      const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      gradient.addColorStop(0, "rgba(255,219,133,0.42)");
      gradient.addColorStop(1, "rgba(255,219,133,0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.arc(p.x, p.y, radius, a - arc, a + arc);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawRecordedTraverse(ctx) {
    if (!this.recordedPaths?.length) return;
    ctx.save();
    ctx.beginPath();
    for (const path of this.recordedPaths) {
      const first = this.llToScreen(path[0][1], path[0][0]);
      ctx.moveTo(first.x, first.y);
      for (const [lon, lat] of path.slice(1)) {
        const p = this.llToScreen(lat, lon);
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "#292034";
    ctx.stroke();
    ctx.lineWidth = 1.7;
    ctx.strokeStyle = "#dcb2f2";
    ctx.stroke();
    ctx.restore();
  }

  drawRoutes(ctx) {
    for (const rt of this.routes) {
      if (rt.visible === false || !rt.points?.length) continue;
      const pts = rt.points.map((p) => this.llToScreen(p.lat, p.lon));
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      // dark casing keeps the line legible over any raster
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = (rt.width || 3) + 2.5;
      ctx.setLineDash(rt.dash || []);
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
      if (rt.segments?.length) {
        // solid colour segmentation by PNR state
        const col = { safe: "#65d8ff", caution: "#65d8ff", no_return: "#ff8c36" };
        rt.segments.forEach((s) => {
          const a = pts[s.from], b = pts[s.to];
          if (!a || !b) return;
          ctx.strokeStyle = col[s.state] || rt.color;
          ctx.lineWidth = rt.width || 3;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        });
      } else {
        ctx.strokeStyle = rt.color || "#f0a24b";
        ctx.lineWidth = rt.width || 3;
        ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
      }
      ctx.setLineDash([]);
      if (rt.pnr) {
        const p = this.llToScreen(rt.pnr.lat, rt.pnr.lon);
        ctx.fillStyle = "#ff8c36"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x + 7, p.y + 5); ctx.lineTo(p.x - 7, p.y + 5); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.font = "600 10px 'Chakra Petch'"; ctx.fillStyle = "#ffd0ac"; ctx.fillText("PNR", p.x + 9, p.y + 4);
      }
    }
  }

  drawEntities(ctx) {
    for (const e of this.entities) {
      if (this.hidden.has(markerKind(e))) continue;
      const p = this.llToScreen(e.lat, e.lon);
      if (p.x < -20 || p.y < -20 || p.x > this.w + 20 || p.y > this.h + 20) continue;
      const reg = ASSET_REGISTRY[markerKind(e)] || ASSET_REGISTRY.waypoint;
      const sel = this.selection && this.selection.id === e.id;
      const rad = e.kind === "waypoint" ? 7 : 11;
      ctx.fillStyle = "rgba(11,16,13,0.88)";
      ctx.strokeStyle = sel ? "#dfbd80" : reg.color;
      ctx.lineWidth = sel ? 2.5 : 1.6;
      ctx.beginPath();
      if (e.kind === "waypoint" || e.kind === "base" || e.kind === "habitat") {
        ctx.moveTo(p.x, p.y - rad); ctx.lineTo(p.x + rad, p.y); ctx.lineTo(p.x, p.y + rad); ctx.lineTo(p.x - rad, p.y); ctx.closePath();
      } else {
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);   // circles encode science/vehicles
      }
      ctx.fill(); ctx.stroke();
      if (e.kind !== "waypoint") {
        const img = iconImage(reg.icon, reg.color);
        if (img.complete) ctx.drawImage(img, p.x - 7, p.y - 7, 14, 14);
        else img.onload = () => this.draw();
      }
      if (e.locked) { ctx.fillStyle = "#dfbd80"; ctx.fillRect(p.x + 6, p.y - 10, 4, 4); }
      if (e.heading != null && (e.kind === "rover" || e.kind === "astronaut")) {
        const a = (e.heading - 90) * Math.PI / 180 + this.cam.rot;
        ctx.strokeStyle = reg.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p.x + Math.cos(a) * 12, p.y + Math.sin(a) * 12); ctx.lineTo(p.x + Math.cos(a) * 22, p.y + Math.sin(a) * 22); ctx.stroke();
      }
    }
  }

  /** Multiscale labels with priority and greedy collision avoidance. */
  drawLabels(ctx) {
    const sc = this.cam.scale / (this.minScale || 1);
    const items = [];
    for (const t of this.toponyms) {
      const minZoom = [1, 1.6, 3.2, 6][t.rank ?? 2];
      if (sc < minZoom) continue;
      items.push({ text: t.name, lat: t.lat, lon: t.lon, prio: 10 - (t.rank ?? 2), kind: "toponym", size: t.rank === 0 ? 13 : 11 });
    }
    for (const e of this.entities) {
      if (this.hidden.has(markerKind(e)) || e.kind === "waypoint" && !e.name) continue;
      if (sc < (e.kind === "sample" ? 6 : 2.2) && !(this.selection && this.selection.id === e.id)) continue;
      items.push({ text: e.name, lat: e.lat, lon: e.lon, prio: (this.selection && this.selection.id === e.id) ? 20 : 5, kind: "entity", size: 11, dy: 22 });
    }
    items.sort((a, b) => b.prio - a.prio);
    const placed = [];
    for (const it of items) {
      const p = this.llToScreen(it.lat, it.lon);
      ctx.font = `${it.kind === "toponym" ? "600" : "500"} ${it.size}px 'Chakra Petch'`;
      const text = it.text.length > 30 ? it.text.slice(0, 29) + "…" : it.text;
      const w = ctx.measureText(text).width + 12, h = it.size + 8;
      const x = p.x - w / 2, y = p.y + (it.dy || -h / 2);
      if (x < 0 || y < 0 || x + w > this.w || y + h > this.h) continue;
      if (placed.some((r) => !(x + w < r.x || r.x + r.w < x || y + h < r.y || r.y + r.h < y))) continue;
      placed.push({ x, y, w, h });
      if (it.kind === "toponym") {
        ctx.fillStyle = "rgba(243,235,220,0.82)";
        ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.lineWidth = 3;
        ctx.strokeText(text, x + 6, y + h - 6); ctx.fillText(text, x + 6, y + h - 6);
      } else {
        ctx.fillStyle = "rgba(16,22,18,0.82)"; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "rgba(223,189,128,0.25)"; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        ctx.fillStyle = "#f3ebdc"; ctx.fillText(text, x + 6, y + h - 6); // label text is never tinted by rasters
      }
    }
  }

  scaleBar(maxPx = 96) {
    const mpp = this.metersPerPixel();
    const raw = mpp * maxPx;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const nice = [1, 2, 5, 10].map((k) => k * pow).filter((v) => v <= raw).pop() || pow;
    return { meters: nice, px: nice / mpp, mpp };
  }

  distance(a, b) { return haversine(a.lat, a.lon, b.lat, b.lon); }
}

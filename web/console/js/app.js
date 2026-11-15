// Hatun Wasi — mission console bootstrap. One Khipu engine, many homogeneous sessions.
import { api } from "/static/shared/js/api.js";
import { fmt, haversine } from "/static/shared/js/geo.js";
import { brandBlock, icon } from "/static/shared/js/icons.js";
import { entitiesFrom, loadRegion, loadScenario } from "/static/shared/js/khipu-client.js";
import { Map2D } from "/static/shared/js/map2d.js";
import { $, $$, esc, simBanner, toast } from "/static/shared/js/ui.js";
import { initDecks, layerParams } from "./decks.js";
import { adaptiveLayers, layerViewport, LAYER_OVERVIEW_STRIDE } from "/static/shared/js/layer-detail.js";
import { drawLayer } from "/static/shared/js/raster.js";
import { initMenus } from "./menus.js";
import { initPlanning } from "./planning.js";
import { initPopover } from "./popover.js";
import { initTraverses } from "./traverses.js";

const LS_KEY = "qn.console.workspace.v1";

export const ctx = {
  bus: new EventTarget(),
  sessions: [],
  cur: null,
  userAssets: [],
  entities: [],
  map3d: null,
  emit(type, detail) { this.bus.dispatchEvent(new CustomEvent(type, { detail })); },
  on(type, fn) { this.bus.addEventListener(type, (e) => fn(e.detail)); },
};
window.qn = ctx; // debugging/verification hook

const defaultParams = () => ({ max_slope_deg: null, walkback_limit_m: 4000, reserve_fraction: null, speed_mps: null,
  w_hazard: 1.0, w_context: 0.6, tau: 0.5, ltst_h: null, alpha: 0.5, realtime: true });

let sessionSeq = 0;
export function newSession(seed = {}) {
  sessionSeq = Math.max(sessionSeq + 1, ...ctx.sessions.map((s) => +s.id.slice(1) + 1 || 0));
  return {
    id: `S${sessionSeq}`, view: "2d", mode: "plan", cam2d: null, cam3d: null,
    eyes: { analyze: true, plan: true }, layers: {}, activeLayer: null, hidden: [],
    traverses: [], activeTraverse: null, showDirect: false, showCalc: true, params: defaultParams(),
    addMode: false, ...seed,
  };
}

function iconize(root = document) {
  $$("[data-icon]", root).forEach((el) => { el.outerHTML = icon(el.dataset.icon); });
}

export function persist() {
  const ws = { sessions: ctx.sessions.map(serializeSession), current: ctx.cur?.id, preferences: { region: ctx.region?.key } };
  try { localStorage.setItem(LS_KEY, JSON.stringify(ws)); } catch { /* quota */ }
  clearTimeout(persist._t);
  persist._t = setTimeout(() => api.saveWorkspace(ws).catch(() => {}), 800);
}

function serializeSession(s) {
  const c = { ...s };
  c.traverses = s.traverses.map(({ revision, ...t }) => t);
  return c;
}
async function restore() {
  let ws = null;
  try { ws = await api.workspace(); } catch { /* offline */ }
  if (!ws?.sessions?.length) { try { ws = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { ws = null; } }
  if (ws?.sessions?.length) {
    ctx.sessions = ws.sessions.map((s) => ({
      ...newSession(), ...s, params: { ...defaultParams(), ...(s.params || {}) },
      traverses: (s.traverses || []).map((t) => {
        const legacy = t.result && !t.result.static_origin && t.result.route_model !== 2;
        return { ...t, params: t.params || { ...s.params },
          ...(legacy ? { result: null, status: "draft", saved: false } : {}) };
      }),
    }));
    sessionSeq = Math.max(...ctx.sessions.map((s) => +s.id.slice(1) || 0));
    ctx.cur = ctx.sessions.find((s) => s.id === ws.current) || ctx.sessions[0];
    return true;
  }
  ctx.sessions = [newSession()];
  ctx.cur = ctx.sessions[0];
  return false;
}

// ------------------------------------------------------------------ sessions UI
export function renderSessions() {
  const el = $("#sessions");
  el.innerHTML = ctx.sessions.map((s) => `<div class="tab ${s === ctx.cur ? "active" : ""}" role="tab" aria-selected="${s === ctx.cur}" tabindex="0" data-sid="${s.id}">
      <span><span class="dot"></span> ${esc(s.id)}</span><button class="x" aria-label="Cerrar sesión ${esc(s.id)}" data-close="${s.id}">×</button></div>`).join("")
    + `<button class="tab add" id="add-session" aria-label="Nueva sesión" title="Nueva sesión (Alt+Shift+N)">+</button>`;
}

export function switchSession(id) {
  saveCamera();
  ctx.cur = ctx.sessions.find((s) => s.id === id) || ctx.cur;
  applySession();
  persist();
}

export function addSession() {
  saveCamera();
  const s = newSession();
  ctx.sessions.push(s);
  ctx.cur = s;
  applySession();
  persist();
  toast(`Sesión ${s.id} creada`, "safe", 1800);
}

export function closeSession(id) {
  if (ctx.sessions.length === 1) {
    // closing the last session leaves a clean new one (homogeneous behaviour)
    ctx.sessions = [];
    ctx.sessions.push(newSession());
    ctx.cur = ctx.sessions[0];
  } else {
    const i = ctx.sessions.findIndex((s) => s.id === id);
    ctx.sessions.splice(i, 1);
    if (ctx.cur.id === id) ctx.cur = ctx.sessions[Math.max(0, i - 1)];
  }
  applySession();
  persist();
}

function saveCamera() {
  if (!ctx.cur || !ctx.map2d) return;
  ctx.cur.cam2d = { ...ctx.map2d.cam };
  if (ctx.map3d) ctx.cur.cam3d = { pos: ctx.map3d.camera.position.toArray(), target: ctx.map3d.controls.target.toArray() };
}

export async function applySession() {
  const s = ctx.cur;
  renderSessions();
  if (s.cam2d) { ctx.map2d.cam = { ...ctx.map2d.cam, ...s.cam2d }; ctx.map2d.clampCam(); }
  else {
    const jz = (ctx.region.focus || []).find((f) => f.key === "jezero");
    if (jz) ctx.map2d.fitBBox(jz.bbox); else ctx.map2d.fit();
  }
  ctx.map2d.hidden = new Set(s.hidden);
  await setView(s.view, true);
  if (ctx.map3d && s.cam3d) {
    ctx.map3d.camera.position.fromArray(s.cam3d.pos);
    ctx.map3d.controls.target.fromArray(s.cam3d.target);
  } else if (ctx.map3d && !s.cam3d) ctx.map3d.resetCamera();
  await reloadAssets();
  if (ctx.cur !== s) return;
  setMode(s.mode, true);
  ctx.emit("session", s);
  refreshScene();
}

// ------------------------------------------------------------------ view & modes
export async function setView(view, silent = false) {
  const s = ctx.cur;
  s.view = view;
  $("#view-2d").setAttribute("aria-pressed", String(view === "2d"));
  $("#view-3d").setAttribute("aria-pressed", String(view === "3d"));
  $("#map2d").hidden = view !== "2d";
  $("#map3d").hidden = view !== "3d";
  if (view === "3d" && !ctx.map3d) {
    try {
      const { Map3D } = await import("/static/shared/js/map3d.js");
      ctx.map3d = new Map3D($("#map3d"), ctx.region);
      if (ctx.sun) ctx.map3d.setSun(ctx.sun.az, ctx.sun.el);
      ctx.map3d.on("hover", (ll) => updateHud(ll));
      ctx.map3d.on("click", (ll, hit, screen) => ctx.emit("mapclick", { ll, hit, screen }));
      ctx.map3d.on("frame", () => { updateScaleBar(); ctx.layerDetail?.update(); });
      // keep 3D centred where the 2D camera was (context preserved)
      const c = ctx.map2d.screenToLL(ctx.map2d.w / 2, ctx.map2d.h / 2);
      ctx.map3d.focusOn(c.lat, c.lon, Math.max(4000, ctx.map2d.metersPerPixel() * 900));
    } catch (e) {
      console.error(e);
      toast("WebGL no disponible: se mantiene la vista 2D", "warn");
      s.view = "2d";
      return setView("2d");
    }
  }
  if (view === "3d") { ctx.map3d.resize(); refreshScene(); }
  if (!silent) persist();
  updateScaleBar();
}

export function setMode(mode, silent = false) {
  const s = ctx.cur;
  mode = ["general", "analyze", "plan"].includes(mode) ? mode : "general";
  s.mode = mode;
  document.body.dataset.mode = mode;
  $$(".console-dock .dock-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $$(".console-dock .eye").forEach((e) => {
    const on = s.eyes[e.dataset.eye];
    e.setAttribute("aria-pressed", String(on));
    e.innerHTML = icon(on ? "eye" : "eyeoff");
  });
  if (mode === "analyze") ctx.decks?.layers.open();
  else ctx.decks?.layers.close();
  if (mode === "general") ctx.decks?.legend.close();
  if (mode !== "plan") [ctx.decks?.metrics, ctx.decks?.nearby, ctx.decks?.risk].forEach((deck) => deck?.close());
  ctx.emit("mode", mode);
  if (ctx.decks?.legend && !ctx.decks.legend.hidden) ctx.decks.legend.dispatchEvent(new Event("deck:open"));
  if (!silent) persist();
  refreshScene();
}

// ------------------------------------------------------------------ scene
export function routeOverlays() {
  const s = ctx.cur;
  const out = [];
  if (!s.eyes.plan) return out;
  for (const t of s.traverses) {
    if (t.visible === false || !t.result) continue;
    const v = t.result.variants.find((x) => x.variant === t.variant) || t.result.variants[0];
    const active = t.id === s.activeTraverse;
    if ((t.showCalc ?? s.showCalc) && v) {
      out.push({ id: `${t.id}:calc`, points: v.points, color: "#65d8ff", width: active ? 3.5 : 2.5,
        segments: v.pnr?.show_pnr ? v.pnr.segments : null, pnr: v.pnr?.show_pnr ? v.pnr.pnr_point : null });
    }
    if (t.result.direct && (t.showDirect ?? (t.result.static_origin || (s.showDirect && active)))) {
      out.push({ id: `${t.id}:direct`, points: t.result.direct.points, color: "#ebcf7f", width: 1.8, dash: [3, 6] });
    }
  }
  return out;
}

export function refreshScene() {
  const s = ctx.cur;
  const m = ctx.map2d;
  m.entities = ctx.entities;
  m.hidden = new Set(s.hidden);
  m.hazards = ctx.scenario.hazards || [];
  m.toponyms = ctx.scenario.toponyms || [];
  m.routes = routeOverlays();
  m.layers = Object.entries(s.layers).filter(([, L]) => L.visible && ctx.layerCanvases?.[L.key]).map(([id, L]) => ({
    id, canvas: ctx.layerCanvases[L.key], opacity: L.opacity, visible: s.eyes.analyze, stride: LAYER_OVERVIEW_STRIDE,
    width: ctx.region.grid.cols, height: ctx.region.grid.rows,
    detail: s.eyes.analyze && ctx.layerDetail?.details.get(id)?.key === L.key ? ctx.layerDetail.details.get(id) : null,
  }));
  ctx.layerDetail?.update();
  m.selection = ctx.selection || null;
  m.draw();
  if (ctx.map3d && s.view === "3d") {
    ctx.map3d.drape(composite());
    ctx.map3d.setRoutes(m.routes);
    ctx.map3d.setHazards(m.hidden.has("hazard") ? [] : m.hazards);
    ctx.map3d.setMarkers(ctx.entities, m.hidden);
  }
  const activeLayer = s.eyes.analyze ? s.activeLayer : null;
  const lname = activeLayer && ctx.catalog[activeLayer]?.name;
  $("#active-layer-name").textContent = lname || "Relieve MOLA (sombreado)";
  const prov = activeLayer ? ctx.catalog[activeLayer]?.provenance : "derived_from_nasa";
  $("#active-layer-badge").innerHTML = prov ? `<span class="badge ${prov === "official_nasa" ? "official" : prov === "derived_from_nasa" ? "derived" : prov === "synthetic" ? "synthetic" : "model"}">${prov.replaceAll("_", " ")}</span>` : "";
}

/** Offscreen composite (relief + visible analytical layers) used as the 3D mantle. */
export function composite() {
  const m = ctx.map2d;
  const s = ctx.region.stride;
  const cv = document.createElement("canvas");
  cv.width = m.base.width * s; cv.height = m.base.height * s;
  const c = cv.getContext("2d");
  c.drawImage(m.base, 0, 0, cv.width, cv.height);
  for (const L of m.layers) if (L.visible) drawLayer(c, L);
  c.globalAlpha = 1;
  return cv;
}

// ------------------------------------------------------------------ HUD
export function updateHud(ll) {
  if (!ll) return;
  const e = ctx.region.elevationAt(ll.lat, ll.lon);
  const sl = ctx.region.slopeAt(ll.lat, ll.lon);
  $("#hud-lat").textContent = fmt.lat(ll.lat);
  $("#hud-lon").textContent = fmt.lon(ll.lon);
  $("#hud-elev").textContent = e == null ? "sin dato" : `${e.toFixed(0)} m`;
  $("#hud-slope").textContent = sl == null ? "—" : `${sl.toFixed(1)}°`;
  ctx.lastHover = ll;
}

export function updateScaleBar() {
  let mpp;
  if (ctx.cur?.view === "3d" && ctx.map3d) mpp = ctx.map3d.metersPerPixel();
  else mpp = ctx.map2d.metersPerPixel();
  const maxPx = 96, raw = mpp * maxPx;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 5, 10].map((k) => k * pow).filter((v) => v <= raw).pop() || pow;
  const px = nice / mpp;
  $("#scalebar .sb-bar i").style.width = `${px}px`;
  $("#scalebar .sb-text").textContent = `100 px : ${fmt.m(mpp * 100)}`;
  $("#scalebar .sb-mid").textContent = fmt.m(nice / 2);
  $("#scalebar .sb-end").textContent = fmt.m(nice);
  const zoom = ctx.cur?.view === "3d" ? (ctx.map2d.metersPerPixel() / mpp) * (ctx.map2d.cam.scale / ctx.map2d.minScale) : ctx.map2d.cam.scale / ctx.map2d.minScale;
  $("#hud-zoom").textContent = `${zoom.toFixed(1)}x`;
}

/** Sector shown dynamically from the camera centre (never a sticky quick-selection). */
export function updateSector() {
  const c = ctx.map2d.screenToLL(ctx.map2d.w / 2, ctx.map2d.h / 2);
  const focus = (ctx.region.focus || []).find((f) => f.bbox && c.lat >= f.bbox.lat_min && c.lat <= f.bbox.lat_max && c.lon >= f.bbox.lon_min && c.lon <= f.bbox.lon_max);
  let name = focus?.name;
  if (!name) {
    const near = (ctx.scenario.toponyms || []).map((t) => ({ t, d: haversine(c.lat, c.lon, t.lat, t.lon) })).sort((a, b) => a.d - b.d)[0];
    name = near ? `cerca de ${near.t.name}` : ctx.region.manifest?.name;
  }
  $("#sector-name").textContent = name || "—";
  $("#sector-meta").textContent = `(${focus ? "MC-13 Syrtis Major · " : ""}${c.lat.toFixed(3)}°N, ${c.lon.toFixed(3)}°E)`;
}

export async function reloadAssets() {
  const session = ctx.cur;
  try {
    const a = await api.assets(session?.id);
    if (ctx.cur !== session) return;
    ctx.userAssets = [...a.general, ...a.session];
  } catch { ctx.userAssets = ctx.userAssets || []; }
  ctx.entities = [
    ...entitiesFrom(ctx.scenario, ctx.userAssets),
    ...(ctx.scenario.hazards || []).map((zone) => ({ ...zone, kind: "hazard", source: "scenario", provenance: "synthetic" })),
  ];
  ctx.emit("entities", ctx.entities);
  refreshScene();
}

/** Relief lighting from the real Mars24 solar position (same az/el in 2D hillshade and 3D light).
 *  At night (sun below 5°) a declared cartographic light (NW, 35°) keeps relief legible. */
export async function applyRealSun() {
  const g = ctx.region.grid;
  try {
    const m = await api.marsTime((g.lat_min + g.lat_max) / 2, (g.lon_min + g.lon_max) / 2);
    const real = m.sun.elevation_deg > 5;
    ctx.sun = real ? { az: m.sun.azimuth_deg, el: m.sun.elevation_deg, real, ltst: m.ltst_h } : { az: 315, el: 35, real, ltst: m.ltst_h };
  } catch { ctx.sun = { az: 315, el: 35, real: false }; }
  ctx.map2d.setSun(ctx.sun.az, ctx.sun.el);
  ctx.map3d?.setSun(ctx.sun.az, ctx.sun.el);
  const h = Math.floor(ctx.sun.ltst ?? 0), mi = Math.round(((ctx.sun.ltst ?? 0) - h) * 60);
  $("#scalebar").title = ctx.sun.real ? `Relieve iluminado con el Sol real (Mars24): az ${ctx.sun.az.toFixed(0)}°, el ${ctx.sun.el.toFixed(0)}° · ${h}:${String(mi).padStart(2, "0")} LTST`
    : "Noche local: relieve con luz cartográfica declarada (NO 35°)";
}

// ------------------------------------------------------------------ boot
async function boot() {
  $("#brand").innerHTML = brandBlock("Hatun Wasi · Núcleo Khipu");
  $("#menu-btn").innerHTML = icon("menu");
  $("#planning-collapse").innerHTML = icon("collapse");
  $("#traverse-toggle").innerHTML = icon("chevron");
  $("#search-clear").innerHTML = icon("x");
  iconize();
  let regions;
  try { regions = await api.regions(); } catch { regions = null; }
  const key = regions?.default || "syrtis_jezero_nili";
  const region = await loadRegion(key, 1).catch((e) => ({ available: false, message: e.message }));
  if (!region.available) {
    const es = $("#empty-state");
    es.hidden = false;
    es.innerHTML = `<h3 style="margin-top:0">Sin datos de terreno</h3><p class="muted">${esc(region.message || "No se pudo cargar la región.")}</p>
      <p class="muted">No se inventan elevaciones. Coloca el original MOLA en <code>data/official_kickoff/raw/mola/</code> y ejecuta <code>scripts/bootstrap_data.py</code>.</p>`;
    return;
  }
  ctx.region = region;
  ctx.scenario = await loadScenario();
  ctx.layerCanvases = {};
  ctx.catalog = {};
  ctx.map2d = new Map2D($("#map2d"), region);
  ctx.map2d.on("hover", (ll) => updateHud(ll));
  ctx.map2d.on("camera", () => { updateScaleBar(); updateSector(); ctx.layerDetail?.update(); });
  ctx.layerDetail = adaptiveLayers(() => {
    const window = ctx.cur ? layerViewport(ctx.map2d, ctx.cur.view === "3d" ? ctx.map3d : null) : null;
    const layers = ctx.cur?.eyes.analyze
      ? Object.entries(ctx.cur.layers).filter(([id, layer]) => layer.visible && layer.key && ctx.catalog[id])
          .map(([id, layer]) => ({ id, key: layer.key, params: layerParams(id) }))
      : [];
    return { region: region.key, layers, window };
  }, refreshScene);
  ctx.map2d.on("click", (ll, hit, screen) => { updateHud(ll); ctx.emit("mapclick", { ll, hit, screen }); });
  if (window.innerWidth <= 600) { $("#traverses").classList.add("collapsed"); }
  const restored = await restore();
  if (!restored && window.innerWidth <= 600) ctx.cur.planningCollapsed = true;
  await reloadAssets();
  initDecks(ctx);
  initPopover(ctx);
  initTraverses(ctx);
  initPlanning(ctx);
  initMenus(ctx);

  $("#sessions").addEventListener("click", (e) => {
    const close = e.target.closest("[data-close]");
    if (close) { e.stopPropagation(); closeSession(close.dataset.close); return; }
    if (e.target.closest("#add-session")) { addSession(); return; }
    const tab = e.target.closest("[data-sid]");
    if (tab) switchSession(tab.dataset.sid);
  });
  $("#sessions").addEventListener("keydown", (e) => {
    const tab = e.target.closest("[data-sid]");
    if (!tab) return;
    if (e.key === "Enter" || e.key === " ") switchSession(tab.dataset.sid);
    if (e.key === "Delete") closeSession(tab.dataset.sid);
  });
  $("#view-2d").addEventListener("click", () => setView("2d"));
  $("#view-3d").addEventListener("click", () => setView("3d"));
  $$(".console-dock .dock-btn").forEach((b) => b.addEventListener("click", (e) => {
    const eye = e.target.closest(".eye");
    if (eye) {
      e.stopPropagation();
      const k = eye.dataset.eye;
      ctx.cur.eyes[k] = !ctx.cur.eyes[k];   // independent eyes per mode
      setMode(ctx.cur.mode);
      return;
    }
    setMode(b.dataset.mode);
  }));
  $$(".console-dock .eye").forEach((eye) => eye.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); eye.click(); } }));

  // NASA weather line (source and freshness always visible)
  api.weather().then((w) => {
    const s = w.summary;
    const t = w.status === "live" && s?.available
      ? `NASA InSight Sol ${s.sol}: ${s.temp_avg_c ?? "—"} °C | ${s.pressure_pa ?? "—"} Pa · ${w.fetched_at?.slice(0, 16)}Z`
      : `NASA InSight: ${w.status === "cached" ? "caché" : "no disponible"} (${w.status})${w.error ? " — " + w.error.slice(0, 48) : ""}`;
    $("#nasa-line").textContent = t;
    $("#nasa-line").title = `Fuente: ${w.source} · procedencia: ${w.provenance}`;
  }).catch(() => { $("#nasa-line").textContent = "NASA: sin conexión (fallback local)"; });
  api.harness().then((h) => simBanner(h.simulation)).catch(() => {});

  await applyRealSun();
  await applySession();
  updateSector();
  updateScaleBar();

  document.body.dataset.ready = "1";
}

boot().catch((e) => { console.error(e); toast(`Error al iniciar: ${e.message}`, "danger", 10000); });

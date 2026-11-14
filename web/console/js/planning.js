// Planning panel: origin/destination, waypoints, multicriteria variants, PNR, save/lock, export.
import { api, download } from "/static/shared/js/api.js";
import { fmt } from "/static/shared/js/geo.js";
import { ASSET_REGISTRY, icon } from "/static/shared/js/icons.js";
import { isMobile } from "/static/shared/js/khipu-client.js";
import { $, $$, esc, toast } from "/static/shared/js/ui.js";
import { persist, refreshScene, reloadAssets } from "./app.js";
import { activeTraverse, addTraverse, render as renderTraverses } from "./traverses.js";

let ctx;
const ORIGIN_KINDS = ["base", "habitat", "rover", "astronaut", "waypoint"];

export function initPlanning(c) {
  ctx = c;
  buildParams();
  $("#origin").addEventListener("change", () => pick("origin"));
  $("#destination").addEventListener("change", () => pick("destination"));
  ["origin", "destination"].forEach((role) => {
    [`#${role}-lat`, `#${role}-lon`].forEach((sel) => $(sel).addEventListener("change", () => coordEdit(role)));
  });
  $("#calculate").addEventListener("click", calculate);
  $("#show-direct").addEventListener("click", () => toggleRoute("showDirect", "#show-direct"));
  $("#show-calculated").addEventListener("click", () => toggleRoute("showCalc", "#show-calculated"));
  $("#save-route").addEventListener("click", saveRoute);
  $("#nearby-pois").addEventListener("click", () => ctx.decks.nearby.openFor(currentVariant()));
  $("#metrics").addEventListener("click", () => ctx.decks.metrics.openFor(activeTraverse()));
  $("#replan").addEventListener("click", replan);
  $("#delete-route").addEventListener("click", deleteRoute);
  $$("[data-export]").forEach((b) => b.addEventListener("click", () => exportRoute(b.dataset.export)));
  $("#import-route").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", importRoute);
  $("#save-project").addEventListener("click", () => { persist(); toast("Proyecto guardado (sesiones, travesías y preferencias)", "safe"); });
  $("#planning-collapse").addEventListener("click", () => collapse(true));
  $("#planning-reopen").addEventListener("click", () => collapse(false));
  $("#waypoint-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rm-wp]");
    if (!b) return;
    const t = activeTraverse();
    t.waypoints.splice(+b.dataset.rmWp, 1);
    invalidate(t, "Waypoint retirado: recalcula la ruta");
  });
  ctx.on("entities", fillSelects);
  ctx.on("session", () => { fillSelects(); syncForm(); syncToggles(); collapse(!!ctx.cur.planningCollapsed, true); });
  ctx.on("active-traverse", () => { syncForm(); refreshScene(); });
  fillSelects();
}

export const currentVariant = () => {
  const t = activeTraverse();
  return t?.result?.variants?.find((v) => v.variant === t.variant) || null;
};

function ensureTraverse() { return activeTraverse() || addTraverse(true); }

function collapse(on, silent) {
  ctx.cur.planningCollapsed = on;
  $("#planning").hidden = on;
  $("#planning-reopen").hidden = !on;
  if (!silent) persist();
}

function optionLabel(e) { return `${e.name}${e.source === "user" ? " (sesión)" : ""}`; }

function fillSelects() {
  const ents = ctx.entities || [];
  const og = ents.filter((e) => ORIGIN_KINDS.includes(e.kind));
  const dg = ents.filter((e) => e.kind !== "hazard");
  const group = (list) => {
    const by = {};
    list.forEach((e) => { (by[e.kind] ||= []).push(e); });
    return Object.entries(by).map(([k, l]) => `<optgroup label="${esc(ASSET_REGISTRY[k]?.label || k)}">${l.map((e) => `<option value="${esc(e.id)}">${esc(optionLabel(e))}</option>`).join("")}</optgroup>`).join("");
  };
  $("#origin").innerHTML = `<option value="">Selecciona el origen</option>${group(og)}<option value="__custom">Coordenadas personalizadas…</option>`;
  $("#destination").innerHTML = `<option value="">Selecciona el destino</option>${group(dg)}<option value="__custom">Coordenadas personalizadas…</option>`;
  syncForm();
}

function syncForm() {
  const t = activeTraverse();
  for (const role of ["origin", "destination"]) {
    const p = t?.[role];
    const sel = $(`#${role}`);
    sel.value = p?.id && ctx.entities.some((e) => e.id === p.id) ? p.id : p ? "__custom" : "";
    $(`#${role}-lat`).value = p ? p.lat.toFixed(5) : "";
    $(`#${role}-lon`).value = p ? p.lon.toFixed(5) : "";
  }
  $("#waypoint-list").innerHTML = (t?.waypoints || []).map((w, i) => `<div class="wp"><span>${icon("pin")} ${esc(w.name || `WP ${i + 1}`)}</span>
      <button class="btn btn-icon" style="width:22px;min-height:22px" data-rm-wp="${i}" aria-label="Quitar waypoint">${icon("x")}</button></div>`).join("");
  renderVariants();
}

function setEndpoint(role, p) {
  const t = ensureTraverse();
  t[role] = p;
  invalidate(t);
  syncForm();
}
export { setEndpoint };

function pick(role) {
  const id = $(`#${role}`).value;
  if (!id) return setEndpoint(role, null);
  if (id === "__custom") { $(`#${role}-lat`).focus(); return; }
  const e = ctx.entities.find((x) => x.id === id);
  setEndpoint(role, { id: e.id, kind: e.kind, name: e.name, lat: e.lat, lon: e.lon });
}

function coordEdit(role) {
  const lat = parseFloat($(`#${role}-lat`).value), lon = parseFloat($(`#${role}-lon`).value);
  if (!isFinite(lat) || !isFinite(lon)) return;
  if (!ctx.region.grid.contains(lat, lon)) { toast("Coordenadas fuera de la región cargada", "warn"); return; }
  setEndpoint(role, { lat, lon, name: `${lat.toFixed(4)}, ${lon.toFixed(4)}` });
}

export function addWaypointToRoute(w) {
  const t = ensureTraverse();
  t.waypoints.push({ id: w.id, lat: w.lat, lon: w.lon, name: w.name });
  invalidate(t, "Waypoint añadido a la travesía");
  syncForm();
}

/** Any geometric change discards the computed route until recalculated. */
export function invalidate(t, msg) {
  if (t.result) {
    t.result = null;
    t.status = "draft";
    if (msg) toast(msg, "warn", 2200);
  }
  t.saved = false;
  persist();
  renderTraverses();
  renderVariants();
  refreshScene();
}

function params() {
  const p = ctx.cur.params;
  return {
    max_slope_deg: p.max_slope_deg || null,
    walkback_limit_m: p.walkback_limit_m || null,
    reserve_fraction: p.reserve_fraction ?? null,
    speed_mps: p.speed_mps || null,
    weights: { hazard: p.w_hazard, context: p.w_context },
  };
}

export async function calculate() {
  const t = ensureTraverse();
  if (!t.origin || !t.destination) { toast("Selecciona origen y destino", "warn"); return; }
  const btn = $("#calculate");
  btn.disabled = true;
  btn.innerHTML = `${icon("route")} Calculando…`;
  $("#route-alert").innerHTML = "";
  const originEnt = ctx.entities.find((e) => e.id === t.origin.id);
  const body = {
    region_key: ctx.region.key, session_id: ctx.cur.id,
    origin: { lat: t.origin.lat, lon: t.origin.lon, id: t.origin.id || null, kind: t.origin.kind || null },
    destination: { lat: t.destination.lat, lon: t.destination.lon, id: t.destination.id || null },
    waypoints: t.waypoints.map((w) => ({ lat: w.lat, lon: w.lon, id: w.id })),
    asset_id: isMobile(originEnt) ? originEnt.id : null,
    profile: isMobile(originEnt) ? originEnt.kind : "rover",
    params: params(),
  };
  try {
    const res = await api.route(body);
    t.result = res;
    t.status = "calculated";
    t.variant = res.recommended || "balanced";
    t.saved = false;
    ctx.emit("route", { traverse: t, result: res });
    const v = currentVariant();
    fitRoute(v.points);
    toast(`Ruta calculada: ${fmt.m(v.metrics.distance_m)} (${v.label})`, "safe", 2500);
  } catch (e) {
    t.result = null;
    t.status = "infeasible";
    showInfeasible(e.body || { detail: e.message });
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon("route")} Calcular`;
    persist();
    renderTraverses();
    renderVariants();
    refreshScene();
  }
}

export function fitRoute(points) {
  if (!points?.length) return;
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  const pad = 0.02;
  ctx.map2d.fitBBox({ lat_min: Math.min(...lats) - pad, lat_max: Math.max(...lats) + pad, lon_min: Math.min(...lons) - pad, lon_max: Math.max(...lons) + pad });
  if (ctx.map3d && ctx.cur.view === "3d") {
    const mid = points[Math.floor(points.length / 2)];
    ctx.map3d.focusOn(mid.lat, mid.lon, Math.max(6000, (Math.max(...lats) - Math.min(...lats)) * 59000 * 2.2));
  }
}

export function showInfeasible(b) {
  const reasons = {
    destino_slope: "Destino en pendiente prohibida", destino_hazard: "Destino en zona prohibida",
    origen_hazard: "Origen en zona prohibida", walkback_exceeded: "Excede el walkback a pie",
    no_path: "Sin corredor transitable", static_asset: "Activo estático no enrutable",
    destino_outside: "Destino fuera de la región", origen_outside: "Origen fuera de la región",
  };
  $("#route-alert").innerHTML = `<div class="alert-card infeasible-card" data-reason="${esc(b.reason || "error")}">
    <strong>${icon("alert")} Ruta imposible — ${esc(reasons[b.reason] || "No factible")}</strong>
    <div style="margin-top:4px;font-size:12px">${esc(b.detail || "")}</div>
    <div style="margin-top:4px;font-size:11px;opacity:.85">Ajusta destino, umbrales o waypoints. La vida tiene prioridad sobre la ciencia.</div></div>`;
}

function renderVariants() {
  const t = activeTraverse();
  const el = $("#variants");
  if (!t?.result) { el.innerHTML = ""; if (t?.status !== "infeasible") $("#route-alert").innerHTML = ""; return; }
  const r = t.result;
  el.innerHTML = r.variants.map((v) => {
    const m = v.metrics;
    const pnr = v.pnr ? (v.pnr.show_pnr ? `<span style="color:var(--danger)">PNR</span>` : `<span style="color:var(--safe)">ida y vuelta OK</span>`) : `<span class="dim">sin métricas de activo</span>`;
    return `<button class="variant ${v.variant === t.variant ? "active" : ""}" data-variant="${v.variant}" aria-pressed="${v.variant === t.variant}">
      <b>${esc(v.label)}</b>${pnr}<small>${fmt.m(m.distance_m)} · ${fmt.dur(m.duration_s)} · riesgo ${fmt.num(m.risk_mean, 2)}</small></button>`;
  }).join("") + (r.static_origin ? `<div class="dim" style="font-size:11px">${esc(r.metrics_suppressed_reason)}</div>` : "");
  $$(".variant", el).forEach((b) => b.addEventListener("click", () => { t.variant = b.dataset.variant; persist(); renderVariants(); renderTraverses(); refreshScene(); ctx.emit("route", { traverse: t, result: r }); }));
}

function toggleRoute(key, sel) {
  ctx.cur[key] = !ctx.cur[key];
  syncToggles();
  persist();
  refreshScene();
}
function syncToggles() {
  $("#show-direct").setAttribute("aria-pressed", String(ctx.cur.showDirect));
  $("#show-calculated").setAttribute("aria-pressed", String(ctx.cur.showCalc));
}

async function saveRoute() {
  const t = activeTraverse();
  if (!t?.result) { toast("Calcula la ruta antes de guardarla", "warn"); return; }
  t.saved = true;
  // lock waypoints that belong to the saved route
  for (const w of t.waypoints) {
    const ent = ctx.entities.find((e) => e.id === w.id && e.source === "user");
    if (ent) { try { await api.patchAsset(ent.id, { locked: true }); } catch { /* ignore */ } }
  }
  await reloadAssets();
  persist();
  renderTraverses();
  toast(`${t.name} guardada; waypoints bloqueados`, "safe");
}

async function replan() {
  const t = activeTraverse();
  const v = currentVariant();
  if (!t || !v) { toast("No hay ruta que replanificar", "warn"); return; }
  const obstacles = [];
  try {
    const h = await api.harness();
    h.active.filter((a) => a.kind === "obstacle" && a.params?.lat).forEach((a) => obstacles.push({ lat: a.params.lat, lon: a.params.lon, radius_m: a.params.radius_m || 400 }));
  } catch { /* offline */ }
  const originEnt = ctx.entities.find((e) => e.id === t.origin.id);
  try {
    const res = await api.replan({ region_key: ctx.region.key, current: t.origin, destination: t.destination,
      route_points: v.points, obstacles, profile: isMobile(originEnt) ? originEnt.kind : "rover", asset_id: isMobile(originEnt) ? originEnt.id : null });
    if (!res.replanned) { toast(`Replanificación: nominal. ${res.reason}`, "safe"); return; }
    v.points = res.route_points;
    v.metrics = res.metrics;
    v.pnr = res.pnr;
    persist();
    refreshScene();
    toast(`Replanificada: ${res.reason}`, res.evasion_ok ? "safe" : "warn");
  } catch (e) { showInfeasible(e.body || { detail: e.message }); }
}

export function deleteRoute() {
  const t = activeTraverse();
  if (!t) return;
  t.result = null; t.origin = null; t.destination = null; t.waypoints = []; t.saved = false; t.status = "draft";
  $("#route-alert").innerHTML = "";
  persist();
  syncForm();
  renderTraverses();
  refreshScene();
  toast("Ruta actual eliminada", "", 1800);
}

export async function exportRoute(fmtName) {
  const t = activeTraverse();
  const v = currentVariant();
  if (!v) { toast("No hay ruta calculada para exportar", "warn"); return; }
  const route = { points: v.points, waypoints: t.waypoints, pnr: v.pnr };
  try {
    const res = await api.export(fmtName, route, t.name.replace(/\s+/g, "_"));
    download(res.filename, res.content, fmtName === "geojson" ? "application/geo+json" : "text/plain");
    toast(`Exportado ${res.filename}`, "safe");
  } catch (e) { toast(`Exportación fallida: ${e.message}`, "danger"); }
}

async function importRoute(e) {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const gj = JSON.parse(await f.text());
    const line = (gj.features || [gj]).find((x) => x.geometry?.type === "LineString");
    if (!line) throw new Error("GeoJSON sin LineString");
    const coords = line.geometry.coordinates;
    const t = addTraverse(true);
    t.name = line.properties?.name || f.name.replace(/\.\w+$/, "");
    t.origin = { lat: coords[0][1], lon: coords[0][0], name: "Inicio importado" };
    t.destination = { lat: coords.at(-1)[1], lon: coords.at(-1)[0], name: "Fin importado" };
    persist();
    syncForm();
    renderTraverses();
    toast("Ruta importada: origen y destino cargados; recalcula para validarla con Khipu", "safe", 4000);
  } catch (err) { toast(`No se pudo importar: ${err.message}`, "danger"); }
  e.target.value = "";
}

// ------------------------------------------------------------------ mission parameters
function buildParams() {
  const box = $("#mission-params .params");
  const rows = [
    ["max_slope_deg", "Pendiente máx. (°)", 8, 30, 1, "auto"],
    ["walkback_limit_m", "Walkback EVA (m)", 1000, 2000, 50],
    ["reserve_fraction", "Reserva de recursos", 0.05, 0.5, 0.05, "auto"],
    ["speed_mps", "Velocidad (m/s)", 0.1, 3, 0.05, "auto"],
    ["w_hazard", "Peso de peligro", 0, 3, 0.1],
    ["w_context", "Peso contextual", 0, 2, 0.1],
  ];
  box.innerHTML = rows.map(([k, l, mn, mx, st, auto]) => `<label for="p-${k}">${l} <b id="pv-${k}"></b></label>
    <input type="range" class="range" id="p-${k}" data-param="${k}" min="${mn}" max="${mx}" step="${st}" ${auto ? `data-auto="1"` : ""} />`).join("")
    + `<div class="reset-row"><button class="btn" id="params-reset">${icon("reset")} Valores por defecto</button></div>
       <p class="dim" style="font-size:10px;margin:6px 0 0">«auto» usa el valor del activo (rover 20°, astronauta 25°) o del modelo.</p>`;
  const sync = () => {
    const p = ctx.cur.params;
    rows.forEach(([k, , mn]) => {
      const inp = $(`#p-${k}`);
      const v = p[k];
      inp.value = v ?? mn;
      $(`#pv-${k}`).textContent = v == null ? "auto" : (k === "reserve_fraction" ? `${Math.round(v * 100)}%` : v);
    });
  };
  box.addEventListener("input", (e) => {
    const k = e.target.dataset.param;
    if (!k) return;
    ctx.cur.params[k] = parseFloat(e.target.value);
    sync();
    persist();
  });
  $("#params-reset").addEventListener("click", () => {
    Object.assign(ctx.cur.params, { max_slope_deg: null, walkback_limit_m: 2000, reserve_fraction: null, speed_mps: null, w_hazard: 1, w_context: 0.6 });
    sync();
    persist();
  });
  ctx.on("session", sync);
  sync();
}

// Planning panel: origin/destination, waypoints, multicriteria variants, PNR, save/lock, export.
import { translate } from "/static/shared/js/language.js";
import { api, download } from "/static/shared/js/api.js";
import { fmt } from "/static/shared/js/geo.js";
import { ASSET_REGISTRY, icon } from "/static/shared/js/icons.js";
import { isMobile } from "/static/shared/js/khipu-client.js";
import { $, $$, esc, toast } from "/static/shared/js/ui.js";
import { persist, refreshScene, reloadAssets } from "./app.js";
import { activeTraverse, addTraverse, render as renderTraverses } from "./traverses.js";

let ctx;


export function initPlanning(c) {
  ctx = c;
  buildParams();
  $("#origin").addEventListener("change", () => pick("origin"));
  $("#destination").addEventListener("change", () => pick("destination"));
  ["origin", "destination"].forEach((role) => {
    [`#${role}-lat`, `#${role}-lon`].forEach((sel) => $(sel).addEventListener("change", () => coordEdit(role)));
  });
  $("#calculate").addEventListener("click", calculate);
  $("#show-direct").addEventListener("click", () => toggleRoute("showDirect"));
  $("#show-calculated").addEventListener("click", () => toggleRoute("showCalc"));
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
  document.addEventListener("qn:language", fillSelects);
  ctx.on("entities", fillSelects);
  ctx.on("session", () => { fillSelects(); syncForm(); syncToggles(); collapse(!!ctx.cur.planningCollapsed, true); });
  ctx.on("active-traverse", () => { syncForm(); refreshScene(); });
  ctx.on("mode", () => collapse(!!ctx.cur.planningCollapsed, true));
  fillSelects();
}

export const currentVariant = () => {
  const t = activeTraverse();
  return t?.result?.variants?.find((v) => v.variant === t.variant) || null;
};

function selectedTraverse() {
  if (ctx.cur.mode !== "plan") return null;
  const traverse = activeTraverse();
  if (!traverse) toast("Crea una travesía antes de elegir sus puntos", "warn");
  return traverse;
}

function collapse(on, silent) {
  ctx.cur.planningCollapsed = on;
  const planning = ctx.cur.mode === "plan";
  $("#planning").hidden = !planning || on;
  $("#planning-reopen").hidden = !planning || !on;
  $("#traverses").hidden = !planning;
  if (!silent) persist();
}

function optionLabel(e) { return `${e.name}${e.source === "user" ? " (sesión)" : ""}`; }

function fillSelects() {
  const ents = ctx.entities || [];

  const group = (list) => {
    const by = {};
    list.forEach((e) => { (by[e.kind] ||= []).push(e); });
    return Object.entries(by).map(([k, l]) => `<optgroup label="${esc(ASSET_REGISTRY[k]?.label || k)}">${l.map((e) => `<option value="${esc(e.id)}">${esc(optionLabel(e))}</option>`).join("")}</optgroup>`).join("");
  };
  $("#origin").innerHTML = `<option value="">Selecciona el origen</option>${group(ents)}<option value="__custom">Coordenadas personalizadas…</option>`;
  $("#destination").innerHTML = `<option value="">Selecciona el destino</option>${group(ents)}<option value="__custom">Coordenadas personalizadas…</option>`;
  for (const role of ["origin", "destination"]) installPointPicker(role, ents);
  syncForm();
}

function installPointPicker(role, entities) {
  const select = document.getElementById(role);
  select.hidden = true;
  let picker = document.getElementById(`${role}-picker`);
  if (!picker) {
    picker = document.createElement("details");
    picker.className = "point-picker"; picker.id = `${role}-picker`;
    picker.innerHTML = `<summary class="select"></summary><div class="point-picker-body"><input class="input" type="search" placeholder="Buscar punto…" aria-label="Buscar punto"><div class="point-picker-groups"></div></div>`;
    select.after(picker);
  }
  const input = picker.querySelector("input");
  const normalize = text => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const render = () => {
    const term = normalize(input.value);
    const groups = Object.groupBy(entities.filter(e => normalize(`${translate(e.name)} ${translate(ASSET_REGISTRY[e.kind]?.label || e.kind)}`).includes(term)), e => e.kind);
    picker.querySelector(".point-picker-groups").innerHTML = Object.entries(groups).map(([kind,list]) =>
      `<details ${term ? "open" : ""}><summary>${esc(translate(ASSET_REGISTRY[kind]?.label || kind))} (${list.length})</summary>${list.map(e=>`<button type="button" class="btn" data-point="${esc(e.id)}">${esc(translate(optionLabel(e)))}</button>`).join("")}</details>`).join("")
      + `<button type="button" class="btn" data-point="__custom">${translate("Coordenadas personalizadas…")}</button>`;
    picker.querySelectorAll("[data-point]").forEach(button => button.onclick = () => {
      select.value = button.dataset.point; select.dispatchEvent(new Event("change")); picker.open = false;
    });
  };
  input.oninput = render;
  picker.ontoggle = () => { if (picker.open) render(); };
  render();
}

function syncForm() {
  const t = activeTraverse();
  $("#planning-empty").hidden = !!t;
  $("#traverse-tools").hidden = !t;
  for (const role of ["origin", "destination"]) {
    const p = t?.[role];
    const sel = $(`#${role}`);
    sel.value = p?.id && ctx.entities.some((e) => e.id === p.id) ? p.id : p ? "__custom" : "";
    const summary = document.querySelector(`#${role}-picker > summary`);
    if (summary) summary.textContent = translate(p?.name || (role === "origin" ? "Selecciona el origen" : "Selecciona el destino"));
    $(`#${role}-lat`).value = p ? p.lat.toFixed(5) : "";
    $(`#${role}-lon`).value = p ? p.lon.toFixed(5) : "";
  }
  $("#waypoint-list").innerHTML = (t?.waypoints || []).map((w, i) => `<div class="wp"><span>${icon("pin")} ${esc(w.name || `WP ${i + 1}`)}</span>
      <button class="btn btn-icon" style="width:22px;min-height:22px" data-rm-wp="${i}" aria-label="Quitar waypoint">${icon("x")}</button></div>`).join("");
  ctx.emit("planning-form");
  renderVariants();
}

function setEndpoint(role, p) {
  const t = selectedTraverse();
  if (!t) return;
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
  const t = selectedTraverse();
  if (!t) return;
  t.waypoints.push({ id: w.id, lat: w.lat, lon: w.lon, name: w.name });
  invalidate(t, "Waypoint añadido a la travesía");
  syncForm();
}

/** Any geometric change discards the computed route until recalculated. */
export function invalidate(t, msg) {
  if (t.result && msg) toast(msg, "warn", 2200);
  t.result = null;
  t.status = "draft";
  t.error = null;
  t.revision = (t.revision || 0) + 1;
  t.saved = false;
  persist();
  renderTraverses();
  renderVariants();
  refreshScene();
}

function params(t) {
  const { w_hazard = 1, w_context = 0.6, ...values } = t.params || {};
  const allowed = PARAMS.map(([key]) => key);
  return { ...Object.fromEntries(Object.entries(values).filter(([key, value]) => allowed.includes(key) && value != null)),
    weights: { hazard: w_hazard, context: w_context } };
}

export async function calculate() {
  const t = selectedTraverse();
  if (!t) return;
  if (!t.origin || !t.destination) { toast("Selecciona origen y destino", "warn"); return; }
  const session = ctx.cur;
  const revision = t.revision = (t.revision || 0) + 1;
  const btn = $("#calculate");
  btn.disabled = true;
  btn.innerHTML = icon("route") + " Calculando…";
  $("#route-alert").innerHTML = "";
  const body = { region_key: ctx.region.key, session_id: session.id,
    origin: t.origin, destination: t.destination, waypoints: t.waypoints, params: params(t) };
  const current = () => ctx.cur === session && t === activeTraverse();
  try {
    const result = await api.route(body);
    if (t.revision !== revision || !session.traverses.includes(t)) return;
    t.result = result;
    t.status = "calculated";
    t.variant = result.recommended;
    t.error = null;
    t.saved = false;
    if (current()) {
      const variant = currentVariant();
      ctx.emit("route", { traverse: t, result });
      if (ctx.cur.mode === "plan") fitRoute(variant?.points || result.direct.points);
      toast(variant ? "Travesía calculada" : "Distancia directa calculada", "safe", 2500);
    }
  } catch (e) {
    if (t.revision !== revision || !session.traverses.includes(t)) return;
    t.result = null;
    t.status = "infeasible";
    t.error = e.body || { detail: e.message };
  } finally {
    btn.disabled = false;
    btn.innerHTML = icon("route") + " Calcular";
    persist();
    if (ctx.cur === session) renderTraverses();
    if (current()) renderVariants();
    refreshScene();
  }
}

export function fitRoute(points) {
  if (!points?.length) return;
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  const pad = Math.max(0.001, (Math.max(...lats) - Math.min(...lats)) * 0.2, (Math.max(...lons) - Math.min(...lons)) * 0.2);
  ctx.map2d.fitBBox({ lat_min: Math.min(...lats) - pad, lat_max: Math.max(...lats) + pad, lon_min: Math.min(...lons) - pad, lon_max: Math.max(...lons) + pad });
  if (ctx.map3d && ctx.cur.view === "3d") {
    const mid = points[Math.floor(points.length / 2)];
    ctx.map3d.focusOn(mid.lat, mid.lon, Math.max(6000, (Math.max(...lats) - Math.min(...lats)) * 59000 * 2.2));
  }
}

export function showInfeasible(error) {
  const reasons = error.reasons || [];
  $("#route-alert").innerHTML = `<div class="alert-card infeasible-card" data-reason="${esc(error.reason || "error")}">
    <strong>${icon("alert")} Travesía inviable</strong>
    <div>${esc(error.detail || "No se pudo calcular la travesía.")}</div>
    ${reasons.length > 1 ? `<ol>${reasons.map((item) => `<li>${esc(item.role ? item.role + " · " + item.detail : item.detail)}</li>`).join("")}</ol>` : ""}</div>`;
}

function renderVariants() {
  const t = activeTraverse();
  const el = $("#variants");
  const result = t?.result;
  const measurement = result?.static_origin;
  for (const id of ["metrics", "nearby-pois", "replan", "show-calculated"]) {
    $(`#${id}`).hidden = !!measurement;
  }
  $("#mission-params").hidden = !!measurement || (!!t?.origin && !isMobile(t.origin));
  $("#save-route").disabled = !result;
  syncToggles();
  $$("[data-export]").forEach((button) => { button.disabled = !result || !!measurement; });
  if (t?.error) showInfeasible(t.error);
  else $("#route-alert").innerHTML = "";
  el.innerHTML = "";
  if (!result) return;
  if (measurement) {
    el.innerHTML = `<div class="variant"><b>Distancia euclídea</b><small>${fmt.m(result.direct.distance_m)}</small></div>`;
    return;
  }
  const route = currentVariant();
  if (!route) return;
  const pnr = route.pnr?.pnr_point;
  const uncertain = route.pnr?.classification === "INDETERMINATE";
  el.innerHTML = `<div class="variant"><b>Ruta de travesía</b>
    <small>${fmt.m(route.metrics.distance_m)} · ${fmt.dur(route.metrics.duration_s)}</small>
    <small class="${uncertain ? "state-caution" : "return-safe"}"><i></i> ${uncertain ? "Retorno no concluyente" : `Retorno con reserva${pnr ? " hasta el PNR" : " en todo el recorrido"}`}</small>
    ${pnr ? `<small class="return-limited"><i></i> Retorno no garantizado desde el PNR</small>
    <small class="mono">PNR · ${fmt.lat(pnr.lat)}, ${fmt.lon(pnr.lon)} · ${fmt.m(pnr.distance_m)} desde el origen</small>` : ""}</div>`;
}

function visible(t, key) {
  return t?.[key] ?? (key === "showDirect" && t?.result?.static_origin ? true : ctx.cur[key]);
}
function toggleRoute(key) {
  const t = activeTraverse();
  if (!t) return;
  t[key] = !visible(t, key);
  syncToggles();
  persist();
  refreshScene();
}
function syncToggles() {
  $("#show-direct").setAttribute("aria-pressed", String(visible(activeTraverse(), "showDirect")));
  $("#show-calculated").setAttribute("aria-pressed", String(visible(activeTraverse(), "showCalc")));
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
  const revision = t.revision = (t.revision || 0) + 1;
  const session = ctx.cur;
  const obstacles = [];
  try {
    const h = await api.harness();
    h.active.filter((a) => a.kind === "obstacle" && a.params?.lat).forEach((a) => obstacles.push({ lat: a.params.lat, lon: a.params.lon, radius_m: a.params.radius_m || 400 }));
  } catch { /* offline */ }
  if (t.revision !== revision || !session.traverses.includes(t)) return;
  const originEnt = ctx.entities.find((e) => e.id === t.origin.id);
  try {
    const res = await api.replan({ region_key: ctx.region.key, current: t.origin, destination: t.destination,
      route_points: v.points, obstacles, session_id: session.id, params: params(t),
      profile: isMobile(originEnt) ? originEnt.kind : "rover", asset_id: isMobile(originEnt) ? originEnt.id : null });
    if (t.revision !== revision || !session.traverses.includes(t)) return;
    if (!res.replanned) { toast(`Replanificación: nominal. ${res.reason}`, "safe"); return; }
    v.points = res.route_points;
    v.metrics = res.metrics;
    v.pnr = res.pnr;
    t.error = null;
    persist();
    renderTraverses();
    if (activeTraverse() === t) renderVariants();
    refreshScene();
    toast(`Replanificada: ${res.reason}`, res.evasion_ok ? "safe" : "warn");
  } catch (e) {
    if (t.revision !== revision || !session.traverses.includes(t)) return;
    t.result = null;
    t.error = e.body || { detail: e.message };
    t.status = "infeasible";
    persist();
    renderTraverses();
    if (activeTraverse() === t) renderVariants();
    refreshScene();
  }
}

export function deleteRoute() {
  const t = activeTraverse();
  if (!t) return;
  t.origin = null; t.destination = null; t.waypoints = [];
  invalidate(t);
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
const PARAMS = [
  ["pnr_tolerance_m", "Precisión espacial PNR (m)", 1, 2000, 1, 100],
  ["pnr_max_evaluations", "Presupuesto de evaluación PNR", 8, 512, 1, 128],
  ["max_slope_deg", "Pendiente máxima (°)", 1, 30, 0.1, null],
  ["walkback_limit_m", "Walkback EVA (m)", 1000, 4000, 1, 4000],
  ["reserve_fraction", "Reserva general (fracción)", 0, 0.8, 0.01, 0.25],
  ["reserve_o2_fraction", "Reserva de oxígeno (fracción)", 0, 0.8, 0.01, null],
  ["reserve_water_fraction", "Reserva de agua (fracción)", 0, 0.8, 0.01, null],
  ["reserve_battery_fraction", "Reserva de batería (fracción)", 0, 0.8, 0.01, null],
  ["speed_mps", "Velocidad (m/s)", 0.1, 5, 0.01, null],
  ["ltst_h", "Hora solar marciana", 0, 24, 0.1, 13],
  ["tau", "Profundidad óptica del polvo (τ)", 0, 10, 0.01, 0.5],
  ["min_temperature_c", "Temperatura mínima (°C)", -170, 80, 1, -105],
  ["max_temperature_c", "Temperatura máxima (°C)", -160, 100, 1, 45],
  ["max_dust_tau", "Polvo máximo (τ)", 0.01, 10, 0.01, 3],
  ["min_light_w_m2", "Insolación mínima (W/m²)", 0.1, 500, 0.1, 0.1],
  ["min_link_db", "Margen de enlace mínimo (dB)", -40, 40, 0.5, 0],
  ["max_blackout_s", "Corte de enlace máximo (s)", 0, 7200, 1, 900],
  ["max_distance_m", "Longitud máxima (m)", 1, 500000, 1, null],
  ["w_hazard", "Peso de peligro", 0, 3, 0.1, 1],
  ["w_context", "Peso contextual", 0, 2, 0.1, 0.6],
];

function buildParams() {
  const box = $("#mission-params .params");
  box.innerHTML = PARAMS.map(([key, label, min, max, step, fallback]) => `
    <label for="p-${key}" ${["walkback_limit_m", "reserve_o2_fraction", "reserve_water_fraction"].includes(key) ? "data-eva-only" : ""}>${label}</label>
    <div class="numeric-pair" ${["walkback_limit_m", "reserve_o2_fraction", "reserve_water_fraction"].includes(key) ? "data-eva-only" : ""}>
      <input class="range" type="range" data-param="${key}" min="${min}" max="${max}" step="${step}" aria-label="${label} (deslizador)">
      <input class="input mono" id="p-${key}" type="number" data-param="${key}" min="${min}" max="${max}" step="any" placeholder="${fallback ?? "Auto"}">
    </div>`).join("") + `
    <button class="btn" id="params-reset">${icon("reset")} Restablecer</button>
    <p class="dim small">La reserva del 25 % deja hasta el 75 % de cada recurso para la ida. Los límites sin valor usan el perfil del activo.</p>`;
  const sync = () => {
    const traverse = activeTraverse();
    const values = traverse?.params || {};
    $$("[data-eva-only]", box).forEach((el) => { el.hidden = traverse?.origin?.kind !== "astronaut"; });
    for (const [key, , min, , , fallback] of PARAMS) {
      const [slider, number] = box.querySelectorAll(`[data-param="${key}"]`);
      slider.value = values[key] ?? fallback ?? min;
      number.value = values[key] ?? fallback ?? "";
    }
  };
  box.addEventListener("change", (e) => {
    const { param } = e.target.dataset;
    const t = activeTraverse();
    if (!param || !t) return;
    if (!e.target.reportValidity()) return;
    t.params ||= {};
    if (e.target.value === "") delete t.params[param];
    else t.params[param] = e.target.valueAsNumber;
    sync();
    invalidate(t);
  });
  $("#params-reset").addEventListener("click", () => {
    const t = activeTraverse();
    if (!t) return;
    t.params = {};
    sync();
    invalidate(t);
  });
  ctx.on("planning-form", sync);
  sync();
}

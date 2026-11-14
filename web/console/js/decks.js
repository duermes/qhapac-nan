// Floating decks: layers, legend, metrics, risk inspector and nearby POIs.
import { api } from "/static/shared/js/api.js";
import { fmt, haversine } from "/static/shared/js/geo.js";
import { ASSET_REGISTRY, icon } from "/static/shared/js/icons.js";
import { layerGrid } from "/static/shared/js/khipu-client.js";
import { LEGEND_STOPS, renderLayer } from "/static/shared/js/raster.js";
import { $, $$, createDeck, esc, provBadge, toast } from "/static/shared/js/ui.js";
import { persist, refreshScene } from "./app.js";

let ctx;
const LAYER_DEFAULT_OPACITY = 0.6;

export async function initDecks(c) {
  ctx = c;
  const parent = $("#decks");
  const W = window.innerWidth, H = window.innerHeight;
  const layers = createDeck({ id: "deck-layers", title: "Capas analíticas", parent, x: 272, y: 128 });
  const legend = createDeck({ id: "deck-legend", title: "Leyenda", parent, x: W - 300, y: H - 470, width: 280 });
  const metrics = createDeck({ id: "deck-metrics", title: "Métricas de travesía", parent, x: Math.max(16, W / 2 - 260), y: Math.max(16, H / 2 - 230), cls: "metrics-deck" });
  const risk = createDeck({ id: "deck-risk", title: "Inspección de riesgo", parent, x: Math.max(280, W - 620), y: 128, width: 300, cls: "risk-deck" }); // left of the traverse rack, never over it
  const nearby = createDeck({ id: "deck-nearby", title: "POIs cercanos al corredor", parent, x: 272, y: Math.max(130, H - 440), width: 300 });
  ctx.decks = { layers, legend, metrics, risk, nearby, closeAll: () => [layers, legend, metrics, risk, nearby].forEach((d) => d.close()) };
  $("#legend-btn").addEventListener("click", () => legend.toggle());
  legend.addEventListener("deck:open", renderLegend);
  metrics.openFor = (t) => { if (ctx.cur.mode === "plan" && t?.result && !t.result.static_origin) { renderMetrics(t); metrics.open(); } };
  nearby.openFor = (v) => { if (ctx.cur.mode === "plan" && v) { nearby.variant = v; renderNearby(); nearby.open(); } };
  layers.addEventListener("deck:open", () => renderLayers());

  try {
    const res = await api.layers(ctx.region.key);
    ctx.catalog = Object.fromEntries(res.layers.map((l) => [l.id, l]));
    ctx.realtime = res.realtime;
  } catch { ctx.catalog = {}; }
  ctx.on("session", async () => { await restoreLayers(); renderLayers(); renderLegend(); });
  ctx.on("entities", () => { if (!legend.hidden) renderLegend(); });
  ctx.on("route", ({ traverse }) => { if (!metrics.hidden) renderMetrics(traverse); if (!nearby.hidden) { nearby.variant = null; renderNearby(); } });
  ctx.on("mapclick", ({ ll, hit }) => { if (ctx.cur.mode === "plan" && !hit && !ctx.cur.addMode) inspectRisk(ll); });
  await restoreLayers();
}

// ------------------------------------------------------------------ layers
const CONTROLS = {
  opacity: ["Transparencia · opacidad", 0, 1, 0.05, 0.6],
  ltst_h: ["Hora solar local (h)", 0, 24, 0.25, 13],
  tau: ["Profundidad óptica del polvo (τ)", 0, 10, 0.05, 0.5],
  alpha: ["Peso de ciencia (α)", 0, 1, 0.05, 0.5],
  max_slope_deg: ["Pendiente límite (°)", 1, 45, 0.5, 20],
  receiver_height_m: ["Altura del receptor (m)", 0.1, 20, 0.1, 2],
  link_margin_offset_db: ["Pérdida adicional del enlace (dB)", -40, 40, 0.5, 0],
  walkback_m: ["Alcance desde la base (m)", 100, 50000, 100, 2000],
  helio_au: ["Distancia al Sol (UA)", 1.3, 1.7, 0.01, 1.52],
  science_radius_scale: ["Radio de influencia científica (factor)", 0.1, 5, 0.1, 1],
  hazard_weight: ["Peso de zonas de peligro", 0, 5, 0.1, 1],
};

function layerParams(id) {
  const d = ctx.catalog[id];
  const layer = ctx.cur.layers[id];
  const params = {};
  for (const key of d.controls || []) {
    if (key === "ltst_h" && layer.realtime !== false) params.realtime = true;
    else if (layer[key] != null) params[key] = layer[key];
  }
  return params;
}

async function ensureLayer(id) {
  const L = ctx.cur.layers[id];
  const p = layerParams(id);
  const key = `${id}:${JSON.stringify(p)}`;
  L.key = key;
  if (ctx.layerCanvases[key]) return;
  const d = ctx.catalog[id];
  const res = await layerGrid(ctx.region.key, id, p);
  if (!res.available) { toast(`${d.name}: ${res.reason}`, "warn", 5000); L.visible = false; return; }
  const lo = d.range_hint?.[0], hi = d.range_hint?.[1];
  ctx.layerCanvases[key] = renderLayer(res.decoded, d.colormap, id, lo, hi);
  if (L.key !== key) return;
  L.stats = res.stats;
  L.paramsUsed = res.params;
  L.simulation = res.simulation;
}

async function restoreLayers() {
  for (const [id, L] of Object.entries(ctx.cur.layers)) if (L.visible) { try { await ensureLayer(id); } catch (e) { console.warn(e); } }
  refreshScene();
}

export async function setLayer(id, visible) {
  const s = ctx.cur;
  const d = ctx.catalog[id];
  if (!d) return;
  if (!d.available) { toast(`${d.name}: ${d.unavailable_reason}`, "warn", 6000); return; }
  const L = (s.layers[id] ||= { visible: false, opacity: LAYER_DEFAULT_OPACITY, realtime: true });
  L.visible = visible ?? !L.visible;
  if (L.visible) {
    s.activeLayer = id;
    try { await ensureLayer(id); }
    catch (error) { L.visible = false; toast(error.message, "warn"); }
  }
  else if (s.activeLayer === id) s.activeLayer = Object.keys(s.layers).find((k) => s.layers[k].visible) || null;
  persist();
  refreshScene();
  renderLayers();
  renderLegend();
}

async function updateLayerParam(id, patch) {
  const L = ctx.cur.layers[id];
  Object.assign(L, patch);
  if (L.visible && !("opacity" in patch)) {
    try { await ensureLayer(id); } catch (error) { toast(error.message, "warn"); }
  }
  persist();
  refreshScene();
  renderLayers();
}

function resetLayer(id) {
  const layer = ctx.cur.layers[id];
  for (const key of ctx.catalog[id].controls || []) delete layer[key];
  delete layer.realtime;
  updateLayerParam(id, { opacity: LAYER_DEFAULT_OPACITY, realtime: true });
  if (layer.visible) ensureLayer(id).then(() => { refreshScene(); renderLayers(); }).catch((e) => toast(e.message, "warn"));
}

export function restoreRealtime() {
  Object.entries(ctx.cur.layers).forEach(([id, layer]) => {
    if (ctx.catalog[id]?.temporal) { layer.realtime = true; delete layer.ltst_h; }
  });
  persist();
  restoreLayers().then(renderLayers);
  toast("Capas temporales restauradas a tiempo real", "safe", 2000);
}

function layerControl(def, layer, key) {
  const id = `layer-${def.id}-${key}`;
  if (key === "profile") {
    return `<label for="${id}">Perfil de movilidad</label><select id="${id}" class="select" data-param="profile">
      <option value="rover">Rover</option><option value="astronaut" ${layer.profile === "astronaut" ? "selected" : ""}>Astronauta</option></select>`;
  }
  const [label, min, max, step, fallback] = CONTROLS[key];
  const nominal = key === "walkback_m" && def.id === "survival_rover" ? 15000
    : key === "max_slope_deg" && (layer.profile === "astronaut" || def.id === "survival_astronaut") ? 25 : fallback;
  const value = layer[key] ?? (key === "ltst_h" ? ctx.realtime?.ltst_h ?? nominal : nominal);
  return `<label for="${id}">${label}${key === "ltst_h" && layer.realtime !== false ? " · tiempo real" : ""}</label>
    <div class="numeric-pair">
      <input class="range" type="range" data-param="${key}" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label} (deslizador)">
      <input class="input mono" type="number" id="${id}" data-param="${key}" min="${min}" max="${max}" step="any" value="${value}" required>
    </div>`;
}

function renderLayers() {
  const deck = ctx.decks.layers;
  if (deck.hidden) return;
  const session = ctx.cur;
  const cats = Object.groupBy(Object.values(ctx.catalog), (layer) => layer.category);
  const anyTemporal = Object.entries(session.layers).some(([id, layer]) => ctx.catalog[id]?.temporal && layer.realtime === false);
  deck.body.innerHTML = `<div class="layer-top">
      <span class="badge ${session.eyes.analyze ? "live" : "unavailable"}">${session.eyes.analyze ? "Capas habilitadas" : "Capas ocultas en el mapa"}</span>
      <button class="btn" id="rt-restore" ${anyTemporal ? "" : "disabled"}>${icon("reset")} Tiempo real</button></div>`
    + Object.entries(cats).map(([category, defs]) => `<div class="kicker layer-category">${esc(category)}</div>` + defs.map((def) => {
      const layer = session.layers[def.id] || {};
      const ramp = LEGEND_STOPS(def.colormap).join(",");
      const inputs = (def.inputs || []).map((input) => input === "Topografía MOLA" ? "NASA · MOLA" : input);
      const mixed = inputs.some((input) => ["Zonas de exclusión", "Objetivos científicos", "Base y alcance EVA",
        "Base y alcance del rover", "Antena UHF"].includes(input));
      return `<div class="layer-row" data-layer="${def.id}">
        <div class="layer-top"><span class="name">${esc(def.name)}</span>
          <button class="btn btn-icon" data-toggle="${def.id}" aria-pressed="${!!layer.visible}" aria-label="Mostrar u ocultar ${esc(def.name)}" ${def.available ? "" : "disabled"}>${icon(layer.visible ? "eye" : "eyeoff")}</button></div>
        <p class="layer-inputs" title="${mixed ? "Incluye datos del escenario sintético" : esc(def.description)}">${esc(inputs.join(" + "))}</p>
        ${layer.visible ? `<div class="legend-ramp" style="background:linear-gradient(90deg,${ramp})"></div>
          <div class="layer-meta mono"><span>${fmt.num(layer.stats?.min ?? def.range_hint?.[0], 1)}</span>
          <span>${fmt.num(layer.stats?.max ?? def.range_hint?.[1], 1)} ${esc(def.units)}</span></div>` : ""}
        ${def.available ? `<details class="layer-settings" ${layer.expanded ? "open" : ""}>
          <summary>Parámetros</summary>
          ${["opacity", ...(def.controls || [])].map((key) => layerControl(def, layer, key)).join("")}
          <button class="btn" data-reset="${def.id}">${icon("reset")} Restablecer</button>
          <p class="dim small">${esc(def.description)}${mixed ? " Incluye datos del escenario sintético." : ""}</p>
          ${layer.simulation ? '<span class="badge sim">Contingencia activa</span>' : ""}
          </details>` : `<p class="small dim">${esc(def.unavailable_reason)}</p>`}
      </div>`;
    }).join("")).join("");
  $("#rt-restore", deck.body)?.addEventListener("click", restoreRealtime);
  $$("[data-layer]", deck.body).forEach((row) => {
    const id = row.dataset.layer;
    const toggle = row.querySelector("[data-toggle]");
    toggle.addEventListener("click", () => setLayer(id));
    const options = row.querySelector("details");
    if (!options) return;
    options.addEventListener("toggle", () => {
      const layer = (session.layers[id] ||= { visible: false, opacity: LAYER_DEFAULT_OPACITY });
      if (!!layer.expanded !== options.open) { layer.expanded = options.open; persist(); }
    });
    options.addEventListener("change", (event) => {
      const input = event.target;
      const key = input.dataset.param;
      if (!key || !input.reportValidity()) return;
      const value = key === "profile" ? input.value : input.valueAsNumber;
      updateLayerParam(id, { [key]: value, ...(key === "ltst_h" ? { realtime: false } : {}) });
    });
    row.querySelector("[data-reset]").addEventListener("click", () => resetLayer(id));
  });
}

// ------------------------------------------------------------------ legend
function renderLegend() {
  const deck = ctx.decks.legend;
  if (deck.hidden) return;
  const s = ctx.cur;
  const kinds = [...new Set((ctx.entities || []).map((e) => e.kind))].filter((kind) => kind !== "hazard");
  const hidden = new Set(s.hidden);
  const visibleLayers = Object.entries(s.layers).filter(([, L]) => s.eyes.analyze && L.visible).map(([id]) => ctx.catalog[id]).filter(Boolean);
  deck.body.innerHTML = `<div class="kicker">Elementos (filtro de visibilidad)</div>`
    + kinds.map((k) => { const r = ASSET_REGISTRY[k] || ASSET_REGISTRY.waypoint; return `<div class="legend-item"><span class="sw" style="border-color:${r.color};border-radius:${["poi", "sample", "rover", "astronaut", "antenna"].includes(k) ? "50%" : "0"}"></span>
      <label for="lg-${k}">${esc(r.label)}</label><label class="switch"><input id="lg-${k}" type="checkbox" data-kind="${k}" ${hidden.has(k) ? "" : "checked"}><span class="track"></span></label></div>`; }).join("")
    + `<div class="legend-item"><span class="sw" style="border-color:var(--danger);border-style:dashed;border-radius:50%"></span><label for="lg-hazard">Zonas de exclusión (sintéticas)</label><label class="switch"><input id="lg-hazard" type="checkbox" data-kind="hazard" ${hidden.has("hazard") ? "" : "checked"}><span class="track"></span></label></div>`
    + `<hr class="joint"/><div class="kicker">Rutas</div>
      <div class="legend-item"><span class="sw" style="border-color:var(--route-direct);border-style:dashed;height:3px"></span>Ruta directa (euclídea)</div>
      <div class="legend-item"><span class="sw" style="border-color:#65d8ff;height:3px"></span>Retorno con reserva</div>
      <div class="legend-item"><span class="sw" style="border-color:#ff8c36;height:3px"></span>Retorno no garantizado</div>`
    + `<hr class="joint"/><div class="kicker">Capas visibles</div>`
    + (visibleLayers.length ? visibleLayers.map((d) => `<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;gap:6px;font-size:12px"><span>${esc(d.name)}</span>${provBadge(d.provenance)}</div>
        <div class="legend-ramp" style="background:linear-gradient(90deg,${LEGEND_STOPS(d.colormap).join(",")})"></div>
        <div class="dim" style="font-size:10px">${esc(d.units)} · ${esc(d.description)}</div></div>`).join("") : `<div class="empty-state">Relieve MOLA sombreado (derivado de NASA). Activa capas en «Analizar».</div>`)
    + `<hr class="joint"/><div class="dim" style="font-size:10px">Topografía: ${esc(ctx.region.manifest?.source?.product_id || "MOLA")} · ${esc(ctx.region.manifest?.resolution || "")}. Entidades y zonas: escenario sintético.</div>`;
  $$("[data-kind]", deck.body).forEach((i) => i.addEventListener("change", () => {
    const set = new Set(s.hidden);
    if (i.checked) set.delete(i.dataset.kind); else set.add(i.dataset.kind);
    s.hidden = [...set];
    persist();
    refreshScene();
  }));
}

// ------------------------------------------------------------------ metrics
function renderMetrics(t) {
  const deck = ctx.decks.metrics;
  if (!t?.result) {
    deck.body.innerHTML = `<div class="empty-state">${t?.status === "infeasible" ? "La travesía activa es inviable con los umbrales actuales." : "Calcula una travesía para ver métricas."}</div>`;
    return;
  }
  const r = t.result;
  if (r.static_origin || !r.variants.length) {
    deck.close();
    return;
  }
  const vs = r.variants;
  const row = (label, f) => `<tr><td>${label}</td>${vs.map((v) => `<td>${f(v)}</td>`).join("")}</tr>`;
  const res = (v, k, d = 1, u = "") => (v.asset_metrics ? `${fmt.num(v.asset_metrics.resources[k], d)} ${u}` : "—");
  const profile = r.profile;
  const resRows = r.static_origin ? "" : profile === "rover"
    ? row("Energía (Wh)", (v) => res(v, "battery_wh", 0))
    : row("O₂ (g)", (v) => (v.asset_metrics ? fmt.num(v.asset_metrics.resources.o2_kg * 1000, 0) : "—")) + row("Agua (g)", (v) => (v.asset_metrics ? fmt.num(v.asset_metrics.resources.water_kg * 1000, 0) : "—")) + row("Batería PLSS (Wh)", (v) => res(v, "battery_wh", 0));
  const sel = vs.find((v) => v.variant === t.variant) || vs[0];
  const p = sel.pnr;
  const budget = p?.resource_margins?.[p.limiting_resource];
  const pnrHtml = !p ? `<div class="dim">Métricas de rover/EVA omitidas: ${esc(r.metrics_suppressed_reason || "origen estático")}</div>`
    : `<dl class="kv pnr-eval">
        <dt>Estado</dt><dd class="${p.status === "round_trip_safe" ? "state-go" : p.status === "infeasible" ? "state-abort" : "state-caution"}">${{ round_trip_safe: "Ida y vuelta segura", pnr_exceeded: "Retorno no garantizado después del PNR", infeasible: "Inviable" }[p.status]}</dd>
        <dt>Recurso limitante</dt><dd>${esc({ o2_kg: "Oxígeno", water_kg: "Agua", battery_wh: "Batería" }[p.limiting_resource || p.resource])}</dd>
        <dt>Disponible</dt><dd>${fmt.num(budget?.available ?? p.available, 2)}</dd>
        <dt>Reserva</dt><dd>${fmt.num(budget?.reserve ?? p.reserve, 2)}</dd>
        <dt>Ida / regreso</dt><dd>${fmt.num(budget?.outbound ?? p.outbound_total, 2)} / ${fmt.num(budget?.return ?? p.return_total, 2)}</dd>
        <dt>Asimetría</dt><dd>${fmt.num(budget ? budget.return - budget.outbound : p.asymmetry, 2)}</dd>
        <dt>Margen ida y vuelta</dt><dd>${fmt.num(p.round_trip_margin, 2)}</dd>
        ${p.show_pnr && p.pnr_point ? `<dt>Punto de no retorno</dt><dd>${fmt.m(p.pnr_point.distance_m)} · ${p.pnr_point.lat.toFixed(4)}, ${p.pnr_point.lon.toFixed(4)}</dd>` : ""}
      </dl>`;
  deck.body.innerHTML = `<div class="dim" style="font-size:11px;margin-bottom:6px">${esc(t.name)} · perfil ${esc(profile)} · límite de pendiente ${fmt.num(r.slope_limit_deg, 0)}°${r.walkback_limit_m ? ` · walkback ${r.walkback_limit_m} m` : ""}</div>
    <table class="metrics-table"><thead><tr><th>Métrica</th>${vs.map((v) => `<th>${esc(v.label)}</th>`).join("")}</tr></thead><tbody>
      ${row("Distancia", (v) => fmt.m(v.metrics.distance_m))}
      ${row("Distancia euclídea", () => fmt.m(r.direct.distance_m))}
      ${row("Duración", (v) => fmt.dur(v.metrics.duration_s))}
      ${row("Ascenso / descenso", (v) => `${fmt.num(v.metrics.ascent_m, 0)} / ${fmt.num(v.metrics.descent_m, 0)} m`)}
      ${row("Pendiente máx.", (v) => `${fmt.num(v.metrics.max_grade_deg, 1)}°`)}
      ${row("Riesgo medio / máx.", (v) => `${fmt.num(v.metrics.risk_mean, 2)} / ${fmt.num(v.metrics.risk_max, 2)}`)}
      ${row("Tramos de alto riesgo", (v) => fmt.pct(100 * v.metrics.high_risk_fraction))}
      ${resRows}
      ${row("Corte de enlace más largo", (v) => fmt.dur(v.metrics.max_blackout_s))}
    </tbody></table>
    <hr class="joint"/><div class="kicker">Evaluación PNR — ${esc(sel.label)}</div>${pnrHtml}
    ${r.direct.crosses_forbidden ? `<div class="alert-card" style="margin-top:8px;font-size:12px">La ruta directa cruza zonas prohibidas; solo la calculada es viable.</div>` : ""}`;
}

// ------------------------------------------------------------------ risk inspector (planning mode only)
async function inspectRisk(ll) {
  const deck = ctx.decks.risk;
  deck.open();
  deck.body.innerHTML = `<div class="empty-state">Evaluando ${ll.lat.toFixed(4)}, ${ll.lon.toFixed(4)}…</div>`;
  const L = Object.values(ctx.cur.layers).find((x) => x.realtime === false && x.ltst_h != null);
  try {
    const r = await api.risk({ lat: ll.lat, lon: ll.lon, region_key: ctx.region.key, profile: "rover", ltst_h: L?.ltst_h });
    if (!r.inside || r.no_data) { deck.body.innerHTML = `<div class="empty-state">${esc(r.message)}</div>`; return; }
    deck.body.innerHTML = `<dl class="kv"><dt>Posición</dt><dd>${r.lat.toFixed(4)}°N ${r.lon.toFixed(4)}°E</dd><dt>Elevación</dt><dd>${fmt.num(r.elevation_m, 0)} m</dd>
      <dt>Nivel</dt><dd class="lvl-${esc(r.tier_name)}">${esc(r.tier_name)}</dd><dt>Límite (rover)</dt><dd>${r.slope_limit_deg}°</dd></dl><hr class="joint"/>
      <div class="risk-list">${r.factors.map((f) => `<div class="risk-item"><span>${esc(f.label)} ${provBadge(f.source)}</span><span class="lvl lvl-${esc(f.level)}">${esc(f.level)}</span>
        <span class="mono dim" style="grid-column:1/-1">${f.value == null ? "sin dato" : `${f.value} ${esc(f.units)}`}${f.note ? " · " + esc(f.note) : ""}</span></div>`).join("")}</div>`;
  } catch (e) { deck.body.innerHTML = `<div class="alert-card">${esc(e.message)}</div>`; }
}

// ------------------------------------------------------------------ nearby POIs
function renderNearby() {
  const deck = ctx.decks.nearby;
  const s = ctx.cur;
  const t = s.traverses.find((x) => x.id === s.activeTraverse);
  const v = deck.variant || t?.result?.variants?.find((x) => x.variant === t.variant);
  if (!v) { deck.body.innerHTML = `<div class="empty-state">Calcula una ruta para listar POIs del corredor.</div>`; return; }
  deck.filter ||= "all";
  deck.corridor ||= 3000;
  const pois = (ctx.entities || []).filter((e) => !["rover", "astronaut"].includes(e.kind));
  const step = Math.max(1, Math.floor(v.points.length / 150));
  const near = pois.map((p) => {
    let d = Infinity;
    for (let i = 0; i < v.points.length; i += step) d = Math.min(d, haversine(p.lat, p.lon, v.points[i].lat, v.points[i].lon));
    return { p, d };
  }).filter((x) => x.d <= deck.corridor && (deck.filter === "all" || (x.p.category || x.p.kind) === deck.filter)).sort((a, b) => a.d - b.d);
  const cats = ["all", "science", "sample", "base"];
  deck.body.innerHTML = `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">${cats.map((c) => `<button class="btn" data-f="${c}" aria-pressed="${deck.filter === c}" style="min-height:24px;padding:2px 8px;font-size:11px">${{ all: "Todos", science: "Ciencia", sample: "Muestras", base: "Infra." }[c]}</button>`).join("")}</div>
    <label class="label">Corredor: <b class="mono">${fmt.m(deck.corridor)}</b></label><input type="range" class="range" min="500" max="10000" step="500" value="${deck.corridor}" data-corr aria-label="Ancho de corredor">
    <div style="margin-top:6px">${near.length ? near.map(({ p, d }) => `<button class="btn" data-poi="${esc(p.id)}" style="width:100%;justify-content:space-between;margin-top:4px"><span>${esc(p.name)}</span><span class="mono dim">${fmt.m(d)}</span></button>`).join("") : '<div class="empty-state">Sin POIs dentro del corredor.</div>'}</div>`;
  $$("[data-f]", deck.body).forEach((b) => b.addEventListener("click", () => { deck.filter = b.dataset.f; renderNearby(); }));
  deck.body.querySelector("[data-corr]").addEventListener("change", (e) => { deck.corridor = +e.target.value; renderNearby(); });
  $$("[data-poi]", deck.body).forEach((b) => b.addEventListener("click", () => {
    const e = ctx.entities.find((x) => x.id === b.dataset.poi);
    ctx.map2d.focusOn(e.lat, e.lon);
    ctx.selection = e;
    refreshScene();
  }));
}

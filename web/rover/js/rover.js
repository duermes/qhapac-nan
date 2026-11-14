// Chaski — rover monitor. Uses the same Khipu planner, layers and physics as Hatun Wasi.
// Mission telemetry and map controls are independent.
import { api } from "/static/shared/js/api.js";
import { bearing, destination, fmt, haversine } from "/static/shared/js/geo.js";
import { brandBlock, icon } from "/static/shared/js/icons.js";
import { entitiesFrom, layerGrid, loadRegion, loadScenario } from "/static/shared/js/khipu-client.js";
import { Map2D } from "/static/shared/js/map2d.js";
import { LEGEND_STOPS, renderLayer } from "/static/shared/js/raster.js";
import { $, $$, esc, modal, provBadge, simBanner, toast } from "/static/shared/js/ui.js";
import { VoiceCopilot } from "/static/shared/js/voice.js";

const ROVER_ID = new URLSearchParams(location.search).get("rover") || "ROVER_PR1";
const S = {
  mode: "navigate", view: "2d", radar: false, panels: true, layer: "relief",
  speed: 0, heading: 135, lat: 0, lon: 0, battery: 1, capacity: 60000,
  route: null, target: null, telecom: null, layers: { slope: false, hazard: false, ibio: false, telecom: false },
  fsm: "GO", slip: 0, pitch: 0, roll: 0, link: null, loc: null,
};
window.chaski = S;
let region, scenario, map, map3d = null, entities = [], voice, base, catalog = {};

const MAP_LAYERS = { relief: "Relieve", slope: "Pendiente", hazard: "Riesgo", ibio: "Ciencia", telecom: "Enlace" };

function iconize() { $$("[data-icon]").forEach((el) => { el.outerHTML = icon(el.dataset.icon); }); }

async function boot() {
  $("#brand").innerHTML = brandBlock("Chaski · Núcleo Khipu");
  iconize();
  const regions = await api.regions();
  region = await loadRegion(regions.default, 1);
  if (!region.available) { toast("Sin datos de terreno: Chaski en modo vacío", "danger", 10000); return; }
  scenario = await loadScenario();
  entities = entitiesFrom(scenario);
  const rover = entities.find((e) => e.id === ROVER_ID) || entities.find((e) => e.kind === "rover");
  base = entities.find((e) => e.kind === "base");
  const definitions = await api.layers(region.key).catch(() => ({ layers: [] }));
  catalog = Object.fromEntries(definitions.layers.filter((layer) => layer.available).map((layer) => [layer.id, layer]));
  Object.assign(S, { assetId: rover.id, lat: rover.lat, lon: rover.lon, name: rover.name, heading: rover.heading_deg ?? 135, speedMax: rover.speed_mps || 1.5, capacity: rover.resources?.battery_wh || 20000 });
  try {
    const lg = await api.ledger(rover.id, "rover");
    S.battery = Math.max(0, lg.remaining / lg.capacity);
    S.capacity = lg.capacity;
  } catch { /* offline: full */ }
  S.loc = { lat: S.lat, lon: S.lon, heading_deg: S.heading, sigma_along_m: 5, sigma_cross_m: 5, odometer_m: 0 };
  $("#region-name").textContent = `${(region.focus || []).find((f) => f.key === "jezero")?.name || "Jezero"} — Relieve MOLA (NASA)`;
  map = new Map2D($("#map2d"), region, { trackUp: true, contourColor: "rgba(170,220,255,0.38)", contourMajor: "rgba(210,240,255,0.7)",  });
  S.map2d = map;
  map.hazards = scenario.hazards;
  map.toponyms = scenario.toponyms;
  map.on("click", onMapClick);
  map.on("render", drawScale);
  map.focusOn(S.lat, S.lon, map.minScale * 14);
  // telecom grid for link margin sampling (same Khipu layer as the console)
  layerGrid(region.key, "telecom", {}).then((r) => { S.telecom = r.decoded; }).catch(() => {});
  bindUI();
  voice = new VoiceCopilot({ iface: "rover", onIntent: handleIntent });
  api.harness().then((h) => simBanner(h.simulation)).catch(() => {});
  setMode("navigate");
  pickDefaultTarget();
  slowTick();
  setInterval(slowTick, 2000);
  document.body.dataset.ready = "1";
}

// ------------------------------------------------------------------ helpers
function roverEntity() {
  return { id: S.assetId, name: S.name, kind: "rover", lat: S.lat, lon: S.lon, heading: S.heading };
}
function refresh() {
  map.entities = [...entities.filter((e) => e.id !== S.assetId && (S.radar || !["poi", "sample"].includes(e.kind) || S.mode !== "navigate")), roverEntity()];
  if (S.radar) map.entities = [...entities.filter((e) => e.id !== S.assetId), roverEntity()];
  map.routes = S.route ? [{ id: "route", points: S.route.points, color: "#65d8ff", width: 4, segments: S.route.pnr?.show_pnr ? S.route.pnr.segments : null, pnr: S.route.pnr?.show_pnr ? S.route.pnr.pnr_point : null }] : [];
  const ell = S.loc?.ellipse;
  map.halos = ell ? [{ lat: S.lat, lon: S.lon, radius_m: Math.max(ell.radius_m, 30) * 6, color: "rgba(79,208,196,0.30)" }] : [];
  map.layers = Object.entries(S.layers).filter(([, on]) => on).map(([id]) => ({ id, canvas: S.layerCanvas?.[id], opacity: 0.55, visible: true, stride: 2 })).filter((l) => l.canvas);
  map.draw();
  if (map3d && S.view === "3d") {
    map3d.setRoutes(map.routes);
    map3d.setMarkers(map.entities);

  }
}

function sampleTelecom(lat, lon) {
  const g = S.telecom;
  if (!g) return null;
  const { r, c } = region.grid.toRC(lat, lon);
  const v = g.data[Math.round(r / g.stride) * g.cols + Math.round(c / g.stride)];
  return isFinite(v) ? v : null;
}

function terrainAttitude() {
  // pitch along heading, roll across (from the DEM, 300 m baseline: MOLA 463 m/px)
  const d = 300;
  const f = destination(S.lat, S.lon, S.heading, d), b = destination(S.lat, S.lon, S.heading + 180, d);
  const r = destination(S.lat, S.lon, S.heading + 90, d), l = destination(S.lat, S.lon, S.heading - 90, d);
  const e = (p) => region.elevationAt(p.lat, p.lon) ?? 0;
  const pitch = Math.atan((e(f) - e(b)) / (2 * d)) * 180 / Math.PI;
  const roll = Math.atan((e(r) - e(l)) / (2 * d)) * 180 / Math.PI;
  return { pitch, roll };
}

// ------------------------------------------------------------------ simulation loop
async function slowTick() {
  if (S.polling) return;
  S.polling = true;
  try {
    const { pitch, roll } = terrainAttitude();
    S.pitch = pitch; S.roll = roll;
    const [ledger, traction, harness] = await Promise.allSettled([
      api.ledger(S.assetId, "rover"), api.traction(Math.abs(pitch), roll), api.harness(),
    ]);
    const previous = S.battery;
    if (ledger.status === "fulfilled") {
      S.capacity = ledger.value.capacity;
      S.battery = Math.max(0, ledger.value.remaining / S.capacity);
    }
    if (traction.status === "fulfilled") {
      const t = traction.value;
      S.slip = t.slip; S.tractionState = t.state; S.tipover = t.tipover_risk;
    }
    const active = harness.status === "fulfilled" ? harness.value.active : [];
    if (harness.status === "fulfilled") simBanner(harness.value.simulation);
    const signature = JSON.stringify(active.map(({ id, t }) => [id, t]));
    if (S.telecomSignature !== signature) {
      S.telecom = (await layerGrid(region.key, "telecom", {}).catch(() => null))?.decoded;
    }
    S.link = sampleTelecom(S.lat, S.lon);
    const status = await api.fsm({ battery_pct: S.battery * 100, link_margin_db: S.link,
      slope_deg: Math.abs(pitch), emergency_stop: false, pnr_exceeded: !!S.pastPnr }).catch(() => null);
    if (status) { S.fsm = status.state; S.fsmReasons = status.reasons; }
    if (S.target && !S.planning && (S.telecomSignature !== signature || previous !== S.battery)) {
      await planTo(S.target, { silent: true });
    }
    S.telecomSignature = signature;
    updatePanels();
    refresh();
  } finally {
    S.polling = false;
  }
}

function updatePanels() {
  $("#speed").textContent = (Math.abs(S.speed) * 3.6).toFixed(1);
  $("#heading").textContent = `${S.heading.toFixed(0)}°`;
  $("#compass-val").textContent = `${S.heading.toFixed(0)}°`;
  const tape = $("#compass-tape");
  const marks = [["N", 0], ["NE", 45], ["E", 90], ["SE", 135], ["S", 180], ["SO", 225], ["O", 270], ["NO", 315]];
  tape.innerHTML = marks.map(([l, a]) => { const d = ((a - S.heading + 540) % 360) - 180; return Math.abs(d) < 60 ? `<span style="left:${50 + d / 60 * 50}%">${l}</span>` : ""; }).join("");
  $("#battery").textContent = fmt.pct(S.battery * 100);
  $("#battery-bar").style.width = `${S.battery * 100}%`;
  $("#battery-bar").style.background = S.battery < 0.2 ? "var(--danger)" : S.battery < 0.35 ? "var(--warn)" : "var(--gold)";
  const dBase = S.dBase ?? (base ? haversine(S.lat, S.lon, base.lat, base.lon) : null);
  if (dBase != null) {
    const min = dBase / 0.9 / 60;                  // walking time home if the rover fails
    $("#walkback").textContent = `${min.toFixed(0)} min`;
    $("#walkback").style.color = dBase > 2000 ? "var(--danger)" : dBase > 1600 ? "var(--warn)" : "";
    $("#walkback-dist").textContent = `${fmt.m(dBase)} a base${dBase > 2000 ? " · fuera de límite a pie" : ""}`;
  }
  $("#link").textContent = S.link == null ? "sin dato" : `${S.link.toFixed(1)} dB`;
  $("#link").style.color = S.link != null && S.link < 0 ? "var(--danger)" : "";
  const z = $("#zone");
  z.className = `tile zone ${S.fsm === "CAUTION" ? "caution" : S.fsm === "ABORT" ? "abort" : ""}`;
  z.firstElementChild.textContent = S.fsm === "GO" ? "ZONA SEGURA" : S.fsm === "CAUTION" ? "PRECAUCIÓN" : "ABORTAR";
  $("#fsm").textContent = `[${S.fsm}]`;
  z.title = (S.fsmReasons || []).join(", ");
  const sgn = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}°`;
  $("#pitch").textContent = sgn(S.pitch); $("#pitch").style.color = Math.abs(S.pitch) > 15 ? "var(--danger)" : "var(--gold)";
  $("#roll").textContent = sgn(S.roll); $("#roll").style.color = Math.abs(S.roll) > 12 ? "var(--danger)" : "var(--safe)";
  $("#pitch-bar").style.width = `${Math.min(100, Math.abs(S.pitch) / 20 * 100)}%`;
  $("#roll-bar").style.width = `${Math.min(100, Math.abs(S.roll) / 20 * 100)}%`;
  $("#slip").textContent = `${(S.slip * 100).toFixed(0)}%`;
  const ts = $("#traction-state");
  ts.textContent = S.tractionState || "—";
  ts.className = `badge ${S.slip > 0.3 ? "danger" : S.slip > 0.15 ? "synthetic" : "live"}`;
  const ell = S.loc?.ellipse;
  $("#loc-line").textContent = ell ? `Localización: odometría ±${ell.radius_m.toFixed(0)} m (95%)${S.loc?.last_fix ? " · última fijación absoluta" : ""}` : "Localización: —";
  const { r, c } = region.grid.toRC(S.lat, S.lon);
  $("#rv-pos").textContent = `${S.lat.toFixed(4)}°N, ${S.lon.toFixed(4)}°E`;
  $("#rv-cell").textContent = `[${Math.round(c)}, ${Math.round(r)}]`;
  const el = region.elevationAt(S.lat, S.lon), sl = region.slopeAt(S.lat, S.lon);
  $("#rv-elev").textContent = `Elev: ${el == null ? "—" : el.toFixed(0) + " m"} | Pendiente: ${sl == null ? "—" : sl.toFixed(1) + "°"}`;
  updateGuide();
}

function updateGuide() {
  const t = S.target;
  if (!t) {
    $("#meta-dist").textContent = "—"; $("#meta-brg").textContent = ""; $("#meta-corridor").textContent = "SIN OBJETIVO"; $("#meta-eta").textContent = "ETA: —";
    return;
  }
  const d = haversine(S.lat, S.lon, t.lat, t.lon);
  const brg = bearing(S.lat, S.lon, t.lat, t.lon);
  $("#meta-dist").textContent = fmt.m(d);
  $("#meta-brg").textContent = `[${brg.toFixed(0)}°]`;
  $("#nav-dial").querySelector("svg").style.transform = `rotate(${brg - S.heading - 45}deg)`;
  let corridor = null, nextIdx = 0, remaining = d;
  if (S.route?.points?.length) {
    const pts = S.route.points;
    let best = Infinity;
    pts.forEach((p, i) => { const dd = haversine(S.lat, S.lon, p.lat, p.lon); if (dd < best) { best = dd; nextIdx = i; } });
    corridor = best;
    remaining = (pts.at(-1).distance_m - pts[nextIdx].distance_m) + best;
    S.pastPnr = S.route.pnr?.pnr_index != null && nextIdx > S.route.pnr.pnr_index;
    const ahead = pts[Math.min(pts.length - 1, nextIdx + 4)];
    const turn = ((bearing(S.lat, S.lon, ahead.lat, ahead.lon) - S.heading + 540) % 360) - 180;
    const dirTxt = Math.abs(turn) < 10 ? "Seguir recto" : `Girar ${Math.abs(turn).toFixed(0)}° a la ${turn > 0 ? "derecha" : "izquierda"}`;
    $("#guide-step").textContent = `En ${fmt.m(haversine(S.lat, S.lon, ahead.lat, ahead.lon))}: ${dirTxt}`;
    $("#turn-icon").innerHTML = icon(Math.abs(turn) < 10 ? "arrowup" : turn > 0 ? "turnright" : "arrowleft");
    $("#guide-sub").innerHTML = `Rumbo ${brg.toFixed(0)}° hacia ${esc(t.name)} ${S.routeStatus ? `· <span class="gold">${esc(S.routeStatus)}</span>` : ""}`;
  } else {
    $("#guide-step").textContent = `Rumbo ${brg.toFixed(0)}° directo`;
    $("#guide-sub").textContent = S.routeError?.detail || t.name;
  }
  $("#meta-corridor").textContent = corridor == null ? "FUERA DE RUTA" : `EN CORREDOR: ${fmt.m(corridor)}`;
  $("#meta-corridor").className = corridor != null && corridor < 600 ? "green" : "gold";
  $("#meta-eta").textContent = S.route ? `ETA: ${fmt.dur(S.route.metrics.duration_s)}` : "ETA: —";
  $("#g-next").textContent = fmt.m(remaining);
  $("#g-eta").textContent = $("#meta-eta").textContent;
  $("#g-total").textContent = `Total: ${S.route ? fmt.m(S.route.metrics.distance_m) : fmt.m(d)}`;
}

// ------------------------------------------------------------------ actions
async function planTo(target, { silent } = {}) {
  const revision = S.planRevision = (S.planRevision || 0) + 1;
  S.target = target;
  S.planning = true;
  try {
    const res = await api.route({ region_key: region.key,
      origin: { lat: S.lat, lon: S.lon, id: S.assetId, kind: "rover" },
      destination: { lat: target.lat, lon: target.lon, id: target.id || null } });
    if (revision !== S.planRevision) return null;
    const route = res.variants[0];
    S.route = route;
    S.routeError = null;
    S.routeStatus = route.pnr?.show_pnr ? "Retorno no garantizado después del PNR" : "Retorno con reserva";
    if (!silent) toast(`Ruta a ${target.name} · ${fmt.m(route.metrics.distance_m)}`, "safe");
    return route;
  } catch (error) {
    if (revision !== S.planRevision) return null;
    S.route = null;
    S.routeError = error.body || { detail: error.message };
    const reasons = (S.routeError.reasons || []).map(({ detail }) => `<li>${esc(detail)}</li>`);
    if (!silent || $("#inspect-title").textContent.startsWith("Ruta")) {
      showInspect("Ruta inviable", `<div class="alert-card infeasible-card">${esc(S.routeError.detail)}${reasons.length > 1 ? `<ol>${reasons.join("")}</ol>` : ""}</div>`);
    }
    return null;
  } finally {
    if (revision === S.planRevision) {
      S.planning = false;
      updateGuide();
      refresh();
    }
  }
}

function pickDefaultTarget() {
  const sci = entities.filter((e) => ["poi", "sample"].includes(e.kind)).map((e) => ({ e, d: haversine(S.lat, S.lon, e.lat, e.lon) })).filter((x) => x.d > 800).sort((a, b) => a.d - b.d)[0];
  if (sci) { S.target = { id: sci.e.id, name: sci.e.name, lat: sci.e.lat, lon: sci.e.lon }; planTo(S.target, { silent: true }); }
}

async function safeReturn() {
  if (base) await onMapClick(base, base, true);
}

function setMode(m) {
  S.mode = m;
  $$(".rover-dock .dock-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  if (m === "plan") toast("Planificar: haz clic en el mapa o en un POI para trazar ruta rápida", "", 3000);
  refresh();
}

async function onMapClick(ll, hit, force = false) {
  if (S.mode === "plan" || force === true) {
    const target = hit ? { id: hit.id, name: hit.name, lat: hit.lat, lon: hit.lon } : { name: `${ll.lat.toFixed(4)}, ${ll.lon.toFixed(4)}`, lat: ll.lat, lon: ll.lon };
    const v = await planTo(target);
    if (v) {
      const pnr = v.pnr?.pnr_point;
      showInspect(`Ruta a ${target.name}`, `<dl class="kv"><dt>Distancia</dt><dd>${fmt.m(v.metrics.distance_m)}</dd>
        <dt>Duración</dt><dd>${fmt.dur(v.metrics.duration_s)}</dd><dt>Energía</dt><dd>${fmt.num(v.metrics.resources.battery_wh, 0)} Wh</dd>
        <dt>Retorno</dt><dd>${esc(S.routeStatus)}</dd>
        ${pnr ? `<dt>PNR</dt><dd>${fmt.lat(pnr.lat)}, ${fmt.lon(pnr.lon)} · ${fmt.m(pnr.distance_m)}</dd>` : ""}</dl>`);
    }
    return;
  }
  if (hit) { inspectEntity(hit); return; }
  if (S.mode === "recon") {
    const r = await api.risk({ lat: ll.lat, lon: ll.lon, region_key: region.key, profile: "rover" }).catch(() => null);
    if (r?.inside) showInspect("Zona inspeccionada", `<dl class="kv"><dt>Elevación</dt><dd>${fmt.num(r.elevation_m, 0)} m</dd><dt>Nivel</dt><dd>${esc(r.tier_name)}</dd></dl><hr class="joint"/>`
      + r.factors.map((f) => `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span>${esc(f.label)}</span><span class="mono">${f.value ?? "—"} ${esc(f.units)} · ${esc(f.level)}</span></div>`).join(""));
  }
}

function inspectEntity(e) {
  const d = haversine(S.lat, S.lon, e.lat, e.lon);
  showInspect(e.name, `<div class="kicker">${esc(e.kind)} ${provBadge(e.provenance || "synthetic")}</div>${e.description ? `<p style="font-size:12px">${esc(e.description)}</p>` : ""}
    <dl class="kv"><dt>Distancia</dt><dd>${fmt.m(d)}</dd><dt>Rumbo</dt><dd>${bearing(S.lat, S.lon, e.lat, e.lon).toFixed(0)}°</dd><dt>Elevación</dt><dd>${fmt.num(region.elevationAt(e.lat, e.lon), 0)} m</dd></dl>
    <button class="btn btn-gold" id="plan-here" style="width:100%;margin-top:8px">Trazar ruta rápida</button>`);
  $("#plan-here").addEventListener("click", () => planTo({ id: e.id, name: e.name, lat: e.lat, lon: e.lon }));
}

function showInspect(title, html) {
  if (!S.panels) $("#panels-toggle").click();
  $("#inspect-card").hidden = false;
  $("#inspect-title").textContent = title;
  $("#inspect-body").innerHTML = html;
}

async function toggleLayer(id, on) {
  S.layers[id] = on;
  S.layerCanvas ||= {};
  if (on && !S.layerCanvas[id]) {
    const r = await layerGrid(region.key, id, {});
    if (!r.available) { toast(r.reason, "warn"); S.layers[id] = false; return; }
    S.layerCanvas[id] = renderLayer(r.decoded, r.layer.colormap, id, r.layer.range_hint?.[0], r.layer.range_hint?.[1]);
    (S.layerMeta ||= {})[id] = { name: r.layer.name, units: r.layer.units, colormap: r.layer.colormap, provenance: r.provenance,
      lo: r.layer.range_hint?.[0] ?? r.stats.min, hi: r.layer.range_hint?.[1] ?? r.stats.max };
  }
  refresh();
  renderLegend();
}

async function setView(v) {
  S.view = v;
  $("#view-label").textContent = v === "2d" ? "2D" : "3D";
  $("#view-toggle").setAttribute("aria-pressed", String(v === "3d"));
  $("#map2d").hidden = v !== "2d";
  $("#map3d").hidden = v !== "3d";
  if (v === "3d" && !map3d) {
    try {
      const { Map3D } = await import("/static/shared/js/map3d.js");
      map3d = new Map3D($("#map3d"), region, { exaggeration: 4 });
      map3d.setHazards(scenario.hazards);
      map3d.on("click", onMapClick);
      map3d.drape(map.base);
      map3d.focusOn(S.lat, S.lon, 9000);
    } catch (e) { toast("WebGL no disponible", "warn"); return setView("2d"); }
  }
  if (v === "3d") { map3d.resize(); await selectLayer(S.layer); }
  refresh();
}

function drawScale() {
  const sb = map.scaleBar(60);
  $("#scale").textContent = `${fmt.m(sb.meters)} ≈ ${sb.px.toFixed(0)} px`;
}

function handleIntent(r) {
  if (r.intent === "set_mode") setMode(r.mode);
  if (r.intent === "emergency_stop") toast("Emergencia: contacta al operador del rover", "danger");
  if (r.intent === "safe_return") safeReturn();
  if (r.intent === "select_layer") {
    if (catalog[r.layer_id] || MAP_LAYERS[r.layer_id]) selectLayer(r.layer_id);
    else toast("Capa sin datos disponibles", "warn");
  }
  if (r.intent === "poi_info") { const e = entities.find((x) => x.id === r.poi_id); if (e) inspectEntity(e); }
  if (r.intent === "status") toast(`Batería ${fmt.pct(S.battery * 100)} · enlace ${S.link?.toFixed(1) ?? "—"} dB · estado ${S.fsm}`, "", 5000);
  if (r.intent === "filter_pois") { S.radar = r.category !== "all" || true; $("#science-radar").setAttribute("aria-pressed", "true"); refresh(); }
}

function renderLegend() {
  let el = $("#rover-legend");
  const on = Object.entries(S.layers).filter(([id, v]) => v && S.layerMeta?.[id]);
  if (!on.length || !S.panels) { el?.remove(); return; }
  if (!el) { el = document.createElement("div"); el.id = "rover-legend"; el.className = "panel rover-legend"; el.setAttribute("aria-label", "Leyenda de capas"); document.body.appendChild(el); }
  el.innerHTML = `<div class="kicker">Leyenda</div>` + on.map(([id]) => { const m = S.layerMeta[id]; return `<div class="small" style="margin-top:6px;display:flex;justify-content:space-between;gap:6px"><span>${esc(m.name)}</span>${provBadge(m.provenance)}</div>
    <div style="height:7px;margin:3px 0;background:linear-gradient(90deg,${LEGEND_STOPS(m.colormap).join(",")})"></div>
    <div class="small mono dim" style="display:flex;justify-content:space-between"><span>${fmt.num(m.lo, 1)}</span><span>${fmt.num(m.hi, 1)} ${esc(m.units)}</span></div>`; }).join("")
    + `<div class="small dim" style="margin-top:6px">Curvas de nivel: MOLA (derivado NASA) · Zonas: escenario sintético</div>`;
}

async function selectLayer(id) {
  S.layer = id;
  $("#map-layer-label").textContent = MAP_LAYERS[id] || catalog[id]?.name || id;
  for (const key of Object.keys(S.layers)) S.layers[key] = false;
  try {
    if (id !== "relief") await toggleLayer(id, true);
    else { refresh(); renderLegend(); }
    if (S.layer !== id) return;
    if (map3d) {
      const canvas = document.createElement("canvas");
      canvas.width = map.base.width; canvas.height = map.base.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(map.base, 0, 0);
      if (S.layerCanvas?.[id]) {
        ctx.globalAlpha = 0.55;
        ctx.drawImage(S.layerCanvas[id], 0, 0, canvas.width, canvas.height);
      }
      map3d.drape(canvas);
    }
  } catch (e) {
    if (S.layer === id) { toast(e.message, "warn"); selectLayer("relief"); }
  }
}

function moveCamera(direction) {
  if (direction === "center") {
    map.focusOn(S.lat, S.lon);
    if (map3d) map3d.focusOn(S.lat, S.lon, map3d.camera.position.distanceTo(map3d.controls.target));
    return;
  }
  const offset = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[direction];
  const factor = direction === "in" ? 1.35 : 1 / 1.35;
  if (S.view === "3d" && map3d) {
    const { camera, controls } = map3d;
    if (!offset) {
      const relative = camera.position.clone().sub(controls.target);
      relative.setLength(Math.max(controls.minDistance, Math.min(controls.maxDistance, relative.length() / factor)));
      camera.position.copy(controls.target).add(relative);
    } else {
      const metres = map3d.metersPerPixel() * 78;
      const right = camera.position.clone().setFromMatrixColumn(camera.matrix, 0).setY(0).normalize();
      const down = right.clone().set(-right.z, 0, right.x);
      const delta = right.multiplyScalar(offset[0] * metres).addScaledVector(down, offset[1] * metres);
      controls.target.add(delta); camera.position.add(delta);
    }
    controls.update();
  } else if (offset) {
    const { row, col } = map.toGrid(map.w / 2 + 78 * offset[0], map.h / 2 + 78 * offset[1]);
    map.cam.cx = col; map.cam.cy = row;
    map.clampCam(); map.draw();
  } else map.zoomAt(factor);
}

function demoDialog() {
  const body = document.createElement("div");
  const draw = async () => {
    const h = await api.harness();
    body.innerHTML = `<p class="muted">Inyecta contingencias de entrenamiento para revisar el mapa y el corredor de Khipu.</p>
      <div class="btn-row" style="margin-top:10px">${Object.entries(h.available).map(([k, v]) => `<button class="btn" data-inj="${k}">${esc(v.label)}</button>`).join("")}</div>
      <button class="btn" id="abs-fix" style="width:100%;margin-top:8px">Fijación absoluta (orbital)</button>
      <div class="kicker" style="margin-top:10px">Activas</div>${h.active.map((a) => `<div><span class="badge sim">SIM</span> ${esc(a.label)}</div>`).join("") || '<div class="empty-state">Ninguna</div>'}
      <button class="btn btn-danger" id="clr" style="margin-top:8px">Limpiar</button>`;
    $$("[data-inj]", body).forEach((b) => b.addEventListener("click", async () => {
      let params = {};
      if (b.dataset.inj === "obstacle" && S.route) { const p = S.route.points[Math.min(S.route.points.length - 1, Math.floor(S.route.points.length / 2))]; params = { lat: p.lat, lon: p.lon, radius_m: 700 }; }
      await api.inject(b.dataset.inj, params); simBanner(true); slowTick(); draw();
    }));
    body.querySelector("#abs-fix").addEventListener("click", async () => {
      const r = await api.localization({ state: S.loc, fix: { lat: S.lat, lon: S.lon, sigma_m: 3 } });
      S.loc = { ...r.state, ellipse: r.ellipse, last_fix: r.last_fix };
      toast("Fijación absoluta aplicada: incertidumbre contraída", "safe");
    });
    body.querySelector("#clr").addEventListener("click", async () => { await api.clearHarness(); simBanner(false); slowTick(); draw(); });
  };
  draw();
  modal({ title: "Demo / configuración (SIMULACIÓN)", body });
}

function bindUI() {
  $$(".rover-dock .dock-btn").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#science-radar").addEventListener("click", () => { S.radar = !S.radar; $("#science-radar").setAttribute("aria-pressed", String(S.radar)); refresh(); });
  $("#safe-return").addEventListener("click", safeReturn);
  $("#voice").addEventListener("click", () => voice.start());
  $("#inspect-close").addEventListener("click", () => { $("#inspect-card").hidden = true; });
  $("#view-toggle").addEventListener("click", () => setView(S.view === "2d" ? "3d" : "2d"));
  $("#demo-btn").addEventListener("click", demoDialog);
  $("#map-menu-btn").addEventListener("click", () => {
    const order = Object.keys(MAP_LAYERS);
    selectLayer(order[(order.indexOf(S.layer) + 1) % order.length]);
  });
  const panelButton = $("#panels-toggle");
  const panels = (open) => {
    S.panels = open;
    $$("[data-window]").forEach((el) => { el.hidden = !open; });
    panelButton.setAttribute("aria-expanded", String(open));
    renderLegend();
  };
  panelButton.addEventListener("click", () => panels(!S.panels));
  panels(window.innerWidth > 700);
  $(".camera-controls").open = window.innerWidth > 700;
  $("#dpad").addEventListener("click", (event) => {
    const direction = event.target.closest("[data-dir]")?.dataset.dir;
    if (direction) moveCamera(direction);
  });
  const keymap = { w: "up", arrowup: "up", s: "down", arrowdown: "down", a: "left", arrowleft: "left", d: "right", arrowright: "right" };
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea")) return;
    const k = e.key.toLowerCase();
    if (keymap[k]) { e.preventDefault(); moveCamera(keymap[k]); }
    if (["+", "=", "-", "c"].includes(k)) moveCamera(k === "c" ? "center" : k === "-" ? "out" : "in");
    if (k === "v") setView(S.view === "2d" ? "3d" : "2d");
    if (k === "1") setMode("navigate");
    if (k === "2") setMode("recon");
    if (k === "3") setMode("plan");
    if (k === "k") voice.start();
  });
}

boot().catch((e) => { console.error(e); toast(`Error: ${e.message}`, "danger", 10000); });

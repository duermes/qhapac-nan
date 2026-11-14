// Chaski — rover monitor. Uses the same Khipu planner, layers and physics as Hatun Wasi.
// Rover motion is a kinematic SIMULATION over real MOLA terrain (labelled as such).
import { api } from "/static/shared/js/api.js";
import { bearing, destination, fmt, haversine } from "/static/shared/js/geo.js";
import { brandBlock, icon } from "/static/shared/js/icons.js";
import { entitiesFrom, layerGrid, loadRegion, loadScenario } from "/static/shared/js/khipu-client.js";
import { Map2D } from "/static/shared/js/map2d.js";
import { LEGEND_STOPS, renderLayer } from "/static/shared/js/raster.js";
import { $, $$, esc, modal, onClickOutside, provBadge, simBanner, toast } from "/static/shared/js/ui.js";
import { VoiceCopilot } from "/static/shared/js/voice.js";

const ROVER_ID = new URLSearchParams(location.search).get("rover") || "ROVER_PR1";
const S = {
  mode: "navigate", view: "2d", autopilot: false, estop: false, radar: false,
  speed: 0, heading: 135, lat: 0, lon: 0, battery: 1, capacity: 60000, odo: 0,
  route: null, target: null, telecom: null, layers: { slope: false, hazard: false, ibio: false, telecom: false },
  fsm: "GO", slip: 0, pitch: 0, roll: 0, link: null, loc: null, simRate: 10, keys: new Set(), lastReplan: 0,
};
window.chaski = S;
let region, scenario, map, map3d = null, entities = [], voice, base;

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
  Object.assign(S, { lat: rover.lat, lon: rover.lon, name: rover.name, speedMax: rover.speed_mps || 1.5, capacity: rover.resources?.battery_wh || 20000 });
  try {
    const lg = await api.ledger(rover.id, "rover");
    S.battery = Math.max(0, lg.remaining / lg.capacity);
    S.capacity = lg.capacity;
  } catch { /* offline: full */ }
  S.loc = { lat: S.lat, lon: S.lon, heading_deg: S.heading, sigma_along_m: 5, sigma_cross_m: 5, odometer_m: 0 };
  $("#region-name").textContent = `${(region.focus || []).find((f) => f.key === "jezero")?.name || "Jezero"} — Relieve MOLA (NASA)`;
  map = new Map2D($("#map2d"), region, { trackUp: true, contourColor: "rgba(170,220,255,0.38)", contourMajor: "rgba(210,240,255,0.7)", maxScale: 60 });
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
  setInterval(tick, 200);
  setInterval(slowTick, 2000);
  document.body.dataset.ready = "1";
}

// ------------------------------------------------------------------ helpers
function roverEntity() {
  return { id: ROVER_ID, name: S.name, kind: "rover", lat: S.lat, lon: S.lon, heading: S.heading };
}
function refresh() {
  map.entities = [...entities.filter((e) => e.id !== ROVER_ID && (S.radar || !["poi", "sample"].includes(e.kind) || S.mode !== "navigate")), roverEntity()];
  if (S.radar) map.entities = [...entities.filter((e) => e.id !== ROVER_ID), roverEntity()];
  map.routes = S.route ? [{ id: "route", points: S.route.points, color: "#f0a24b", width: 4, segments: S.route.pnr?.show_pnr ? S.route.pnr.segments : null, pnr: S.route.pnr?.show_pnr ? S.route.pnr.pnr_point : null }] : [];
  const ell = S.loc?.ellipse;
  map.halos = ell ? [{ lat: S.lat, lon: S.lon, radius_m: Math.max(ell.radius_m, 30) * 6, color: "rgba(79,208,196,0.30)" }] : [];
  map.layers = Object.entries(S.layers).filter(([, on]) => on).map(([id]) => ({ id, canvas: S.layerCanvas?.[id], opacity: 0.55, visible: true, stride: 2 })).filter((l) => l.canvas);
  if (S.mode === "navigate") {
    map.cam.rot = -S.heading * Math.PI / 180;     // track-up: rover heading points to screen top
    const { r, c } = region.grid.toRC(S.lat, S.lon);
    map.cam.cx = c + 0.5; map.cam.cy = r + 0.5;   // locked, rover-centred
  }
  map.draw();
  if (map3d && S.view === "3d") {
    map3d.setRoutes(map.routes);
    map3d.setMarkers(map.entities);
    const p = map3d.toWorld(S.lat, S.lon, 60);
    map3d.controls.target.copy(p);
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
function tick() {
  const dt = 0.2 * S.simRate;
  let throttle = 0, steer = 0;
  if (!S.estop) {
    if (S.keys.has("up")) throttle = 1;
    if (S.keys.has("down")) throttle = -0.4;
    if (S.keys.has("left")) steer = -1;
    if (S.keys.has("right")) steer = 1;
    if (S.autopilot && S.apCmd) {
      if (S.apCmd.state === "TRACKING") { throttle = S.apCmd.speed_mps / S.speedMax; steer = Math.max(-1, Math.min(1, S.apCmd.steer_deg / 20)); }
      if (S.apCmd.state === "ARRIVED") { setAutopilot(false); toast("Objetivo alcanzado", "safe"); }
      if (S.apCmd.state === "HOLD") throttle = 0;
    }
  }
  const slope = Math.abs(S.pitch);
  const vmax = S.speedMax * Math.max(0.3, 1 - slope / 25) * (1 - S.slip);
  const target = throttle * vmax;
  S.speed += (target - S.speed) * Math.min(1, dt * 0.5);
  if (S.estop || Math.abs(S.speed) < 0.01 && !throttle) S.speed = S.estop ? 0 : S.speed * 0.5;
  S.heading = (S.heading + steer * 6 * dt / S.simRate * 2 + 360) % 360;
  const dist = S.speed * dt;
  if (Math.abs(dist) > 0.001) {
    const p = destination(S.lat, S.lon, S.heading, dist);
    if (region.grid.contains(p.lat, p.lon)) { S.lat = p.lat; S.lon = p.lon; S.odo += Math.abs(dist); S.pendingOdo = (S.pendingOdo || 0) + Math.abs(dist); }
    // energy from terramechanics model approximation: drive + hotel (same coefficients as Khipu)
    const wh = (1025 * 3.721 * (0.08 + Math.sin(S.pitch * Math.PI / 180)) / 0.75 * Math.abs(dist) + 300 * dt) / 3600;
    S.battery = Math.max(0, S.battery - Math.max(0, wh) / S.capacity);
    S.pendingWh = (S.pendingWh || 0) + Math.max(0, wh);
  } else {
    S.battery = Math.max(0, S.battery - (300 * dt / 3600) / S.capacity);
  }
  const att = terrainAttitude();
  S.pitch = att.pitch; S.roll = att.roll;
  S.link = sampleTelecom(S.lat, S.lon);
  updatePanels();
  refresh();
}

async function slowTick() {
  // traction (Bekker/Janosi) from Khipu
  try {
    const t = await api.traction(Math.abs(S.pitch), S.roll);
    S.slip = t.slip; S.tractionState = t.state; S.tipover = t.tipover_risk;
  } catch { /* keep last */ }
  // odometry with growing uncertainty
  if (S.pendingOdo) {
    try {
      const r = await api.localization({ state: S.loc, step: { distance_m: S.pendingOdo, heading_deg: S.heading, slip: S.slip } });
      S.loc = { ...r.state, ellipse: r.ellipse, lat: S.lat, lon: S.lon };
    } catch { /* offline */ }
    S.pendingOdo = 0;
  }
  if (S.pendingWh) { api.consume(ROVER_ID, S.pendingWh, "rover", "conducción (simulación)").catch(() => {}); S.pendingWh = 0; }
  // FSM from telemetry snapshot
  const dBase = base ? haversine(S.lat, S.lon, base.lat, base.lon) : null;
  try {
    const f = await api.fsm({ battery_pct: S.battery * 100, link_margin_db: S.link, slope_deg: Math.abs(S.pitch), emergency_stop: S.estop, pnr_exceeded: S.route?.pnr?.status === "pnr_exceeded" && S.pastPnr, reset: !S.estop && S.fsm === "ABORT" && S.battery > 0.2 });
    S.fsm = f.state; S.fsmReasons = f.reasons;
  } catch { /* offline */ }
  // autopilot command (pure pursuit + safety envelope)
  if (S.autopilot && S.route) {
    try { S.apCmd = await api.autopilot({ lat: S.lat, lon: S.lon, heading_deg: S.heading, path: S.route.points, slope_deg: Math.abs(S.pitch), roll_deg: S.roll, link_ok: (S.link ?? 10) > 0, emergency: S.estop }); }
    catch { S.apCmd = null; }
  }
  // dynamic replanning when an injected obstacle compromises the corridor
  if (S.route && S.target && Date.now() - S.lastReplan > 6000) {
    try {
      const h = await api.harness();
      simBanner(h.simulation);
      const obs = h.active.filter((a) => a.kind === "obstacle" && a.params?.lat).map((a) => ({ lat: a.params.lat, lon: a.params.lon, radius_m: a.params.radius_m || 500 }));
      if (obs.length) {
        S.lastReplan = Date.now();
        const r = await api.replan({ region_key: region.key, current: { lat: S.lat, lon: S.lon }, destination: { lat: S.target.lat, lon: S.target.lon }, route_points: S.route.points, obstacles: obs, profile: "rover", asset_id: ROVER_ID });
        if (r.replanned) { S.route = { ...S.route, points: r.route_points, metrics: r.metrics, pnr: r.pnr }; S.routeStatus = "Replanificada: evasión de obstáculo"; toast(r.reason, "warn"); }
        else S.routeStatus = "Corredor nominal";
      }
    } catch { /* ignore */ }
  }
  if (dBase != null) S.dBase = dBase;
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
    $("#guide-sub").textContent = `${t.name} · sin ruta Khipu (planifica en modo Planificar)`;
  }
  const v = Math.max(0.2, Math.abs(S.speed) || S.speedMax * 0.7);
  $("#meta-corridor").textContent = corridor == null ? "FUERA DE RUTA" : `EN CORREDOR: ${fmt.m(corridor)}`;
  $("#meta-corridor").className = corridor != null && corridor < 600 ? "green" : "gold";
  $("#meta-eta").textContent = `ETA: ~${fmt.dur(remaining / v)} · ${S.autopilot ? "Piloto auto" : "Manual"}`;
  $("#g-next").textContent = fmt.m(remaining);
  $("#g-eta").textContent = `ETA: ${fmt.dur(remaining / v)}`;
  $("#g-total").textContent = `Total: ${S.route ? fmt.m(S.route.metrics.distance_m) : fmt.m(d)}`;
}

// ------------------------------------------------------------------ actions
async function planTo(target, { silent } = {}) {
  S.target = target;
  try {
    const res = await api.route({ region_key: region.key, origin: { lat: S.lat, lon: S.lon, id: ROVER_ID, kind: "rover" }, destination: { lat: target.lat, lon: target.lon, id: target.id || null },
      asset_id: ROVER_ID, profile: "rover", variants: true });
    const v = res.variants.find((x) => x.variant === res.recommended) || res.variants[0];
    S.route = v;
    S.routeStatus = "Ruta Khipu (equilibrada)";
    if (!silent) toast(`Ruta a ${target.name}: ${fmt.m(v.metrics.distance_m)} · PNR ${v.pnr?.status}`, "safe");
    return v;
  } catch (e) {
    S.route = null;
    S.routeStatus = null;
    showInspect("Ruta imposible", `<div class="alert-card infeasible-card"><strong>${esc(e.body?.reason || "error")}</strong><div style="font-size:12px">${esc(e.body?.detail || e.message)}</div></div>`);
    return null;
  }
}

function pickDefaultTarget() {
  const sci = entities.filter((e) => ["poi", "sample"].includes(e.kind)).map((e) => ({ e, d: haversine(S.lat, S.lon, e.lat, e.lon) })).filter((x) => x.d > 800).sort((a, b) => a.d - b.d)[0];
  if (sci) { S.target = { id: sci.e.id, name: sci.e.name, lat: sci.e.lat, lon: sci.e.lon }; planTo(S.target, { silent: true }); }
}

function setAutopilot(on) {
  if (on && !S.route) { toast("Sin ruta: planifica un objetivo primero", "warn"); on = false; }
  if (on && S.estop) { toast("Parada de emergencia activa", "danger"); on = false; }
  S.autopilot = on;
  $("#autopilot").setAttribute("aria-pressed", String(on));
  $("#ap-state").textContent = on ? "AUTO" : "MANUAL";
}

function setEstop(on) {
  S.estop = on;
  $("#estop").setAttribute("aria-pressed", String(on));
  $("#estop-label").innerHTML = on ? "PARADA ACTIVA<br><small>Pulsa para reanudar</small>" : "Parada de<br>emergencia";
  if (on) { setAutopilot(false); S.speed = 0; S.keys.clear(); toast("PARADA DE EMERGENCIA ACTIVADA", "danger", 6000); }
  else toast("Parada liberada: control manual", "safe");
}

async function safeReturn() {
  if (!base) return;
  const v = await planTo({ id: base.id, name: base.name, lat: base.lat, lon: base.lon });
  if (v) { setMode("navigate"); setAutopilot(true); }
}

function setMode(m) {
  S.mode = m;
  $$(".rover-dock .dock-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  map.opts.lockPan = m === "navigate";
  if (m !== "navigate") map.cam.rot = 0;   // north-up for reconnaissance and planning
  if (m === "plan") toast("Planificar: haz clic en el mapa o en un POI para trazar ruta rápida", "", 3000);
  refresh();
}

async function onMapClick(ll, hit) {
  if (S.mode === "plan") {
    const target = hit ? { id: hit.id, name: hit.name, lat: hit.lat, lon: hit.lon } : { name: `${ll.lat.toFixed(4)}, ${ll.lon.toFixed(4)}`, lat: ll.lat, lon: ll.lon };
    const v = await planTo(target);
    if (v) showInspect(`Ruta a ${target.name}`, `<dl class="kv"><dt>Distancia</dt><dd>${fmt.m(v.metrics.distance_m)}</dd><dt>Duración</dt><dd>${fmt.dur(v.metrics.duration_s)}</dd>
      <dt>Energía</dt><dd>${fmt.num(v.metrics.resources.battery_wh, 0)} Wh</dd><dt>PNR</dt><dd>${esc(v.pnr?.status)}</dd><dt>Riesgo medio</dt><dd>${fmt.num(v.metrics.risk_mean, 2)}</dd></dl>
      <button class="btn btn-gold" style="width:100%;margin-top:8px" id="go-drive">Conducir (piloto auto)</button>`);
    $("#go-drive")?.addEventListener("click", () => { setMode("navigate"); setAutopilot(true); });
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
      map3d.drape(map.base);
      map3d.focusOn(S.lat, S.lon, 9000);
    } catch (e) { toast("WebGL no disponible", "warn"); return setView("2d"); }
  }
  refresh();
}

function drawScale() {
  const sb = map.scaleBar(60);
  $("#scale").textContent = `${fmt.m(sb.meters)} ≈ ${sb.px.toFixed(0)} px`;
}

function handleIntent(r) {
  if (r.intent === "set_mode") setMode(r.mode);
  if (r.intent === "emergency_stop") setEstop(true);
  if (r.intent === "safe_return") safeReturn();
  if (r.intent === "select_layer") { const id = ["slope", "hazard", "ibio", "telecom"].includes(r.layer_id) ? r.layer_id : null; if (id) { toggleLayer(id, true); buildMapMenu(); } else toast(`Capa ${r.layer_id} disponible en Hatun Wasi`, "warn"); }
  if (r.intent === "poi_info") { const e = entities.find((x) => x.id === r.poi_id); if (e) inspectEntity(e); }
  if (r.intent === "status") toast(`Batería ${fmt.pct(S.battery * 100)} · enlace ${S.link?.toFixed(1) ?? "—"} dB · estado ${S.fsm}`, "", 5000);
  if (r.intent === "filter_pois") { S.radar = r.category !== "all" || true; $("#science-radar").setAttribute("aria-pressed", "true"); refresh(); }
}

function renderLegend() {
  let el = $("#rover-legend");
  const on = Object.entries(S.layers).filter(([id, v]) => v && S.layerMeta?.[id]);
  if (!on.length) { el?.remove(); return; }
  if (!el) { el = document.createElement("div"); el.id = "rover-legend"; el.className = "panel rover-legend"; el.setAttribute("aria-label", "Leyenda de capas"); document.body.appendChild(el); }
  el.innerHTML = `<div class="kicker">Leyenda</div>` + on.map(([id]) => { const m = S.layerMeta[id]; return `<div class="small" style="margin-top:6px;display:flex;justify-content:space-between;gap:6px"><span>${esc(m.name)}</span>${provBadge(m.provenance)}</div>
    <div style="height:7px;margin:3px 0;background:linear-gradient(90deg,${LEGEND_STOPS(m.colormap).join(",")})"></div>
    <div class="small mono dim" style="display:flex;justify-content:space-between"><span>${fmt.num(m.lo, 1)}</span><span>${fmt.num(m.hi, 1)} ${esc(m.units)}</span></div>`; }).join("")
    + `<div class="small dim" style="margin-top:6px">Curvas de nivel: MOLA (derivado NASA) · Zonas: escenario sintético</div>`;
}

function buildMapMenu() {
  const names = { slope: "Pendiente", hazard: "Niveles de riesgo", ibio: "Ciencia (IBIO)", telecom: "Margen de enlace" };
  $("#map-menu").innerHTML = `<div class="kicker" style="padding:4px">Capas del mapa táctico</div>` + Object.entries(names).map(([id, n]) => `<label><span>${n}</span><span class="switch"><input type="checkbox" data-layer="${id}" ${S.layers[id] ? "checked" : ""}><span class="track"></span></span></label>`).join("")
    + `<label><span>Curvas de nivel</span><span class="switch"><input type="checkbox" data-contours ${map.opts.contours ? "checked" : ""}><span class="track"></span></span></label>
       <label><span>Rótulos</span><span class="switch"><input type="checkbox" data-labels ${map.opts.labels ? "checked" : ""}><span class="track"></span></span></label>
       <button class="btn" id="cam-reset" style="width:100%;margin-top:6px">${icon("reset")} Restablecer cámara</button>`;
  $$("[data-layer]", $("#map-menu")).forEach((i) => i.addEventListener("change", () => toggleLayer(i.dataset.layer, i.checked)));
  $("[data-contours]").addEventListener("change", (e) => { map.opts.contours = e.target.checked; map.draw(); });
  $("[data-labels]").addEventListener("change", (e) => { map.opts.labels = e.target.checked; map.draw(); });
  $("#cam-reset").addEventListener("click", () => { if (S.view === "3d" && map3d) map3d.focusOn(S.lat, S.lon, 9000); else map.focusOn(S.lat, S.lon, map.minScale * 14); });
}

function demoDialog() {
  const body = document.createElement("div");
  const draw = async () => {
    const h = await api.harness();
    body.innerHTML = `<p class="muted" style="margin-top:0">Configuración de <b>simulación</b>: la cinemática del rover se simula sobre el terreno MOLA real; las fallas se inyectan en el harness de demo sin tocar el modelo de producción.</p>
      <label class="label">Aceleración temporal: <b class="mono">x${S.simRate}</b></label><input type="range" class="range" min="1" max="60" value="${S.simRate}" id="sim-rate">
      <div class="btn-row" style="margin-top:10px">${Object.entries(h.available).map(([k, v]) => `<button class="btn" data-inj="${k}">${esc(v.label)}</button>`).join("")}</div>
      <button class="btn" id="abs-fix" style="width:100%;margin-top:8px">Fijación absoluta (orbital)</button>
      <div class="kicker" style="margin-top:10px">Activas</div>${h.active.map((a) => `<div><span class="badge sim">SIM</span> ${esc(a.label)}</div>`).join("") || '<div class="empty-state">Ninguna</div>'}
      <button class="btn btn-danger" id="clr" style="margin-top:8px">Limpiar</button>`;
    body.querySelector("#sim-rate").addEventListener("input", (e) => { S.simRate = +e.target.value; body.querySelector(".label b").textContent = `x${S.simRate}`; });
    $$("[data-inj]", body).forEach((b) => b.addEventListener("click", async () => {
      let params = {};
      if (b.dataset.inj === "obstacle" && S.route) { const p = S.route.points[Math.min(S.route.points.length - 1, Math.floor(S.route.points.length / 2))]; params = { lat: p.lat, lon: p.lon, radius_m: 700 }; }
      await api.inject(b.dataset.inj, params); simBanner(true); S.lastReplan = 0; draw();
    }));
    body.querySelector("#abs-fix").addEventListener("click", async () => {
      const r = await api.localization({ state: S.loc, fix: { lat: S.lat, lon: S.lon, sigma_m: 3 } });
      S.loc = { ...r.state, ellipse: r.ellipse, last_fix: r.last_fix };
      toast("Fijación absoluta aplicada: incertidumbre contraída", "safe");
    });
    body.querySelector("#clr").addEventListener("click", async () => { await api.clearHarness(); simBanner(false); draw(); });
  };
  draw();
  modal({ title: "Demo / configuración (SIMULACIÓN)", body });
}

function bindUI() {
  $$(".rover-dock .dock-btn").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#autopilot").addEventListener("click", () => setAutopilot(!S.autopilot));
  $("#science-radar").addEventListener("click", () => { S.radar = !S.radar; $("#science-radar").setAttribute("aria-pressed", String(S.radar)); refresh(); });
  $("#safe-return").addEventListener("click", safeReturn);
  $("#estop").addEventListener("click", () => setEstop(!S.estop));
  $("#voice").addEventListener("click", () => voice.start());
  $("#inspect-close").addEventListener("click", () => { $("#inspect-card").hidden = true; });
  $("#view-toggle").addEventListener("click", () => setView(S.view === "2d" ? "3d" : "2d"));
  $("#demo-btn").addEventListener("click", demoDialog);
  const mm = $("#map-menu");
  $("#map-menu-btn").addEventListener("click", () => { mm.hidden = !mm.hidden; $("#map-menu-btn").setAttribute("aria-expanded", String(!mm.hidden)); if (!mm.hidden) buildMapMenu(); });
  onClickOutside(mm, () => { mm.hidden = true; }, [$("#map-menu-btn")]);
  $$("#dpad [data-dir]").forEach((b) => {
    const dir = b.dataset.dir;
    const on = (e) => { e.preventDefault(); if (dir === "stop") { S.keys.clear(); S.speed = 0; setAutopilot(false); return; } if (S.estop) return; setAutopilot(false); S.keys.add(dir); b.classList.add("pressed"); };
    const off = () => { S.keys.delete(dir); b.classList.remove("pressed"); };
    b.addEventListener("pointerdown", on);
    b.addEventListener("pointerup", off);
    b.addEventListener("pointerleave", off);
  });
  const keymap = { w: "up", arrowup: "up", s: "down", arrowdown: "down", a: "left", arrowleft: "left", d: "right", arrowright: "right" };
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea")) return;
    const k = e.key.toLowerCase();
    if (keymap[k]) { e.preventDefault(); if (!S.estop) { setAutopilot(false); S.keys.add(keymap[k]); } }
    if (k === " ") { e.preventDefault(); setEstop(!S.estop); }
    if (k === "v") setView(S.view === "2d" ? "3d" : "2d");
    if (k === "1") setMode("navigate");
    if (k === "2") setMode("recon");
    if (k === "3") setMode("plan");
    if (k === "k") voice.start();
  });
  document.addEventListener("keyup", (e) => { const k = keymap[e.key.toLowerCase()]; if (k) S.keys.delete(k); });
}

boot().catch((e) => { console.error(e); toast(`Error: ${e.message}`, "danger", 10000); });

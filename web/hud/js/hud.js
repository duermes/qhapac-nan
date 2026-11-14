// Ñawi — EVA survival visor bootstrap: scene + vitals + spatial panels + voice.
import { api } from "/static/shared/js/api.js";
import { bearing, fmt, haversine } from "/static/shared/js/geo.js";
import { ASSET_REGISTRY, icon } from "/static/shared/js/icons.js";
import { entitiesFrom, loadRegion, loadScenario } from "/static/shared/js/khipu-client.js";
import { $, $$, esc, modal, simBanner, toast } from "/static/shared/js/ui.js";
import { VoiceCopilot } from "/static/shared/js/voice.js";
import { EvaScene } from "./scene.js";
import { consume, createVitals, refreshVitals, renderAlerts, renderVitals } from "./vitals.js";

const EVA_ID = new URLSearchParams(location.search).get("eva") || "EVA_01";
const SAMPLE_CAPACITY = 16;
const H = { x: 0, z: 0, speed: 0, keys: new Set(), targets: [], ti: 0, route: null, samples: [], filter: null, rate: 3, sos: false, inside: false };
window.nawi = H;
let region, scenario, scene, entities, base, vit, voice, walkLimit = 2000;

function iconize() { $$("[data-icon]").forEach((el) => { el.outerHTML = icon(el.dataset.icon); }); }

async function boot() {
  iconize();
  const regions = await api.regions();
  region = await loadRegion(regions.default, 1);
  if (!region.available) { toast("Sin datos de terreno", "danger", 10000); return; }
  scenario = await loadScenario();
  entities = entitiesFrom(scenario);
  walkLimit = scenario.eva_policy?.walkback_limit_m || 2000;
  const me = entities.find((e) => e.id === EVA_ID) || entities.find((e) => e.kind === "astronaut");
  base = entities.find((e) => e.kind === "base");
  $("#eva-id").textContent = EVA_ID.replace("_", "-");
  scene = new EvaScene($("#scene"), region, { lat: me.lat, lon: me.lon });
  H.scene = scene;
  const others = entities.filter((e) => e.id !== me.id);
  scene.setMarkers(others, (n) => icon(n));
  H.targets = others.filter((e) => ["poi", "sample", "base", "rover", "landmark"].includes(e.kind) && haversine(me.lat, me.lon, e.lat, e.lon) < 3000)
    .sort((a, b) => haversine(me.lat, me.lon, a.lat, a.lon) - haversine(me.lat, me.lon, b.lat, b.lon));
  H.ti = Math.max(0, H.targets.findIndex((t) => t.kind === "sample"));
  vit = createVitals();
  try { const lg = await api.ledger(me.id, "astronaut"); vit.o2_kg = Math.max(0, lg.remaining); } catch { /* full suit */ }
  voice = new VoiceCopilot({ iface: "hud", onIntent: handleIntent });
  bind();
  api.harness().then((h) => { simBanner(h.simulation); if (h.active.some((a) => a.kind === "suit_leak")) vit.leak = 2.2; }).catch(() => {});
  renderHelp();
  await planToTarget(true);
  let last = performance.now();
  const loop = (t) => {
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    step(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  setInterval(slow, 2000);
  slow();
  document.body.dataset.ready = "1";
}

const pos = () => scene.toLatLon(H.x, H.z);
const target = () => H.targets[H.ti];

function step(dt) {
  const turn = (H.keys.has("left") ? 1 : 0) - (H.keys.has("right") ? 1 : 0);
  scene.yaw += turn * 1.4 * dt;
  const fwd = (H.keys.has("fwd") ? 1 : 0) - (H.keys.has("back") ? 0.5 : 0);
  const p = pos();
  const slope = region.slopeAt(p.lat, p.lon) ?? 0;
  const v = H.inside || H.sos ? 0 : fwd * 1.1 * Math.max(0.35, 1 - slope / 30);
  H.speed = v;
  const d = v * dt * H.rate;
  if (d) {
    const nx = H.x - Math.sin(scene.yaw) * d, nz = H.z - Math.cos(scene.yaw) * d;
    if (Math.abs(nx) < 1500 && Math.abs(nz) < 1500) { H.x = nx; H.z = nz; }
    H.moved = (H.moved || 0) + Math.abs(d);
  }
  consume(vit, dt * H.rate);
  scene.update(H.x, H.z);
  panels();
}

function panels() {
  const p = pos();
  const hdg = scene.heading();
  const e = region.elevationAt(p.lat, p.lon);
  const sl = region.slopeAt(p.lat, p.lon);
  $("#loc-ll").textContent = `${p.lat.toFixed(4)}° N, ${p.lon.toFixed(4)}° E`;
  $("#loc-elev").textContent = `Elev: ${e == null ? "—" : e.toFixed(0) + " m"} · Inclinación: ${sl == null ? "—" : sl.toFixed(1) + "°"} · Rumbo ${hdg.toFixed(0)}°`;
  $("#needle").style.transform = `rotate(${-hdg}deg)`;
  $("#azimuth").textContent = `${String(Math.round(hdg)).padStart(3, "0")}° AZ`;
  $("#ladder").style.transform = `translateY(${scene.pitch * 60}px)`;
  const t = target();
  if (t) {
    const dist = haversine(p.lat, p.lon, t.lat, t.lon);
    const brg = bearing(p.lat, p.lon, t.lat, t.lon);
    const dz = (region.elevationAt(t.lat, t.lon) ?? 0) - (e ?? 0);
    $("#goal-dist").textContent = fmt.m(dist);
    $("#goal-name").textContent = t.name;
    $("#goal-brg").textContent = `${String(Math.round(brg)).padStart(3, "0")}°`;
    $("#goal-eta").textContent = `${(dist / 0.9 / 60).toFixed(1)} min`;
    $("#goal-dz").textContent = `${dz >= 0 ? "+" : ""}${dz.toFixed(1)} m`;
    const tBase = base ? haversine(t.lat, t.lon, base.lat, base.lon) : 0;
    const safe = tBase <= (vit.last?.walkback?.walkback_m ?? walkLimit);
    $("#goal-safe").textContent = safe ? "En radio seguro" : "Fuera de walkback";
    $("#goal-safe").className = safe ? "ok" : "bad";
    $("#director").style.transform = `translateX(-50%) rotate(${((brg - hdg + 540) % 360) - 180}deg)`;
  }
  // field of view list (±45°, ≤ 2.5 km)
  const fov = entities.filter((x) => x.id !== EVA_ID).map((x) => ({ x, d: haversine(p.lat, p.lon, x.lat, x.lon), rel: ((bearing(p.lat, p.lon, x.lat, x.lon) - hdg + 540) % 360) - 180 }))
    .filter((o) => Math.abs(o.rel) <= 45 && o.d <= 2500 && (!H.filter || H.filter.includes(o.x.kind))).sort((a, b) => a.d - b.d).slice(0, 10);
  $("#fov-list").innerHTML = fov.length ? fov.map((o) => { const reg = ASSET_REGISTRY[o.x.kind] || ASSET_REGISTRY.poi; return `<button class="fov-item ${t && o.x.id === t.id ? "active" : ""}" data-id="${esc(o.x.id)}" style="color:${reg.color}">${icon(reg.icon)}<span class="n">${esc(o.x.name)}</span><span class="d">${fmt.m(o.d)}</span></button>`; }).join("")
    : `<div class="small dim">Nada en el campo visual${H.filter ? " (filtro activo)" : ""}</div>`;
  scene.markers.forEach((m) => { m.hidden = H.filter ? !H.filter.includes(m.e.kind) : false; });
  // proximity prompts: airlock and samples
  const dBase = base ? haversine(p.lat, p.lon, base.lat, base.lon) : Infinity;
  const smp = entities.find((x) => x.kind === "sample" && !H.samples.includes(x.id) && haversine(p.lat, p.lon, x.lat, x.lon) < 30);
  H.prompt = H.inside ? null : dBase < 60 ? "base" : smp ? smp : null;
  const pr = $("#prompt");
  pr.hidden = !H.prompt;
  if (H.prompt === "base") pr.innerHTML = `${icon("home")} Presiona [F] para entrar a ${esc(base.name)}`;
  else if (H.prompt) pr.innerHTML = `${icon("sample")} Presiona [E] para recolectar ${esc(H.prompt.name)}`;
  H.dBase = dBase;
}

async function slow() {
  const p = pos();
  const g = Math.tan((region.slopeAt(p.lat, p.lon) ?? 0) * Math.PI / 180) * (H.speed > 0 ? 1 : 0);
  let r;
  try { r = await refreshVitals(vit, { speed: H.speed, gradient: g, distanceToBase: H.dBase ?? 0, walkbackLimit: walkLimit, gripping: false }); }
  catch { r = null; }
  renderVitals(vit, { distanceToBase: H.dBase ?? 0 });
  const alerts = [...(r?.alerts || [])];
  for (const hz of scenario.hazards) {
    const d = haversine(p.lat, p.lon, hz.lat, hz.lon) - hz.radius_m;
    if (d < 0) alerts.push({ level: "critical", code: "HAZARD_IN", text: `Dentro de ${hz.name}` });
    else if (d < 250) alerts.push({ level: "warning", code: "HAZARD_NEAR", text: `${hz.name} a ${d.toFixed(0)} m` });
  }
  if (H.sos) alerts.push({ level: "critical", code: "SOS", text: "Emergencia EVA declarada — retorno asistido" });
  if (vit.leak) alerts.push({ level: "critical", code: "LEAK", text: "Fuga en traje (simulación): consumo O₂ x2.2" });
  if (vit.o2_kg / 1.2 < 0.35) alerts.push({ level: "warning", code: "O2_RES", text: "O₂ por debajo de la reserva: retornar" });
  renderAlerts(alerts);
  const slope = region.slopeAt(p.lat, p.lon) ?? 0;
  $("#traction").textContent = slope > 20 ? "TRACCIÓN COMPROMETIDA" : slope > 12 ? "TRACCIÓN REDUCIDA" : "TRACCIÓN NOMINAL";
  $("#traction").style.color = slope > 20 ? "var(--danger)" : slope > 12 ? "var(--warn)" : "";
  relief(p);
  if (H.moved > 5) { const used = 1.2 - vit.o2_kg; api.consume(EVA_ID, Math.max(0, used - (H.reported || 0)), "astronaut", "EVA").catch(() => {}); H.reported = used; H.moved = 0; }
}

function relief(p) {
  const e0 = region.elevationAt(p.lat, p.lon) ?? 0;
  let hi = -Infinity, lo = Infinity;
  for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) {
    const dx = i * 45, dz = j * 45;
    if (Math.hypot(dx, dz) > 180) continue;
    const ll = scene.toLatLon(H.x + dx, H.z + dz);
    const e = region.elevationAt(ll.lat, ll.lon);
    if (e == null) continue;
    hi = Math.max(hi, e); lo = Math.min(lo, e);
  }
  const ref = scene.z0;
  $("#peak").textContent = `${hi - ref >= 0 ? "+" : ""}${(hi - ref).toFixed(1)} m`;
  $("#valley").textContent = `${lo - ref >= 0 ? "+" : ""}${(lo - ref).toFixed(1)} m`;
  $("#peak-dz").textContent = `ΔZ: ${(hi - e0 >= 0 ? "+" : "")}${(hi - e0).toFixed(1)} m`;
  $("#valley-dz").textContent = `ΔZ: ${(lo - e0).toFixed(1)} m`;
  const range = hi - lo;
  $("#relief-txt").textContent = `${range > 30 ? "Relieve quebrado" : "Relieve suave"} · Rango local ${range.toFixed(1)} m (MOLA interpolado)`;
}

async function planToTarget(silent) {
  const t = target();
  if (!t) return;
  const p = pos();
  try {
    const res = await api.route({ region_key: region.key, origin: { lat: p.lat, lon: p.lon, id: EVA_ID, kind: "astronaut" }, destination: { lat: t.lat, lon: t.lon, id: t.id }, asset_id: EVA_ID, profile: "astronaut", variants: false });
    H.route = res.variants[0];
    scene.setRoute(H.route.points);
    if (!silent) toast(`Ruta Khipu: ${fmt.m(H.route.metrics.distance_m)} · ${H.route.pnr?.status}`, "safe");
  } catch (e) {
    H.route = null;
    scene.setRoute(null);
    if (!silent) toast(e.body?.detail || e.message, "danger", 6000);
    else $("#goal-safe").textContent = e.body?.reason === "walkback_exceeded" ? "Fuera de walkback" : "Sin ruta";
  }
}

function interact() {
  if (H.prompt === "base") {
    H.inside = true;
    const used = 1.2 - vit.o2_kg;
    modal({ title: "Retorno al hábitat completado", body: `<p>Esclusa de ${esc(base.name)} presurizada. EVA finalizada.</p>
      <dl class="kv"><dt>Duración (sim.)</dt><dd>${fmt.dur(vit.elapsed_s)}</dd><dt>O₂ consumido</dt><dd>${(used * 1000).toFixed(0)} g</dd><dt>Muestras</dt><dd>${H.samples.length}/${SAMPLE_CAPACITY}</dd></dl>`,
      actions: [{ label: "Permanecer dentro" }, { label: "Salir a nueva EVA (traje recargado)", cls: "btn-gold", onClick: () => { H.inside = false; H.x -= 70; const fresh = createVitals(); Object.assign(vit, fresh); toast("Traje recargado en el hábitat", "safe"); } }] });
  } else if (H.prompt && H.prompt.id) {
    H.samples.push(H.prompt.id);
    $("#samples").textContent = `${H.samples.length}/${SAMPLE_CAPACITY}`;
    toast(`Muestra recolectada: ${H.prompt.name}`, "safe");
  } else toast("Nada con que interactuar aquí", "", 1500);
}

function cycleCamera() {
  scene.cameraMode = scene.cameraMode === "third" ? "first" : "third";
  if (scene.cameraMode === "third") { scene.pitch = -0.15; }
  toast(scene.cameraMode === "first" ? "Cámara: primera persona" : "Cámara: tercera persona (vista restaurada)", "", 1500);
}

function handleIntent(r) {
  if (r.intent === "poi_info") { const i = H.targets.findIndex((t) => t.id === r.poi_id); if (i >= 0) { H.ti = i; planToTarget(); } }
  if (r.intent === "filter_pois") H.filter = r.category === "all" ? null : { science: ["poi"], sample: ["sample"], vehicle: ["rover"], base: ["base", "habitat", "landmark"], hazard: ["hazard"] }[r.category] || null;
  if (r.intent === "safe_return") { const i = H.targets.findIndex((t) => t.kind === "base"); if (i >= 0) { H.ti = i; planToTarget(); } }
  if (r.intent === "emergency_stop") setSos(true);
  if (r.intent === "status") toast(`O₂ ${((vit.o2_kg / 1.2) * 100).toFixed(0)}% · base a ${fmt.m(H.dBase)}`, "", 5000);
  if (r.intent === "help") toggleHelp(true);
  $("#fov-filter").textContent = H.filter ? `filtro: ${r.category}` : "";
}

function setSos(on) {
  H.sos = on;
  $("#sos-btn").classList.toggle("pressed", on);
  if (on) { const i = H.targets.findIndex((t) => t.kind === "base"); if (i >= 0) { H.ti = i; planToTarget(); } toast("SOS: objetivo fijado en la base; detén el avance y espera asistencia", "danger", 6000); }
}

function renderHelp() {
  $("#help-body").innerHTML = `<p><b>Moverse:</b> W/S o ▲▼ avanzar/retroceder · A/D o ◀▶ girar · arrastrar para mirar.</p>
    <p><b>F</b> entrar a la esclusa cerca de la base · <b>E</b> recolectar muestra cercana · <b>C</b> cámara · <b>K</b> Khipu voz · <b>H</b> ayuda · <b>Tab</b> siguiente objetivo.</p>
    <p><b>Datos:</b> relieve MOLA interpolado (463 m/px); las rocas son decorativas y no proceden de datos. Vitales y consumibles: modelos Khipu (Minetti/PLSS/Rohmert). Entidades: escenario sintético.</p>
    <p><b>Walkback:</b> límite a pie ${walkLimit} m con reserva del 25%. Recalcular no repone O₂.</p>`;
}
function toggleHelp(force) {
  const h = $("#help");
  h.hidden = force === undefined ? !h.hidden : !force;
  $("#help-btn").setAttribute("aria-expanded", String(!h.hidden));
}

function bind() {
  const km = { w: "fwd", arrowup: "fwd", s: "back", arrowdown: "back", a: "left", arrowleft: "left", d: "right", arrowright: "right" };
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select")) return;
    const k = e.key.toLowerCase();
    if (km[k]) { H.keys.add(km[k]); e.preventDefault(); }
    if (k === "f" || k === "e") interact();
    if (k === "c") cycleCamera();
    if (k === "h") toggleHelp();
    if (k === "k") voice.start();
    if (k === "tab") { e.preventDefault(); H.ti = (H.ti + 1) % H.targets.length; planToTarget(true); }
  });
  document.addEventListener("keyup", (e) => { const k = km[e.key.toLowerCase()]; if (k) H.keys.delete(k); });
  $$("[data-move]").forEach((b) => {
    const k = b.dataset.move;
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); H.keys.add(k); b.classList.add("pressed"); });
    const off = () => { H.keys.delete(k); b.classList.remove("pressed"); };
    b.addEventListener("pointerup", off); b.addEventListener("pointerleave", off);
  });
  $("#act-btn").addEventListener("click", interact);
  $("#sos-btn").addEventListener("click", () => setSos(!H.sos));
  $("#camera-btn").addEventListener("click", cycleCamera);
  $("#help-btn").addEventListener("click", () => toggleHelp());
  $("#help-close").addEventListener("click", () => toggleHelp(false));
  $("#voice-btn").addEventListener("click", () => voice.start());
  $("#goal-next").addEventListener("click", () => { H.ti = (H.ti + 1) % H.targets.length; planToTarget(true); });
  $("#goal-prev").addEventListener("click", () => { H.ti = (H.ti - 1 + H.targets.length) % H.targets.length; planToTarget(true); });
  $("#goal-route").addEventListener("click", () => planToTarget(false));
  $("#fov-list").addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (!b) return; const i = H.targets.findIndex((t) => t.id === b.dataset.id); if (i >= 0) { H.ti = i; planToTarget(true); } });
}

boot().catch((e) => { console.error(e); toast(`Error: ${e.message}`, "danger", 10000); });

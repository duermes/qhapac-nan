import { api } from "/static/shared/js/api.js";
import { bearing, fmt, haversine } from "/static/shared/js/geo.js";
import { ASSET_REGISTRY, icon } from "/static/shared/js/icons.js";
import { entitiesFrom, loadRegion, loadScenario } from "/static/shared/js/khipu-client.js";
import { $, $$, esc, modal, simBanner, toast } from "/static/shared/js/ui.js";
import { VoiceCopilot } from "/static/shared/js/voice.js";
import { EvaScene } from "./scene.js";
import { consume, createVitals, refreshVitals, renderAlerts, renderVitals } from "./vitals.js";
import { localRoute } from "./navigation.js";
import { evaRequest } from "./eva-api.js";
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
    if (!region.available) {
        toast("Sin datos de terreno", "danger", 10000);
        return;
    }
    scenario = await loadScenario();
    entities = entitiesFrom(scenario);
    walkLimit = scenario.eva_policy?.walkback_limit_m || 2000;
    const me = entities.find((e) => e.id === EVA_ID) || entities.find((e) => e.kind === "astronaut");
    base = entities.find((e) => e.kind === "base");
    $("#eva-id").textContent = EVA_ID.replace("_", "-");
    scene = new EvaScene($("#scene"), region, { lat: base.lat, lon: base.lon });
    H.scene = scene;
    H.x = scene.character.position.x;
    H.z = scene.character.position.z;
    entities = scene.localEntities();
    base = entities.find(e => e.kind === "base");
    const others = entities;
    scene.setMarkers(others, (n) => icon(n));
    const start = scene.toLatLon(H.x, H.z);
    H.targets = others.filter((e) => ["poi", "sample", "base", "rover", "astronaut", "landmark", "antenna"].includes(e.kind))
        .sort((a, b) => haversine(start.lat, start.lon, a.lat, a.lon) - haversine(start.lat, start.lon, b.lat, b.lon));
    H.ti = Math.max(0, H.targets.findIndex((t) => t.kind === "sample"));
    vit = createVitals();
    H.vitals = vit;
    H.ledgerQueue = Promise.resolve();
    scene.onCollect = () => {
        vit.effort.collect();
        vit.grippingUntil = performance.now() + 2500;
        vit.o2_kg = Math.max(0, vit.o2_kg - 0.0006);
        vit.battery_wh = Math.max(0, vit.battery_wh - 1.32);
    };
    try {
        const lg = await api.ledger(me.id, "astronaut");
        vit.o2_kg = Math.max(0, lg.remaining);
        H.o2Start = vit.o2_kg;
    }
    catch { }
    voice = new VoiceCopilot({ iface: "hud", onIntent: handleIntent });
    bind();
    api.harness().then((h) => { simBanner(h.simulation); if (h.active.some((a) => a.kind === "suit_leak"))
        vit.leak = 2.2; }).catch(() => { });
    renderHelp();
    await planToTarget(true);
    let last = performance.now();
    const loop = (t) => {
        const dt = Math.min(0.1, (t - last) / 1000);
        last = t;
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
    scene.character.updatePosition(H.x, H.z);
    const state = scene.move(dt * H.rate, H.keys, H.sos || H.resupplying, vit.effort.staminaPct, dt);
    H.x = state.x;
    H.z = state.z;
    H.speed = state.speed;
    H.gradient = state.gradient;
    H.moved = (H.moved || 0) + state.distance;
    H.inside = scene.character.isInsideBase;
    vit.effort.update(dt, H.speed, Math.atan(H.gradient) * 180 / Math.PI, performance.now() < (vit.grippingUntil || 0));
    vit.grip_min = vit.effort.gripMinutes;
    if (!H.inside && !H.resupplying) consume(vit, dt * H.rate);
    scene.update(H.x, H.z, dt);
    renderVitals(vit, { distanceToBase: H.dBase ?? 0 });
    panels();
}
function panels() {
    const p = pos();
    const hdg = scene.heading();
    const e = scene.surfaceElevation(H.x, H.z);
    const sl = Math.atan(Math.hypot(scene.groundY(H.x + 1, H.z) - scene.groundY(H.x - 1, H.z), scene.groundY(H.x, H.z + 1) - scene.groundY(H.x, H.z - 1)) / 2) * 180 / Math.PI;
    $("#loc-ll").textContent = `${p.lat.toFixed(4)}° N, ${p.lon.toFixed(4)}° E`;
    $("#loc-elev").textContent = `Elev: ${e == null ? "—" : e.toFixed(0) + " m"} · Inclinación: ${sl == null ? "—" : sl.toFixed(1) + "°"} · Rumbo ${hdg.toFixed(0)}°`;
    $("#needle").style.transform = `rotate(${-hdg}deg)`;
    $("#azimuth").textContent = `${String(Math.round(hdg)).padStart(3, "0")}° AZ`;
    $("#ladder").style.transform = `translateY(${scene.pitch * 60}px)`;
    const t = target();
    if (t) {
        const dist = haversine(p.lat, p.lon, t.lat, t.lon);
        const brg = bearing(p.lat, p.lon, t.lat, t.lon);
        const localTarget = scene.toLocal(t.lat, t.lon);
        const dz = scene.surfaceElevation(localTarget.x, localTarget.z) - e;
        $("#goal-dist").textContent = fmt.m(H.route?.metrics.distance_m ?? dist);
        $("#goal-name").textContent = t.name;
        $("#goal-brg").textContent = `${String(Math.round(brg)).padStart(3, "0")}°`;
        $("#goal-eta").textContent = H.route ? fmt.dur(H.route.metrics.duration_s) : "—";
        $("#goal-dz").textContent = `${dz >= 0 ? "+" : ""}${dz.toFixed(1)} m`;
        const tBase = base ? haversine(t.lat, t.lon, base.lat, base.lon) : 0;
        const safe = !H.routeError && tBase <= (vit.last?.walkback?.walkback_m ?? walkLimit) && (!H.route || H.route.pnr.status === "round_trip_safe");
        $("#goal-safe").textContent = H.routeError ? "Sin ruta transitable" : safe ? "Retorno con reserva" : "Reserva insuficiente";
        $("#goal-safe").className = safe ? "ok" : "bad";
    const pnr = H.route?.pnr?.pnr_point;
    $("#goal-pnr").hidden = !pnr;
    if (pnr) $("#goal-pnr").textContent = `PNR · ${fmt.lat(pnr.lat)}, ${fmt.lon(pnr.lon)} · ${fmt.m(pnr.distance_m)}`;
        $("#director").style.transform = `translateX(-50%) rotate(${((brg - hdg + 540) % 360) - 180}deg)`;
    }
    const fov = entities.filter((x) => x.id !== EVA_ID && !H.samples.includes(x.id) && !H.inside).map((x) => ({ x, d: haversine(p.lat, p.lon, x.lat, x.lon), rel: ((bearing(p.lat, p.lon, x.lat, x.lon) - hdg + 540) % 360) - 180 }))
        .filter((o) => Math.abs(o.rel) <= 45 && o.d <= 2500 && (!H.filter || H.filter.includes(o.x.kind))).sort((a, b) => a.d - b.d).slice(0, 10);
    $("#fov-list").innerHTML = fov.length ? fov.map((o) => { const reg = ASSET_REGISTRY[o.x.kind] || ASSET_REGISTRY.poi; return `<button class="fov-item ${t && o.x.id === t.id ? "active" : ""}" data-id="${esc(o.x.id)}" style="color:${reg.color}">${icon(reg.icon)}<span class="n">${esc(o.x.name)}</span><span class="d">${fmt.m(o.d)}</span></button>`; }).join("")
        : `<div class="small dim">Nada en el campo visual${H.filter ? " (filtro activo)" : ""}</div>`;
    scene.markers.forEach((m) => { m.hidden = H.filter ? !H.filter.includes(m.e.kind) : false; });
    const dBase = base ? haversine(p.lat, p.lon, base.lat, base.lon) : Infinity;
    const smp = entities.filter(x => x.kind === "sample" && !H.samples.includes(x.id))
        .map(x => ({ entity: x, distance: Math.hypot(H.x - x.x, H.z - x.z) }))
        .filter(x => x.distance < 4.8).sort((a, b) => a.distance - b.distance)[0]?.entity;
    const station = scene.world.interactiveStations.find(s => Math.hypot(H.x - s.x, H.z - s.z) < 5.8);
    const companion = entities.filter(e => ["rover", "astronaut", "poi"].includes(e.kind))
        .map(e => ({ e, distance: Math.hypot(H.x - e.x, H.z - e.z) }))
        .filter(({ distance }) => distance < 10).sort((a, b) => a.distance - b.distance)[0]?.e;
    H.prompt = scene.character.nearBaseAirlock ? "base" : H.inside
        ? Math.hypot(H.x + 65, H.z + 69.8) < 7 ? "monitor" : null
        : smp || (station ? { station } : companion ? { companion } : null);
    const pr = $("#prompt");
    pr.hidden = !H.prompt;
    if (H.prompt === "base")
        pr.innerHTML = `${icon("home")} Pulsa [E] para ${H.inside ? "salir a la superficie" : "entrar a " + esc(base.name)}`;
    else if (H.prompt === "monitor") pr.innerHTML = `${icon("eye")} Presiona [E] para consultar el monitor de misión`;
    else if (H.prompt?.station) pr.innerHTML = `${icon("eye")} Presiona [E] para inspeccionar ${esc(H.prompt.station.name)}`;
    else if (H.prompt?.companion)
        pr.innerHTML = `${icon("eye")} Pulsa [E] para interactuar con ${esc(H.prompt.companion.name)}`;
    else if (H.prompt)
        pr.innerHTML = `${icon("sample")} Presiona [E] para recolectar ${esc(H.prompt.name)}`;
    H.dBase = dBase;
}
async function flushConsumption() {
  const used = Math.max(0, (H.o2Start ?? 1.2) - vit.o2_kg);
  H.ledgerQueue = H.ledgerQueue.catch(() => {}).then(async () => {
    const amount = Math.max(0, used - (H.reported || 0));
    if (amount > 0) {
      await api.consume(EVA_ID, amount, "astronaut", "EVA");
      H.reported = used;
    }
  });
  return H.ledgerQueue;
}

async function slow() {
  if (H.slowBusy || H.resupplying) return;
  H.slowBusy = true;
  try {
    const p = pos();
    let result;
    try {
      result = await refreshVitals(vit, { speed: H.speed, gradient: H.gradient || 0, distanceToBase: H.dBase ?? 0, walkbackLimit: walkLimit, gripping: performance.now() < (vit.grippingUntil || 0) });
    } catch {}
    const alerts = [...(result?.alerts || [])].filter(a => !["STAMINA", "HR"].includes(a.code));
    for (const hz of scenario.hazards) {
      const distance = haversine(p.lat, p.lon, hz.lat, hz.lon) - hz.radius_m;
      if (distance < 0) alerts.push({ level: "critical", code: "HAZARD_IN", text: `Dentro de ${hz.name}` });
      else if (distance < 250) alerts.push({ level: "warning", code: "HAZARD_NEAR", text: `${hz.name} a ${distance.toFixed(0)} m` });
    }
    const hazard = scene.character.proximityHazard;
    if (!H.inside && hazard.hasHazard) alerts.push({ level: "warning", code: "TERRAIN", text: hazard.message });
    if (vit.effort.staminaPct < 35) alerts.push({ level: "warning", code: "STAMINA", text: "Estamina baja: descansa para recuperarte" });
    if (vit.effort.heartRateBpm > 160) alerts.push({ level: "warning", code: "HR", text: "Frecuencia cardíaca elevada" });
    if (H.sos) alerts.push({ level: "critical", code: "SOS", text: "Emergencia EVA declarada — retorno asistido" });
    if (vit.leak) alerts.push({ level: "critical", code: "LEAK", text: "Fuga en traje (simulación): consumo O₂ x2.2" });
    if (!H.inside && H.routeError) alerts.push({ level: "warning", code: "ROUTE", text: H.routeError });
    if (H.notice && H.notice.until > performance.now()) alerts.push({ level: "info", code: "ACTION", text: H.notice.text });
    renderAlerts(alerts);
    $("#traction").textContent = H.inside ? "HÁBITAT PRESURIZADO · ENTRENAMIENTO" : hazard.hasHazard ? hazard.message : H.gradient > 0.2 ? "SUBIDA ESCARPADA · AVANCE REDUCIDO" : "TRACCIÓN NOMINAL";
    relief();
    scene.updateMissionMonitor(vit, H.samples.length);
    await flushConsumption();
    const active = await api.harness().catch(() => null);
    if (active) {
      simBanner(active.simulation);
      vit.leak = active.active.some((event) => event.kind === "suit_leak") ? 2.2 : 0;
      const tag = JSON.stringify(active.active.map(({ id, t }) => [id, t]));
      if (typeof H.contingencies === "string" && H.contingencies !== tag) planToTarget(true);
      H.contingencies = tag;
    }
    if (!H.inside && H.route && vit.o2_kg < (H.lastPlannedO2 ?? 0) - 0.03 && !H.planning) planToTarget(true);
  } catch {
    $("#traction").textContent = "SIN ENLACE CON KHIPU · ESTADO LOCAL CONSERVADO";
  } finally {
    H.slowBusy = false;
  }
}

function relief() {
  const r = scene.world.getNearbyReliefExtrema(H.x, H.z, 180);
  $("#peak").textContent = `${r.maxPeak >= 0 ? "+" : ""}${r.maxPeak.toFixed(1)} m`;
  $("#valley").textContent = `${r.minValley >= 0 ? "+" : ""}${r.minValley.toFixed(1)} m`;
  $("#peak-dz").textContent = `ΔZ: ${r.deltaPeak >= 0 ? "+" : ""}${r.deltaPeak.toFixed(1)} m`;
  $("#valley-dz").textContent = `ΔZ: ${r.deltaValley.toFixed(1)} m`;
  $("#relief-txt").textContent = `Relieve local de entrenamiento · Rango ${(r.maxPeak - r.minValley).toFixed(1)} m`;
}

async function planToTarget(silent) {
  const t = target();
  if (!t || H.inside || H.samples.includes(t.id)) return;
  const version = H.planVersion = (H.planVersion || 0) + 1;
  H.planning = true;
  try {
    await flushConsumption();
    const points = localRoute(scene, { x: H.x, z: H.z }, t);
    if (points.length < 2) { H.route = null; H.routeError = null; scene.setRoute(null); return; }
    const route = await evaRequest("surface-route", { asset_id: EVA_ID, points, available_o2_kg: vit.o2_kg,
      available_water_kg: vit.water_kg, available_battery_wh: vit.battery_wh });
    if (version !== H.planVersion) return;
    H.route = route;
    H.lastPlannedO2 = vit.o2_kg;
    H.routeError = null;
    scene.setRoute(route.points, route.pnr);
    if (!silent) toast(`Ruta Khipu: ${fmt.m(route.metrics.distance_m)} · ${route.pnr.status === "round_trip_safe" ? "retorno con reserva" : "reserva insuficiente"}`, route.pnr.status === "round_trip_safe" ? "safe" : "danger");
  } catch (e) {
    if (version !== H.planVersion) return;
    H.route = null;
    H.routeError = e.message;
    scene.setRoute(null);
    $("#goal-safe").textContent = "Sin ruta transitable";
    if (!silent) toast(e.message, "danger", 6000);
  } finally { if (version === H.planVersion) H.planning = false; }
}

async function interact(key) {
  if (H.resupplying || scene.cameraMode !== "first") return;
  if (H.prompt === "base") {
    if (!scene.character.toggleBaseAirlock()) return;
    H.keys.clear();
    H.planVersion = (H.planVersion || 0) + 1;
    H.planning = false;
    H.inside = scene.character.isInsideBase;
    H.x = scene.character.position.x;
    H.z = scene.character.position.z;
    document.body.dataset.inside = H.inside ? "1" : "0";
    if (H.inside) {
      H.resupplying = true;
      try {
        await flushConsumption();
        const supply = await evaRequest("resupply", { asset_id: EVA_ID, ...pos() });
        const leak = vit.leak;
        Object.assign(vit, createVitals(), { o2_kg: supply.o2_kg, water_kg: supply.water_kg, battery_wh: supply.battery_wh, leak });
        H.o2Start = supply.o2_kg;
        H.reported = 0;
        H.ledgerQueue = Promise.resolve();
        toast("Hábitat presurizado · traje recargado · E para salir por la esclusa", "safe", 6000);
      } catch (e) { toast(`Recarga pendiente: ${e.message}`, "danger"); }
      finally { H.resupplying = false; }
    } else {
      toast("EVA iniciada · superficie de entrenamiento", "safe");
      planToTarget(true);
    }
    panels();
    slow();
  } else if (key !== "f" && H.prompt === "monitor") {
    modal({ title: "Monitor de misión · Base Alfa", body: `<p>SIMULACIÓN DE ENTRENAMIENTO</p><dl class="kv"><dt>Tripulación</dt><dd>Hábitat presurizado</dd><dt>Muestras</dt><dd>${H.samples.length}/${SAMPLE_CAPACITY}</dd><dt>O₂</dt><dd>${(vit.o2_kg / 1.2 * 100).toFixed(1)}%</dd><dt>Batería</dt><dd>${(vit.battery_wh / 1100 * 100).toFixed(1)}%</dd></dl>` });
  } else if (key !== "f" && H.prompt?.station) {
    const s = H.prompt.station;
    modal({ title: s.infoTitle,
      body: `<p class="small">Equipo de entrenamiento</p><p>${esc(s.infoDesc)}</p><p>${s.fault ? "Falla detectada. Recupera el módulo de alimentación." : "Equipo operativo."}</p>`,
      actions: s.fault ? [{ label: "Cerrar" }, { label: "Reparar", cls: "btn-gold", onClick: () => {
        if (Math.hypot(H.x - s.x, H.z - s.z) > 5.8 || !s.fault) return;
        s.fault = false;
        s.beacon.color.setHex(0x69ddc9);
        vit.grippingUntil = performance.now() + 2500;
        vit.effort.collect();
        vit.battery_wh = Math.max(0, vit.battery_wh - 2);
        H.notice = { text: `${s.name} volvió a estado operativo`, until: performance.now() + 8000 };
        toast(H.notice.text, "safe");
        slow();
      } }] : [{ label: "Cerrar" }]
    });
  } else if (key !== "f" && H.prompt?.companion) {
    const point = H.prompt.companion;
    modal({ title: point.name, body: `<p>${esc(point.description || "Punto de interés de la misión de entrenamiento.")}</p>`,
      actions: [{ label: "Cerrar" }, { label: "Fijar como objetivo", cls: "btn-gold", onClick: () => {
        const index = H.targets.findIndex((target) => target.id === point.id);
        if (index >= 0) { H.ti = index; planToTarget(false); }
      } }] });
  } else if (key !== "f" && H.prompt?.id) {
    if (H.samples.length >= SAMPLE_CAPACITY) { toast("Inventario completo: regresa al hábitat", "danger"); return; }
    const sample = scene.character.tryCollectNearestSample();
    if (!sample) return;
    H.samples.push(sample.id);
    scene.markers.forEach(m => { if (m.e.id === sample.id) { m.collected = true; m.el.hidden = true; } });
    $("#samples").textContent = `${H.samples.length}/${SAMPLE_CAPACITY}`;
    toast(`Muestra recolectada: ${sample.name} · ${sample.yield}`, "safe");
    await flushConsumption().catch(() => {});
    panels();
    slow();
  } else toast("Acércate a una muestra, un activo o la esclusa", "", 1500);
}

function cycleCamera() {
    scene.cameraMode = scene.cameraMode === "third" ? "first" : "third";
    document.body.dataset.camera = scene.cameraMode;
    H.keys.clear();
    toggleHelp(false);
    if (scene.cameraMode === "third") scene.pitch = -0.15;
    scene.renderer.domElement.focus({ preventScroll: true });
}
function handleIntent(r) {
    if (r.intent === "poi_info") {
        let i = H.targets.findIndex((t) => t.id === r.poi_id);
        if (i < 0) {
            const original = entitiesFrom(scenario).find(e => e.id === r.poi_id);
            const normalize = name => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
            const words = normalize(original?.name || "").split(/\W+/).filter(word => word.length > 3);
            const ranked = H.targets.map((t, index) => ({ index, score: words.filter(word => normalize(t.name).includes(word)).length })).sort((a, b) => b.score - a.score);
            if (ranked[0]?.score) i = ranked[0].index;
        }
        if (i >= 0) {
            H.ti = i;
            planToTarget();
        }
    }
    if (r.intent === "filter_pois")
        H.filter = r.category === "all" ? null : { science: ["poi"], sample: ["sample"], vehicle: ["rover"], base: ["base", "habitat", "landmark"], hazard: ["hazard"] }[r.category] || null;
    if (r.intent === "safe_return") {
        const i = H.targets.findIndex((t) => t.kind === "base");
        if (i >= 0) {
            H.ti = i;
            planToTarget();
        }
    }
    if (r.intent === "emergency_stop")
        setSos(true);
    if (r.intent === "status")
        toast(`O₂ ${((vit.o2_kg / 1.2) * 100).toFixed(0)}% · base a ${fmt.m(H.dBase)}`, "", 5000);
    if (r.intent === "help")
        toggleHelp(true);
    $("#fov-filter").textContent = H.filter ? `filtro: ${r.category}` : "";
}
function setSos(on) {
    H.sos = on;
    $("#sos-btn").classList.toggle("pressed", on);
    if (on) {
        const i = H.targets.findIndex((t) => t.kind === "base");
        if (i >= 0) {
            H.ti = i;
            planToTarget();
        }
        toast("SOS: objetivo fijado en la base; detén el avance y espera asistencia", "danger", 6000);
    }
}
function renderHelp() {
    $("#help-body").innerHTML = `<p><b>Moverse:</b> W/S o ▲▼ avanzar/retroceder · A/D o ◀▶ girar · arrastrar para mirar.</p>
    <p><b>E</b> usar la esclusa, recolectar, hablar o inspeccionar y reparar equipos · <b>C</b> para cambiar de cámara. En vista externa, toca la escena para volver · <b>K</b> Khipu voz · <b>H</b> ayuda · <b>Tab</b> siguiente objetivo.</p>
    <p><b>Datos:</b> MOLA regional (463 m/px), con montes, dunas y rocas sintéticos para entrenamiento local. Consumibles: Khipu (Minetti/PLSS/Rohmert). Estamina: esfuerzo acumulado con recuperación. Entidades: escenario sintético.</p>
    <p><b>Walkback:</b> límite a pie ${walkLimit} m con reserva del 25%. Recalcular no repone O₂.</p>`;
}
function toggleHelp(force) {
    const h = $("#help");
    h.hidden = force === undefined ? !h.hidden : !force;
    $("#help-btn").setAttribute("aria-expanded", String(!h.hidden));
}
function bind() {
    const canvas = scene.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Escena EVA. Pulsa C para alternar la cámara o toca la escena para volver al visor");
    canvas.addEventListener("dblclick", () => { if (scene.cameraMode === "third") cycleCamera(); });
    let touch = null;
    canvas.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch" && scene.cameraMode === "third") {
        touch = { id: event.pointerId, x: event.clientX, y: event.clientY };
      }
    });
    canvas.addEventListener("pointerup", (event) => {
      if (touch?.id === event.pointerId && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) < 12) {
        cycleCamera();
      }
      touch = null;
    });
    canvas.addEventListener("pointercancel", () => { touch = null; });
    window.addEventListener("blur", () => H.keys.clear());
    document.addEventListener("visibilitychange", () => { if (document.hidden) H.keys.clear(); });
    const km = { w: "fwd", arrowup: "fwd", s: "back", arrowdown: "back", a: "left", arrowleft: "left", d: "right", arrowright: "right" };
    document.addEventListener("keydown", (e) => {
        if (e.target.closest("input, textarea, select"))
            return;
        const k = e.key.toLowerCase();
        if (km[k]) {
            H.keys.add(km[k]);
            e.preventDefault();
        }
        if ((k === "f" || k === "e") && !e.repeat) { e.preventDefault(); interact(k); }
        if ((k === "c" || k === "v") && !e.repeat)
            cycleCamera();
        if (scene.cameraMode === "third") return;
        if (k === "h")
            toggleHelp();
        if (k === "k")
            voice.start();
        if (k === "tab") {
            e.preventDefault();
            H.ti = (H.ti + 1) % H.targets.length;
            planToTarget(true);
        }
    });
    document.addEventListener("keyup", (e) => { const k = km[e.key.toLowerCase()]; if (k)
        H.keys.delete(k); });
    $$("[data-move]").forEach((b) => {
        const k = b.dataset.move;
        b.addEventListener("pointerdown", (e) => { e.preventDefault(); H.keys.add(k); b.classList.add("pressed"); });
        const off = () => { H.keys.delete(k); b.classList.remove("pressed"); };
        b.addEventListener("pointerup", off);
        b.addEventListener("pointerleave", off);
        b.addEventListener("pointercancel", off);
    });
    $("#act-btn").addEventListener("click", () => interact());
    $("#sos-btn").addEventListener("click", () => setSos(!H.sos));
    $("#camera-btn").addEventListener("click", cycleCamera);
    $("#help-btn").addEventListener("click", () => toggleHelp());
    $("#help-close").addEventListener("click", () => toggleHelp(false));
    $("#voice-btn").addEventListener("click", () => voice.start());
    $("#goal-next").addEventListener("click", () => { H.ti = (H.ti + 1) % H.targets.length; planToTarget(true); });
    $("#goal-prev").addEventListener("click", () => { H.ti = (H.ti - 1 + H.targets.length) % H.targets.length; planToTarget(true); });
    $("#goal-route").addEventListener("click", () => planToTarget(false));
    $("#fov-list").addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (!b)
        return; const i = H.targets.findIndex((t) => t.id === b.dataset.id); if (i >= 0) {
        H.ti = i;
        planToTarget(true);
    } });
}
boot().catch((e) => { console.error(e); toast(`Error: ${e.message}`, "danger", 10000); });

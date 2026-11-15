import { api } from "/static/shared/js/api.js";
import { bearing, fmt, haversine } from "/static/shared/js/geo.js";
import { ASSET_REGISTRY, icon } from "/static/shared/js/icons.js";
import { entitiesFrom, loadRegion, loadScenario } from "/static/shared/js/khipu-client.js";
import { $, $$, colocatedScience, esc, modal, scienceDetails, toast } from "/static/shared/js/ui.js";
import { VoiceCopilot } from "/static/shared/js/voice.js";
import { currentLanguage } from "/static/shared/js/language.js";
import { EvaScene } from "./scene.js";
import { monitorImage } from "./world-assets.js";
import { consume, createVitals, refreshVitals, renderAlerts, renderVitals } from "./vitals.js";
import { localRoute } from "./navigation.js";
import { evaRequest } from "./eva-api.js";
const EVA_ID = new URLSearchParams(location.search).get("eva") || "EVA_01";
const SAMPLE_CAPACITY = 16;
const H = { eventAlerts: new Map(), conditionAlerts: [], x: 0, z: 0, speed: 0, keys: new Set(), targets: [], ti: 0, route: null, samples: [], filter: null, rate: 3, sos: false, inside: false };
window.nawi = H;
let region, scenario, scene, entities, base, vit, voice, walkLimit = 8000;
function iconize() { $$("[data-icon]").forEach((el) => { el.outerHTML = icon(el.dataset.icon); }); }
async function boot() {
    iconize();
    const regions = await api.regions();
    region = await loadRegion(regions.default, 1);
    if (!region.available) {
        throw new Error("El servicio no entregó el terreno MOLA para Ñawi.");
    }
    scenario = await loadScenario();
    entities = entitiesFrom(scenario);
    walkLimit = scenario.eva_policy?.walkback_limit_m || 8000;
    const me = entities.find((e) => e.id === EVA_ID) || entities.find((e) => e.kind === "astronaut");
    base = entities.find((e) => e.kind === "base");
    $("#eva-id").textContent = EVA_ID.replace("_", "-");
    scene = new EvaScene($("#scene"), region, { lat: base.lat, lon: base.lon }, scenario.eva_policy);
    H.scene = scene;
    $("#eva-2d-status").hidden = !scene.overview;
    if (scene.overview) $("#camera-btn").hidden = true;
    const lava = scenario.eva_policy?.lava_tubes;
    if (lava) scenario.hazards = [...(scenario.hazards || []), {
      ...lava, ...scene.toLatLon(lava.x, lava.z), tier: "forbidden", provenance: "synthetic",
    }];
    H.x = scene.character.position.x;
    H.z = scene.character.position.z;
    const half = scene.world.gridSize / 2 - 4;
    const official = entities.filter((point) => point.source === "official_science")
        .map((point) => ({ ...point, ...scene.toLocal(point.lat, point.lon) }))
        .filter(({ x, z }) => Math.abs(x) < half && Math.abs(z) < half);
    entities = [...scene.localEntities(), ...official];
    base = entities.find(e => e.kind === "base");
    const others = entities;
    scene.setMarkers(others, (n) => icon(n));
    const start = scene.toLatLon(H.x, H.z);
    H.targets = others.filter((e) => ["poi", "sample", "base", "rover", "astronaut", "landmark", "antenna"].includes(e.kind))
        .sort((a, b) => haversine(start.lat, start.lon, a.lat, a.lon) - haversine(start.lat, start.lon, b.lat, b.lon));
    H.ti = Math.max(0, H.targets.findIndex((t) => t.kind === "sample" && t.provenance === "synthetic"));
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
    voice = new VoiceCopilot({ iface: "hud", onIntent: handleIntent, button: $("#voice-btn"),
        points: () => H.targets.filter((point) => !H.samples.includes(point.id)).map(({ id, name, description }) =>
            ({ id, name, description: description || "" })) });
    bind();
    api.harness().then((h) => { if (h.active.some((a) => a.kind === "suit_leak"))
        vit.leak = 2.2; }).catch(() => { });
    renderHelp();
    document.addEventListener("qn:language", () => {
      renderHelp();
      $$("[data-monitor]").forEach((image) => { image.src = monitorImage(image.dataset.monitor); });
    });
    planToTarget(true);
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
    const state = scene.move(dt * H.rate, H.keys, H.sos || H.resupplying || !!document.querySelector(".modal-backdrop"), vit.effort.staminaPct, dt);
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
    if (t && H.route && !H.inside) {
        const brg = bearing(p.lat, p.lon, t.lat, t.lon);
        $("#director").hidden = false;
        $("#director").style.transform = `translateX(-50%) rotate(${((brg - hdg + 540) % 360) - 180}deg)`;
    } else $("#director").hidden = true;
    const fov = entities.filter((x) => x.id !== EVA_ID && !H.samples.includes(x.id) && !H.inside).map((x) => ({ x, d: haversine(p.lat, p.lon, x.lat, x.lon), rel: ((bearing(p.lat, p.lon, x.lat, x.lon) - hdg + 540) % 360) - 180 }))
        .filter((o) => Math.abs(o.rel) <= 45 && o.d <= 2500 && (!H.filter || H.filter.includes(o.x.kind))).sort((a, b) => a.d - b.d).slice(0, 10);
    $("#fov-list").innerHTML = fov.length ? fov.map((o) => { const reg = ASSET_REGISTRY[o.x.kind] || ASSET_REGISTRY.poi; return `<div class="fov-item ${t && o.x.id === t.id ? "active" : ""}" style="color:${reg.color}">${icon(reg.icon)}<span class="n">${esc(o.x.name)}</span><span class="d">${fmt.m(o.d)}</span></div>`; }).join("")
        : `<div class="small dim">Nada en el campo visual${H.filter ? " (filtro activo)" : ""}</div>`;
    scene.markers.forEach((m) => { m.hidden = H.filter ? !H.filter.includes(m.e.kind) : false; });
    const dBase = base ? haversine(p.lat, p.lon, base.lat, base.lon) : Infinity;
    const smp = entities.filter(x => x.provenance === "synthetic" && x.kind === "sample" && !H.samples.includes(x.id))
        .map(x => ({ entity: x, distance: Math.hypot(H.x - x.x, H.z - x.z) }))
        .filter(x => x.distance < 4.8).sort((a, b) => a.distance - b.distance)[0]?.entity;
    const station = scene.world.interactiveStations.find(s => Math.hypot(H.x - s.x, H.z - s.z) < 5.8);
    const companion = entities.filter(e => e.source === "official_science" || ["rover", "astronaut", "poi"].includes(e.kind))
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

function renderHudAlerts() {
    renderAlerts([...H.conditionAlerts, ...H.eventAlerts.values()]);
}

function eventAlert(code, text, level = "warning", duration = 5500) {
    const alert = { code, level, text };
    H.eventAlerts.set(code, alert);
    renderHudAlerts();
    setTimeout(() => {
        if (H.eventAlerts.get(code) !== alert) return;
        H.eventAlerts.delete(code);
        renderHudAlerts();
    }, duration);
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
      else if (distance < (hz.warning_distance_m ?? 250)) alerts.push({ level: "warning", code: "HAZARD_NEAR", text: `${hz.name} a ${distance.toFixed(0)} m` });
    }
    const hazard = scene.character.proximityHazard;
    if (!H.inside && hazard.hasHazard) alerts.push({ level: "warning", code: "TERRAIN", text: hazard.message });
    if (vit.effort.staminaPct < 35) alerts.push({ level: "warning", code: "STAMINA", text: "Estamina baja: descansa para recuperarte" });
    if (vit.effort.heartRateBpm > 160) alerts.push({ level: "warning", code: "HR", text: "Frecuencia cardíaca elevada" });
    if (H.sos) alerts.push({ level: "critical", code: "SOS", text: "Emergencia EVA declarada — retorno asistido" });
    if (vit.leak) alerts.push({ level: "critical", code: "LEAK", text: "Fuga en traje: consumo O₂ x2.2" });
    if (!H.inside && H.storm) alerts.push({ level: "critical", code: "STORM", text: "Tormenta de polvo de entrenamiento" });
    if (!result) alerts.push({ level: "warning", code: "CONNECTION", text: "Sin enlace con Khipu" });
    H.conditionAlerts = alerts;
    renderHudAlerts();
    $("#traction").textContent = H.inside ? "HÁBITAT PRESURIZADO · ENTRENAMIENTO" : hazard.hasHazard ? hazard.message : H.gradient > 0.2 ? "SUBIDA ESCARPADA · AVANCE REDUCIDO" : "TRACCIÓN NOMINAL";
    relief();
    scene.updateMissionMonitor(vit, H.samples.length);
    await flushConsumption();
    const active = await api.harness().catch(() => null);
    if (active) {

      H.storm = active.active.some((event) => event.kind === "dust_storm");
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
  if (H.planning && silent) { H.replanPending = true; return null; }
  const t = target();
  if (!t || H.inside || H.samples.includes(t.id)) {
    if (!silent) eventAlert("ROUTE", H.inside ? "Sal de la base para iniciar la guía." : "No hay un objetivo disponible.");
    return null;
  }
  const version = H.planVersion = (H.planVersion || 0) + 1;
  H.planning = true;
  try {
    await flushConsumption();
    if (version !== H.planVersion) return;
    const points = localRoute(scene, { x: H.x, z: H.z }, t);
    if (points.length < 2) {
      H.route = null;
      H.routeError = "Ya estás en el objetivo.";
      scene.setRoute(null);
      return;
    }
    const route = await evaRequest("surface-route", { asset_id: EVA_ID, points, available_o2_kg: vit.o2_kg,
      available_water_kg: vit.water_kg, available_battery_wh: vit.battery_wh,
      ltst_h: (13 + vit.elapsed_s * 24 / (24.6597 * 3600)) % 24 });
    if (version !== H.planVersion) return;
    H.route = route;
    H.eventAlerts.delete("ROUTE");
    renderHudAlerts();
    H.lastPlannedO2 = vit.o2_kg;
    H.routeError = null;
    scene.setRoute(route.points, route.pnr);
    if (!silent && !voice?.listening) toast(`Ruta Khipu: ${fmt.m(route.metrics.distance_m)} · ${route.pnr.classification === "INDETERMINATE" ? "retorno no concluyente" : route.pnr.status === "round_trip_safe" ? "retorno con reserva" : "reserva insuficiente"}`, route.pnr.status === "round_trip_safe" ? "safe" : "danger");
    return route;
  } catch (e) {
    if (version !== H.planVersion) return;
    H.route = null;
    H.routeError = e.message;
    scene.setRoute(null);
    eventAlert("ROUTE", e.message);
    return null;
  } finally {
    if (version === H.planVersion) {
      H.planning = false;
      if (H.replanPending) { H.replanPending = false; queueMicrotask(() => planToTarget(true)); }
    }
  }
}

async function interact(key) {
  if (H.resupplying || H.interacting || document.querySelector(".modal-backdrop") || scene.cameraMode !== "first") return;
  H.keys.clear();
  H.interacting = true;
  try {
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
    modal({ title: "Monitor de misión · Base Alfa", body: `<img class="monitor-preview" data-monitor="hatunWasi" src="${monitorImage("hatunWasi")}" alt="Captura de Hatun Wasi"><dl class="kv"><dt>Tripulación</dt><dd>Hábitat presurizado</dd><dt>Muestras</dt><dd>${H.samples.length}/${SAMPLE_CAPACITY}</dd><dt>O₂</dt><dd>${(vit.o2_kg / 1.2 * 100).toFixed(1)}%</dd><dt>Batería</dt><dd>${(vit.battery_wh / 1100 * 100).toFixed(1)}%</dd></dl>` });
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
        eventAlert("ACTION", `${s.name} volvió a estado operativo`, "info");
        slow();
      } }] : [{ label: "Cerrar" }]
    });
  } else if (key !== "f" && H.prompt?.companion) {
    const point = H.prompt.companion;
    if (point.source === "official_science") {
      const records = colocatedScience(point, entities);
      modal({ title: "Catálogo científico oficial", body: records.map((record) =>
        "<h3>" + esc(record.name) + "</h3><p>" + esc(record.description) + "</p>" + scienceDetails(record)).join("") });
      return;
    }
    const data = document.createElement("div");
    data.innerHTML = `<p>${esc(point.description || "Punto de interés de entrenamiento.")}</p>
      <dl class="kv"><dt>Posición</dt><dd>${fmt.lat(point.lat)}, ${fmt.lon(point.lon)}</dd>
      <dt>Distancia</dt><dd>${fmt.m(Math.hypot(H.x - point.x, H.z - point.z))}</dd></dl>`;
    const actions = [{ label: "Cerrar" }];
    if (point.monitor) actions.push({
      label: "Monitor de Chaski",
      onClick: () => {
        const preview = document.createElement("img");
        preview.className = "monitor-preview";
        preview.dataset.monitor = point.monitor;
        preview.src = monitorImage(point.monitor);
        preview.alt = "Captura de Chaski";
        data.replaceChildren(preview);
        return true;
      },
    });
    if (point.kind === "astronaut") actions.push({
      label: "Hablar", cls: "btn-gold", onClick: () => {
        const speech = point.activity === "walking"
          ? "Estoy recorriendo el sector. Las muestras cercanas ya están marcadas."
          : "Estoy revisando el equipo. Si la torre indica una falla, puedes reparar el módulo de alimentación.";
        data.textContent = speech;
        voice.speak(speech);
        return true;
      },
    });
    if (point.kind === "rover") actions.push({
      label: "Telemetría", cls: "btn-gold", onClick: async () => {
        const match = point.name.match(/([A-Z]+)-(\d+)/);
        const roster = scenario.assets.find((a) => match && a.id === "ROVER_" + match[1] + Number(match[2]));
        const ledger = roster ? await api.ledger(roster.id, "rover").catch(() => null) : null;
        const remaining = ledger && ledger.capacity > 0 ? `${(ledger.remaining / ledger.capacity * 100).toFixed(0)} %` : "sin lectura";
        data.innerHTML += `<dl class="kv"><dt>Batería</dt><dd>${remaining}</dd>
          <dt>Velocidad de referencia</dt><dd>${roster?.speed_mps ?? "—"} m/s</dd><dt>Origen</dt><dd>Entrenamiento</dd></dl>`;
        return true;
      },
    });
    modal({ title: point.name, body: data, actions });
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
  } finally { H.interacting = false; }
}

function cycleCamera() {
    if (scene.overview) return;
    scene.cameraMode = scene.cameraMode === "third" ? "first" : "third";
    document.body.dataset.camera = scene.cameraMode;
    H.keys.clear();
    toggleHelp(false);
    if (scene.cameraMode === "third") scene.pitch = -0.15;
    scene.renderer.domElement.focus({ preventScroll: true });
}
async function handleIntent(result) {
    const { intent } = result;
    if (["plan_target", "next_target", "safe_return"].includes(intent)) {
        const options = H.targets.filter((point) => !H.samples.includes(point.id));
        const next = intent === "plan_target" ? options.find((point) => point.id === result.poi_id)
            : intent === "safe_return" ? base
            : options[(options.findIndex((point) => point.id === target()?.id) + 1) % options.length];
        if (!next) return "No hay un objetivo disponible.";
        H.ti = H.targets.indexOf(next);
        const route = await planToTarget();
        if (!route) return H.routeError || "No se pudo trazar la ruta.";
        const marker = route.pnr?.pnr_point;
        if (currentLanguage() === "en") {
            const returnNote = marker
                ? `Point of no return at ${fmt.m(marker.distance_m)}` : "Return reserve maintained throughout";
            return `Route to ${next.name}. Distance ${fmt.m(route.metrics.distance_m)}. ${returnNote}.`;
        }
        return `Ruta a ${next.name}. Distancia ${fmt.m(route.metrics.distance_m)}. ${marker
            ? "Punto de no retorno a " + fmt.m(marker.distance_m) : route.pnr?.classification === "INDETERMINATE" ? "Retorno no concluyente" : "Retorno con reserva en todo el recorrido"}.`;
    }
    if (intent === "poi_info") {
        const point = H.targets.find((candidate) => candidate.id === result.poi_id);
        if (point?.source === "official_science" && point.materials.length) {
            const materials = point.materials.join(", ");
            return currentLanguage() === "en" ? point.name + ". Reported materials: " + materials + "."
                : point.name + ". Materiales citados: " + materials + ".";
        }
    }
    if (intent === "clear_route") {
        H.planVersion = (H.planVersion || 0) + 1;
        H.planning = false;
        H.ti = -1;
        H.route = null;
        scene.setRoute(null);
    }
    if (intent === "filter_pois") {
        H.filter = { science: ["poi"], sample: ["sample"], vehicle: ["rover"], base: ["base", "habitat", "landmark"], hazard: ["hazard"] }[result.category] || null;
        $("#fov-filter").textContent = H.filter ? "Filtro activo" : "";
    }
    if (intent === "emergency_stop") setSos(true);
    if (intent === "status") {
        const oxygen = (vit.o2_kg / 1.2 * 100).toFixed(0);
        const distance = fmt.m(H.dBase);
        return currentLanguage() === "en" ? `Oxygen ${oxygen} percent. Base is ${distance} away.`
            : `Oxígeno ${oxygen} por ciento. Base a ${distance}.`;
    }
    if (intent === "help") toggleHelp(true);
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
    const commands = currentLanguage() === "en" ? [
      "Route to [point]", "Return to base", "Next target", "Clear route", "Status", "Describe [point]",
      "Filter science / hazards / vehicles / samples / base / all", "Emergency stop", "Help",
    ] : [
      "Ruta a [punto]", "Vuelve a base (Return to base)", "Siguiente objetivo", "Borra ruta", "Estado",
      "Info de [punto]", "Filtra ciencia / peligro / vehículos / muestras / base / todo", "Parada de emergencia", "Ayuda",
    ];
    $("#help-body").innerHTML = `<p><b>Moverse:</b> W/S o ▲▼ avanzar/retroceder · A/D o ◀▶ girar · arrastrar para mirar.</p>
    <p><b>E</b> usar la esclusa, recolectar, hablar o inspeccionar y reparar equipos · <b>C</b> para cambiar de cámara. En vista externa, toca la escena para volver · <b>K</b> Khipu voz · <b>H</b> ayuda. Pulsa K o el botón de voz para dar una orden.</p>
    <h3>Comandos de voz</h3><ul>${commands.map((command) => "<li>" + esc(command) + "</li>").join("")}</ul>
    <p><b>Datos:</b> <span>MOLA regional (463 m/px), con montes, dunas y rocas sintéticos para entrenamiento local. Consumibles: Khipu (Minetti/PLSS/Rohmert). Estamina: esfuerzo acumulado con recuperación. Los puntos NASA cercanos se pueden inspeccionar desde el visor.</span></p>
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
        if (k === "k" && !e.repeat)
            voice.start();
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
    $("#eva-demo-toggle").addEventListener("click", (event) => {
        const controls = $("#eva-demo-controls");
        controls.hidden = !controls.hidden;
        event.currentTarget.setAttribute("aria-expanded", String(!controls.hidden));
        if (controls.hidden) H.keys.clear();
    });
}
$("#eva-retry").addEventListener("click", () => location.reload());
boot().catch((error) => {
    console.error(error);
    $("#eva-load-message").textContent = error.message;
    $("#eva-load-error").hidden = false;
    document.body.dataset.ready = "error";
});

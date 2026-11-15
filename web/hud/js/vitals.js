import { EffortModel } from "./effort.js";
import { api } from "/static/shared/js/api.js";
import { $, esc } from "/static/shared/js/ui.js";
export const SUIT = { o2_cap: 1.2, water_cap: 1.65, bat_cap: 1100 };
export function createVitals() {
    return { o2_kg: SUIT.o2_cap, water_kg: SUIT.water_cap, battery_wh: SUIT.bat_cap, elapsed_s: 0, grip_min: 0, last: null, rates: null, effort: new EffortModel() };
}
export function consume(v, dtSim) {
    if (!v.rates)
        return;
    const h = dtSim / 3600;
    v.o2_kg = Math.max(0, v.o2_kg - v.rates.o2_kg_h * h * (v.leak || 1));
    v.water_kg = Math.max(0, v.water_kg - v.rates.water_kg_h * h);
    v.battery_wh = Math.max(0, v.battery_wh - v.rates.power_w * h);
    v.elapsed_s += dtSim;
}
export async function refreshVitals(v, { speed, gradient, distanceToBase, walkbackLimit, gripping }) {
    const r = await api.vitals({ speed_mps: speed, gradient, elapsed_s: v.elapsed_s, o2_kg: v.o2_kg, water_kg: v.water_kg,
        battery_wh: v.battery_wh, grip_fraction: gripping ? 0.45 : 0.2, grip_minutes: v.grip_min, distance_to_base_m: distanceToBase,
        walkback_limit_m: walkbackLimit });
    v.rates = r.rates;
    v.last = r;
    return r;
}
export function renderVitals(v, extra) {
    const r = v.last;
    const o2pct = (v.o2_kg / SUIT.o2_cap) * 100, batpct = (v.battery_wh / SUIT.bat_cap) * 100;
    const set = (id, t) => { $(id).textContent = t; };
    set("#o2", `${o2pct.toFixed(1)}%`);
    set("#bat", `${batpct.toFixed(1)}%`);
    if (r) {
        set("#o2-min", `${Math.round(r.hours_left.o2 * 60)} min`);
        set("#bat-h", `${r.hours_left.battery.toFixed(1)} h`);
        set("#hr", `${Math.round(v.effort.heartRateBpm)} bpm`);
        const st = v.effort.staminaPct;
        set("#stamina", `${st.toFixed(0)}%`);
        set("#stamina-pct", `${st.toFixed(0)}%`);
        $("#stamina-bar").style.width = `${st}%`;
        $("#stamina-bar").style.background = st < 35 ? "var(--danger)" : st < 60 ? "var(--warn)" : "linear-gradient(90deg,var(--copper),var(--gold))";
        const wb = r.walkback.walkback_m;
        set("#walkback", `${(wb / 1000).toFixed(2)} km`);
        const inside = extra.distanceToBase <= wb;
        $("#wb-state").textContent = inside ? "Seguro" : "FUERA";
        $("#wb-state").className = inside ? "ok" : "bad";
        $("#effort-body").innerHTML = `Metabólico: ${r.metabolic_w.toFixed(0)} W<br>O₂: ${(r.rates.o2_kg_h * 1000).toFixed(0)} g/h · agua ${(r.rates.water_kg_h * 1000).toFixed(0)} g/h<br>
      Fatiga muscular: ${(v.effort.accumulatedFatigue * 100).toFixed(0)}%<br>Fatiga guantes: ${(r.glove_fatigue * 100).toFixed(0)}%<br>Recurso limitante: ${esc(r.hours_left.limiting)}<br>
      ${v.effort.topConsumptionCauses.map(c => `${esc(c.name)}: ${c.share}%`).join("<br>")}<br><span class="dim">${esc(r.model)}</span>`;
        $("#v-o2").className = `v ${o2pct < 20 ? "crit" : o2pct < 40 ? "warn" : ""}`;
        $("#v-bat").className = `v ${batpct < 15 ? "crit" : batpct < 35 ? "warn" : ""}`;
        $("#v-hr").className = `v ${v.effort.heartRateBpm > 175 ? "crit" : v.effort.heartRateBpm > 150 ? "warn" : ""}`;
        $("#v-st").className = `v ${st < 35 ? "warn" : ""}`;
        $("#v-wb").className = `v ${inside ? "" : "crit"}`;
    }
}
const ORDER = { critical: 0, warning: 1, info: 2 };
export function renderAlerts(list) {
    const sorted = [...list].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
    $(".suit").hidden = sorted.length === 0;
    $("#alert-count").textContent = String(sorted.filter((a) => a.level !== "info").length);
    $("#alert-count").className = `badge ${sorted.some((a) => a.level === "critical") ? "danger" : sorted.length ? "synthetic" : "cached"}`;
    $("#suit-alerts").innerHTML = sorted.length ? sorted.map((a) => `<div class="a ${a.level}" data-code="${esc(a.code)}">${a.level === "critical" ? "CRÍTICO: " : a.level === "warning" ? "Aviso: " : ""}${esc(a.text)}</div>`).join("")
        : `<div class="empty">Sin avisos activos</div>`;
    const crit = sorted.find((a) => a.level === "critical");
    $("#critical").hidden = !crit;
    if (crit)
        $("#critical").textContent = crit.text;
}

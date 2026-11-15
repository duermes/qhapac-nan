// Small UI toolkit: toasts, draggable bounded decks, modals, provenance badges.
import { icon } from "./icons.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function toast(text, kind = "", ms = 4200) {
  let stack = $(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  const t = document.createElement("div");
  t.className = `toast panel ${kind}`;
  t.textContent = text;
  stack.appendChild(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

const PROV = {
  official_nasa: ["official", "NASA original"],
  official_usgs: ["official", "USGS original"],
  derived_from_nasa: ["derived", "Derivado NASA"],
  live_service: ["live", "Servicio en vivo"],
  live: ["live", "En vivo"],
  cached: ["cached", "Caché"],
  model: ["model", "Modelo"],
  synthetic: ["synthetic", "Sintético"],
  user: ["cached", "Creado por usuario"],
  unavailable: ["unavailable", "No disponible"],
  fallback: ["unavailable", "Fallback"],
};
export function provBadge(p) {
  const [cls, label] = PROV[p] || ["unavailable", p || "desconocido"];
  return `<span class="badge ${cls}" data-provenance="${esc(p)}" title="Procedencia: ${esc(label)}">${esc(label)}</span>`;
}

export function scienceDetails(point) {
  if (point.source !== "official_science") return "";
  const asField = (label, value) => value != null && value !== ""
    ? '<dt>' + label + '</dt><dd>' + esc(value) + '</dd>' : "";
  return '<dl class="kv">'
    + asField(point.category === "rover_sample" ? "Materiales citados en el informe" : "Materiales detectados", point.materials.join(", "))
    + asField("Instrumento o misión", point.instrument)
    + asField("Campaña", point.campaign)
    + asField("Sol", point.sol)
    + asField("Elevación del informe", point.reported_elevation_m == null ? null : point.reported_elevation_m + " m")
    + asField("Registros de origen", point.record_ids?.join(", "))
    + '</dl><a class="small" href="' + esc(point.source_url) + '" target="_blank" rel="noopener noreferrer">'
    + esc(point.provider) + '</a>';
}

export function colocatedScience(point, entities) {
  return point.source === "official_science" ? entities.filter((e) =>
    e.source === point.source && e.lat === point.lat && e.lon === point.lon) : [];
}

export function colocatedScienceSelect(point, nearby) {
  if (nearby.length < 2) return "";
  return '<label class="label" for="same-location">Registros en esta ubicación</label><select id="same-location" class="select">'
    + nearby.map((e) => '<option value="' + esc(e.id) + '"' + (e.id === point.id ? ' selected' : '') + '>' + esc(e.name) + '</option>').join('')
    + '</select>';
}

export function classLegend(classes) {
  return '<ul class="science-legend">' + classes.map((c) =>
    '<li><span style="background:' + esc(c.color) + '"></span>'
      + esc(c.symbol || c.label) + (c.symbol ? ' · ' + esc(c.label) : '') + '</li>').join('') + '</ul>';
}

/** Keep an absolutely positioned element inside its container. */
export function clampInto(el, container = el.offsetParent || document.body, minTop = 8) {
  const cw = container.clientWidth, ch = container.clientHeight;
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = el.offsetLeft, y = el.offsetTop;
  x = Math.min(Math.max(8, x), Math.max(8, cw - w - 8));
  y = Math.min(Math.max(minTop, y), Math.max(minTop, ch - Math.min(h, ch - minTop) - 8));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
}

/** Drag only by the handle; never leave the viewport; top boundary respected. */
export function makeDraggable(el, handle, { minTop = 8 } = {}) {
  let sx, sy, ox, oy, dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, input, select, a, [data-nodrag]")) return;
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    sx = e.clientX; sy = e.clientY; ox = el.offsetLeft; oy = el.offsetTop;
    el.style.right = "auto"; el.style.bottom = "auto"; el.style.transform = "none";
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    el.style.left = `${ox + e.clientX - sx}px`;
    el.style.top = `${oy + e.clientY - sy}px`;
    clampInto(el, el.offsetParent || document.body, minTop);
  });
  const end = () => { dragging = false; };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  window.addEventListener("resize", () => { if (!el.hidden) clampInto(el, el.offsetParent || document.body, minTop); });
}

/** Create a floating deck (draggable, closable, bounded). */
export function createDeck({ id, title, parent, x, y, width, cls = "" }) {
  const d = document.createElement("section");
  d.className = `deck panel ${cls}`;
  d.id = id;
  d.hidden = true;
  d.setAttribute("role", "dialog");
  d.setAttribute("aria-label", title);
  d.innerHTML = `<header class="panel-head deck-handle"><span>${esc(title)}</span>
    <button class="btn btn-icon deck-close" aria-label="Cerrar ${esc(title)}" data-nodrag>${icon("x")}</button></header>
    <div class="deck-body"></div>`;
  if (width) d.style.width = `${width}px`;
  d.style.left = `${x}px`;
  d.style.top = `${y}px`;
  parent.appendChild(d);
  makeDraggable(d, d.querySelector(".deck-handle"), { minTop: 8 });
  d.querySelector(".deck-close").addEventListener("click", () => { d.hidden = true; d.dispatchEvent(new CustomEvent("deck:close")); });
  d.body = d.querySelector(".deck-body");
  new ResizeObserver(() => { if (!d.hidden) clampInto(d, d.offsetParent || parent); }).observe(d);
  d.open = () => { d.hidden = false; clampInto(d, d.offsetParent || parent); requestAnimationFrame(() => clampInto(d, d.offsetParent || parent)); d.dispatchEvent(new CustomEvent("deck:open")); };
  d.close = () => { d.hidden = true; d.dispatchEvent(new CustomEvent("deck:close")); };
  d.toggle = () => (d.hidden ? d.open() : d.close());
  return d;
}

export function modal({ title, body, actions = [] }) {
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.innerHTML = `<div class="modal panel cut" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header class="panel-head"><span>${esc(title)}</span><button class="btn btn-icon" data-close aria-label="Cerrar">${icon("x")}</button></header>
    <div class="deck-body"></div>
    <footer class="panel-body" style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--joint)"></footer></div>`;
  const b = back.querySelector(".deck-body");
  if (typeof body === "string") b.innerHTML = body; else b.appendChild(body);
  const foot = back.querySelector("footer");
  if (!actions.length) foot.remove();
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  actions.forEach((a) => {
    const btn = document.createElement("button");
    btn.className = `btn ${a.cls || ""}`;
    btn.textContent = a.label;
    btn.addEventListener("click", async () => { const keep = await a.onClick?.(back); if (!keep) close(); });
    foot.appendChild(btn);
  });
  back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-close]")) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(back);
  setTimeout(() => back.querySelector("button, input, select")?.focus(), 0);
  return { el: back, close };
}

export function simBanner(active) {
  let b = $(".sim-banner");
  if (active && !b) {
    b = document.createElement("div");
    b.className = "sim-banner";
    b.setAttribute("role", "status");
    b.textContent = "SIMULACIÓN ACTIVA — contingencias de demo inyectadas";
    document.body.appendChild(b);
  } else if (!active && b) b.remove();
}

export function onClickOutside(el, cb, ignore = []) {
  const h = (e) => {
    if (el.hidden) return;
    if (el.contains(e.target) || ignore.some((i) => i && i.contains(e.target))) return;
    cb(e);
  };
  document.addEventListener("pointerdown", h, true);
  return () => document.removeEventListener("pointerdown", h, true);
}

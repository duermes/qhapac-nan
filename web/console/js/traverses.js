// Traverse rack: add / toggle / rename inline / delete — homogeneous for every card.
import { fmt } from "/static/shared/js/geo.js";
import { icon } from "/static/shared/js/icons.js";
import { $, esc, toast } from "/static/shared/js/ui.js";
import { persist, refreshScene } from "./app.js";

let ctx;

export function initTraverses(c) {
  ctx = c;
  $("#new-traverse").addEventListener("click", () => addTraverse());
  $("#traverse-toggle").addEventListener("click", () => {
    const el = $("#traverses");
    el.classList.toggle("collapsed");
    $("#traverse-toggle").setAttribute("aria-expanded", String(!el.classList.contains("collapsed")));
  });
  $("#traverse-list").addEventListener("click", onClick);
  $("#traverse-list").addEventListener("keydown", (event) => {
    if (event.target.matches("[data-tid]") && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      event.target.click();
      $("#traverse-list .trav.active")?.focus();
    }
  });
  $("#traverse-list").addEventListener("dblclick", (e) => {
    const card = e.target.closest("[data-tid]");
    if (card && e.target.closest(".trav-name")) startRename(card.dataset.tid);
  });
  ctx.on("session", render);
  ctx.on("traverses", render);

}

export function addTraverse(silent = false) {
  const s = ctx.cur;
  const n = s.traverses.length + 1;
  const t = { id: `T${Date.now().toString(36)}${n}`, name: `Travesía ${String(n).padStart(2, "0")}`, origin: null, destination: null,
    waypoints: [], params: {}, result: null, variant: "balanced", saved: false, visible: true, status: "draft" };
  s.traverses.push(t);
  s.activeTraverse = t.id;
  persist();
  ctx.emit("traverses");
  ctx.emit("active-traverse", t);
  if (!silent) toast(`${t.name} creada`, "safe", 1600);
  return t;
}

export function activeTraverse() {
  const s = ctx.cur;
  return s.traverses.find((t) => t.id === s.activeTraverse) || null;
}

function onClick(e) {
  const card = e.target.closest("[data-tid]");
  if (!card) return;
  const s = ctx.cur;
  const t = s.traverses.find((x) => x.id === card.dataset.tid);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "eye") { t.visible = t.visible === false; refreshScene(); }
  else if (act === "rename") { startRename(t.id); return; }
  else if (act === "delete") {
    s.traverses = s.traverses.filter((x) => x.id !== t.id);
    if (s.activeTraverse === t.id) s.activeTraverse = s.traverses[0]?.id || null;
    toast(`${t.name} eliminada`, "", 1600);
    ctx.emit("active-traverse", activeTraverse());
  } else if (!e.target.closest("input")) {
    s.activeTraverse = t.id;
    ctx.emit("active-traverse", t);
  }
  persist();
  render();
  refreshScene();
}

function startRename(tid) {
  const card = $(`[data-tid="${tid}"] .trav-name`);
  const t = ctx.cur.traverses.find((x) => x.id === tid);
  card.innerHTML = `<input class="input rename-input" value="${esc(t.name)}" aria-label="Nuevo nombre" maxlength="60" />`;
  const inp = card.querySelector("input");
  inp.focus(); inp.select();
  const commit = (ok) => {
    if (ok && inp.value.trim()) t.name = inp.value.trim();
    persist();
    render();
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(true); if (e.key === "Escape") commit(false); e.stopPropagation(); });
  inp.addEventListener("blur", () => commit(true));
}

function label(p) { return p ? (p.id || `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`) : "—"; }

export function render() {
  const s = ctx.cur;
  const n = s.traverses.length;
  $("#traverse-count").textContent = `${n} ${n === 1 ? "Ruta" : "Rutas"}`;
  $("#traverse-list").innerHTML = n ? s.traverses.map((t) => {
    const v = t.result?.variants?.find((x) => x.variant === t.variant);
    const status = t.status === "infeasible" ? `<span style="color:var(--danger)">Inviable</span>`
      : v ? `${fmt.m(v.metrics.distance_m)} · ${fmt.dur(v.metrics.duration_s)}${t.saved ? " · guardada" : ""}` : t.result?.static_origin ? fmt.m(t.result.direct.distance_m) : "Sin calcular";
    return `<article class="trav ${t.id === s.activeTraverse ? "active" : ""}" data-tid="${t.id}" tabindex="0" aria-current="${t.id === s.activeTraverse}">
      <div class="trav-head"><span class="dot"></span><span class="trav-name" title="Doble clic para renombrar">${esc(t.name)}</span>
        <button class="btn btn-icon" data-act="rename" aria-label="Renombrar ${esc(t.name)}">${icon("edit")}</button>
        <button class="btn btn-icon" data-act="eye" aria-pressed="${t.visible !== false}" aria-label="Mostrar u ocultar ${esc(t.name)}">${icon(t.visible === false ? "eyeoff" : "eye")}</button>
        <button class="btn btn-icon" data-act="delete" aria-label="Eliminar ${esc(t.name)}">${icon("x")}</button></div>
      <div class="trav-sub">${esc(label(t.origin))} → ${esc(label(t.destination))}</div>
      <div class="trav-foot"><span>${status}</span>${t.id === s.activeTraverse ? '<span class="st-active">ACTIVA</span>' : ""}</div></article>`;
  }).join("") : `<div class="empty-state">Sin travesías. Crea una con «Nueva travesía».</div>`;
}

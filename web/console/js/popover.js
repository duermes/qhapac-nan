// Smart point popover: inspection, metadata, actions and in-situ edit form.
import { api } from "/static/shared/js/api.js";
import { fmt } from "/static/shared/js/geo.js";
import { ASSET_REGISTRY, icon } from "/static/shared/js/icons.js";
import { isMobile } from "/static/shared/js/khipu-client.js";
import { $, esc, modal, onClickOutside, provBadge, toast } from "/static/shared/js/ui.js";
import { refreshScene, reloadAssets } from "./app.js";
import { addWaypointToRoute, calculate, invalidate, setEndpoint } from "./planning.js";
import { activeTraverse } from "./traverses.js";

let ctx, pop;

export function initPopover(c) {
  ctx = c;
  pop = document.createElement("div");
  pop.className = "popover panel";
  pop.id = "point-popover";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Detalle del punto");
  $("#stage").appendChild(pop);
  onClickOutside(pop, () => close(), [$("#map2d"), $("#map3d")]);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { setAddMode(false); close(); } });
  ctx.on("mapclick", onMapClick);
  ctx.on("mode", close);
  ctx.on("entities", markDraggable);
  ctx.map2d.on("entitydrag", () => close());
  ctx.map2d.on("entitydrop", onDrop);
  $("#new-point").addEventListener("click", () => setAddMode(!ctx.cur.addMode));
  ctx.popover = { close, openEntity: (e, xy) => openEntity(e, xy) };
}

export function setAddMode(on) {
  ctx.cur.addMode = on;
  $("#new-point").setAttribute("aria-pressed", String(on));
  $("#map2d").classList.toggle("adding", on);
  if (on) toast("Haz clic en el mapa para crear un punto (Esc cancela)", "", 2500);
}

function markDraggable() {
  for (const e of ctx.entities) e.draggable = e.source === "user" && !e.locked;
}

function close() { pop.hidden = true; ctx.selection = null; refreshScene(); }

function place(screen) {
  const st = $("#stage").getBoundingClientRect();
  let x = screen ? screen.x + 14 : st.width / 2 - 145, y = screen ? screen.y - 20 : st.height / 2 - 150;
  pop.hidden = false;
  x = Math.min(Math.max(8, x), st.width - pop.offsetWidth - 8);
  y = Math.min(Math.max(70, y), st.height - pop.offsetHeight - 8);
  pop.style.left = `${x}px`;
  pop.style.top = `${y}px`;
}

function onMapClick({ ll, hit, screen }) {
  if (ctx.cur.addMode) { addPointDialog(ll); return; }
  if (hit) { openEntity(hit, screen); return; }
  openPoint(ll, screen);
}

function metaBlock(lat, lon) {
  const e = ctx.region.elevationAt(lat, lon), s = ctx.region.slopeAt(lat, lon);
  return `<dl class="kv"><dt>Latitud</dt><dd>${fmt.lat(lat)}</dd><dt>Longitud</dt><dd>${fmt.lon(lon)}</dd>
    <dt>Elevación MOLA</dt><dd>${e == null ? "sin dato" : e.toFixed(0) + " m"}</dd><dt>Pendiente</dt><dd>${s == null ? "—" : s.toFixed(1) + "°"}</dd></dl>`;
}

function openPoint(ll, screen) {
  ctx.selection = null;
  const selecting = ctx.cur.mode === "plan" && activeTraverse();
  pop.innerHTML = `<div class="pop-head"><div><div class="pop-title">Punto del terreno</div><div class="pop-kind">inspección</div></div>
      <button class="btn btn-icon" data-x aria-label="Cerrar">${icon("x")}</button></div>
    <div class="pop-body">${metaBlock(ll.lat, ll.lon)}<div class="dim" style="font-size:10px;margin-top:6px">${provBadge("derived_from_nasa")} interpolación bilineal de MOLA 463 m/px</div></div>
    <div class="pop-actions"><button class="btn" data-a="wp">${icon("pin")} Crear waypoint</button><button class="btn" data-a="dest" ${selecting ? "" : "hidden"}>${icon("target")} Usar como destino</button>
      <button class="btn" data-a="orig" ${selecting ? "" : "hidden"}>${icon("nav")} Usar como origen</button><button class="btn" data-a="focus">${icon("focus")} Enfocar</button></div>`;
  place(screen);
  pop.querySelector("[data-x]").onclick = close;
  pop.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", () => {
    const a = b.dataset.a;
    if (a === "wp") addPointDialog(ll);
    if (a === "dest") setEndpoint("destination", { lat: ll.lat, lon: ll.lon, name: `${ll.lat.toFixed(4)}, ${ll.lon.toFixed(4)}` });
    if (a === "orig") setEndpoint("origin", { lat: ll.lat, lon: ll.lon, name: `${ll.lat.toFixed(4)}, ${ll.lon.toFixed(4)}` });
    if (a === "focus") ctx.map2d.focusOn(ll.lat, ll.lon, ctx.map2d.cam.scale * 2);
    close();
  }));
}

function openEntity(e, screen, editing = false) {
  ctx.selection = e;
  refreshScene();
  const reg = ASSET_REGISTRY[e.kind] || ASSET_REGISTRY.waypoint;
  const editable = e.source === "user";
  const selecting = ctx.cur.mode === "plan" && activeTraverse();
  const mobile = isMobile(e);
  const meta = Object.entries(e.metadata || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd>`).join("");
  const read = `<div class="pop-body">${metaBlock(e.lat, e.lon)}
      ${e.description ? `<p style="font-size:12px;margin:8px 0 0">${esc(e.description)}</p>` : ""}
      ${mobile ? mobileReadout(e) : ""}
      ${meta ? `<hr class="joint"/><dl class="kv">${meta}</dl>` : ""}
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${provBadge(e.source === "user" ? "user" : (e.provenance || "synthetic"))}${isMobile(e) ? '<span class="badge derived">móvil</span>' : '<span class="badge cached">estático</span>'}${e.locked ? `<span class="badge model">${icon("lock")} bloqueado</span>` : ""}</div></div>
    <div class="pop-actions">
      <button class="btn" data-a="orig" ${selecting ? "" : "hidden"}>${icon("nav")} Origen</button>
      <button class="btn" data-a="dest" ${selecting ? "" : "hidden"}>${icon("target")} Destino</button>
      <button class="btn" data-a="route" ${selecting ? "" : "hidden"}>${icon("route")} Ruta desde aquí</button>
      <button class="btn" data-a="addwp" ${selecting ? "" : "hidden"}>${icon("plus")} Añadir a ruta</button>
      ${editable ? `<button class="btn" data-a="edit" ${e.locked ? "disabled" : ""}>${icon("edit")} Editar</button><button class="btn btn-danger" data-a="del" ${e.locked ? "disabled" : ""}>${icon("trash")} Borrar</button>` : ""}
    </div>`;
  const form = `<form class="pop-body edit-form"><label class="label" for="ed-name">Nombre</label><input class="input" id="ed-name" name="name" value="${esc(e.name)}" required maxlength="120">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px"><div><label class="label" for="ed-lat">Lat</label><input class="input mono" id="ed-lat" name="lat" value="${e.lat.toFixed(5)}"></div>
      <div><label class="label" for="ed-lon">Lon</label><input class="input mono" id="ed-lon" name="lon" value="${e.lon.toFixed(5)}"></div></div>
      ${mobile ? mobileFields(e.kind, e) : ""}
      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px"><button type="button" class="btn" data-cancel>Cancelar</button><button type="submit" class="btn btn-gold">Guardar</button></div></form>`;
  pop.innerHTML = `<div class="pop-head"><div><div class="pop-title">${esc(e.name)}</div><div class="pop-kind" style="color:${reg.color}">${esc(reg.label)} · ${esc(e.id)}</div></div>
    <button class="btn btn-icon" data-x aria-label="Cerrar">${icon("x")}</button></div>${editing ? form : read}`;
  place(screen);
  pop.querySelector("[data-x]").onclick = close;
  if (editing) {
    pop.querySelector("[data-cancel]").onclick = () => openEntity(e, screen, false);
    pop.querySelector("form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const lat = parseFloat(f.get("lat")), lon = parseFloat(f.get("lon"));
      if (!ctx.region.grid.contains(lat, lon)) { toast("Coordenadas fuera de la región", "warn"); return; }
      try {
        await api.patchAsset(e.id, { name: f.get("name"), lat, lon, ...mobileValues(f, e.kind) });
        await reloadAssets();
        discardIfInRoute(e.id);
        openEntity(ctx.entities.find((x) => x.id === e.id), screen, false);
        toast("Punto actualizado", "safe", 1500);
      } catch (err) { toast(err.message, "danger"); }
    });
    return;
  }
  pop.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", async () => {
    const a = b.dataset.a;
    const ref = { id: e.id, kind: e.kind, name: e.name, lat: e.lat, lon: e.lon };
    if (a === "orig") setEndpoint("origin", ref);
    if (a === "dest") setEndpoint("destination", ref);
    if (a === "route") { setEndpoint("origin", ref); toast("Origen fijado: elige destino y calcula", "", 2200); }
    if (a === "addwp") addWaypointToRoute(ref);
    if (a === "edit") { openEntity(e, screen, true); return; }
    if (a === "del") {
      await api.deleteAsset(e.id);
      await reloadAssets();
      discardIfInRoute(e.id);
      toast("Punto eliminado", "", 1500);
    }
    close();
  }));
}

function discardIfInRoute(id) {
  const entity = ctx.entities.find((point) => point.id === id);
  for (const session of ctx.sessions) {
    for (const traverse of session.traverses) {
      const refs = [traverse.origin, traverse.destination, ...traverse.waypoints].filter((point) => point?.id === id);
      if (!refs.length) continue;
      if (entity) {
        refs.forEach((point) => Object.assign(point, { lat: entity.lat, lon: entity.lon, name: entity.name }));
      } else {
        if (traverse.origin?.id === id) traverse.origin = null;
        if (traverse.destination?.id === id) traverse.destination = null;
        traverse.waypoints = traverse.waypoints.filter((point) => point.id !== id);
      }
      invalidate(traverse, "El punto cambió: se descartó la ruta calculada");
    }
  }
  ctx.emit("active-traverse", activeTraverse());
}

async function onDrop(e, ll) {
  try {
    await api.patchAsset(e.id, { lat: ll.lat, lon: ll.lon });
    await reloadAssets();
    discardIfInRoute(e.id);
  } catch (err) {
    toast(err.message, "danger");
    await reloadAssets();
  }
}

const MOBILE_FIELDS = {
  astronaut: [["o2_kg", "Oxígeno (kg)", 1.2, 1.2], ["water_kg", "Agua (kg)", 3.6, 3.6],
    ["battery_wh", "Batería del traje (Wh)", 1100, 1100], ["speed_mps", "Velocidad (m/s)", 0.9, 5],
    ["max_slope_deg", "Pendiente máxima (°)", 25, 30]],
  rover: [["battery_wh", "Batería (Wh)", 120000, 120000], ["speed_mps", "Velocidad (m/s)", 2, 5],
    ["max_slope_deg", "Pendiente máxima (°)", 20, 30]],
};

function mobileReadout(entity) {
  const fields = MOBILE_FIELDS[entity.kind];
  return `<dl class="kv"><dt>Activo</dt><dd>${entity.source === "user" ? "Virtual" : "Desplegado · lectura"}</dd>
    ${fields.map(([key, label]) => `<dt>${label}</dt><dd>${esc(entity.resources?.[key] ?? entity[key] ?? "—")}</dd>`).join("")}</dl>`;
}

function mobileFields(kind, entity = {}) {
  return (MOBILE_FIELDS[kind] || []).map(([key, label, fallback, max]) => `
    <label class="label" for="mobile-${key}">${label}</label>
    <input class="input mono" id="mobile-${key}" type="number" name="${key}"
      min="${key in { speed_mps: 1, max_slope_deg: 1 } ? 0.1 : 0}" max="${max}" step="any" required
      value="${entity.resources?.[key] ?? entity[key] ?? fallback}">`).join("");
}

function mobileValues(form, kind) {
  if (!MOBILE_FIELDS[kind]) return {};
  const values = Object.fromEntries(MOBILE_FIELDS[kind].map(([key]) => [key, Number(form.get(key))]));
  const { speed_mps, max_slope_deg, ...resources } = values;
  return { speed_mps, max_slope_deg, resources };
}

function addPointDialog(ll) {
  setAddMode(false);
  const n = (ctx.userAssets?.length || 0) + 1;
  const sessionId = ctx.cur.id;
  const body = `<form id="add-point-form" style="display:grid;gap:8px">
    <div>${metaBlock(ll.lat, ll.lon)}</div>
    <label class="label" for="ap-name">Nombre</label><input class="input" id="ap-name" name="name" value="Waypoint ${n}" required maxlength="120">
    <label class="label" for="ap-kind">Tipo</label><select class="select" id="ap-kind" name="kind">
      <option value="waypoint">Waypoint</option><option value="poi">POI científico</option><option value="sample">Muestra</option><option value="hazard">Peligro observado</option>
      <option value="lava_pit">Fosa de lava</option><option value="laboratory">Laboratorio</option>
      <option value="astronaut">Astronauta virtual</option><option value="rover">Rover virtual</option></select>
    <div data-mobile-fields></div>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="general"> Guardar en activos generales (persistente)</label></form>`;
  const dialog = modal({ title: "Nuevo punto", body, actions: [
    { label: "Cancelar" },
    { label: "Crear punto", cls: "btn-gold", onClick: async (root) => {
      const form = root.querySelector("form");
      if (!form.reportValidity()) return true;
      const f = new FormData(form);
      const id = `WP_${Date.now().toString(36).toUpperCase()}`;
      try {
        await api.addAsset({ id, name: f.get("name"), kind: f.get("kind"), lat: ll.lat, lon: ll.lon, session_id: sessionId, ...mobileValues(f, f.get("kind")), metadata: { created_in: "Hatun Wasi" } });
        if (f.get("general")) await api.saveToGeneral(sessionId, [id]);
        await reloadAssets();
        toast("Punto creado", "safe", 1500);
      } catch (err) { toast(err.message, "danger"); return true; }
    } },
  ] });
  dialog.el.querySelector("#ap-kind").addEventListener("change", (event) => {
    dialog.el.querySelector("[data-mobile-fields]").innerHTML = mobileFields(event.target.value);
  });
}

export { calculate };

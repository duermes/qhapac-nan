// Top menus (Files/Edit/View/Layers/Analysis/Tools/Help), search, focus menu and shortcuts.
import { api } from "/static/shared/js/api.js";
import { fmt } from "/static/shared/js/geo.js";
import { icon } from "/static/shared/js/icons.js";
import { $, $$, esc, modal, onClickOutside, provBadge, simBanner, toast } from "/static/shared/js/ui.js";
import { VoiceCopilot } from "/static/shared/js/voice.js";
import { addSession, applyRealSun, closeSession, persist, refreshScene, reloadAssets, setMode, setView } from "./app.js";
import { restoreRealtime, setLayer } from "./decks.js";
import { calculate, deleteRoute, exportRoute } from "./planning.js";
import { setAddMode } from "./popover.js";
import { addTraverse } from "./traverses.js";

let ctx;

const SHORTCUTS = [
  ["Alt+M", "Abrir/cerrar menú"], ["/", "Buscar"], ["Alt+Shift+N", "Nueva sesión"], ["Alt+Shift+W", "Cerrar sesión"],
  ["V", "Alternar 2D/3D"], ["G / A / P / F", "Modo General / Analizar / Planificar / Enfocar"], ["N", "Nuevo punto"],
  ["L", "Leyenda"], ["Y", "Capas"], ["M", "Métricas"], ["Ctrl+Enter", "Calcular ruta"], ["R", "Restablecer cámara"],
  ["+ / −", "Zoom"], ["Flechas", "Desplazar mapa"], ["K", "Khipu voz"], ["Esc", "Cerrar popover/menú"], ["?", "Atajos"],
];

export function initMenus(c) {
  ctx = c;
  const voice = new VoiceCopilot({ iface: "console", onIntent: handleIntent });
  ctx.voice = voice;
  const M = {
    Files: [["Nueva travesía", () => { setMode("plan"); addTraverse(); }], ["Importar ruta GeoJSON…", () => $("#import-file").click()],
      ["Guardar proyecto", () => { persist(); toast("Proyecto guardado", "safe"); }, "Ctrl+S"],
      ["Exportar GeoJSON", () => exportRoute("geojson")], ["Exportar SASF (secuencia)", () => exportRoute("sasf")], ["Exportar CSV (telemetría)", () => exportRoute("csv")],
      ["Volver al portal", () => { location.href = "/home"; }]],
    Edit: [["Nuevo punto", () => setAddMode(true), "N"], ["Borrar ruta actual", () => deleteRoute()],
      ["Guardar puntos de sesión en generales", async () => { const r = await api.saveToGeneral(ctx.cur.id); await reloadAssets(); toast(`${r.moved} punto(s) guardados`, "safe"); }],
      ["Limpiar puntos de la sesión", async () => { const r = await api.clearSession(ctx.cur.id); await reloadAssets(); toast(`${r.cleared} punto(s) eliminados`); }],
      ["Nueva sesión", () => addSession(), "Alt+Shift+N"], ["Cerrar sesión", () => closeSession(ctx.cur.id), "Alt+Shift+W"]],
    View: [["Vista 2D", () => setView("2d")], ["Vista 3D", () => setView("3d")], ["Alternar 2D/3D", () => setView(ctx.cur.view === "2d" ? "3d" : "2d"), "V"],
      ["Restablecer cámara", resetCamera, "R"], ["Curvas de nivel", () => { ctx.map2d.opts.contours = !ctx.map2d.opts.contours; ctx.map3d && (ctx.map3d.uniforms.uContours.value = ctx.map2d.opts.contours ? 1 : 0); ctx.map2d.draw(); }],
      ["Rótulos", () => { ctx.map2d.opts.labels = !ctx.map2d.opts.labels; ctx.map2d.draw(); }],
      ["Iluminación: Sol real ↔ cartográfica", () => {
        const real = !(ctx.sun?.real && ctx.sun.forced !== false);
        if (real) applyRealSun(); else { ctx.sun = { ...ctx.sun, az: 315, el: 35, real: false, forced: false }; ctx.map2d.setSun(315, 35); ctx.map3d?.setSun(315, 35); }
        toast(real ? "Relieve con Sol real (Mars24)" : "Relieve con luz cartográfica (NO 35°)", "", 2000);
      }], ["Pantalla completa", () => document.documentElement.requestFullscreen?.()]],
    Layers: [["Panel de capas", () => ctx.decks.layers.toggle(), "Y"], ["Leyenda", () => ctx.decks.legend.toggle(), "L"],
      ["Pendiente", () => setLayer("slope", true)], ["Coste de supervivencia EVA", () => setLayer("survival_astronaut", true)],
      ["Margen de enlace", () => setLayer("telecom", true)], ["Restaurar tiempo real", () => restoreRealtime()]],
    Analysis: [["Métricas de travesía", () => ctx.decks.metrics.openFor(ctx.cur.traverses.find((t) => t.id === ctx.cur.activeTraverse)), "M"],
      ["Inspección de riesgo (clic en mapa)", () => { setMode("plan"); toast("Modo planificar: haz clic en el mapa para inspeccionar riesgos"); }],
      ["POIs cercanos", () => $("#nearby-pois").click()], ["Resumen del mapa de coste", costmapDialog], ["Región personalizada MOLA…", ingestDialog]],
    Tools: [["Khipu voz", () => voice.start(), "K"], ["Demo y contingencias (simulación)…", demoDialog], ["Redundancia de nodos…", swarmDialog], ["Datos NASA (clima / APOD)…", nasaDialog]],
    Help: [["Atajos de teclado", shortcutsDialog, "?"], ["Procedencia de datos", provenanceDialog], ["Acerca de Qhapaq Ñan", aboutDialog]],
  };
  const LABEL = { Files: "Files", Edit: "Edit", View: "View", Layers: "Layers", Analysis: "Analysis", Tools: "Tools", Help: "Help" };
  const bar = $("#menubar");
  bar.innerHTML = Object.entries(M).map(([k, items]) => `<div class="menu"><button aria-haspopup="true" aria-expanded="false" data-menu="${k}">${LABEL[k]}</button>
    <div class="menu-list panel" role="menu" hidden>${items.map(([l, , kbd], i) => `<button role="menuitem" data-item="${k}:${i}"><span>${esc(l)}</span>${kbd ? `<kbd>${kbd}</kbd>` : ""}</button>`).join("")}</div></div>`).join("");
  const closeMenus = () => { $$(".menu-list", bar).forEach((l) => { l.hidden = true; }); $$("[data-menu]", bar).forEach((b) => b.setAttribute("aria-expanded", "false")); };
  bar.addEventListener("click", (e) => {
    const mb = e.target.closest("[data-menu]");
    if (mb) {
      const list = mb.nextElementSibling;
      const open = list.hidden;
      closeMenus();
      list.hidden = !open;
      mb.setAttribute("aria-expanded", String(open));
      return;
    }
    const it = e.target.closest("[data-item]");
    if (it) {
      const [k, i] = it.dataset.item.split(":");
      closeMenus();
      toggleMenubar(false);
      M[k][+i][1]();
    }
  });
  const toggleMenubar = (force) => {
    const show = force ?? bar.hidden;
    bar.hidden = !show;
    $("#menu-btn").setAttribute("aria-expanded", String(show));
    if (!show) closeMenus();
  };
  $("#menu-btn").addEventListener("click", () => toggleMenubar());
  onClickOutside(bar, () => toggleMenubar(false), [$("#menu-btn")]);
  initSearch();
  initFocusMenu();
  initShortcuts(toggleMenubar);
}

function resetCamera() {
  if (ctx.cur.view === "3d" && ctx.map3d) ctx.map3d.resetCamera(); else ctx.map2d.fit();
}

// ------------------------------------------------------------------ search
function initSearch() {
  const inp = $("#search"), res = $("#search-results"), clr = $("#search-clear");
  const run = () => {
    const q = inp.value.trim().toLowerCase();
    clr.hidden = !q;
    if (!q) { res.hidden = true; res.innerHTML = ""; return; }
    const items = [
      ...(ctx.entities || []).map((e) => ({ name: e.name, sub: e.kind, lat: e.lat, lon: e.lon, ent: e })),
      ...(ctx.scenario.toponyms || []).map((t) => ({ name: t.name, sub: `topónimo · ${t.type}${t.approx ? " (aprox.)" : ""}`, lat: t.lat, lon: t.lon })),
      ...(ctx.region.focus || []).map((f) => ({ name: f.name, sub: "sector de enfoque", lat: f.center?.lat, lon: f.center?.lon, bbox: f.bbox })),
    ].filter((x) => x.name.toLowerCase().includes(q)).slice(0, 12);
    res.hidden = false;  // floating results only while searching
    res.innerHTML = items.length ? items.map((x, i) => `<button role="option" data-i="${i}">${icon(x.ent ? "pin" : "globe")}<span><b>${esc(x.name)}</b><br><span class="dim" style="font-size:11px">${esc(x.sub)}</span></span></button>`).join("")
      : `<div class="empty-state" style="padding:8px 10px">Sin resultados</div>`;
    $$("[data-i]", res).forEach((b) => b.addEventListener("click", () => {
      const x = items[+b.dataset.i];
      if (x.bbox) ctx.map2d.fitBBox(x.bbox); else ctx.map2d.focusOn(x.lat, x.lon, Math.max(ctx.map2d.cam.scale, ctx.map2d.minScale * 6));
      if (ctx.map3d && ctx.cur.view === "3d") ctx.map3d.focusOn(x.lat, x.lon, 15000);
      if (x.ent) { ctx.selection = x.ent; refreshScene(); }
      clear();
    }));
  };
  const clear = () => { inp.value = ""; run(); };
  inp.addEventListener("input", run);
  inp.addEventListener("keydown", (e) => { if (e.key === "Escape") { clear(); inp.blur(); } if (e.key === "Enter") res.querySelector("button")?.click(); });
  clr.addEventListener("click", () => { clear(); inp.focus(); });
  onClickOutside(res, () => { res.hidden = true; }, [inp]);
}

// ------------------------------------------------------------------ focus
function initFocusMenu() {
  const el = $("#focus-menu");
  const button = $("#focus-btn");
  const open = (show) => { el.hidden = !show; button.setAttribute("aria-expanded", String(show)); };
  button.addEventListener("click", () => open(el.hidden));
  onClickOutside(el, () => open(false), [button]);
  const items = [{ name: ctx.region.manifest?.name || "Macrorregión", bbox: { lat_min: ctx.region.grid.lat_min, lat_max: ctx.region.grid.lat_max, lon_min: ctx.region.grid.lon_min, lon_max: ctx.region.grid.lon_max } },
    ...(ctx.region.focus || [])];
  el.innerHTML = `<div class="kicker" style="padding:4px 10px">Enfocar sector (navegación instantánea)</div>` + items.map((f, i) => `<button role="menuitem" data-f="${i}"><span>${esc(f.name)}</span><span class="mono dim">${f.center ? `${f.center.lat.toFixed(2)}°N ${f.center.lon.toFixed(2)}°E` : "completa"}</span></button>`).join("");
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-f]");
    if (!b) return;
    const f = items[+b.dataset.f];
    ctx.map2d.fitBBox(f.bbox);
    if (ctx.map3d && ctx.cur.view === "3d" && f.center) ctx.map3d.focusOn(f.center.lat, f.center.lon, 60000);
    if (ctx.map3d && ctx.cur.view === "3d" && !f.center) ctx.map3d.resetCamera();
    open(false);
    button.focus();
  });
}

// ------------------------------------------------------------------ shortcuts
function initShortcuts(toggleMenubar) {
  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest("input, select, textarea, [contenteditable]");
    if (e.altKey && e.shiftKey && e.code === "KeyN") { e.preventDefault(); addSession(); return; }
    if (e.altKey && e.shiftKey && e.code === "KeyW") { e.preventDefault(); closeSession(ctx.cur.id); return; }
    if (e.altKey && e.code === "KeyM") { e.preventDefault(); toggleMenubar(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); calculate(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); persist(); toast("Proyecto guardado", "safe", 1500); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const m = ctx.map2d;
    const k = e.key;
    const map = {
      v: () => setView(ctx.cur.view === "2d" ? "3d" : "2d"), g: () => setMode("general"), a: () => setMode("analyze"),
      p: () => setMode("plan"), f: () => $("#focus-btn").click(), n: () => setAddMode(!ctx.cur.addMode), l: () => ctx.decks.legend.toggle(),
      y: () => ctx.decks.layers.toggle(), m: () => { if (ctx.cur.mode === "plan") $("#metrics").click(); }, r: resetCamera, k: () => ctx.voice.start(),
      "/": () => $("#search").focus(), "?": shortcutsDialog, "+": () => m.zoomAt(1.25), "=": () => m.zoomAt(1.25), "-": () => m.zoomAt(0.8),
      ArrowLeft: () => { m.cam.cx -= 40 / m.cam.scale; m.clampCam(); m.draw(); }, ArrowRight: () => { m.cam.cx += 40 / m.cam.scale; m.clampCam(); m.draw(); },
      ArrowUp: () => { m.cam.cy -= 40 / m.cam.scale; m.clampCam(); m.draw(); }, ArrowDown: () => { m.cam.cy += 40 / m.cam.scale; m.clampCam(); m.draw(); },
      Escape: () => { setAddMode(false); toggleMenubar(false); if (!$("#focus-menu").hidden) $("#focus-btn").click(); },
    };
    const fn = map[k] || map[k.toLowerCase()];
    if (fn) { e.preventDefault(); fn(); }
  });
}

// ------------------------------------------------------------------ voice intents
function handleIntent(r) {
  if (r.intent === "select_layer") { setMode("analyze"); setLayer(r.layer_id, true); }
  if (r.intent === "set_mode") setMode({ navigate: "general", recon: "analyze", plan: "plan" }[r.mode] || "plan");
  if (r.intent === "poi_info") { const e = ctx.entities.find((x) => x.id === r.poi_id); if (e) { ctx.map2d.focusOn(e.lat, e.lon); ctx.popover.openEntity(e); } }
  if (r.intent === "filter_pois") {
    const kinds = { science: ["poi"], sample: ["sample"], vehicle: ["rover"], base: ["base", "habitat", "landmark"], hazard: ["hazard"] }[r.category];
    const all = [...new Set(ctx.entities.map((e) => e.kind))];
    ctx.cur.hidden = r.category === "all" ? [] : all.filter((k) => !kinds?.includes(k));
    refreshScene();
  }
}

// ------------------------------------------------------------------ dialogs
function shortcutsDialog() {
  modal({ title: "Atajos de teclado", body: `<dl class="kv">${SHORTCUTS.map(([k, d]) => `<dt>${esc(d)}</dt><dd><kbd>${esc(k)}</kbd></dd>`).join("")}</dl>` });
}

function aboutDialog() {
  modal({ title: "Qhapaq Ñan", body: `<p><b>Qhapaq Ñan</b> planifica y guía la navegación de superficie marciana. <b>Khipu</b> es el núcleo analítico compartido por Hatun Wasi (consola), Chaski (rover) y Ñawi (EVA).</p>
    <p class="muted">Apoyo de decisión dentro de los datos, umbrales y supuestos declarados; no certifica seguridad operacional. La identidad andina es una interpretación visual del equipo.</p>` });
}

async function provenanceDialog() {
  const m = ctx.region.manifest;
  modal({ title: "Procedencia de datos", body: `<dl class="kv"><dt>Región</dt><dd>${esc(m.name)}</dd><dt>Producto</dt><dd>${esc(m.source?.product_id)}</dd>
    <dt>Conjunto</dt><dd>${esc(m.source?.data_set_id)}</dd><dt>Clasificación</dt><dd>${provBadge(m.classification)}</dd>
    <dt>Resolución</dt><dd>${esc(m.resolution)}</dd><dt>Unidades</dt><dd>${esc(m.units)}</dd><dt>CRS</dt><dd>${esc(m.coordinate_reference)}</dd>
    <dt>Cobertura válida</dt><dd>${fmt.pct(100 * m.coverage.valid_fraction)}</dd><dt>SHA-256 original</dt><dd style="word-break:break-all;font-size:10px">${esc(m.source?.image_sha256 || "—")}</dd></dl>
    <hr class="joint"/><p class="muted" style="font-size:12px">Escenario (base, vehículos, astronautas, zonas, muestras): ${provBadge("synthetic")}. Capas ambientales: ${provBadge("model")}. ISRU no se muestra por falta de datos.</p>` });
}

async function demoDialog() {
  let h;
  try { h = await api.harness(); } catch (e) { toast(e.message, "danger"); return; }
  const body = document.createElement("div");
  const render = () => {
    body.innerHTML = `<p class="muted" style="margin-top:0">Metasoftware de demostración: las contingencias se aplican sobre una capa de simulación y <b>no</b> modifican el modelo de producción.</p>
      <div class="btn-row">${Object.entries(h.available).map(([k, v]) => `<button class="btn" data-inj="${k}">${esc(v.label)}</button>`).join("")}</div>
      <hr class="joint"/><div class="kicker">Activas</div>${h.active.length ? h.active.map((a) => `<div class="legend-item"><span class="badge sim">SIM</span> ${esc(a.id)} — ${esc(a.label)}</div>`).join("") : '<div class="empty-state">Ninguna</div>'}
      <button class="btn btn-danger" data-clear style="margin-top:8px">Limpiar simulación</button>`;
    $$("[data-inj]", body).forEach((b) => b.addEventListener("click", async () => {
      const params = b.dataset.inj === "obstacle" && ctx.lastHover ? { lat: ctx.lastHover.lat, lon: ctx.lastHover.lon, radius_m: 600 } : {};
      await api.inject(b.dataset.inj, params);
      h = await api.harness(); simBanner(true); render();
      ctx.layerCanvases = {}; ctx.emit("session", ctx.cur);
    }));
    body.querySelector("[data-clear]").addEventListener("click", async () => { await api.clearHarness(); h = await api.harness(); simBanner(false); render(); ctx.layerCanvases = {}; ctx.emit("session", ctx.cur); });
  };
  render();
  modal({ title: "Demo — contingencias (SIMULACIÓN)", body });
}

async function swarmDialog() {
  const body = document.createElement("div");
  const render = (st) => {
    body.innerHTML = `<dl class="kv"><dt>Líder</dt><dd>${esc(st.leader)}</dd><dt>Versión costmap</dt><dd>${st.costmap_version}</dd></dl><hr class="joint"/>
      ${st.peers.map((p) => `<div class="legend-item"><span class="badge ${p.health === "healthy" ? "live" : p.health === "degraded" ? "synthetic" : "danger"}">${esc(p.health)}</span>
        <span style="flex:1">${esc(p.peer_id)} <span class="dim">(${esc(p.role)}, prio ${p.priority})</span></span><span class="mono dim">v${p.costmap_version}${p.in_sync ? " ✓" : ""}</span>
        <button class="btn" data-out="${esc(p.peer_id)}" style="min-height:24px;font-size:11px">Forzar caída</button></div>`).join("")}`;
    $$("[data-out]", body).forEach((b) => b.addEventListener("click", async () => { const r = await api.failover(b.dataset.out); toast(`Failover: ${r.previous_leader} → ${r.new_leader}`, "warn"); render(r.status); }));
  };
  render(await api.swarm());
  modal({ title: "Redundancia de nodos (swarm)", body });
}

async function costmapDialog() {
  const r = await api.costmap({ region_key: ctx.region.key, profile: "rover" });
  const s = r.summary;
  modal({ title: "Mapa de coste (rover)", body: `<dl class="kv"><dt>Libre</dt><dd>${fmt.pct(100 * s.free_fraction)}</dd><dt>Precaución</dt><dd>${fmt.pct(100 * s.caution_fraction)}</dd>
    <dt>Alto</dt><dd>${fmt.pct(100 * s.high_fraction)}</dd><dt>Prohibido</dt><dd>${fmt.pct(100 * s.forbidden_fraction)}</dd><dt>Límite de pendiente</dt><dd>${s.slope_limit_deg}°</dd>
    <dt>Coste medio</dt><dd>${fmt.num(s.cost_mean, 3)}</dd><dt>Versión</dt><dd>${s.version}</dd></dl>` });
}

function ingestDialog() {
  const g = ctx.region.grid;
  const body = `<form style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><label class="label" style="grid-column:1/-1">Extrae una subregión del original MOLA (los originales no se modifican).</label>
    <input class="input" name="key" placeholder="clave (a-z0-9_)" required pattern="[a-z0-9_]{2,40}" style="grid-column:1/-1">
    <input class="input" name="name" placeholder="Nombre" required style="grid-column:1/-1">
    <input class="input mono" name="lat_min" value="${(g.lat_min + 1).toFixed(2)}"><input class="input mono" name="lat_max" value="${(g.lat_min + 3).toFixed(2)}">
    <input class="input mono" name="lon_min" value="${(g.lon_min + 1).toFixed(2)}"><input class="input mono" name="lon_max" value="${(g.lon_min + 3).toFixed(2)}"></form>`;
  modal({ title: "Región personalizada MOLA", body, actions: [{ label: "Cancelar" }, { label: "Extraer", cls: "btn-gold", onClick: async (root) => {
    const f = Object.fromEntries(new FormData(root.querySelector("form")));
    ["lat_min", "lat_max", "lon_min", "lon_max"].forEach((k) => { f[k] = parseFloat(f[k]); });
    try { const r = await api.ingest(f); toast(`Región ${r.manifest.key} creada: ${r.manifest.geometry.rows}×${r.manifest.geometry.cols}`, "safe", 5000); }
    catch (e) { toast(e.message, "danger"); return true; }
  } }] });
}

async function nasaDialog() {
  const [w, a] = await Promise.all([api.weather().catch((e) => ({ status: "error", error: e.message })), api.apod().catch((e) => ({ status: "error", error: e.message }))]);
  const block = (title, r, inner) => `<div class="kicker">${title}</div><div style="display:flex;gap:6px;align-items:center;margin:4px 0">${provBadge(r.provenance || r.status)}<span class="dim mono" style="font-size:11px">${esc(r.fetched_at || "")}</span></div>
    ${inner}${r.error ? `<div class="dim" style="font-size:11px">Error/limitación: ${esc(r.error)}</div>` : ""}<div class="dim" style="font-size:10px">Fuente: ${esc(r.source || "")}</div>`;
  const ws = w.summary;
  const as = a.summary;
  modal({ title: "Servicios NASA", body: block("Clima InSight", w, ws?.available ? `<dl class="kv"><dt>Sol</dt><dd>${esc(ws.sol)}</dd><dt>Temp. media</dt><dd>${fmt.num(ws.temp_avg_c)} °C</dd><dt>Presión</dt><dd>${fmt.num(ws.pressure_pa)} Pa</dd></dl>` : `<div class="empty-state">${esc(ws?.note || "Sin datos del servicio; las capas usan modelos declarados.")}</div>`)
    + "<hr class='joint'/>" + block("APOD", a, as ? `<p style="margin:4px 0"><b>${esc(as.title)}</b> (${esc(as.date)})</p>${as.media_type === "image" ? `<p class="dim" style="font-size:11px">Imagen remota no cargada automáticamente: <a href="${esc(as.url)}" target="_blank" rel="noopener" style="color:var(--gold)">abrir</a></p>` : ""}` : `<div class="empty-state">No disponible</div>`) });
}

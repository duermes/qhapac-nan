import { api } from "/static/shared/js/api.js";
import { STOPS, clamp, journeyState, eyeGeometry, closeupGeometry } from "./journey-math.js";
import { playStoneClick } from "./stone-audio.js";

const $ = selector => document.querySelector(selector);
const viewport = $("#journey-viewport");
const scroller = $("#journey");
const art = $("#world-art");
const eyeArt = $("#eyes-art");
const eyeLink = $("#go-hud");
const copies = [...document.querySelectorAll("[data-copy]")];
const waypoints = [...document.querySelectorAll("[data-stop]")];
const targets = [...document.querySelectorAll("[data-station]")];
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
const dialog = $("#mission-dialog");
const soundToggle = $("#sound-toggle");
let soundEnabled = true;
try { soundEnabled = localStorage.getItem("qn-ui-sound") !== "off"; } catch {}

function updateSoundControl() {
  soundToggle.setAttribute("aria-pressed", String(soundEnabled));
  soundToggle.setAttribute("aria-label", soundEnabled ? "Desactivar efectos de sonido" : "Activar efectos de sonido");
  soundToggle.title = soundEnabled ? "Desactivar efectos de sonido" : "Activar efectos de sonido";
  soundToggle.textContent = soundEnabled ? "Sonido: sí" : "Sonido: no";
}

document.addEventListener("click", event => {
  if (soundEnabled && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.target.closest(".stone-button,.waypoint,.mission-info,.journey-brand,.world-target,.eye-entry")) playStoneClick();
}, { capture: true });
soundToggle.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  try { localStorage.setItem("qn-ui-sound", soundEnabled ? "on" : "off"); } catch {}
  updateSoundControl();
  if (soundEnabled) playStoneClick();
});
updateSoundControl();
const announcements = ["Intiwatana. Hatun Wasi, consola de misión.", "Chaski. Monitor de navegación del rover.", "Ñawi. Acércate a la mirada del guerrero para entrar al visor EVA."];
let width = innerWidth, height = innerHeight, range = 1;
let progress = 0, targetProgress = 0, lastTime = performance.now(), frame = 0, activeStage = -1, leaving = false;
let touch = null;

function measure(preserve = false) {
  if (preserve && Math.abs(width - innerWidth) < 2 && Math.abs(height - innerHeight) < 2) return;
  width = innerWidth;
  height = innerHeight;
  range = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
  if (preserve) scroller.scrollTo({ top: progress * range, behavior: "instant" });
  targetProgress = clamp(scroller.scrollTop / range);
  const eye = closeupGeometry(width, height, eyeArt.naturalWidth || 1672, eyeArt.naturalHeight || 941);
  eyeArt.style.objectPosition = `${eye.positionX * 100}% 48%`;
  Object.assign(eyeLink.style, { left: `${eye.left}px`, top: `${eye.top}px`, width: `${eye.width}px`, height: `${eye.height}px` });
  requestRender();
}

function setProgress(value, behavior = "smooth") {
  if (leaving) return;
  scroller.scrollTo({ top: clamp(value) * range, behavior: motionPreference.matches ? "instant" : behavior });
  if (motionPreference.matches) { targetProgress = clamp(value); progress = targetProgress; requestRender(); }
}

function requestRender() {
  if (!frame) { lastTime = performance.now(); frame = requestAnimationFrame(render); }
}

function render(time) {
  frame = 0;
  const dt = Math.min(0.05, Math.max(0.001, (time - lastTime) / 1000));
  lastTime = time;
  progress = motionPreference.matches ? targetProgress : progress + (targetProgress - progress) * (1 - Math.exp(-12 * dt));
  if (Math.abs(progress - targetProgress) < 0.00008) progress = targetProgress;
  const state = journeyState(progress, width, height, motionPreference.matches);
  const eye = eyeGeometry(state, width, height, (art.naturalWidth || 2172) / (art.naturalHeight || 724));
  viewport.style.setProperty("--world-width", `${state.worldWidth}px`);
  viewport.style.setProperty("--world-x", `${-state.cameraX}px`);
  viewport.style.setProperty("--focus-x", `${eye.focusX}px`);
  viewport.style.setProperty("--focus-y", `${eye.focusY}px`);
  viewport.style.setProperty("--camera-shift-x", `${eye.shiftX}px`);
  viewport.style.setProperty("--camera-shift-y", `${eye.shiftY}px`);
  viewport.style.setProperty("--camera-zoom", state.zoom.toFixed(5));
  viewport.style.setProperty("--eye-opacity", state.eyeOpacity.toFixed(5));
  viewport.style.setProperty("--eye-reveal", `${(state.eyeReveal * 120).toFixed(4)}vmax`);
  viewport.style.setProperty("--eye-scale", state.eyeScale.toFixed(5));
  viewport.dataset.progress = progress.toFixed(4);
  viewport.dataset.cameraX = state.cameraX.toFixed(2);
  document.body.dataset.stage = String(state.stage);
  document.body.dataset.eyeReady = String(state.eyeReady);
  copies.forEach((copy, index) => {
    const alpha = state.copies[index];
    const enabled = alpha > 0.5;
    copy.style.opacity = alpha.toFixed(4);
    copy.style.transform = `translate3d(0,${(1 - alpha) * 14}px,0)`;
    copy.classList.toggle("is-active", alpha > 0.02);
    copy.inert = !enabled;
    copy.setAttribute("aria-hidden", String(!enabled));
    copy.querySelectorAll("a,button").forEach(link => { link.tabIndex = enabled ? 0 : -1; });
  });
  targets.forEach(target => {
    const enabled = Number(target.dataset.station) === state.stage && progress < 0.815;
    target.classList.toggle("is-active", enabled);
    target.tabIndex = enabled ? 0 : -1;
    target.setAttribute("aria-hidden", String(!enabled));
  });
  eyeLink.classList.toggle("is-ready", state.eyeReady);
  eyeLink.tabIndex = state.eyeReady ? 0 : -1;
  eyeLink.setAttribute("aria-hidden", String(!state.eyeReady));
  $("#eyes-scene").setAttribute("aria-hidden", String(!state.eyeReady));
  waypoints.forEach((point, index) => {
    point.classList.toggle("is-active", index === state.stage);
    if (index === state.stage) point.setAttribute("aria-current", "step");
    else point.removeAttribute("aria-current");
  });
  if (activeStage !== state.stage) {
    activeStage = state.stage;
    $("#journey-announcement").textContent = announcements[state.stage];
  }
  if (Math.abs(progress - targetProgress) > 0.00008 && !leaving) frame = requestAnimationFrame(render);
}

function nextStop() {
  if (progress > 0.96) return setProgress(0);
  setProgress(progress < 0.25 ? STOPS[1] : progress < 0.62 ? STOPS[2] : 1);
}

function previousStop() {
  setProgress(progress > 0.9 ? STOPS[2] : progress > 0.6 ? STOPS[1] : 0);
}

async function enter(event) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (leaving) return;
  const link = event.currentTarget;
  const destination = link.dataset.enter;
  if (destination === "hud" && progress < 0.955) return setProgress(1);
  leaving = true;
  const names = { console: ["HATUN WASI", "CENTRO DE MISIÓN"], rover: ["CHASKI", "EXPLORACIÓN MÓVIL"], hud: ["ÑAWI", "VISOR DE EXPLORACIÓN"] };
  document.body.classList.add("is-leaving");
  try { sessionStorage.setItem("qn-entry-transition", JSON.stringify({ path: link.getAttribute("href"), time: Date.now(), name: names[destination][0], caption: names[destination][1] })); } catch {}
  await window.QNEntryTransition.start({ name: names[destination][0], caption: names[destination][1] });
  location.assign(link.href);
}

function openMission() {
  dialog.showModal();
  api.health().then(health => {
    $("#st-health").textContent = health.status === "ok" ? "Khipu · operativo" : "Khipu · sin conexión";
    $("#st-data").textContent = health.data.macro_available ? "MOLA disponible" : "Sin topografía";
  }).catch(() => { $("#st-health").textContent = "Sin conexión con Khipu"; });
}

scroller.addEventListener("scroll", () => { targetProgress = clamp(scroller.scrollTop / range); requestRender(); }, { passive: true });
window.addEventListener("resize", () => measure(true));
window.addEventListener("wheel", event => {
  if (document.querySelector("dialog[open]") || event.target.closest(".qn-settings") || event.ctrlKey || leaving) return;
  event.preventDefault();
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
  scroller.scrollBy({ top: delta * unit, behavior: "instant" });
}, { passive: false });
window.addEventListener("touchstart", event => {
  if (event.touches.length !== 1 || document.querySelector("dialog[open]") || event.target.closest("a,button,.qn-settings")) return;
  touch = { x: event.touches[0].clientX, y: event.touches[0].clientY, scroll: scroller.scrollTop };
}, { passive: true });
window.addEventListener("touchmove", event => {
  if (!touch || event.touches.length !== 1 || leaving) return;
  const dx = event.touches[0].clientX - touch.x, dy = event.touches[0].clientY - touch.y;
  if (Math.abs(dx) > Math.abs(dy) * 1.2 && Math.abs(dx) > 12) {
    event.preventDefault();
    scroller.scrollTo({ top: touch.scroll - dx * 4, behavior: "instant" });
  } else if (Math.abs(dy) > 12) {
    event.preventDefault();
    scroller.scrollTo({ top: touch.scroll - dy * 2, behavior: "instant" });
  }
}, { passive: false });
window.addEventListener("touchend", () => { touch = null; }, { passive: true });
window.addEventListener("touchcancel", () => { touch = null; }, { passive: true });
window.addEventListener("keydown", event => {
  if (document.querySelector("dialog[open]") || event.target.closest("input,textarea,select,.qn-settings") || leaving || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "ArrowRight") { event.preventDefault(); nextStop(); }
  if (event.key === "ArrowLeft") { event.preventDefault(); previousStop(); }
  if (event.key === "Home") { event.preventDefault(); setProgress(0); }
  if (event.key === "End") { event.preventDefault(); setProgress(1); }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    scroller.scrollBy({ top: event.key === "ArrowDown" ? 100 : -100, behavior: motionPreference.matches ? "instant" : "smooth" });
  }
  if (event.key === "PageDown" || event.key === "PageUp") {
    event.preventDefault();
    scroller.scrollBy({ top: height * (event.key === "PageDown" ? 0.8 : -0.8), behavior: motionPreference.matches ? "instant" : "smooth" });
  }
});
window.addEventListener("pageshow", () => {
  leaving = false;
  document.body.classList.remove("is-leaving");
  measure();
});
motionPreference.addEventListener("change", requestRender);
waypoints.forEach((point, index) => point.addEventListener("click", () => setProgress(STOPS[index])));
$("#approach-eyes").addEventListener("click", () => setProgress(1));
$("#warrior-target").addEventListener("click", () => setProgress(1));
$("#mission-info").addEventListener("click", openMission);
$("#mission-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", event => {
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
});
document.querySelectorAll("[data-enter]").forEach(link => link.addEventListener("click", enter));
document.querySelector(".journey-brand").addEventListener("click", event => { event.preventDefault(); setProgress(0); });
art.addEventListener("load", () => measure());
eyeArt.addEventListener("load", () => measure());
measure();
progress = targetProgress;
document.body.dataset.ready = "1";

import { currentLanguage, setLanguage } from "./language.js";
import { guideSteps } from "./guide-steps.js";

const stage = document.body.dataset.guide;
const host = document.querySelector("[data-guide-settings]");
const copy = (es, en) => currentLanguage() === "en" ? en : es;
const surfaces = guideSteps[stage];
host.innerHTML = `<details class="qn-settings">
  <summary tabindex="0" aria-controls="qn-settings-options"><span data-current-language></span></summary>
  <div class="qn-settings-options panel" id="qn-settings-options">
    <div class="qn-settings-languages" role="group">
      <button class="btn" type="button" data-language="es" lang="es" data-no-localize>Español</button>
      <button class="btn" type="button" data-language="en" lang="en" data-no-localize>English</button>
    </div>
    <button class="btn qn-guide-start" type="button" hidden></button>
  </div>
</details>`;
const settings = host.querySelector("details");
const summary = settings.querySelector("summary");
const group = host.querySelector(".qn-settings-languages");
const start = host.querySelector(".qn-guide-start");
start.hidden = !surfaces;
function renderSettings() {
  const label = copy("Idioma", "Language");
  group.setAttribute("aria-label", label);
  summary.setAttribute("aria-label", surfaces ? copy("Idioma y tutorial", "Language and tutorial") : label);
  summary.title = summary.getAttribute("aria-label");
  host.querySelector("[data-current-language]").textContent = currentLanguage().toUpperCase();
  group.querySelectorAll("[data-language]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.language === currentLanguage()));
  });
  start.textContent = "Tutorial";
}
renderSettings();
group.addEventListener("click", (event) => {
  const button = event.target.closest("[data-language]");
  if (button) setLanguage(button.dataset.language);
});
document.addEventListener("qn:language", renderSettings);
document.addEventListener("pointerdown", (event) => {
  if (settings.open && !host.contains(event.target)) settings.open = false;
});
settings.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { settings.open = false; summary.focus(); }
});

if (surfaces) wireGuide();

function wireGuide() {
  const dialog = document.createElement("dialog");
  dialog.className = "qn-guide";
  dialog.setAttribute("aria-labelledby", "qn-guide-title");
  dialog.dataset.noLocalize = "";
  dialog.innerHTML = `<div class="qn-guide-focus" aria-hidden="true"></div>
    <section class="qn-guide-card panel">
      <header class="qn-guide-head"><span class="qn-guide-count"></span><button class="btn qn-guide-close" type="button">×</button></header>
      <div class="qn-guide-slide" aria-live="polite">
        <h2 id="qn-guide-title"></h2>
        <p class="qn-guide-instruction"><strong hidden></strong><span></span></p>
        <p class="qn-guide-benefit" hidden><strong></strong><span></span></p>
        <a class="qn-guide-link" hidden></a>
        <button class="btn qn-guide-reveal" type="button" hidden></button>
      </div>
      <footer><button class="btn qn-guide-prev" type="button"></button><button class="btn btn-gold qn-guide-next" type="button"></button></footer>
    </section>`;
  document.body.append(dialog);
  const box = dialog.querySelector(".qn-guide-focus");
  const card = dialog.querySelector(".qn-guide-card");
  const content = dialog.querySelector(".qn-guide-slide");
  const next = dialog.querySelector(".qn-guide-next");
  const previous = dialog.querySelector(".qn-guide-prev");
  const close = dialog.querySelector(".qn-guide-close");
  const link = dialog.querySelector("a");
  const instruction = content.querySelector(".qn-guide-instruction");
  const benefit = content.querySelector(".qn-guide-benefit");
  const revealButton = content.querySelector(".qn-guide-reveal");
  if (stage !== "home") dialog.classList.add("qn-guide-operational");
  let index = 0;
  let pointer;
  let slide;

  function targetRect(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      if (rect?.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
          rect.left < innerWidth && rect.top < innerHeight && getComputedStyle(element).visibility === "visible") {
        return rect;
      }
    }
    return null;
  }

  function position() {
    if (!dialog.open) return;
    const rect = targetRect(surfaces[index].targets);
    box.hidden = !rect;
    const inset = 12;
    const { width, height } = card.getBoundingClientRect();
    let left = (innerWidth - width) / 2;
    let top = (innerHeight - height) / 2;
    if (rect) {
      const x = Math.max(1, rect.left - 5), y = Math.max(1, rect.top - 5);
      const right = Math.min(innerWidth - 1, rect.right + 5), bottom = Math.min(innerHeight - 1, rect.bottom + 5);
      Object.assign(box.style, { left: x + "px", top: y + "px", width: right - x + "px", height: bottom - y + "px" });
      left = Math.min(innerWidth - width - inset, Math.max(inset, (x + right - width) / 2));
      if (bottom + height + inset * 2 <= innerHeight) {
        top = bottom + inset;
      } else if (y - height >= inset * 2) {
        top = y - inset - height;
      } else if (right + width + inset * 2 <= innerWidth || x - width >= inset * 2) {
        left = right + width + inset * 2 <= innerWidth ? right + inset : x - inset - width;
        top = Math.min(innerHeight - height - inset, Math.max(inset, (y + bottom - height) / 2));
      } else {
        top = y + bottom > innerHeight ? inset : innerHeight - height - inset;
      }
    }
    card.style.left = Math.max(inset, left) + "px";
    card.style.top = Math.max(inset, top) + "px";
  }

  function render(direction = 0) {
    const step = surfaces[index];
    const title = copy(...step.title);
    if (stage === "home") document.querySelector(step.targets[0])?.click();
    const operational = Boolean(step.benefit);
    instruction.querySelector("strong").hidden = !operational;
    instruction.querySelector("strong").textContent = copy("Qué hacer", "What to do");
    instruction.querySelector("span").textContent = copy(...step.instruction);
    benefit.hidden = !operational;
    if (operational) {
      benefit.querySelector("strong").textContent = copy("Qué obtienes", "What you get");
      benefit.querySelector("span").textContent = copy(...step.benefit);
    }
    renderReveal();
    dialog.querySelector(".qn-guide-count").textContent = copy("Paso", "Step") + ` ${index + 1} / ${surfaces.length}`;
    dialog.querySelector("h2").textContent = title;
    close.setAttribute("aria-label", copy("Cerrar tutorial", "Close tutorial"));
    previous.textContent = copy("Anterior", "Back");
    previous.disabled = index === 0;
    next.textContent = index === surfaces.length - 1 ? copy("Finalizar", "Finish") : copy("Siguiente", "Next");
    link.hidden = !step.path;
    if (step.path) {
      link.href = step.path + "?tutorial=1";
      link.textContent = copy("Abrir", "Open") + " " + title;
    }
    slide?.cancel();
    if (direction && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      slide = content.animate([{ opacity: 0, transform: `translateX(${direction * 20}px)` },
        { opacity: 1, transform: "translateX(0)" }], { duration: 210, easing: "ease-out" });
    }
    position();
  }

  function renderReveal() {
    const reveal = surfaces[index].reveal;
    revealButton.hidden = !reveal?.controls.some((selector) => targetRect([selector]));
    if (reveal) revealButton.textContent = copy(...reveal.label);
    if (revealButton.hidden && document.activeElement === revealButton) next.focus();
  }

  revealButton.addEventListener("click", () => {
    for (const selector of surfaces[index].reveal.controls) {
      if (targetRect([selector])) document.querySelector(selector).click();
    }
    renderReveal();
    position();
    requestAnimationFrame(position);
  });

  function finish() {
    dialog.close();
    summary.focus({ preventScroll: true });
  }

  function advance(change) {
    if (index + change >= surfaces.length) { finish(); return; }
    if (index + change < 0) return;
    index += change;
    render(change);
    if (previous.disabled && document.activeElement === previous) next.focus();
  }

  function open() {
    settings.open = false;
    index = 0;
    dialog.showModal();
    render();
    next.focus();
  }

  start.addEventListener("click", open);
  close.addEventListener("click", finish);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(); });
  previous.addEventListener("click", () => advance(-1));
  next.addEventListener("click", () => advance(1));
  dialog.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button,a") || !card.contains(event.target)) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    card.setPointerCapture(event.pointerId);
  });
  dialog.addEventListener("pointerup", (event) => {
    if (pointer?.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    pointer = undefined;
    if (Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy)) advance(dx < 0 ? 1 : -1);
  });
  dialog.addEventListener("pointercancel", () => { pointer = undefined; });
  window.addEventListener("keydown", (event) => {
    if (!dialog.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      finish();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      advance(event.key === "ArrowRight" ? 1 : -1);
    }
    event.stopImmediatePropagation();
  }, { capture: true });
  window.addEventListener("resize", position);
  document.addEventListener("qn:language", () => { if (dialog.open) render(); });
  const url = new URL(location.href);
  if (url.searchParams.get("tutorial") === "1") {
    url.searchParams.delete("tutorial");
    history.replaceState(history.state, "", url);
    if (stage === "home" || document.body.dataset.ready === "1") open();
    else {
      const ready = new MutationObserver(() => {
        if (document.body.dataset.ready !== "1") return;
        ready.disconnect();
        open();
      });
      ready.observe(document.body, { attributes: true, attributeFilter: ["data-ready"] });
    }
  }
}

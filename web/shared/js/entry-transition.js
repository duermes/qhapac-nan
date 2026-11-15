(() => {
  const destinations = {
    "/console": { name: "HATUN WASI", caption: "CENTRO DE MISIÓN" },
    "/rover": { name: "CHASKI", caption: "EXPLORACIÓN MÓVIL" },
    "/hud": { name: "ÑAWI", caption: "VISOR DE EXPLORACIÓN" }
  };
  let cover;
  function createCover(details, entering = false) {
    cover?.remove();
    cover = document.createElement("div");
    cover.id = "journey-entry-cover";
    cover.className = "product-loading" + (entering ? " is-entering" : "");
    cover.setAttribute("role", "status");
    cover.setAttribute("aria-live", "polite");
    const content = document.createElement("div");
    content.className = "product-loading-content";
    const runner = document.createElement("img");
    runner.className = "product-loading-runner";
    runner.src = "/static/shared/assets/chaski-running.svg";
    runner.alt = "";
    runner.width = 216;
    runner.height = 144;
    const name = document.createElement("h2");
    name.className = "product-loading-name";
    name.textContent = details.name;
    const caption = document.createElement("p");
    caption.className = "product-loading-caption";
    caption.textContent = details.caption;
    const status = document.createElement("p");
    status.className = "product-loading-status";
    status.textContent = "Preparando la travesía…";
    content.append(runner, name, caption, status);
    cover.appendChild(content);
    document.documentElement.appendChild(cover);
    return cover;
  }
  window.QNEntryTransition = {
    async start(details) {
      createCover(details, true);
      await new Promise(resolve => setTimeout(resolve, matchMedia("(prefers-reduced-motion: reduce)").matches ? 40 : 460));
    }
  };
  window.addEventListener("pageshow", event => { if (event.persisted) cover?.remove(); });
  if (!destinations[location.pathname]) return;
  let entry;
  try {
    entry = JSON.parse(sessionStorage.getItem("qn-entry-transition") || "null");
    sessionStorage.removeItem("qn-entry-transition");
  } catch {}
  const details = entry?.path === location.pathname && Date.now() - entry.time < 30000 ? entry : destinations[location.pathname];
  const loading = createCover(details);
  const started = performance.now();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function reveal() {
    const elapsed = performance.now() - started;
    if ((document.body?.dataset.ready !== "1" || elapsed < (reduced ? 40 : 850)) && elapsed < 15000) return requestAnimationFrame(reveal);
    const animation = loading.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? 1 : 450, easing: "ease-out", fill: "forwards" });
    animation.finished.finally(() => loading.remove());
  }
  requestAnimationFrame(reveal);
})();

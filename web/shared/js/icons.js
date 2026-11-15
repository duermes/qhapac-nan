// Local stroke icons (no CDN). Usage: icon("map")
const P = {
  brand: '<path d="M3 21h18M5 21v-4h4v-4h4V9h4V5h2" /><path d="M7 17h2M11 13h2M15 9h2" />',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  cube: '<path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h6"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  focus: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="2"/>',
  pin: '<path d="M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5z"/><path d="M4 19a2 2 0 0 1 2-2h13"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8M8 21v-7h8v7"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4.4-1"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13 7 4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevdown: '<path d="m6 9 6 6 6-6"/>',
  collapse: '<rect x="4" y="4" width="16" height="16"/><path d="M9 4v16M15 10l-2 2 2 2"/>',
  expand: '<rect x="4" y="4" width="16" height="16"/><path d="M9 4v16M13 10l2 2-2 2"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  truck: '<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  scan: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M4 12h16"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  nav: '<path d="M3 11 21 3l-8 18-2-8-8-2z"/>',
  flask: '<path d="M9 3h6M10 3v6L4 19a1.5 1.5 0 0 0 1.3 2h13.4A1.5 1.5 0 0 0 20 19l-6-10V3"/><path d="M7 15h10"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  radio: '<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17v.5"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17v.5"/>',
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
  battery: '<rect x="3" y="7" width="16" height="10"/><path d="M21 10v4"/>',
  o2: '<circle cx="9" cy="12" r="5"/><path d="M16 15h3l-3 3h3"/>',
  person: '<circle cx="12" cy="5" r="2"/><path d="M12 7v7M8 10h8M9 21l3-7 3 7"/>',
  antenna: '<path d="M12 10v11M8 21h8"/><path d="M8.5 6.5a5 5 0 0 1 7 0M6 4a8.5 8.5 0 0 1 12 0"/><circle cx="12" cy="9" r="1.5"/>',
  base: '<path d="M3 20h18M5 20v-7a7 7 0 0 1 14 0v7"/><path d="M10 20v-4h4v4"/>',
  hazard: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17v.5"/>',
  sample: '<path d="M9 3h6l-1 6 4 10H6l4-10-1-6z"/>',
  rocket: '<path d="M12 2c3 2 5 6 5 10l-2 5H9l-2-5c0-4 2-8 5-10z"/><circle cx="12" cy="10" r="2"/><path d="M9 17l-2 4M15 17l2 4"/>',
  station: '<path d="M12 21V9M6 21h12"/><path d="M8 9h8l-1-5H9z"/><path d="M12 4V2"/>',
  drill: '<path d="M9 21h6M12 21V9M8 9h8L12 3 8 9z"/><path d="M10 13h4M10 17h4"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  lock: '<rect x="5" y="11" width="14" height="10"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6"/><path d="M4 4v4.6h4.6"/>',
  arrowup: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowdown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  arrowleft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  arrowright: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  turnright: '<path d="M6 20v-7a4 4 0 0 1 4-4h9M15 5l4 4-4 4"/>',
};

export function icon(name, cls = "icon") {
  const body = P[name] || P.target;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// Asset registry: kind -> icon + semantic colour (decoupled from rendering code)
export const ASSET_REGISTRY = {
  base: { icon: "base", color: "#dfbd80", label: "Base" },
  habitat: { icon: "home", color: "#dfbd80", label: "Hábitat" },
  antenna: { icon: "antenna", color: "#4fb3d9", label: "Antena" },
  rover: { icon: "truck", color: "#4fd0c4", label: "Rover" },
  astronaut: { icon: "person", color: "#e7f0ff", label: "Astronauta" },
  waypoint: { icon: "pin", color: "#f3ebdc", label: "Waypoint" },
  poi: { icon: "flask", color: "#b18cff", label: "POI científico" },
  sample: { icon: "sample", color: "#3fbf7f", label: "Muestra" },
  rover_sample: { icon: "sample", color: "#68e1ff", label: "Muestras de Perseverance" },
  orbital: { icon: "flask", color: "#f4a887", label: "Detecciones de Mars Trek" },
  landmark: { icon: "station", color: "#b8b3a5", label: "Infraestructura" },
  hazard: { icon: "hazard", color: "#e0534a", label: "Peligro" },
  lava_pit: { icon: "hazard", color: "#ff8c36", label: "Fosa de lava" },
  laboratory: { icon: "flask", color: "#72cec7", label: "Laboratorio" },
};

export const markerKind = (e) => e.source === "official_science" ? e.category : e.kind;

// Optional local SVG replacements. The same image supplies canvas, 3D and legend.
const markerCache = new Map();
const fallbackCache = new Map();
let customKinds = new Set();
fetch("/api/map-icons").then(response => response.ok ? response.json() : {kinds:[]})
  .then(({kinds}) => { customKinds = new Set(kinds); document.dispatchEvent(new Event("qn:icons")); })
  .catch(() => {});
export function markerImage(kind, color = ASSET_REGISTRY[kind]?.color || "#f3ebdc") {
  const reg = ASSET_REGISTRY[kind] || ASSET_REGISTRY.waypoint;
  if (customKinds.has(kind) && !markerCache.has(kind)) {
    const custom = new Image();
    markerCache.set(kind, custom);
    custom.onload = () => document.dispatchEvent(new Event("qn:icons"));
    custom.onerror = () => { markerCache.set(kind, null); };
    custom.src = `/static/shared/assets/markers/${encodeURIComponent(kind)}.svg`;
  }
  const custom = markerCache.get(kind);
  if (custom?.complete && custom.naturalWidth) return custom;
  const key = `${kind}:${color}`;
  if (!fallbackCache.has(key)) {
    const img = new Image();
    const svg = icon(reg.icon).replace('stroke="currentColor"', `stroke="${color}"`)
      .replace('class="icon"', 'xmlns="http://www.w3.org/2000/svg" width="24" height="24"');
    img.onload = () => document.dispatchEvent(new Event("qn:icons"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    fallbackCache.set(key, img);
  }
  return fallbackCache.get(key);
}

export function markerSymbol(kind) {
  const img = markerImage(kind);
  const custom = markerCache.get(kind);
  return custom?.complete && custom.naturalWidth
    ? `<img src="${img.src}" class="icon" alt="" aria-hidden="true">`
    : icon((ASSET_REGISTRY[kind] || ASSET_REGISTRY.waypoint).icon);
}

export const isVirtual = (entity) => ["astronaut", "rover"].includes(entity.kind)
  && (entity.virtual === true || entity.source === "user");

export function brandBlock(name) {
  return `<div class="brand panel cut" role="banner">
    <span class="brand-mark">${icon("brand", "brand-mark")}</span>
    <div><div class="brand-name">${name}</div><div class="brand-sub">Qhapaq Ñan · Khipu Engine</div></div>
  </div>`;
}

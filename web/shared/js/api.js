// Thin client for the Khipu API. Mirrors api/schemas.py contracts.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.detail || body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body, { timeout = 30000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { detail: text }; }
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  } catch (e) {
    if (e.name === "AbortError") throw new ApiError(0, { detail: "Tiempo de espera agotado" });
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, { detail: "Sin conexión con Khipu (modo local limitado)" });
  } finally {
    clearTimeout(t);
  }
}

const q = (o) => {
  const p = new URLSearchParams();
  Object.entries(o || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") p.set(k, v); });
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  health: () => request("GET", "/api/health"),
  regions: () => request("GET", "/api/regions"),
  officialRoutes: (key) => request("GET", "/api/official_routes/" + encodeURIComponent(key)),
  scenario: () => request("GET", "/api/scenario"),
  terrain: (key, opts = {}) => request("GET", `/api/terrain/${encodeURIComponent(key)}${q(opts)}`),
  sample: (key, lat, lon) => request("GET", `/api/terrain/${encodeURIComponent(key)}/sample${q({ lat, lon })}`),
  officialRoutes: (key) => request("GET", `/api/official_routes/${encodeURIComponent(key)}`),
  marsTime: (lat, lon) => request("GET", `/api/mars_time${q({ lat, lon })}`),
  route: (body) => request("POST", "/api/route", body, { timeout: 60000 }),
  replan: (body) => request("POST", "/api/route/dynamic_replan", body, { timeout: 60000 }),
  costmap: (body) => request("POST", "/api/costmap", body),
  assets: (session_id) => request("GET", `/api/assets${q({ session_id })}`),
  addAsset: (a) => request("POST", "/api/assets", a),
  patchAsset: (id, p) => request("PATCH", `/api/assets/${encodeURIComponent(id)}`, p),
  deleteAsset: (id) => request("DELETE", `/api/assets/${encodeURIComponent(id)}`),
  saveToGeneral: (session_id, ids) => request("POST", "/api/assets/save_to_general", { session_id, ids }),
  clearSession: (session_id) => request("POST", "/api/assets/clear_session", { session_id }),
  workspace: () => request("GET", "/api/workspace"),
  saveWorkspace: (ws) => request("PUT", "/api/workspace", ws),
  risk: (opts) => request("GET", `/api/inspection/risk_factors${q(opts)}`),
  layers: (region_key) => request("GET", `/api/layers${q({ region_key })}`),
  layer: (id, opts) => request("GET", `/api/layers/${encodeURIComponent(id)}${q(opts)}`),
  weather: () => request("GET", "/api/nasa/weather"),
  apod: () => request("GET", "/api/nasa/apod"),
  ingest: (body) => request("POST", "/api/ingest/extract_mola", body, { timeout: 60000 }),
  harness: () => request("GET", "/api/harness"),
  inject: (kind, params) => request("POST", "/api/harness/inject", { kind, params }),
  clearHarness: () => request("DELETE", "/api/harness"),
  swarm: () => request("GET", "/api/swarm/status"),
  failover: (force_out) => request("POST", "/api/swarm/failover", { force_out }),
  export: (fmt, route, name) => request("POST", `/api/export/${fmt}`, { route, name }),
  voiceStatus: () => request("GET", "/api/voice/status", undefined, { timeout: 5000 }),
  voice: (text, iface, points = [], language = "es", preferLocal = false) =>
    request("POST", "/api/voice/command", { text, interface: iface, points, language, prefer_local: preferLocal }, { timeout: 40000 }),
  voiceAudio: (audio, mimeType, iface, points, language) =>
    request("POST", "/api/voice/audio", { audio, mime_type: mimeType, interface: iface, points, language }, { timeout: 40000 }),
  fsm: (snap) => request("POST", "/api/fsm/evaluate", snap),
  localization: (body) => request("POST", "/api/localization", body),
  autopilot: (body) => request("POST", "/api/autopilot/command", body),
  traction: (slope_deg, roll_deg) => request("GET", `/api/rover/traction${q({ slope_deg, roll_deg })}`),
  vitals: (body) => request("POST", "/api/eva/vitals", body),
  ledger: (id, profile) => request("GET", `/api/ledger/${encodeURIComponent(id)}${q({ profile })}`),
  consume: (id, amount, profile, note) => request("POST", `/api/ledger/${encodeURIComponent(id)}/consume`, { amount, profile, note }),
};

export function download(filename, content, mime = "text/plain") {
  const blob = new Blob([typeof content === "string" ? content : JSON.stringify(content, null, 2)], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// Geodesy helpers mirrored from khipu/geodesy.py (sphere R = 3396 km).
export const R = 3396000;
export const DEG = Math.PI / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dp = p2 - p1, dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

export function destination(lat, lon, brgDeg, distM) {
  const d = distM / R, b = brgDeg * DEG, p1 = lat * DEG, l1 = lon * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / DEG, lon: l2 / DEG };
}

// Grid geometry (simple cylindrical, row 0 north) — matches GridGeometry.
export class Grid {
  constructor(g) {
    Object.assign(this, g);
    this.dy = R * DEG / g.pixels_per_degree;
    this.latC = (g.lat_max + g.lat_min) / 2;
    this.dxC = this.dy * Math.cos(this.latC * DEG); // isotropic metres at centre latitude
  }
  toRC(lat, lon) {
    return { r: (this.lat_max - lat) * this.pixels_per_degree - 0.5, c: (lon - this.lon_min) * this.pixels_per_degree - 0.5 };
  }
  toLL(r, c) {
    return { lat: this.lat_max - (r + 0.5) / this.pixels_per_degree, lon: this.lon_min + (c + 0.5) / this.pixels_per_degree };
  }
  dxAt(lat) { return this.dy * Math.cos(lat * DEG); }
  contains(lat, lon) { return lat >= this.lat_min && lat <= this.lat_max && lon >= this.lon_min && lon <= this.lon_max; }
  // local tangent-plane metres relative to the region centre (x east, z south)
  toXZ(lat, lon) {
    const x = R * Math.cos(this.latC * DEG) * (lon - (this.lon_min + this.lon_max) / 2) * DEG;
    const y = R * (lat - this.latC) * DEG;
    return { x, z: -y };
  }
  fromXZ(x, z) {
    const lat = this.latC + (-z / R) / DEG;
    const lon = (this.lon_min + this.lon_max) / 2 + (x / (R * Math.cos(this.latC * DEG))) / DEG;
    return { lat, lon };
  }
  widthM() { return this.cols * this.dxC; }
  heightM() { return this.rows * this.dy; }
}

export const fmt = {
  lat: (v) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? "N" : "S"}`,
  lon: (v) => `${(((v % 360) + 360) % 360).toFixed(4)}° E`,
  m: (v) => (v == null ? "—" : Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)} km` : `${v.toFixed(0)} m`),
  dur: (s) => {
    if (s == null || !isFinite(s)) return "—";
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? `${h} h ${m} min` : `${m} min`;
  },
  num: (v, d = 1) => (v == null || !isFinite(v) ? "—" : Number(v).toFixed(d)),
  pct: (v) => (v == null || !isFinite(v) ? "—" : `${v.toFixed(1)}%`),
};

export function bilinear(arr, rows, cols, r, c) {
  r = Math.min(Math.max(r, 0), rows - 1);
  c = Math.min(Math.max(c, 0), cols - 1);
  const r0 = Math.floor(r), c0 = Math.floor(c);
  const r1 = Math.min(r0 + 1, rows - 1), c1 = Math.min(c0 + 1, cols - 1);
  const fr = r - r0, fc = c - c0;
  const v = (rr, cc) => arr[rr * cols + cc];
  return (v(r0, c0) * (1 - fc) + v(r0, c1) * fc) * (1 - fr) + (v(r1, c0) * (1 - fc) + v(r1, c1) * fc) * fr;
}

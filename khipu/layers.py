"""Layer catalog and snapshot manager.

Every layer declares units, provenance, availability and whether it depends
on time parameters. Temporal layers default to the "real-time" parameter set
(current Mars time) and can be reset to it."""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

import numpy as np

from .costmap import CostParams, HazardZone, compute_costmap, distance_grid_m
from .domain import Provenance, Snapshot
from .physics import environment as env
from .physics import ephemeris as eph
from .physics import telecom as tc
from .physics import terramechanics as tm
from .terrain import TerrainContext


LAYER_INPUTS = {
    "elevation": ("Topografía MOLA",),
    "slope": ("Topografía MOLA", "Geometría planetocéntrica"),
    "roughness": ("Topografía MOLA", "Ventana de relieve"),
    "hazard": ("Topografía MOLA", "Pendiente", "Zonas de exclusión"),
    "costmap": ("Topografía MOLA", "Pendiente y relieve", "Zonas de exclusión"),
    "temperature": ("Topografía MOLA", "Insolación", "Atmósfera de polvo"),
    "thermal_gradient": ("Topografía MOLA", "Temperatura superficial", "Escala espacial"),
    "insolation": ("Topografía MOLA", "Efemérides solares", "Atenuación atmosférica"),
    "shadow": ("Topografía MOLA", "Efemérides solares"),
    "dust": ("Topografía MOLA", "Columna atmosférica", "Profundidad óptica"),
    "radiation": ("Topografía MOLA", "Columna atmosférica", "Referencia MSL/RAD"),
    "telecom": ("Topografía MOLA", "Antena UHF", "Difracción ITU-R"),
    "traversability": ("Topografía MOLA", "Tracción y relieve", "Polvo"),
    "slip": ("Topografía MOLA", "Tracción y suelo"),
    "igt": ("Topografía MOLA", "Tracción, pendiente y rugosidad"),
    "ibio": ("Topografía MOLA", "Cuencas", "Objetivos científicos"),
    "science_vs_risk": ("Topografía MOLA", "Objetivos científicos", "Zonas de exclusión"),
    "survival_astronaut": ("Topografía MOLA", "Base y alcance EVA", "Enlace, polvo y temperatura"),
    "survival_rover": ("Topografía MOLA", "Base y alcance del rover", "Enlace, polvo y temperatura"),
    "isru": ("Mapas CRISM/SHARAD", "Coeficientes ISRU"),
}

LAYER_CONTROLS = {
    "hazard": ("profile", "max_slope_deg"),
    "costmap": ("profile", "max_slope_deg", "hazard_weight"),
    "temperature": ("ltst_h", "tau"),
    "thermal_gradient": ("ltst_h", "tau"),
    "insolation": ("ltst_h", "tau", "helio_au"),
    "shadow": ("ltst_h",),
    "dust": ("tau",),
    "radiation": ("tau",),
    "telecom": ("receiver_height_m", "link_margin_offset_db"),
    "traversability": ("max_slope_deg", "tau"),
    "igt": ("max_slope_deg",),
    "ibio": ("science_radius_scale",),
    "science_vs_risk": ("alpha", "science_radius_scale", "max_slope_deg"),
    "survival_astronaut": ("ltst_h", "tau", "walkback_m", "max_slope_deg"),
    "survival_rover": ("ltst_h", "tau", "walkback_m", "max_slope_deg"),
}

@dataclass
class LayerDef:
    id: str
    name: str
    units: str
    provenance: Provenance
    category: str
    description: str
    temporal: bool = False
    colormap: str = "viridis"
    requires: list[str] = field(default_factory=list)
    available: bool = True
    unavailable_reason: str | None = None
    default_params: dict = field(default_factory=dict)
    compute: Callable[["LayerContext", dict], np.ndarray] | None = None
    range_hint: tuple[float, float] | None = None

    def describe(self) -> dict:
        return {"id": self.id, "name": self.name, "units": self.units, "provenance": self.provenance.value,
                "category": self.category, "description": self.description, "temporal": self.temporal,
                "inputs": LAYER_INPUTS.get(self.id, ()), "controls": LAYER_CONTROLS.get(self.id, ()),
                "colormap": self.colormap, "requires": self.requires, "available": self.available,
                "unavailable_reason": self.unavailable_reason, "default_params": self.default_params,
                "range_hint": list(self.range_hint) if self.range_hint else None}


@dataclass
class LayerContext:
    terrain: TerrainContext
    scenario: dict
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)

    def hazards(self) -> list[HazardZone]:
        return [HazardZone.from_dict(h) for h in self.scenario.get("hazards", [])]

    def antenna(self) -> dict | None:
        for a in self.scenario.get("assets", []):
            if a.get("kind") == "antenna":
                return a
        return None

    def science_pois(self) -> list[dict]:
        return [p for p in self.scenario.get("pois", []) if p.get("science_value")]


def realtime_params(ctx: LayerContext, lat: float | None = None, lon: float | None = None) -> dict:
    g = ctx.terrain.geometry
    lat = lat if lat is not None else (g.lat_min + g.lat_max) / 2
    lon = lon if lon is not None else (g.lon_min + g.lon_max) / 2
    mt = eph.mars_time(ctx.now(), lon)
    return {"ltst_h": round(mt["ltst_h"], 3), "ls_deg": mt["ls_deg"], "declination_deg": mt["declination_deg"],
            "helio_au": mt["helio_au"], "sol": mt["sol"], "tau": 0.5, "realtime": True, "lat": lat, "lon": lon}


def _solar(ctx: LayerContext, p: dict) -> dict:
    lat = p.get("lat") or (ctx.terrain.geometry.lat_min + ctx.terrain.geometry.lat_max) / 2
    return eph.solar_position(lat, float(p.get("ltst_h", 13.0)), float(p.get("declination_deg", 0.0)))


# ------------------------------------------------------------------ computations

def L_elevation(ctx, p):
    return ctx.terrain.elevation.copy()


def L_slope(ctx, p):
    return ctx.terrain.slope.copy()


def L_roughness(ctx, p):
    return ctx.terrain.relief.copy()


def L_temperature(ctx, p):
    t = env.surface_temperature_k(float(p.get("ltst_h", 13.0)), ctx.terrain.filled(), float(p.get("tau", 0.5)),
                                  latitude_deg=float(p.get("lat") or 18.0))
    sol = _solar(ctx, p)
    if sol["elevation_deg"] > 0:
        ins = L_insolation(ctx, p)
        t = t + 8.0 * (ins / max(ins.max(), 1.0) - 0.5)
    return t - 273.15


def L_thermal_gradient(ctx, p):
    return env.thermal_gradient_k_per_km(L_temperature(ctx, p), ctx.terrain.geometry.dy_m)


def L_insolation(ctx, p):
    sol = _solar(ctx, p)
    sh = eph.terrain_shadow(ctx.terrain.filled(), ctx.terrain.geometry, sol["elevation_deg"], sol["azimuth_deg"], 40)
    return eph.insolation_w_m2(ctx.terrain.filled(), np.nan_to_num(ctx.terrain.slope), ctx.terrain.aspect,
                               sol["elevation_deg"], sol["azimuth_deg"], float(p.get("helio_au", 1.52)),
                               float(p.get("tau", 0.5)), sh)


def L_shadow(ctx, p):
    sol = _solar(ctx, p)
    return eph.terrain_shadow(ctx.terrain.filled(), ctx.terrain.geometry, sol["elevation_deg"], sol["azimuth_deg"], 40).astype(float)


def L_dust(ctx, p):
    tau = float(p.get("tau", 0.5))
    z = ctx.terrain.filled()
    # optical depth scales with atmospheric column (scale height ~11 km)
    return tau * np.exp(-(z - np.nanmedian(z)) / 11100.0)


def L_radiation(ctx, p):
    return env.radiation_dose_mgy_day(ctx.terrain.filled(), float(p.get("tau", 0.5)))


def telecom_margin_grid(ctx: LayerContext, p: dict, stride: int = 4, samples: int = 40) -> np.ndarray:
    """Link margin (dB) from the scenario antenna to every cell, with terrain
    horizon/diffraction (ITU-R P.526) and Mars curvature."""
    ant = p.get("antenna") or ctx.antenna()
    terrain = ctx.terrain
    if not ant:
        return np.full(terrain.shape, np.nan)
    g = terrain.geometry
    z = terrain.filled()
    ra, ca = g.latlon_to_rc(float(ant["lat"]), float(ant["lon"]))
    ra = min(max(ra, 0), terrain.shape[0] - 1)
    ca = min(max(ca, 0), terrain.shape[1] - 1)
    h_tx = float(ant.get("metadata", {}).get("mast_height_m", p.get("antenna_height_m", 6.0)))
    h_rx = float(p.get("receiver_height_m", 2.0))
    rows = np.arange(0, terrain.shape[0], stride)
    cols = np.arange(0, terrain.shape[1], stride)
    RR, CC = np.meshgrid(rows, cols, indexing="ij")
    dx = float(np.mean(g.dx_rows()))
    total = np.hypot((CC - ca) * dx, (RR - ra) * g.dy_m) + 1.0
    z_tx = z[int(round(ra)), int(round(ca))] + h_tx
    z_rx = z[RR, CC] + h_rx
    lam = tc.C / 401.5e6
    nu_max = np.full(RR.shape, -10.0)
    for k in range(1, samples):
        f = k / samples
        r = np.clip(np.rint(ra + (RR - ra) * f).astype(int), 0, terrain.shape[0] - 1)
        c = np.clip(np.rint(ca + (CC - ca) * f).astype(int), 0, terrain.shape[1] - 1)
        d1 = total * f
        d2 = total - d1
        bulge = d1 * d2 / (2 * g.radius)
        los = z_tx + (z_rx - z_tx) * f
        h = z[r, c] + bulge - los
        nu = h * np.sqrt(2.0 / lam * total / np.maximum(d1 * d2, 1e-6))
        nu_max = np.maximum(nu_max, nu)
    diff = tc.itu_knife_edge_loss_db_array(nu_max)
    fspl = 20 * np.log10(4 * math.pi * total * 401.5e6 / tc.C)
    prx = 10.0 + 2.0 + 2.0 - fspl - diff - 3.0
    n0 = tc.BOLTZMANN_DBW + 10 * math.log10(500.0)
    margin = prx - n0 - 10 * math.log10(256000.0) - 4.5
    margin = margin - float(p.get("link_margin_offset_db", 0.0) or 0.0)
    full = np.repeat(np.repeat(margin, stride, axis=0), stride, axis=1)[: terrain.shape[0], : terrain.shape[1]]
    return full


def L_telecom(ctx, p):
    return telecom_margin_grid(ctx, p)


def L_slip(ctx, p):
    slope = np.nan_to_num(ctx.terrain.slope, nan=60.0)
    table_s = np.arange(0, 31, 1.0)
    table = np.array([tm.equilibrium_slip(tm.Rover(), s) for s in table_s])
    out = np.interp(np.clip(slope, 0, 30), table_s, table)
    return np.where(slope > 30, 1.0, out)


def L_traversability(ctx, p):
    """Dynamic traversability 0-1 (continuous; 1 = easy)."""
    slip = L_slip(ctx, p)
    slope = np.nan_to_num(ctx.terrain.slope, nan=90.0)
    limit = float(p.get("max_slope_deg", 20.0))
    rough = np.clip(ctx.terrain.relief / 260.0, 0, 1)
    tau = float(p.get("tau", 0.5))
    vis = 1.0 - min(0.4, 0.08 * tau)
    trav = (1 - np.clip(slope / limit, 0, 1) ** 1.5) * (1 - slip) * (1 - 0.5 * rough) * vis
    return np.clip(trav, 0, 1)


def L_igt(ctx, p):
    """IGT matrix: global traversability index 0-100 combining slope, roughness and slip."""
    return 100.0 * L_traversability(ctx, {**p, "tau": 0.0})


def L_ibio(ctx, p):
    """IBIO astrobiology index 0-100: kernel density around scenario science
    targets weighted by their declared value, modulated by low-energy
    depositional settings (local depressions)."""
    terrain = ctx.terrain
    out = np.zeros(terrain.shape)
    for poi in ctx.science_pois():
        d = distance_grid_m(terrain, poi["lat"], poi["lon"])
        sigma = float(poi.get("influence_m", 2500.0)) * p.get("science_radius_scale", 1.0)
        out = np.maximum(out, float(poi["science_value"]) * np.exp(-(d / sigma) ** 2))
    z = terrain.filled()
    k = 6
    pad = np.pad(z, k, mode="edge")
    mean = np.zeros_like(z)
    for dr in range(0, 2 * k + 1, 3):
        for dc in range(0, 2 * k + 1, 3):
            mean += pad[dr:dr + z.shape[0], dc:dc + z.shape[1]]
    mean /= len(range(0, 2 * k + 1, 3)) ** 2
    basin = np.clip((mean - z) / 150.0, 0, 1)
    return np.clip(100.0 * (0.8 * out + 0.2 * basin), 0, 100)


def L_science(ctx, p):
    return L_ibio(ctx, p) / 100.0


def L_risk(ctx, p):
    cp = CostParams(profile=p.get("profile", "rover"), max_slope_deg=p.get("max_slope_deg"), hazard_zones=ctx.hazards())
    cm = compute_costmap(ctx.terrain, cp)
    risk = np.clip(np.where(np.isfinite(cm.cost), cm.cost / 3.0, 1.0), 0, 1)
    return risk


def L_science_vs_risk(ctx, p):
    """alpha*science - (1-alpha)*risk  in [-1, 1]; alpha from slider."""
    a = float(p.get("alpha", 0.5))
    return a * L_science(ctx, p) - (1 - a) * L_risk(ctx, p)


def L_survival(ctx, p):
    """Composite survival cost 0-1 for the selected profile: terrain risk,
    distance from base vs walkback, comms loss, thermal stress."""
    prof = p.get("profile", "astronaut")
    risk = L_risk(ctx, {**p, "profile": prof})
    base = next((a for a in ctx.scenario.get("assets", []) if a.get("kind") in ("base", "habitat")), None)
    if base:
        d = distance_grid_m(ctx.terrain, base["lat"], base["lon"])
        reach = float(p.get("walkback_m", 2000.0 if prof == "astronaut" else 15000.0))
        dist_f = np.clip(d / reach, 0, 1.5) / 1.5
    else:
        dist_f = np.zeros(ctx.terrain.shape)
    link = telecom_margin_grid(ctx, p)
    comm_f = np.clip((6.0 - np.nan_to_num(link, nan=-20.0)) / 26.0, 0, 1)
    temp = L_temperature(ctx, p)
    therm_f = np.clip((-60.0 - temp) / 50.0, 0, 1)
    tau = float(p.get("tau", 0.5))
    dust_f = min(1.0, tau / 3.0)
    survival = 0.35 * risk + 0.30 * dist_f + 0.2 * comm_f + 0.1 * therm_f + 0.05 * dust_f
    return np.clip(survival, 0, 1)


def L_costmap(ctx, p):
    cp = CostParams(profile=p.get("profile", "rover"), max_slope_deg=p.get("max_slope_deg"),
                    w_hazard=p.get("hazard_weight", 1.0), hazard_zones=ctx.hazards())
    cm = compute_costmap(ctx.terrain, cp)
    finite = np.isfinite(cm.cost)
    upper = max(1.0, float(cm.cost[finite].max())) if finite.any() else 1.0
    return np.where(finite, cm.cost, np.where(ctx.terrain.valid, upper * 1.15, np.nan))


def L_hazard_tiers(ctx, p):
    cp = CostParams(profile=p.get("profile", "rover"), max_slope_deg=p.get("max_slope_deg"), hazard_zones=ctx.hazards())
    return compute_costmap(ctx.terrain, cp).tiers.astype(float)


def build_catalog(scenario: dict | None = None) -> dict[str, LayerDef]:
    P = Provenance
    has_isru = bool((scenario or {}).get("isru_coefficients"))
    defs = [
        LayerDef("elevation", "Elevación MOLA", "m", P.OFFICIAL_NASA, "terreno",
                 "Topografía mediana MOLA MEGDR sobre el areoide.", colormap="terrain", compute=L_elevation),
        LayerDef("slope", "Pendiente física", "°", P.DERIVED_FROM_NASA, "terreno",
                 "Pendiente por diferencias centrales con corrección geodésica cos(lat).", colormap="slope",
                 compute=L_slope, range_hint=(0, 30)),
        LayerDef("roughness", "Relieve local", "m", P.DERIVED_FROM_NASA, "terreno",
                 "Rango de elevación en ventana 3×3 (~1.4 km).", colormap="magma", compute=L_roughness),
        LayerDef("hazard", "Niveles de riesgo", "nivel 0-3", P.DERIVED_FROM_NASA, "riesgo",
                 "Libre/precaución/alto/prohibido por pendiente y zonas de exclusión del escenario.",
                 colormap="tiers", compute=L_hazard_tiers, range_hint=(0, 3)),
        LayerDef("costmap", "Mapa de coste", "adim.", P.DERIVED_FROM_NASA, "riesgo",
                 "Coste continuo de navegación; rojo intenso en zonas prohibidas.", colormap="cost", compute=L_costmap),
        LayerDef("temperature", "Temperatura superficial", "°C", P.MODEL, "ambiente",
                 "Modelo diurno amortiguado por polvo con insolación del terreno.", temporal=True,
                 colormap="thermal", compute=L_temperature),
        LayerDef("thermal_gradient", "Gradiente térmico", "K/km", P.MODEL, "ambiente",
                 "Magnitud del gradiente espacial de temperatura.", temporal=True, colormap="magma",
                 compute=L_thermal_gradient),
        LayerDef("insolation", "Insolación", "W/m²", P.MODEL, "ambiente",
                 "Irradiancia directa+difusa sobre la superficie inclinada con sombras de terreno.", temporal=True,
                 colormap="solar", compute=L_insolation),
        LayerDef("shadow", "Sombras de terreno", "0/1", P.MODEL, "ambiente",
                 "Celdas ocultas al Sol según la posición solar Mars24.", temporal=True, colormap="shadow",
                 compute=L_shadow, range_hint=(0, 1)),
        LayerDef("dust", "Opacidad de polvo", "τ", P.MODEL, "ambiente",
                 "Profundidad óptica escalada por columna atmosférica.", colormap="dust",
                 compute=L_dust),
        LayerDef("radiation", "Dosis de radiación", "mGy/día", P.MODEL, "ambiente",
                 "Dosis absorbida referida a MSL/RAD y columna atmosférica.", colormap="magma", compute=L_radiation),
        LayerDef("telecom", "Margen de enlace", "dB", P.MODEL, "comunicaciones",
                 "Margen UHF desde la antena del escenario con horizonte y difracción ITU-R P.526.",
                 colormap="telecom", compute=L_telecom, requires=["antena del escenario"], range_hint=(-20, 40)),
        LayerDef("traversability", "Transitabilidad dinámica", "0-1", P.MODEL, "movilidad",
                 "Pendiente, deslizamiento Bekker/Janosi, rugosidad y visibilidad por polvo.",
                 colormap="traversability", compute=L_traversability, range_hint=(0, 1)),
        LayerDef("slip", "Deslizamiento del rover", "0-1", P.MODEL, "movilidad",
                 "Deslizamiento de equilibrio (tracción = resistencia) según pendiente.", colormap="magma",
                 compute=L_slip, range_hint=(0, 1)),
        LayerDef("igt", "Matriz IGT", "0-100", P.MODEL, "movilidad",
                 "Índice global de transitabilidad.", colormap="traversability", compute=L_igt, range_hint=(0, 100)),
        LayerDef("ibio", "Matriz IBIO", "0-100", P.SYNTHETIC, "ciencia",
                 "Índice astrobiológico desde objetivos científicos del escenario (sintético) y cuencas.",
                 colormap="science", compute=L_ibio, range_hint=(0, 100)),
        LayerDef("science_vs_risk", "Ciencia frente a riesgo", "-1..1", P.MODEL, "ciencia",
                 "α·ciencia − (1−α)·riesgo con α ajustable.", colormap="diverging", compute=L_science_vs_risk,
                 default_params={"alpha": 0.5}, range_hint=(-1, 1)),
        LayerDef("survival_astronaut", "Coste de supervivencia EVA (Astronauta)", "0-1", P.MODEL, "supervivencia",
                 "Riesgo de terreno, distancia vs walkback, enlace, frío y polvo.", temporal=True,
                 colormap="survival", compute=lambda c, p: L_survival(c, {**p, "profile": "astronaut"}),
                 range_hint=(0, 1)),
        LayerDef("survival_rover", "Supervivencia del rover", "0-1", P.MODEL, "supervivencia",
                 "Coste compuesto para el rover (alcance 15 km).", temporal=True, colormap="survival",
                 compute=lambda c, p: L_survival(c, {**p, "profile": "rover"}), range_hint=(0, 1)),
        LayerDef("isru", "Habitabilidad ISRU", "0-1", P.UNAVAILABLE, "ciencia",
                 "Requiere mapas de hidratación/hielo (CRISM, SHARAD) y coeficientes ISRU.",
                 available=has_isru,
                 unavailable_reason=None if has_isru else
                 "No hay datos de hidratación/hielo ni coeficientes ISRU en el manifiesto; la capa no se inventa.",
                 colormap="science"),
    ]
    return {d.id: d for d in defs}


class SnapshotManager:
    def __init__(self, ctx: LayerContext, catalog: dict[str, LayerDef] | None = None, max_items: int = 48):
        self.ctx = ctx
        self.catalog = catalog or build_catalog(ctx.scenario)
        self.cache: dict[str, Snapshot] = {}
        self.max_items = max_items

    def list(self) -> list[dict]:
        return [d.describe() for d in self.catalog.values()]

    def params_for(self, layer_id: str, params: dict | None) -> dict:
        d = self.catalog[layer_id]
        p = dict(d.default_params)
        if d.temporal and (not params or params.get("realtime", False) or "ltst_h" not in (params or {})):
            p.update(realtime_params(self.ctx))
        if params:
            p.update({k: v for k, v in params.items() if v is not None})
        return p

    def snapshot(self, layer_id: str, params: dict | None = None) -> Snapshot:
        if layer_id not in self.catalog:
            raise KeyError(layer_id)
        d = self.catalog[layer_id]
        if not d.available or d.compute is None:
            raise LookupError(d.unavailable_reason or "layer unavailable")
        p = self.params_for(layer_id, params)
        key_p = {k: v for k, v in p.items() if k not in ("ls_deg", "sol")}
        key = layer_id + ":" + hashlib.sha1(json.dumps(key_p, sort_keys=True, default=str).encode()).hexdigest()
        if key in self.cache:
            return self.cache[key]
        data = np.asarray(d.compute(self.ctx, p), dtype=np.float64)
        data = np.where(self.ctx.terrain.valid, data, np.nan)
        snap = Snapshot(layer_id, p, data, d.units, d.provenance)
        if len(self.cache) >= self.max_items:
            self.cache.pop(next(iter(self.cache)))
        self.cache[key] = snap
        return snap

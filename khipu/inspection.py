"""Point inspection: contextual risk factors at a location, honest about gaps."""
from __future__ import annotations

import math

import numpy as np

from .costmap import TIER_FORBIDDEN, CostParams, compute_costmap, distance_grid_m
from .geodesy import haversine_m
from .layers import LayerContext, SnapshotManager
from .physics import ephemeris as eph
from .physics import terramechanics as tm

TIER_NAMES = {0: "libre", 1: "precaución", 2: "alto", 3: "prohibido"}


def risk_factors(mgr: SnapshotManager, lat: float, lon: float, profile: str = "rover", params: dict | None = None) -> dict:
    ctx: LayerContext = mgr.ctx
    terrain = ctx.terrain
    s = terrain.sample(lat, lon)
    if not s["inside"]:
        return {"inside": False, "lat": lat, "lon": lon, "factors": [], "message": "Fuera de la región cargada."}
    if s.get("no_data"):
        return {"inside": True, "lat": lat, "lon": lon, "factors": [], "no_data": True,
                "message": "Celda sin datos MOLA: no se infiere elevación ni riesgo."}
    r, c = s["row"], s["col"]
    p = dict(params or {})
    cp = CostParams(profile=profile, hazard_zones=ctx.hazards(), max_slope_deg=p.get("max_slope_deg"))
    cm = compute_costmap(terrain, cp)
    tier = int(cm.tiers[r, c])
    factors = []
    limit = cp.slope_limit()
    slope = s["slope_deg"]
    factors.append({"id": "slope", "label": "Pendiente", "value": round(slope, 2), "units": "°",
                    "level": "alto" if slope > limit else ("precaución" if slope > 0.6 * limit else "bajo"),
                    "source": "derived_from_nasa"})
    factors.append({"id": "roughness", "label": "Relieve local", "value": round(s["relief_m"], 1), "units": "m",
                    "level": "alto" if s["relief_m"] > 200 else ("precaución" if s["relief_m"] > 100 else "bajo"),
                    "source": "derived_from_nasa"})
    slip = tm.equilibrium_slip(tm.Rover(), min(slope, 35.0))
    factors.append({"id": "slip", "label": "Deslizamiento estimado", "value": round(slip, 3), "units": "0-1",
                    "level": tm.traction_state(slip), "source": "model"})
    for hz in ctx.hazards():
        d = haversine_m(lat, lon, hz.lat, hz.lon)
        if d <= hz.radius_m * 1.5:
            factors.append({"id": f"zone:{hz.id}", "label": hz.name, "value": round(d, 0), "units": "m al centro",
                            "level": TIER_NAMES[hz.tier] if d <= hz.radius_m else "proximidad",
                            "source": "synthetic"})
    # illumination: only when solar parameters are resolvable
    snap_p = mgr.params_for("insolation", p)
    if snap_p.get("ltst_h") is None:
        factors.append({"id": "illumination", "label": "Iluminación", "value": None, "units": "W/m²",
                        "level": "sin datos", "source": "unavailable",
                        "note": "Sin hora solar: no se declara baja iluminación."})
    else:
        ins = mgr.snapshot("insolation", snap_p).data[r, c]
        sol = eph.solar_position(lat, snap_p["ltst_h"], snap_p.get("declination_deg", 0.0))
        if not np.isfinite(ins):
            factors.append({"id": "illumination", "label": "Iluminación", "value": None, "units": "W/m²",
                            "level": "sin datos", "source": "unavailable"})
        else:
            low = sol["elevation_deg"] > 0 and ins < 60
            factors.append({"id": "illumination", "label": "Iluminación", "value": round(float(ins), 1),
                            "units": "W/m²", "level": "noche" if sol["elevation_deg"] <= 0 else ("baja" if low else "adecuada"),
                            "source": "model", "sun_elevation_deg": round(sol["elevation_deg"], 2)})
    try:
        tel = mgr.snapshot("telecom", {}).data[r, c]
        if np.isfinite(tel):
            factors.append({"id": "telecom", "label": "Margen de enlace", "value": round(float(tel), 1), "units": "dB",
                            "level": "pérdida" if tel < 0 else ("precaución" if tel < 6 else "nominal"),
                            "source": "model"})
    except LookupError:
        pass
    return {"inside": True, "lat": lat, "lon": lon, "elevation_m": s["elevation_m"], "slope_deg": slope,
            "tier": tier, "tier_name": TIER_NAMES[tier], "forbidden": tier == TIER_FORBIDDEN,
            "profile": profile, "slope_limit_deg": limit, "factors": factors}


def nearby_pois(pois: list[dict], route_points: list[dict], corridor_m: float = 3000.0, kinds: list[str] | None = None) -> list[dict]:
    out = []
    for p in pois:
        if kinds and p.get("category", p.get("kind")) not in kinds:
            continue
        best = math.inf
        best_k = None
        for k, q in enumerate(route_points[:: max(1, len(route_points) // 200)]):
            d = haversine_m(p["lat"], p["lon"], q["lat"], q["lon"])
            if d < best:
                best, best_k = d, k
        if best <= corridor_m:
            out.append({**p, "corridor_distance_m": best})
    return sorted(out, key=lambda x: x["corridor_distance_m"])

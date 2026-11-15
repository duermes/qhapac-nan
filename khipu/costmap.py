"""Continuous cost map with forbidden tiers, hazard zones and contextual coupling.

Tiers: 0 free, 1 caution, 2 high risk, 3 forbidden (cost = +inf).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .geodesy import DEG
from .terrain import TerrainContext

TIER_FREE, TIER_CAUTION, TIER_HIGH, TIER_FORBIDDEN = 0, 1, 2, 3

PROFILE_DEFAULTS = {
    "rover": {"max_slope_deg": 20.0, "caution_slope_deg": 12.0, "max_relief_m": 260.0},
    "astronaut": {"max_slope_deg": 20.0, "caution_slope_deg": 15.0, "max_relief_m": 220.0},
}

# Symmetric coupling between normalised factors
# order: terrain, comms, life_support, thermal
FACTORS = ("terrain", "comms", "life_support", "thermal")
DEFAULT_COUPLING = np.array([
    [0.0, 0.6, 0.8, 0.3],
    [0.6, 0.0, 0.9, 0.2],
    [0.8, 0.9, 0.0, 0.5],
    [0.3, 0.2, 0.5, 0.0],
])


@dataclass
class HazardZone:
    id: str
    name: str
    lat: float
    lon: float
    radius_m: float
    tier: int = TIER_FORBIDDEN
    kind: str = "hazard"

    @classmethod
    def from_dict(cls, d: dict) -> "HazardZone":
        tier = d.get("tier", TIER_FORBIDDEN)
        if isinstance(tier, str):
            tier = {"forbidden": 3, "high": 2, "caution": 1}.get(tier, 3)
        return cls(str(d.get("id", d.get("name", "hz"))), str(d.get("name", "")), float(d["lat"]), float(d["lon"]),
                   float(d.get("radius_m", 500.0)), int(tier), str(d.get("kind", "hazard")))


@dataclass
class CostParams:
    profile: str = "rover"
    max_slope_deg: float | None = None
    w_slope: float = 1.0
    w_roughness: float = 0.5
    w_hazard: float = 1.0
    w_context: float = 0.6
    w_science: float = 0.0
    hazard_zones: list[HazardZone] = field(default_factory=list)
    comms_risk: np.ndarray | None = None
    life_support_risk: np.ndarray | None = None
    thermal_risk: np.ndarray | None = None
    science_interest: np.ndarray | None = None
    coupling: np.ndarray | None = None
    restrictions: dict[str, np.ndarray] = field(default_factory=dict)
    walkback_origin: tuple[float, float] | None = None
    walkback_radius_m: float | None = None

    def slope_limit(self) -> float:
        if self.max_slope_deg is not None:
            return float(self.max_slope_deg)
        return PROFILE_DEFAULTS.get(self.profile, PROFILE_DEFAULTS["rover"])["max_slope_deg"]


@dataclass
class CostmapResult:
    cost: np.ndarray
    tiers: np.ndarray
    components: dict[str, np.ndarray]
    params: CostParams
    version: int = 1

    def summary(self) -> dict:
        finite = np.isfinite(self.cost)
        total = self.cost.size
        return {
            "shape": list(self.cost.shape),
            "forbidden_fraction": float((self.tiers == TIER_FORBIDDEN).sum() / total),
            "high_fraction": float((self.tiers == TIER_HIGH).sum() / total),
            "caution_fraction": float((self.tiers == TIER_CAUTION).sum() / total),
            "free_fraction": float((self.tiers == TIER_FREE).sum() / total),
            "cost_min": float(self.cost[finite].min()) if finite.any() else None,
            "cost_max": float(self.cost[finite].max()) if finite.any() else None,
            "cost_mean": float(self.cost[finite].mean()) if finite.any() else None,
            "slope_limit_deg": self.params.slope_limit(),
            "profile": self.params.profile,
            "version": self.version,
        }


def distance_grid_m(terrain: TerrainContext, lat: float, lon: float) -> np.ndarray:
    g = terrain.geometry
    rows, cols = terrain.shape
    lats = g.lat_max - (np.arange(rows) + 0.5) / g.pixels_per_degree
    lons = g.lon_min + (np.arange(cols) + 0.5) / g.pixels_per_degree
    dy = (lats[:, None] - lat) * DEG * g.radius
    dx = (lons[None, :] - lon) * DEG * g.radius * math.cos(lat * DEG)
    return np.hypot(dx, dy)


def hazard_grid(terrain: TerrainContext, zones: list[HazardZone]) -> tuple[np.ndarray, np.ndarray]:
    """A-priori hazard injection: returns (tier grid, soft hazard 0-1 with halo)."""
    tiers = np.zeros(terrain.shape, dtype=np.int8)
    soft = np.zeros(terrain.shape)
    for z in zones:
        d = distance_grid_m(terrain, z.lat, z.lon)
        inside = d <= z.radius_m
        tiers = np.where(inside, np.maximum(tiers, z.tier), tiers)
        halo = np.clip(1.0 - (d - z.radius_m) / max(z.radius_m, 1.0), 0, 1)
        soft = np.maximum(soft, np.where(inside, 1.0, 0.5 * halo * z.tier / 3.0))
    return tiers, soft


def contextual_coupling(factors: dict[str, np.ndarray], coupling: np.ndarray | None = None) -> np.ndarray:
    """sum_i f_i + sum_{i<j} M_ij f_i f_j — joint degradations cost more than the sum."""
    M = DEFAULT_COUPLING if coupling is None else coupling
    keys = [k for k in FACTORS]
    arrs = [np.clip(factors.get(k, 0.0), 0, 1) for k in keys]
    shape = np.broadcast_shapes(*[np.shape(a) for a in arrs])
    total = np.zeros(shape)
    for a in arrs:
        total = total + a
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            total = total + M[i, j] * arrs[i] * arrs[j]
    return total


def compute_costmap(terrain: TerrainContext, params: CostParams) -> CostmapResult:
    prof = PROFILE_DEFAULTS.get(params.profile, PROFILE_DEFAULTS["rover"])
    limit = params.slope_limit()
    slope = np.nan_to_num(terrain.slope, nan=90.0)
    relief = terrain.relief

    slope_n = np.clip(slope / limit, 0, None)
    slope_cost = slope_n ** 2
    rough_n = np.clip(relief / prof["max_relief_m"], 0, 1.5)
    hz_tiers, hz_soft = hazard_grid(terrain, params.hazard_zones)

    terrain_f = np.clip(0.6 * slope_n + 0.4 * rough_n, 0, 1)
    factors = {"terrain": terrain_f}
    if params.comms_risk is not None:
        factors["comms"] = params.comms_risk
    if params.life_support_risk is not None:
        factors["life_support"] = params.life_support_risk
    if params.thermal_risk is not None:
        factors["thermal"] = params.thermal_risk
    context = contextual_coupling(factors, params.coupling) - terrain_f  # avoid double counting terrain alone

    cost = (params.w_slope * slope_cost + params.w_roughness * rough_n + params.w_hazard * hz_soft * 3.0
            + params.w_context * context)
    if params.science_interest is not None and params.w_science:
        cost = cost - params.w_science * np.clip(params.science_interest, 0, 1) * 0.5
    cost = np.clip(cost, 0.01, None)

    tiers = np.zeros(terrain.shape, dtype=np.int8)
    tiers = np.where(slope >= prof["caution_slope_deg"], TIER_CAUTION, tiers)
    tiers = np.where(slope >= 0.85 * limit, TIER_HIGH, tiers)
    tiers = np.where(slope > limit, TIER_FORBIDDEN, tiers)
    tiers = np.maximum(tiers, hz_tiers).astype(np.int8)
    tiers = np.where(terrain.valid, tiers, TIER_FORBIDDEN).astype(np.int8)

    walk = None
    if params.walkback_origin is not None and params.walkback_radius_m is not None:
        d = distance_grid_m(terrain, *params.walkback_origin)
        walk = d > params.walkback_radius_m
        tiers = np.where(walk, TIER_FORBIDDEN, tiers).astype(np.int8)

    for mask in params.restrictions.values():
        tiers[mask] = TIER_FORBIDDEN
    cost = np.where(tiers == TIER_FORBIDDEN, np.inf, cost)
    comps = {"slope": slope_cost, "roughness": rough_n, "hazard": hz_soft, "context": context}
    if walk is not None:
        comps["walkback_excluded"] = walk.astype(float)
    return CostmapResult(cost, tiers, comps, params)


def walkback_collapse(terrain: TerrainContext, params: CostParams, origin: tuple[float, float],
                      radius_m: float) -> CostmapResult:
    """Dynamic inference: as consumables drop, the reachable envelope collapses."""
    params.walkback_origin = origin
    params.walkback_radius_m = radius_m
    return compute_costmap(terrain, params)

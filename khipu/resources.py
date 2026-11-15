"""Route metrics per asset type, point of no return (PNR) and cumulative ledger.

Resource logic is cumulative: re-planning from a new position never refills
inventory nor erases a deficit (see ResourceLedger)."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from functools import lru_cache

from .geodesy import haversine_m
from .physics import metabolic as met
from .physics import terramechanics as tm

ROVER = tm.Rover()
ROVER_DEMO_CAPACITY_WH = 120_000.0
EVA_WALKBACK_LIMIT_M = 4_000.0


@lru_cache(maxsize=180)
def rover_slip(slope_deg: int) -> float:
    return tm.equilibrium_slip(ROVER, slope_deg / 2)

PNR_DEFAULTS = {
    "rover": {"resource": "battery_wh", "capacity": ROVER_DEMO_CAPACITY_WH, "reserve_fraction": 0.20},
    "astronaut": {"resource": "o2_kg", "capacity": 1.2, "reserve_fraction": 0.25},
}


def segment_cost(profile: str, dist_m: float, grade_deg: float, speed_mps: float | None = None) -> dict:
    """Resource and time spent on one segment (directional)."""
    if profile == "rover":
        v = speed_mps or 1.0
        slip = rover_slip(round(abs(grade_deg) * 2))
        v_eff = v * max(0.35, 1.0 - max(0.0, grade_deg) / 30.0) * max(0.25, 1.0 - slip)
        e_wh = tm.energy_per_meter_wh(ROVER, grade_deg, v_eff) * dist_m
        return {"time_s": dist_m / v_eff, "battery_wh": max(e_wh, 0.0)}
    v = speed_mps or 0.9
    gradient = math.tan(math.radians(grade_deg))
    v_eff = v * max(0.4, 1.0 - abs(gradient) * 1.5)
    t = dist_m / v_eff
    power = met.metabolic_power_w(gradient, v_eff, 160.0)
    rates = met.plss_rates(power)
    h = t / 3600.0
    return {"time_s": t, "o2_kg": rates.o2_kg_h * h, "water_kg": rates.water_kg_h * h,
            "battery_wh": rates.power_w * h, "co2_kg": rates.co2_kg_h * h, "metabolic_w": power}


def route_segments(points: list[dict]) -> list[tuple[float, float]]:
    segs = []
    for a, b in zip(points[:-1], points[1:]):
        d = haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
        grade = math.degrees(math.atan2(b["elevation_m"] - a["elevation_m"], d)) if d > 0 else 0.0
        segs.append((d, grade))
    return segs


def route_metrics(points: list[dict], profile: str, speed_mps: float | None = None) -> dict:
    segs = route_segments(points)
    totals: dict[str, float] = {"time_s": 0.0}
    ascent = descent = 0.0
    max_grade = 0.0
    for d, g in segs:
        c = segment_cost(profile, d, g, speed_mps)
        for k, v in c.items():
            if k == "metabolic_w":
                continue
            totals[k] = totals.get(k, 0.0) + v
        dz = d * math.tan(math.radians(g))
        ascent += max(0.0, dz)
        descent += max(0.0, -dz)
        max_grade = max(max_grade, abs(g))
    dist = sum(d for d, _ in segs)
    tiers = [p.get("tier", 0) for p in points]
    costs = [p["cost"] for p in points if p.get("cost") is not None]
    return {
        "distance_m": dist,
        "duration_s": totals.pop("time_s"),
        "ascent_m": ascent,
        "descent_m": descent,
        "max_grade_deg": max_grade,
        "risk_mean": sum(costs) / len(costs) if costs else None,
        "risk_max": max(costs) if costs else None,
        "high_risk_fraction": sum(1 for t in tiers if t >= 2) / len(tiers) if tiers else 0.0,
        "resources": totals,
        "profile": profile,
    }


def evaluate_pnr(points: list[dict], profile: str, available: float | None = None, capacity: float | None = None,
                 reserve_fraction: float | None = None, speed_mps: float | None = None) -> dict:
    """Asymmetric point of no return.

    spent(k): resource used outbound to vertex k; back(k): resource to return
    from k to the origin along the reversed path (uphill/downhill swapped).
    PNR = last k with available - spent(k) - back(k) >= reserve.
    """
    d = PNR_DEFAULTS[profile]
    res = d["resource"]
    capacity = capacity if capacity is not None else d["capacity"]
    available = available if available is not None else capacity
    reserve_fraction = d["reserve_fraction"] if reserve_fraction is None else reserve_fraction
    reserve = capacity * reserve_fraction
    segs = route_segments(points)
    out = [segment_cost(profile, dist, g, speed_mps)[res] for dist, g in segs]
    back = [segment_cost(profile, dist, -g, speed_mps)[res] for dist, g in segs]
    n = len(points)
    spent = [0.0] * n
    for k in range(1, n):
        spent[k] = spent[k - 1] + out[k - 1]
    ret = [0.0] * n
    for k in range(1, n):
        ret[k] = ret[k - 1] + back[k - 1]
    margins = [available - spent[k] - ret[k] - reserve for k in range(n)]
    round_trip = margins[-1] if n else available - reserve
    status = "round_trip_safe"
    pnr_index = None
    if n and margins[0] < 0:
        status = "infeasible"
        pnr_index = 0
    elif n and round_trip < 0:
        status = "pnr_exceeded"
        pnr_index = max(k for k in range(n) if margins[k] >= 0)
    segments = []
    for k in range(max(0, n - 1)):
        if status == "round_trip_safe":
            state = "safe"
        elif pnr_index is not None and k >= pnr_index:
            state = "no_return"
        elif pnr_index is not None and spent[k + 1] >= 0.85 * spent[pnr_index] and pnr_index > 0:
            state = "caution"
        else:
            state = "safe"
        segments.append({"from": k, "to": k + 1, "state": state})
    one_way_end = available - spent[-1] - reserve if n else available - reserve
    result = {
        "resource": res,
        "capacity": capacity,
        "available": available,
        "reserve": reserve,
        "status": status,
        "show_pnr": status != "round_trip_safe",
        "pnr_index": pnr_index,
        "pnr_point": ({"lat": points[pnr_index]["lat"], "lon": points[pnr_index]["lon"],
                       "elevation_m": points[pnr_index].get("elevation_m"),
                       "distance_m": points[pnr_index].get("distance_m", sum(d for d, _ in segs[:pnr_index]))}
                      if pnr_index is not None else None),
        "outbound_total": spent[-1] if n else 0.0,
        "return_total": ret[-1] if n else 0.0,
        "round_trip_margin": round_trip,
        "one_way_margin": one_way_end,
        "asymmetry": (ret[-1] - spent[-1]) if n else 0.0,
        "segments": segments,
    }
    return result


def assess_route(points: list[dict], profile: str, inventory: dict[str, tuple[float, float]],
                 reserve_fractions: dict[str, float], speed_mps: float | None = None,
                 return_prefix: list[dict] | None = None) -> tuple[list[dict], dict]:
    """Evaluate forward and reverse consumption on one path and insert its exact PNR."""
    resource = PNR_DEFAULTS[profile]["resource"]
    segments = route_segments(points)
    outward = {key: 0.0 for key in inventory}
    home = route_metrics(list(reversed(return_prefix or [])), profile, speed_mps)["resources"]
    reverse = {key: home.get(key, 0.0) for key in inventory}
    reserve = {key: capacity * reserve_fractions[key] for key, (_, capacity) in inventory.items()}
    budget = {key: available - reserve[key] for key, (available, _) in inventory.items()}
    crossing = (0, 0.0, min(budget, key=lambda k: budget[k] - reverse[k])) if any(
        reverse[key] > budget[key] for key in inventory) else None
    for i, (distance, grade) in enumerate(segments):
        fwd = segment_cost(profile, distance, grade, speed_mps)
        back = segment_cost(profile, distance, -grade, speed_mps)
        fractions = []
        for key in inventory:
            cost = fwd[key] + back[key]
            margin = budget[key] - outward[key] - reverse[key]
            if cost > 0 and cost > margin:
                fractions.append((max(0.0, margin / cost), key))
            outward[key] += fwd[key]
            reverse[key] += back[key]
        if crossing is None and fractions:
            fraction, limiting = min(fractions)
            crossing = (i, fraction, limiting)

    one_way = {key: budget[key] - outward[key] for key in inventory}
    round_trip = {key: one_way[key] - reverse[key] for key in inventory}
    limiting = crossing[2] if crossing else min(inventory, key=lambda key: round_trip[key] / inventory[key][1])
    if any(value < -1e-9 for value in one_way.values()):
        limiting = min(inventory, key=lambda key: one_way[key] / inventory[key][1])
        status = "infeasible"
    else:
        status = "pnr_exceeded" if crossing else "round_trip_safe"

    distances = [0.0]
    for distance, _ in segments:
        distances.append(distances[-1] + distance)
    result_points = [{**point, "distance_m": distance} for point, distance in zip(points, distances)]
    index = None
    if crossing:
        i, fraction, _ = crossing
        index = i
        if fraction > 0 and i + 1 < len(result_points):
            a, b = result_points[i:i + 2]
            fields = ("lat", "lon", "elevation_m", "distance_m")
            marker = {**a, **{key: a[key] + (b[key] - a[key]) * fraction for key in fields}}
            index += 1
            result_points.insert(index, marker)

    pnr = {
        "resource": resource, "limiting_resource": limiting, "capacity": inventory[resource][1],
        "available": inventory[resource][0], "reserve": reserve[resource],
        "status": status, "show_pnr": index is not None, "pnr_index": index,
        "pnr_point": ({key: result_points[index][key] for key in ("lat", "lon", "elevation_m", "distance_m")}
                      if index is not None and result_points else None),
        "outbound_total": outward[resource], "return_total": reverse[resource],
        "round_trip_margin": round_trip[limiting], "one_way_margin": one_way[limiting],
        "asymmetry": reverse[resource] - outward[resource],
        "resource_margins": {key: {"available": inventory[key][0], "reserve": reserve[key],
                                   "outbound": outward[key], "return": reverse[key],
                                   "one_way_margin": one_way[key], "round_trip_margin": round_trip[key]}
                             for key in inventory},
        "segments": [{"from": i, "to": i + 1, "state": "safe" if index is None or i < index else "no_return"}
                     for i in range(len(result_points) - 1)],
    }
    return result_points, pnr


@dataclass
class ResourceLedger:
    """Cumulative consumable account for a mobile asset."""

    asset_id: str
    resource: str
    capacity: float
    consumed: float = 0.0
    history: list[dict] = field(default_factory=list)

    @property
    def remaining(self) -> float:
        return self.capacity - self.consumed

    @property
    def deficit(self) -> float:
        return max(0.0, -self.remaining)

    def consume(self, amount: float, note: str = "") -> None:
        if amount < 0:
            raise ValueError("consumption cannot be negative; resources are never refilled by re-planning")
        self.consumed += amount
        self.history.append({"amount": amount, "note": note, "remaining": self.remaining})

    def replan_budget(self) -> float:
        """Budget for a plan computed from the current position: never resets."""
        return self.remaining

    def to_dict(self) -> dict:
        return {"asset_id": self.asset_id, "resource": self.resource, "capacity": self.capacity,
                "consumed": self.consumed, "remaining": self.remaining, "deficit": self.deficit,
                "history": self.history[-20:]}

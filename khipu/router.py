"""Grid path planning over the Khipu cost map.

* A* on an 8-connected grid inside an adaptive window.
* Edge feasibility uses the *directional step slope* between cells, so a cliff
  cannot be climbed even if both cells are individually flat.
* Uphill costs more than downhill (asymmetric penalty).
* Any-angle shortcutting (Theta*-style line-of-sight) then Catmull-Rom
  smoothing; smoothed vertices are re-validated against forbidden cells.
* Three multicriteria variants (safe / balanced / fast) with diversity penalty.
* Goals inside forbidden slope or hazards are rejected before searching.
"""
from __future__ import annotations

import heapq
import math
import time
from typing import Callable
from dataclasses import dataclass, field

import numpy as np

from .costmap import TIER_FORBIDDEN, CostmapResult
from .geodesy import bilinear, haversine_m
from .terrain import TerrainContext

SQRT2 = math.sqrt(2.0)
NEIGHBORS = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]

VARIANTS = {
    "safe": {"label": "Segura", "risk_weight": 3.0, "uphill": 4.0, "downhill": 1.5, "slope_scale": 0.8},
    "balanced": {"label": "Equilibrada", "risk_weight": 1.0, "uphill": 2.5, "downhill": 1.0, "slope_scale": 1.0},
    "fast": {"label": "Rapida", "risk_weight": 0.15, "uphill": 1.2, "downhill": 0.4, "slope_scale": 1.0},
}


class RouteInfeasible(Exception):
    def __init__(self, reason: str, detail: str, **extra):
        super().__init__(detail)
        self.reason = reason
        self.detail = detail
        self.extra = extra

    def to_dict(self) -> dict:
        return {"feasible": False, "classification": "INVALID_ROUTE", "pnr": None,
                "reason": self.reason, "detail": self.detail, **self.extra}


@dataclass
class RouterConfig:
    max_search_seconds: float = 4.0
    max_expansions: int = 150000
    max_step_slope_deg: float = 20.0
    risk_weight: float = 1.0
    uphill_penalty: float = 2.5
    downhill_penalty: float = 1.0
    window_margin_px: int = 40
    max_window_px: int = 420
    smooth: bool = True
    extra_penalty: np.ndarray | None = None
    edge_cost: Callable[[float, float], float] | None = None


@dataclass
class PlannedPath:
    cells: list[tuple[int, int]]
    cost: float
    expanded: int
    vertices: list[tuple[float, float]] = field(default_factory=list)  # (row, col) float after smoothing


def _step_geometry(terrain: TerrainContext):
    g = terrain.geometry
    dx_rows = g.dx_rows()
    return dx_rows, g.dy_m


def edge_length_m(dx_rows: np.ndarray, dy: float, r: int, dr: int, dc: int) -> float:
    dx = dx_rows[r]
    return math.hypot(dc * dx, dr * dy)


def astar(terrain: TerrainContext, costmap: CostmapResult, start: tuple[int, int], goal: tuple[int, int],
          cfg: RouterConfig) -> PlannedPath | None:
    rows, cols = terrain.shape
    sr, sc = start
    gr, gc = goal
    m = cfg.window_margin_px
    r0, r1 = max(0, min(sr, gr) - m), min(rows, max(sr, gr) + m + 1)
    c0, c1 = max(0, min(sc, gc) - m), min(cols, max(sc, gc) + m + 1)
    if (r1 - r0) > cfg.max_window_px or (c1 - c0) > cfg.max_window_px:
        r0, r1 = max(0, min(sr, gr) - 8), min(rows, max(sr, gr) + 9)
        c0, c1 = max(0, min(sc, gc) - 8), min(cols, max(sc, gc) + 9)
    z = terrain.filled()
    cost = costmap.cost
    pen = cfg.extra_penalty if cfg.extra_penalty is not None else np.ones(terrain.shape)
    pl = pen[r0:r1, c0:c1].tolist()
    dx_rows, dy = _step_geometry(terrain)
    tan_lim = math.tan(math.radians(cfg.max_step_slope_deg))
    W = c1 - c0
    H = r1 - r0
    zl = z[r0:r1, c0:c1].tolist()
    cl = cost[r0:r1, c0:c1].tolist()
    dxl = dx_rows[r0:r1].tolist()
    s = (sr - r0) * W + (sc - c0)
    t = (gr - r0) * W + (gc - c0)
    INF = float("inf")
    gscore = [INF] * (W * H)
    parent = [-1] * (W * H)
    closed = bytearray(W * H)
    gscore[s] = 0.0
    tr, tc = gr - r0, gc - c0
    mean_dx = sum(dxl) / len(dxl)

    def h(idx: int) -> float:
        r, c = divmod(idx, W)
        return 0.0 if cfg.edge_cost else math.hypot((c - tc) * mean_dx, (r - tr) * dy)

    heap = [(h(s), 0.0, s)]
    expanded = 0
    deadline = time.monotonic() + cfg.max_search_seconds
    rw = cfg.risk_weight
    up, down = cfg.uphill_penalty, cfg.downhill_penalty
    while heap:
        f, gcur, cur = heapq.heappop(heap)
        if closed[cur]:
            continue
        closed[cur] = 1
        expanded += 1
        if expanded % 256 == 0 and (expanded > cfg.max_expansions or time.monotonic() > deadline):
            raise RouteInfeasible("search_budget", "La búsqueda alcanzó su límite de trabajo. Reduce el tramo o ajusta las restricciones; no se ha demostrado que no exista ruta.", classification="INDETERMINATE")
        if cur == t:
            break
        r, c = divmod(cur, W)
        zc = zl[r][c]
        cc_cost = cl[r][c]
        for dr, dc in NEIGHBORS:
            nr, nc = r + dr, c + dc
            if nr < 0 or nr >= H or nc < 0 or nc >= W:
                continue
            ni = nr * W + nc
            if closed[ni]:
                continue
            ncost = cl[nr][nc]
            if ncost == INF or (dr and dc and (cl[nr][c] == INF or cl[r][nc] == INF)):
                continue
            dist = math.hypot(dc * dxl[r], dr * dy)
            dz = zl[nr][nc] - zc
            grade = dz / dist
            if abs(grade) > tan_lim:
                continue  # local step slope too steep (cliff)
            gdeg = math.degrees(math.atan(abs(grade)))
            dirf = 1.0 + (up if grade > 0 else down) * gdeg / cfg.max_step_slope_deg
            if cfg.edge_cost:
                step = cfg.edge_cost(dist, math.copysign(gdeg, grade))
            else:
                step = dist * dirf * (1.0 + rw * 0.5 * (cc_cost + ncost)) * pl[nr][nc]
            ng = gcur + step
            if ng < gscore[ni]:
                gscore[ni] = ng
                parent[ni] = cur
                heapq.heappush(heap, (ng + h(ni), ng, ni))
    if gscore[t] == INF:
        return None
    path = []
    cur = t
    while cur != -1:
        r, c = divmod(cur, W)
        path.append((r + r0, c + c0))
        cur = parent[cur]
    path.reverse()
    return PlannedPath(path, gscore[t], expanded)


def segment_is_valid(terrain: TerrainContext, costmap: CostmapResult, a: tuple[float, float],
                     b: tuple[float, float], max_step_slope_deg: float, penalty: np.ndarray | None = None) -> bool:
    """Line-of-sight check: no forbidden cell and no steep step along a->b."""
    z = terrain.filled()
    (ra, ca), (rb, cb) = a, b
    n = int(max(abs(rb - ra), abs(cb - ca)) * 3) + 2
    tan_lim = math.tan(math.radians(max_step_slope_deg))
    g = terrain.geometry
    prev = None
    for k in range(n + 1):
        f = k / n
        r = ra + (rb - ra) * f
        c = ca + (cb - ca) * f
        ri, ci = int(round(r)), int(round(c))
        if ri < 0 or ci < 0 or ri >= z.shape[0] or ci >= z.shape[1]:
            return False
        if costmap.tiers[ri, ci] == TIER_FORBIDDEN:
            return False
        if penalty is not None and penalty[ri, ci] > 1.0 and 0 < k < n:
            return False
        e = bilinear(z, r, c)
        if prev is not None:
            pr, pc, pe = prev
            dist = math.hypot((c - pc) * g.dx_m(r), (r - pr) * g.dy_m)
            if dist > 0 and abs(e - pe) / dist > tan_lim:
                return False
        prev = (r, c, e)
    return True


def any_angle_shortcut(terrain: TerrainContext, costmap: CostmapResult, cells: list[tuple[int, int]],
                       max_step_slope_deg: float, max_cost_ratio: float = 1.15,
                       penalty: np.ndarray | None = None) -> list[tuple[float, float]]:
    """Theta*-style post-processing: keep a vertex only when line of sight breaks."""
    if len(cells) <= 2:
        return [(float(r), float(c)) for r, c in cells]
    out = [cells[0]]
    i = 0
    while i < len(cells) - 1:
        j = len(cells) - 1
        while j > i + 1:
            if segment_is_valid(terrain, costmap, cells[i], cells[j], max_step_slope_deg, penalty):
                seg_cost = np.nanmean([costmap.cost[r, c] for r, c in cells[i:j + 1]])
                line_cost = _line_mean_cost(costmap, cells[i], cells[j])
                if line_cost <= seg_cost * max_cost_ratio:
                    break
            j -= 1
        out.append(cells[j])
        i = j
    return [(float(r), float(c)) for r, c in out]


def _line_mean_cost(costmap: CostmapResult, a, b) -> float:
    n = int(max(abs(b[0] - a[0]), abs(b[1] - a[1]))) + 1
    vals = []
    for k in range(n + 1):
        f = k / n
        vals.append(costmap.cost[int(round(a[0] + (b[0] - a[0]) * f)), int(round(a[1] + (b[1] - a[1]) * f))])
    return float(np.mean(vals))


def catmull_rom(points: list[tuple[float, float]], samples_per_segment: int = 6) -> list[tuple[float, float]]:
    """Centripetal-free uniform Catmull-Rom through all control points (endpoints kept)."""
    if len(points) < 3:
        return list(points)
    pts = [points[0]] + list(points) + [points[-1]]
    out = []
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        for s in range(samples_per_segment):
            t = s / samples_per_segment
            t2, t3 = t * t, t * t * t
            out.append(tuple(
                0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2
                       + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)
                for k in range(2)))
    out.append(points[-1])
    return out


def smooth_path(terrain: TerrainContext, costmap: CostmapResult, vertices: list[tuple[float, float]],
                max_step_slope_deg: float) -> list[tuple[float, float]]:
    """Organic smoothing that never cuts through obstacles: per segment fallback."""
    if len(vertices) < 3:
        return densify(vertices)
    curve = catmull_rom(vertices)
    ok = all(segment_is_valid(terrain, costmap, curve[k], curve[k + 1], max_step_slope_deg)
             for k in range(len(curve) - 1))
    return densify(curve) if ok else densify(vertices)


def densify(vertices: list[tuple[float, float]], step_px: float = 0.125) -> list[tuple[float, float]]:
    if len(vertices) < 2:
        return list(vertices)
    out = [vertices[0]]
    for a, b in zip(vertices[:-1], vertices[1:]):
        n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / step_px))
        for k in range(1, n + 1):
            f = k / n
            out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    return out


def check_goal(terrain: TerrainContext, costmap: CostmapResult, rc: tuple[int, int], role: str, limit: float) -> None:
    r, c = rc
    if not terrain.valid[r, c]:
        raise RouteInfeasible(f"{role}_no_data", f"El {role} cae en una celda sin datos de elevación.")
    slope = float(terrain.slope[r, c])
    if slope > limit:
        raise RouteInfeasible(f"{role}_slope", f"Pendiente del {role} {slope:.1f}° supera el límite de {limit:.1f}°.",
                              slope_deg=slope, limit_deg=limit)
    if costmap.tiers[r, c] == TIER_FORBIDDEN:
        raise RouteInfeasible(f"{role}_hazard", f"El {role} está dentro de una zona prohibida (peligro o exclusión).")


def latlon_to_cell(terrain: TerrainContext, lat: float, lon: float, role: str) -> tuple[int, int]:
    if not terrain.geometry.contains(lat, lon):
        raise RouteInfeasible(f"{role}_outside", f"El {role} ({lat:.4f}, {lon:.4f}) está fuera de la región cargada.")
    r, c = terrain.geometry.latlon_to_rc(lat, lon)
    return (int(round(min(max(r, 0), terrain.shape[0] - 1))), int(round(min(max(c, 0), terrain.shape[1] - 1))))


def build_route(terrain: TerrainContext, costmap: CostmapResult, vertices: list[tuple[float, float]]) -> list[dict]:
    """Dense route points with Z from the DEM (bilinear) and cumulative distance."""
    z = terrain.filled()
    g = terrain.geometry
    pts = []
    cum = 0.0
    prev = None
    for r, c in vertices:
        lat, lon = g.rc_to_latlon(r, c)
        e = bilinear(z, r, c)
        ri, ci = int(round(r)), int(round(c))
        ri = min(max(ri, 0), z.shape[0] - 1)
        ci = min(max(ci, 0), z.shape[1] - 1)
        if prev is not None:
            seg = haversine_m(prev[0], prev[1], lat, lon)
            cum += seg
            grade = (e - prev[2]) / seg if seg > 0 else 0.0
        else:
            grade = 0.0
        pts.append({"lat": lat, "lon": lon, "elevation_m": e, "distance_m": cum,
                    "grade_deg": math.degrees(math.atan(grade)), "terrain_slope_deg": float(np.nan_to_num(terrain.slope[ri, ci])),
                    "tier": int(costmap.tiers[ri, ci]), "cost": float(costmap.cost[ri, ci]) if np.isfinite(costmap.cost[ri, ci]) else None})
        prev = (lat, lon, e)
    return pts


def plan(terrain: TerrainContext, costmap: CostmapResult, start_ll: tuple[float, float], goal_ll: tuple[float, float],
         cfg: RouterConfig | None = None) -> dict:
    cfg = cfg or RouterConfig()
    limit = costmap.params.slope_limit()
    cfg.max_step_slope_deg = min(cfg.max_step_slope_deg, limit)
    s = latlon_to_cell(terrain, *start_ll, role="origen")
    t = latlon_to_cell(terrain, *goal_ll, role="destino")
    check_goal(terrain, costmap, t, "destino", limit)
    check_goal(terrain, costmap, s, "origen", limit)
    found = astar(terrain, costmap, s, t, cfg)
    if found is None:
        cfg2 = RouterConfig(**{**cfg.__dict__, "window_margin_px": cfg.window_margin_px * 3})
        found = astar(terrain, costmap, s, t, cfg2)
    if found is None:
        raise RouteInfeasible("no_path", "No existe corredor transitable entre origen y destino con los umbrales declarados.",
                              slope_limit_deg=limit)
    vertices = any_angle_shortcut(terrain, costmap, found.cells, cfg.max_step_slope_deg,
                                  penalty=cfg.extra_penalty) if cfg.smooth else \
        [(float(r), float(c)) for r, c in found.cells]
    cell_vertices = [(float(r), float(c)) for r, c in found.cells]
    # anchor the exact requested coordinates instead of cell centres
    g = terrain.geometry
    s_exact, t_exact = g.latlon_to_rc(*start_ll), g.latlon_to_rc(*goal_ll)
    vertices = [s_exact] + vertices[1:-1] + [t_exact] if len(vertices) >= 2 else [s_exact, t_exact]
    def valid(path):
        return all(segment_is_valid(terrain, costmap, a, b, cfg.max_step_slope_deg)
                   for a, b in zip(path, path[1:]))

    if not valid(vertices):
        vertices = [s_exact, *cell_vertices, t_exact]
        if not valid(vertices):
            raise RouteInfeasible("no_path", "Sin conexión apta entre las coordenadas exactas y el corredor.")
    dense = smooth_path(terrain, costmap, vertices, cfg.max_step_slope_deg) if cfg.smooth else densify(vertices)
    if not valid(dense):
        dense = densify(vertices)
    pts = build_route(terrain, costmap, dense)
    return {"feasible": True, "cells": found.cells, "control_points": vertices, "points": pts,
            "expanded": found.expanded, "search_cost": found.cost}


def _overlap(a: list[tuple[int, int]], b: list[tuple[int, int]]) -> float:
    sa, sb = set(a[1:-1]), set(b[1:-1])
    if not sa or not sb:
        return 1.0 if a == b else 0.0
    return len(sa & sb) / min(len(sa), len(sb))


def plan_variants(terrain: TerrainContext, costmap: CostmapResult, start_ll, goal_ll,
                  base_cfg: RouterConfig | None = None, max_overlap: float = 0.8) -> list[dict]:
    """Each variant optimises its own criteria; only when it would duplicate an
    earlier corridor (>80% shared cells) is it re-planned with a diversity penalty."""
    base_cfg = base_cfg or RouterConfig()
    results = []
    penalty = np.ones(terrain.shape)
    for key in ("balanced", "fast", "safe"):
        v = VARIANTS[key]

        def make_cfg(pen, slope):
            return RouterConfig(max_step_slope_deg=slope, risk_weight=v["risk_weight"], uphill_penalty=v["uphill"],
                                downhill_penalty=v["downhill"], window_margin_px=base_cfg.window_margin_px,
                                max_window_px=base_cfg.max_window_px, extra_penalty=pen)

        slope = base_cfg.max_step_slope_deg * v["slope_scale"]
        note = None
        try:
            res = plan(terrain, costmap, start_ll, goal_ll, make_cfg(None, slope))
        except RouteInfeasible:
            if key != "safe":
                raise
            slope = base_cfg.max_step_slope_deg
            res = plan(terrain, costmap, start_ll, goal_ll, make_cfg(None, slope))
            note = "margen de pendiente reducido no factible; se usó el límite nominal"
        if any(_overlap(res["cells"], r["cells"]) > max_overlap for r in results):
            try:
                alt = plan(terrain, costmap, start_ll, goal_ll, make_cfg(penalty.copy(), slope))
                if not any(_overlap(alt["cells"], r["cells"]) > 0.98 for r in results):
                    res = alt
                    note = (note + "; " if note else "") + "corredor alternativo (penalización de diversidad)"
                else:
                    note = (note + "; " if note else "") + "no existe corredor alternativo distinto"
            except RouteInfeasible:
                note = (note + "; " if note else "") + "no existe corredor alternativo distinto"
        res["variant"], res["label"] = key, v["label"]
        if note:
            res["note"] = note
        for r, c in res["cells"][1:-1]:
            penalty[r, c] = max(penalty[r, c], 1.6)
        results.append(res)
    order = {"safe": 0, "balanced": 1, "fast": 2}
    return sorted(results, key=lambda r: order[r["variant"]])


def direct_route(terrain: TerrainContext, costmap: CostmapResult, start_ll, goal_ll) -> dict:
    latlon_to_cell(terrain, *start_ll, role="origen")
    latlon_to_cell(terrain, *goal_ll, role="destino")
    g = terrain.geometry
    verts = densify([g.latlon_to_rc(*start_ll), g.latlon_to_rc(*goal_ll)])
    pts = build_route(terrain, costmap, verts)
    for point, (lat, lon) in zip((pts[0], pts[-1]), (start_ll, goal_ll)):
        point.update(lat=lat, lon=lon)
    distance = haversine_m(*start_ll, *goal_ll)
    return {"points": pts, "distance_m": distance, "crosses_forbidden": any(p["tier"] == TIER_FORBIDDEN for p in pts),
            "euclidean_m": distance}


def path_hits_obstacle(points: list[dict], obstacle: dict) -> bool:
    for p in points:
        if haversine_m(p["lat"], p["lon"], obstacle["lat"], obstacle["lon"]) <= obstacle.get("radius_m", 300.0):
            return True
    return False

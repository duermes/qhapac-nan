"""Shared operational restrictions and corridor validation."""
from __future__ import annotations

from dataclasses import replace

import numpy as np

from .costmap import TIER_FORBIDDEN
from .geodesy import haversine_m
from .resources import route_segments, segment_cost
from .router import RouteInfeasible, latlon_to_cell, segment_is_valid

RESTRICTIONS = {
    "hazard": "Zona prohibida u obstáculo físico",
    "no_data": "Terreno sin cobertura de elevación",
    "slope": "Pendiente superior al límite operativo",
    "temperature": "Temperatura fuera del rango operativo",
    "dust": "Tormenta o visibilidad reducida por polvo",
    "darkness": "Iluminación por debajo del mínimo operativo",
    "blackout": "Pérdida prolongada de telecomunicaciones",
    "distance": "Distancia superior al límite de la travesía",
    "resources": "Recursos insuficientes para llegar con la reserva vital",
}


def issue(code, detail=None):
    return {"code": code, "detail": detail or RESTRICTIONS[code]}


def forbid(issue_list, location=None):
    first = issue_list[0]
    reason = f"{location}_{first['code']}" if location else first["code"]
    label = f"Punto de {location} inviable" if location else "Sin corredor viable"
    raise RouteInfeasible(reason, f"{label}. {first['detail']}", reasons=issue_list)


def endpoint_issues(terrain, costmap, ll, role):
    try:
        row, col = latlon_to_cell(terrain, *ll, role=role)
    except RouteInfeasible as error:
        return [{"code": "outside", "detail": error.detail, "role": role}]
    issues = []
    zones = [zone.name or zone.kind for zone in costmap.params.hazard_zones if zone.tier == TIER_FORBIDDEN
             and haversine_m(*ll, zone.lat, zone.lon) <= zone.radius_m]
    if zones:
        issues.append(issue("hazard", f"Zona prohibida: {', '.join(zones)}."))
    if not terrain.valid[row, col]:
        issues.append(issue("no_data"))
    slope = terrain.slope[row, col]
    limit = costmap.params.slope_limit()
    if slope > limit:
        issues.append(issue("slope", f"Pendiente de {slope:.1f}° frente al límite de {limit:.1f}°."))
    for code, mask in costmap.params.restrictions.items():
        if mask[row, col] and not any(item["code"] == code for item in issues):
            issues.append(issue(code))
    return [{**item, "role": role} for item in issues]


def check_endpoints(terrain, costmap, endpoints):
    order = {code: i for i, code in enumerate((*RESTRICTIONS, "outside"))}
    issues = [item for ll, role in endpoints for item in endpoint_issues(terrain, costmap, ll, role)]
    if issues:
        issues.sort(key=lambda item: order[item["code"]])
        first = issues[0]
        role = first["role"]
        raise RouteInfeasible(f"{role}_{first['code']}", f"Punto de {role} inviable. {first['detail']}", reasons=issues)


def blocked_link(terrain, points, link, threshold, profile, speed):
    longest = current = 0.0
    for (a, b), (distance, grade) in zip(zip(points, points[1:]), route_segments(points)):
        mid = ((a["lat"] + b["lat"]) / 2, (a["lon"] + b["lon"]) / 2)
        row, col = latlon_to_cell(terrain, *mid, role="corredor")
        current = (current + segment_cost(profile, distance, grade, speed)["time_s"]
                   if not np.isfinite(link[row, col]) or link[row, col] < threshold else 0.0)
        longest = max(longest, current)
    return longest


def diagnose_corridor(terrain, costmap, start, end):
    a = latlon_to_cell(terrain, *start, role="origen")
    b = latlon_to_cell(terrain, *end, role="destino")
    window = tuple(slice(max(0, min(x, y) - 3), max(x, y) + 4) for x, y in zip(a, b))
    masks = {**costmap.params.restrictions, "no_data": ~terrain.valid,
             "slope": terrain.slope > costmap.params.slope_limit()}
    impacts = sorted(((np.count_nonzero(mask[window]), code) for code, mask in masks.items()), reverse=True)
    return [issue(code, f"{RESTRICTIONS[code]} en el área de búsqueda.") for count, code in impacts if count]


def check_surface_geometry(terrain, costmap, points):
    vertices = [terrain.geometry.latlon_to_rc(p["lat"], p["lon"]) for p in points]
    limit = costmap.params.slope_limit()
    for a, b in zip(vertices, vertices[1:]):
        if not segment_is_valid(terrain, costmap, a, b, limit):
            issues = diagnose_corridor(terrain, costmap, (points[0]["lat"], points[0]["lon"]),
                                       (points[-1]["lat"], points[-1]["lon"]))
            if issues:
                forbid(issues)
            raise RouteInfeasible("no_path", "El sendero cruza un sector no transitable.")


def with_link_required(costmap, link, threshold):
    denied = ~np.isfinite(link) | (link < threshold)
    return replace(costmap, cost=np.where(denied, np.inf, costmap.cost),
                   tiers=np.where(denied, TIER_FORBIDDEN, costmap.tiers))

"""Shared operational restrictions and corridor validation."""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import replace

import numpy as np

from .costmap import TIER_FORBIDDEN
from .geodesy import haversine_m
from .resources import route_metrics, route_segments, segment_cost
from .physics.environment import SOL_HOURS
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


class TravelForecast:
    """Evaluate the shared environmental fields at the estimated passage time."""

    def __init__(self, manager, link, params, profile, speed, restrictions=None):
        self.manager = manager
        self.terrain = manager.ctx.terrain
        self.link = link
        self.params = params
        self.profile = profile
        self.speed = speed
        self.restrictions = restrictions or {}
        self.snapshots = OrderedDict()

    def hour(self, elapsed_s):
        return (self.params.get("ltst_h", 13) + elapsed_s * 24 / (SOL_HOURS * 3600)) % 24

    def fields(self, elapsed_s):
        # Limit expensive full-region snapshots. Planning evaluates passage in 15 min LTST bins.
        hour = round(self.hour(elapsed_s) * 4) / 4 % 24
        if hour not in self.snapshots:
            params = {"ltst_h": hour, "tau": self.params.get("tau", 0.5)}
            self.snapshots[hour] = tuple(self.manager.snapshot(name, params).data
                                         for name in ("temperature", "insolation"))
            if len(self.snapshots) > 8:
                self.snapshots.popitem(last=False)
        self.snapshots.move_to_end(hour)
        return self.snapshots[hour]

    def violations(self, points, start_s=0.0, telecom=True, weather_cells=None):
        found = {}
        elapsed = start_s
        dark_end = self.params.get("min_light_w_m2", 0.1)
        minimum = self.params.get("min_temperature_c", -105)
        maximum = self.params.get("max_temperature_c", 45)
        blackout = 0.0
        blackout_limit = self.params.get("max_blackout_s", 900)
        link_limit = self.params.get("min_link_db", 0)

        def inspect(point, at):
            row, col = latlon_to_cell(self.terrain, point["lat"], point["lon"], role="corredor")
            for code in ("hazard", "dust"):
                if code in self.restrictions and self.restrictions[code][row, col]:
                    found.setdefault(code, issue(code))
            temperature, light = self.fields(at)
            warm_enough = minimum <= temperature[row, col] <= maximum
            lit = light[row, col] >= dark_end
            if not warm_enough:
                found.setdefault("temperature", issue("temperature", f"Temperatura fuera del rango a las {self.hour(at):.2f} h solares."))
            if not lit:
                found.setdefault("darkness", issue("darkness", f"Iluminación insuficiente a las {self.hour(at):.2f} h solares."))
            if weather_cells is not None and (not warm_enough or not lit):
                weather_cells.add((row, col))
            return row, col

        if points:
            inspect(points[0], elapsed)
        for (a, b), (distance, grade) in zip(zip(points, points[1:]), route_segments(points)):
            duration = segment_cost(self.profile, distance, grade, self.speed)["time_s"]
            # Even the longest regional edge may span multiple environmental intervals.
            parts = max(1, int(np.ceil(duration / 300)))
            for part in range(parts):
                fraction = (part + 0.5) / parts
                point = {key: a[key] + (b[key] - a[key]) * fraction for key in ("lat", "lon")}
                rc = inspect(point, elapsed + duration * fraction)
                if telecom:
                    value = self.link[rc]
                    blackout = blackout + duration / parts if not np.isfinite(value) or value < link_limit else 0
                    if blackout > blackout_limit + 1e-6:
                        found.setdefault("blackout", issue("blackout", f"Corte de enlace previsto de {blackout:.0f} s, límite {blackout_limit:.0f} s."))
            elapsed += duration
        if points:
            inspect(points[-1], elapsed)
        return list(found.values())


def check_retreat(points, pnr, forecast, inventory, reserve, prefix=None, find_return=None):
    """Find the first point whose immediate retreat fails under projected conditions."""
    if len(points) < 2:
        return points, pnr
    prefix = list(reversed(prefix or []))
    profile, speed = forecast.profile, forecast.speed
    budgets = {k: available - capacity * reserve[k] for k, (available, capacity) in inventory.items()}
    original_split = pnr["pnr_index"]
    home = prefix[-1] if prefix else points[0]

    def check(path):
        spent = route_metrics(path, profile, speed)
        elapsed = spent["duration_s"]

        def assess(back):
            consumed = route_metrics(back, profile, speed)["resources"]
            margins = {k: budgets[k] - spent["resources"].get(k, 0) - consumed.get(k, 0) for k in budgets}
            limiting = min(margins, key=lambda k: margins[k] / inventory[k][1])
            problems = forecast.violations(back, elapsed)
            if margins[limiting] < -1e-9:
                problems.append(issue("resources"))
            return problems, margins, limiting, consumed

        reverse = list(reversed(path)) + prefix
        problems, margins, limiting, consumed = assess(reverse)
        if problems and find_return and path[-1]["distance_m"] > 1:
            start = path[-1]
            direct = haversine_m(start["lat"], start["lon"], home["lat"], home["lon"])
            back_length = path[-1]["distance_m"] + (route_metrics(prefix, profile, speed)["distance_m"] if prefix else 0)
            # A detour may restore resources. For environmental events also test a different corridor.
            if any(p["code"] != "resources" for p in problems) or back_length > direct * 1.08:
                alternative = find_return((start["lat"], start["lon"]), (home["lat"], home["lon"]), elapsed)
                if alternative:
                    other = assess(alternative)
                    if not other[0]:
                        return other
        return problems, margins, limiting, consumed

    step = max(1, (len(points) - 1) // 100)
    indexes = sorted({*range(0, len(points), step), len(points) - 1,
                      *([original_split, min(len(points) - 1, original_split + 1)] if original_split is not None else [])})
    good = None
    failure = None
    result = None
    for index in indexes:
        result = check(points[:index + 1])
        if result[0]:
            failure = index
            break
        good = index
    if failure is None:
        _, margins, limiting, consumed = result
        pnr.update(status="round_trip_safe", show_pnr=False, pnr_index=None, pnr_point=None,
                   round_trip_margin=margins[limiting], limiting_resource=limiting,
                   return_total=consumed.get(pnr["resource"], 0.0))
        for key, detail in pnr["resource_margins"].items():
            detail["return"] = consumed.get(key, 0)
            detail["round_trip_margin"] = margins[key]
        pnr["asymmetry"] = pnr["return_total"] - pnr["outbound_total"]
        for segment in pnr["segments"]:
            segment["state"] = "safe"
        return points, pnr

    if good is None:
        index = 0
    else:
        while failure - good > 1:
            middle = (good + failure) // 2
            result = check(points[:middle + 1])
            if result[0]:
                failure = middle
            else:
                good = middle
        a, b = points[good], points[failure]
        low, high = 0.0, 1.0
        for _ in range(7):
            if (high - low) * (b["distance_m"] - a["distance_m"]) < 0.5:
                break
            fraction = (low + high) / 2
            probe = {**a, **{k: a[k] + (b[k] - a[k]) * fraction
                             for k in ("lat", "lon", "elevation_m", "distance_m")}}
            if check([*points[:good + 1], probe])[0]:
                high = fraction
            else:
                low = fraction
        index = good
        if low > 0:
            marker = {**a, **{k: a[k] + (b[k] - a[k]) * low for k in ("lat", "lon", "elevation_m", "distance_m")}}
            index = good + 1
            points = [*points[:index], marker, *points[index:]]

    reasons, _, limiting, _ = check(points[:min(index + 2, len(points))])
    pnr.update(status="pnr_exceeded", show_pnr=True, pnr_index=index, limiting_resource=limiting,
               round_trip_margin=pnr["resource_margins"][limiting]["round_trip_margin"],
               one_way_margin=pnr["resource_margins"][limiting]["one_way_margin"],
               pnr_point={key: points[index][key] for key in ("lat", "lon", "elevation_m", "distance_m")},
               return_reasons=reasons,
               segments=[{"from": i, "to": i + 1, "state": "safe" if i < index else "no_return"}
                         for i in range(len(points) - 1)])
    return points, pnr

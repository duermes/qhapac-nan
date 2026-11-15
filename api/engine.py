"""Engine service: wires Khipu core with data adapters. One shared instance
serves Hatun Wasi, Chaski and Ñawi (no divergent engines)."""
from __future__ import annotations

import base64
import json
import math
import time
from dataclasses import replace
from pathlib import Path

import numpy as np

from khipu import exporters, inspection, navigation, voice
from khipu.costmap import CostParams, HazardZone, TIER_FORBIDDEN, compute_costmap, distance_grid_m
from khipu.domain import MOBILE_KINDS, Provenance, make_asset
from khipu.geodesy import haversine_m
from khipu.layers import LayerContext, LayerDef, SnapshotManager, build_catalog, realtime_params
from khipu.operations import DemoHarness, MissionFSM, PeerSwarm
from khipu.resources import EVA_WALKBACK_LIMIT_M, PNR_DEFAULTS, ResourceLedger, assess_route, route_metrics, segment_cost
from khipu.router import RouteInfeasible, RouterConfig, direct_route, path_hits_obstacle, plan
from khipu.terrain import TerrainContext
from khipu_data.gemini import GeminiVoiceClient, GeminiVoiceError
from khipu_data.nasa_client import NasaClient
from khipu_data.regions import DATA, MACRO_KEY, RegionStore
from khipu_data.science import ScienceCatalog
from khipu_data.store import AssetRepository, JsonStore

SCENARIO_PATH = DATA / "fixtures" / "synthetic" / "scenario.json"


def encode_grid(arr: np.ndarray, bits: int = 8, lo: float | None = None, hi: float | None = None) -> dict:
    a = np.asarray(arr, dtype=np.float64)
    finite = np.isfinite(a)
    if not finite.any():
        return {"encoding": f"uint{bits}", "rows": a.shape[0], "cols": a.shape[1], "min": None, "max": None,
                "nodata": (1 << bits) - 1, "data": "", "coverage": 0.0}
    lo = float(np.nanmin(a)) if lo is None else lo
    hi = float(np.nanmax(a)) if hi is None else hi
    if hi <= lo:
        hi = lo + 1e-6
    top = (1 << bits) - 2
    q = np.clip(np.rint((a - lo) / (hi - lo) * top), 0, top)
    q = np.where(finite, q, top + 1)
    dt = np.uint8 if bits == 8 else np.dtype("<u2")
    raw = q.astype(dt).tobytes()
    return {"encoding": f"uint{bits}", "rows": int(a.shape[0]), "cols": int(a.shape[1]), "min": lo, "max": hi,
            "nodata": top + 1, "data": base64.b64encode(raw).decode("ascii"), "coverage": float(finite.mean())}


def strided(arr: np.ndarray, stride: int) -> np.ndarray:
    return arr[::stride, ::stride] if stride > 1 else arr


class Engine:
    def __init__(self, store_dir: Path | None = None):
        self.regions = RegionStore()
        self.scenario = json.loads(SCENARIO_PATH.read_text(encoding="utf-8")) if SCENARIO_PATH.exists() else {"assets": [], "hazards": [], "pois": []}
        self.store = JsonStore(store_dir) if store_dir else JsonStore()
        self.assets = AssetRepository(self.store)
        self.science = ScienceCatalog()
        self.nasa = NasaClient()
        self.gemini_voice = GeminiVoiceClient()
        self.harness = DemoHarness()
        self.fsm = MissionFSM()
        self.swarm = PeerSwarm()
        now = time.time()
        for pid, role, prio in (("hatun-wasi", "console", 1), ("chaski-pr01", "rover", 2), ("nawi-eva01", "eva", 3)):
            self.swarm.register(pid, role, prio, now=now)
        self.swarm.broadcast_costmap(now)
        self._managers: dict[str, SnapshotManager] = {}
        self.ledgers: dict[str, ResourceLedger] = {}
        self.started = now

    # ------------------------------------------------------------- regions
    def terrain(self, region_key: str) -> TerrainContext:
        t = self.regions.terrain(region_key)
        if t is None:
            raise LookupError(f"region '{region_key}' not available")
        return t

    def manager(self, region_key: str) -> SnapshotManager:
        t = self.terrain(region_key)
        if t.key not in self._managers:
            self._managers[t.key] = SnapshotManager(LayerContext(t, self.scenario), self.layer_catalog(t))
        return self._managers[t.key]

    def layer_catalog(self, terrain: TerrainContext | None = None) -> dict[str, LayerDef]:
        catalog = build_catalog(self.scenario)
        classes = self.science.data["geology_legend"]
        if classes and self.science.geology is not None:
            available = terrain is None or self.science.covers(terrain.geometry)
            catalog["geology_usgs"] = LayerDef(
                "geology_usgs", "Geología USGS", "", Provenance.OFFICIAL_USGS, "Geología",
                "Unidades cartografiadas en Jezero y Nili Planum. Conserva los colores de USGS.",
                available=available, unavailable_reason=None if available else "Fuera de la cobertura del mapa geológico.",
                compute=lambda ctx, _: self.science.geology_grid(ctx.terrain.geometry),
                range_hint=(1, len(classes)), classes=classes,
            )
        return catalog

    def default_region(self) -> str:
        return MACRO_KEY if self.regions.manifest(MACRO_KEY) else next(iter(self.regions.manifests()), MACRO_KEY)

    def terrain_payload(self, region_key: str, include_grid: bool = False, stride: int = 1) -> dict:
        m = self.regions.manifest(region_key)
        if m is None:
            return {"region_key": region_key, "available": False, "status": "no_data",
                    "message": "Región sin datos procesados. Ejecuta scripts/bootstrap_data.py con el original MOLA.",
                    "elevation": None}
        t = self.terrain(region_key)
        parent = self.regions.manifest(t.key)
        out = {"region_key": region_key, "available": True, "status": "ok", "manifest": m,
               "data_region": t.key, "geometry": t.geometry.to_dict(), "provenance": t.provenance,
               "elevation_stats": {"min": float(np.nanmin(t.elevation)), "max": float(np.nanmax(t.elevation)),
                                   "mean": float(np.nanmean(t.elevation))},
               "parent_manifest": parent if parent is not m else None,
               "analytical_layers": [d["id"] for d in self.manager(region_key).list() if d["available"]],
               "unavailable_layers": [{"id": d["id"], "reason": d["unavailable_reason"]}
                                      for d in self.manager(region_key).list() if not d["available"]],
               "focus_regions": [{"key": k, "name": v["name"], "center": v.get("center"), "bbox": v.get("focus_bbox")}
                                 for k, v in self.regions.manifests().items() if v.get("parent") == t.key]}
        if include_grid:
            out["elevation"] = encode_grid(strided(t.elevation, stride), 16)
            out["elevation"]["stride"] = stride
        return out

    # ------------------------------------------------------------- entities
    def all_entities(self, session_id: str | None = None) -> list[dict]:
        ents = []
        for point in self.scenario.get("assets", []) + self.scenario.get("pois", []):
            entity = make_asset({**point, "locked": True, "virtual": False})
            ents.append({**point, **entity.to_dict(), "source": "scenario", "editable": False})
        user = self.assets.list(session_id)
        for point in user["general"] + user["session"]:
            entity = make_asset({**point, "virtual": point["kind"] in MOBILE_KINDS})
            ents.append({**point, **entity.to_dict(), "source": "user", "editable": not entity.locked})
        return ents + self.science.entities

    def find_entity(self, entity_id: str | None, session_id: str | None = None) -> dict | None:
        if not entity_id:
            return None
        return next((e for e in self.all_entities(session_id) if e["id"] == entity_id), None)

    def ledger(self, asset_id: str, profile: str) -> ResourceLedger:
        if asset_id not in self.ledgers:
            d = PNR_DEFAULTS[profile]
            ent = self.find_entity(asset_id) or {}
            cap = float((ent.get("resources") or {}).get(d["resource"], d["capacity"]))
            self.ledgers[asset_id] = ResourceLedger(asset_id, d["resource"], cap)
        return self.ledgers[asset_id]

    # ------------------------------------------------------------- planning
    def eva_walkback_limit(self):
        return self.scenario.get("eva_policy", {}).get("walkback_limit_m", EVA_WALKBACK_LIMIT_M)

    def hazards(self, extra: list[dict] | None = None) -> list[HazardZone]:
        hz = [HazardZone.from_dict(h) for h in self.scenario.get("hazards", [])]
        for e in extra or []:
            hz.append(HazardZone.from_dict({**e, "tier": e.get("tier", "forbidden")}))
        return hz

    def costmap(self, region_key: str, profile: str = "rover", max_slope_deg: float | None = None,
                weights: dict | None = None, extra_hazards: list[dict] | None = None, walkback: dict | None = None,
                restrictions: dict | None = None, link: np.ndarray | None = None):
        t = self.terrain(region_key)
        w = weights or {}
        cp = CostParams(profile=profile, max_slope_deg=max_slope_deg, hazard_zones=self.hazards(extra_hazards), restrictions=restrictions or {},
                        w_slope=w.get("slope", 1.0), w_roughness=w.get("roughness", 0.5),
                        w_hazard=w.get("hazard", 1.0), w_context=w.get("context", 0.6), w_science=w.get("science", 0.0))
        if w.get("context", 0.6) > 0:
            mgr = self.manager(region_key)
            try:
                tel = link if link is not None else mgr.snapshot("telecom", {}).data
                cp.comms_risk = np.clip((6.0 - np.nan_to_num(tel, nan=-20.0)) / 26.0, 0, 1)
            except LookupError:
                pass
        if w.get("science"):
            cp.science_interest = self.manager(region_key).snapshot("science_vs_risk", {"alpha": 1.0}).data
        if walkback:
            cp.walkback_origin = (walkback["lat"], walkback["lon"])
            cp.walkback_radius_m = walkback["radius_m"]
        return t, compute_costmap(t, cp)

    def operational_costmap(self, region, profile, params, session_id=None, asset=None):
        mgr = self.manager(region)
        t = mgr.ctx.terrain
        overlay = self.harness.apply({"tau": params.get("tau", 0.5), "link_margin_db": 0, "obstacles": []})
        observed = [e for e in self.all_entities(session_id)
                    if e["kind"] in ("hazard", "lava_pit")]
        observed = [{**e, "radius_m": e.get("radius_m", e["metadata"].get("radius_m", 100))}
                    for e in observed if e.get("source") == "user" or e["kind"] == "lava_pit"]
        obstacles = [*(params.get("obstacles") or []), *overlay["obstacles"], *observed]
        if any(event["kind"] == "dust_storm" for event in self.harness.active):
            overlay["tau"] = max(3.5, overlay["tau"])
        atmosphere = {"ltst_h": params.get("ltst_h", 13), "tau": overlay["tau"]}
        temp = mgr.snapshot("temperature", atmosphere).data
        light = mgr.snapshot("insolation", atmosphere).data
        dust = mgr.snapshot("dust", {"tau": overlay["tau"]}).data
        link = mgr.snapshot("telecom", {"link_margin_offset_db": -overlay["link_margin_db"]}).data
        minimum = params.get("min_temperature_c", -105)
        maximum = params.get("max_temperature_c", 45)
        if minimum >= maximum:
            raise RouteInfeasible("temperature_range", "La temperatura mínima debe ser inferior a la máxima.")
        # Cover subpixel exclusions and avoid crossing their boundaries when shortcutting.
        padding = 0.5 * math.hypot(float(max(t.geometry.dx_rows())), t.geometry.dy_m)
        exclusions = np.zeros(t.shape, dtype=bool)
        for zone in self.hazards(obstacles):
            if zone.tier == TIER_FORBIDDEN:
                exclusions |= distance_grid_m(t, zone.lat, zone.lon) <= zone.radius_m + padding
        restrictions = {
            "hazard": exclusions,
            "temperature": ~np.isfinite(temp) | (temp < minimum) | (temp > maximum),
            "dust": ~np.isfinite(dust) | (dust > params.get("max_dust_tau", 3)),
            "darkness": ~np.isfinite(light) | (light < params.get("min_light_w_m2", 0.1)),
        }
        asset_limit = (asset or {}).get("max_slope_deg")
        configured_limit = params.get("max_slope_deg")
        slope = min((limit for limit in (configured_limit, asset_limit, 30.0) if limit is not None)) if (
            configured_limit is not None or asset_limit is not None) else None
        return (*self.costmap(region, profile, slope, params.get("weights"), obstacles,
                              restrictions=restrictions, link=link), link)

    def route_inventory(self, profile, params, asset, telemetry=None):
        settings = PNR_DEFAULTS[profile]
        main = settings["resource"]
        capacities = {main: settings["capacity"]}
        if profile == "astronaut":
            capacities.update(water_kg=3.6, battery_wh=1100.0)
        declared = (asset or {}).get("resources") or {}
        readings = {**declared, **(telemetry or {})}
        if asset and not asset.get("virtual"):
            ledger = self.ledger(asset["id"], profile)
            capacities[main] = ledger.capacity
            readings[main] = min(readings.get(main, ledger.remaining), ledger.remaining)
            for key in capacities.keys() - {main}:
                if declared.get(key, 0) > 0:
                    capacities[key] = declared[key]
        elif params.get("resources_capacity") is not None:
            capacities[main] = params["resources_capacity"]
        requested = params.get("resources_available")
        if requested is not None:
            readings[main] = min(readings.get(main, requested), requested)
        return {key: (min(readings.get(key, capacity), capacity), capacity) for key, capacity in capacities.items()}

    def evaluate_corridor(self, terrain, points, profile, params, asset, link, speed,
                          telemetry=None, return_prefix=None, manager=None, costmap=None, region=None,
                          weather_cells=None):
        inventory = self.route_inventory(profile, params, asset, telemetry)
        default = params.get("reserve_fraction")
        reserve = {}
        for resource, field in (("o2_kg", "reserve_o2_fraction"), ("water_kg", "reserve_water_fraction"),
                                ("battery_wh", "reserve_battery_fraction")):
            override = params.get(field)
            reserve[resource] = override if override is not None else default if default is not None else 0.25
        outbound = points
        points, pnr = assess_route(outbound, profile, inventory, reserve, speed, return_prefix)
        metrics = route_metrics(outbound, profile, speed)
        loss = navigation.blocked_link(terrain, outbound, link, params.get("min_link_db", 0), profile, speed)
        metrics["max_blackout_s"] = loss
        issues = []
        if manager is not None:
            overlay = self.harness.apply({"tau": params.get("tau", 0.5)})
            tau = overlay["tau"]
            if any(event["kind"] == "dust_storm" for event in self.harness.active):
                tau = max(3.5, tau)
            forecast = navigation.TravelForecast(manager, link, {**params, "tau": tau}, profile, speed,
                                                 costmap.params.restrictions if costmap else None)
            issues.extend(forecast.violations(outbound, telecom=False, weather_cells=weather_cells))
            if (not issues and pnr["status"] != "infeasible"
                    and (params.get("max_distance_m") is None or metrics["distance_m"] <= params["max_distance_m"])
                    and loss <= params.get("max_blackout_s", 900)):
                return_maps = {}
                def return_path(start, finish, elapsed_s):
                    hour = round(forecast.hour(elapsed_s) * 4) / 4 % 24
                    if hour not in return_maps:
                        _, return_maps[hour], _ = self.operational_costmap(region, profile, {**params, "ltst_h": hour}, asset=asset)
                    return_map = return_maps[hour]
                    # Keep the current mission exclusions including session points and obstacles.
                    for code in ("hazard", "dust"):
                        denied = costmap.params.restrictions[code]
                        return_map.tiers[denied] = TIER_FORBIDDEN
                        return_map.cost[denied] = np.inf
                    try:
                        cfg = RouterConfig(max_step_slope_deg=return_map.params.slope_limit())
                        return plan(terrain, return_map, start, finish, cfg)["points"]
                    except RouteInfeasible as error:
                        if error.reason == "search_budget":
                            raise TimeoutError from error
                        return []
                points, pnr = navigation.check_retreat(points, pnr, forecast, inventory, reserve,
                                                       return_prefix, return_path)
        if pnr["status"] == "infeasible":
            key = pnr["limiting_resource"]
            margin = pnr["resource_margins"][key]
            title = {"battery_wh": "batería", "o2_kg": "oxígeno", "water_kg": "agua"}[key]
            unit = "Wh" if key == "battery_wh" else "kg"
            issues.append(navigation.issue("resources", f"Faltan {-margin['one_way_margin']:.3g} {unit} de {title} para llegar conservando la reserva."))
        limit = params.get("max_distance_m")
        if limit is not None and metrics["distance_m"] > limit:
            issues.append(navigation.issue("distance", f"El recorrido de {metrics['distance_m']:.0f} m supera el límite de {limit:.0f} m."))
        if loss > (limit := params.get("max_blackout_s", 900)) + 1e-6:
            issues.append(navigation.issue("blackout", f"Pérdida continua de enlace de {loss:.0f} s frente al límite de {limit:.0f} s."))
        return points, metrics, pnr, issues

    def plan_route(self, req: dict) -> dict:
        region = req.get("region_key") or self.default_region()
        session_id = req.get("session_id")
        origin, destination = req["origin"], req["destination"]
        params = req.get("params") or {}
        origin_ent = self.find_entity(origin.get("id"), session_id)
        explicit_asset = self.find_entity(req.get("asset_id"), session_id)
        asset = origin_ent or explicit_asset
        origin_kind = (asset or origin).get("kind")
        profile = origin_kind if origin_kind in MOBILE_KINDS else None
        o, d = ((float(point["lat"]), float(point["lon"])) for point in (origin, destination))
        distance = haversine_m(*o, *d)
        result = {"feasible": True, "region_key": region, "profile": profile,
                  "asset_id": asset["id"] if profile and asset else None, "static_origin": profile is None,
                  "direct": {"distance_m": distance, "points": [{"lat": lat, "lon": lon} for lat, lon in (o, d)]},
                  "variants": [], "recommended": None, "operational_route": True, "route_model": 3, "costmap_version": self.swarm.costmap_version}
        if profile is None:
            return result

        legs = [o, *((float(w["lat"]), float(w["lon"])) for w in req.get("waypoints", [])), d]
        t, cm, link = self.operational_costmap(region, profile, params, session_id, asset)
        roles = ["origen", *(f"waypoint {i}" for i in range(1, len(legs) - 1)), "destino"]
        navigation.check_endpoints(t, cm, zip(legs, roles))

        walk_limit = (params.get("walkback_limit_m") or self.eva_walkback_limit()
                      if profile == "astronaut" else None)
        if walk_limit and max(haversine_m(*o, *point) for point in legs) > walk_limit:
            raise RouteInfeasible("walkback_exceeded", f"Un punto excede el radio de retorno a pie de {walk_limit:.0f} m.",
                                  walkback_limit_m=walk_limit, reasons=[{"code": "walkback", "detail": f"Radio de retorno a pie: {walk_limit:.0f} m."}])
        if walk_limit:
            params = {**params, "max_distance_m": min(walk_limit, params.get("max_distance_m") or walk_limit)}
        asset_speed = (asset or {}).get("speed_mps")
        speed = params.get("speed_mps") or asset_speed
        if speed is not None and asset_speed is not None:
            speed = min(speed, asset_speed)
        prefix = req.get("return_prefix")

        weather_cells = set()

        def calculate(costmap, edge_cost=None, smooth=True, collect_weather=False):
            points, controls = [], []
            for a, b in zip(legs, legs[1:]):
                cfg = RouterConfig(max_step_slope_deg=cm.params.slope_limit(), edge_cost=edge_cost, smooth=smooth)
                leg = plan(t, costmap, a, b, cfg)
                points.extend(leg["points"][1:] if points else leg["points"])
                controls.extend(leg["control_points"])
            return self.evaluate_corridor(t, points, profile, params, asset, link, speed, return_prefix=prefix,
                                          manager=self.manager(region), costmap=costmap, region=region,
                                          weather_cells=weather_cells if collect_weather else None), controls

        try:
            (points, metrics, pnr, issues), controls = calculate(cm, collect_weather=True)
        except RouteInfeasible as exc:
            causes = navigation.diagnose_corridor(t, cm, o, d)
            if exc.reason == "no_path" and causes:
                navigation.forbid(causes)
            raise

        if issues:
            # Search feasible alternatives internally. Only the accepted path leaves the engine.
            strict = navigation.with_link_required(cm, link, params.get("min_link_db", 0))
            key = pnr["limiting_resource"]
            def low_consumption(distance, grade):
                return segment_cost(profile, distance, grade, speed)[key]

            codes = {item["code"] for item in issues}
            candidates = []
            fixed = cm
            if weather_cells:
                endpoint_cells = {navigation.latlon_to_cell(t, *ll, role=role) for ll, role in zip(legs, roles)}
                cost, tiers = cm.cost.copy(), cm.tiers.copy()
                for cell in weather_cells - endpoint_cells:
                    cost[cell], tiers[cell] = np.inf, TIER_FORBIDDEN
                fixed = replace(cm, cost=cost, tiers=tiers)
                candidates.extend([(fixed, lambda distance, _: distance, False), (fixed, None, True)])
            if "blackout" in codes:
                candidates.append((strict, None, True))
            if "distance" in codes:
                candidates.append((strict if "blackout" in codes else cm, lambda distance, _: distance, False))
            if "resources" in codes:
                candidates.append((strict if "blackout" in codes else cm, low_consumption, False))
            for candidate in candidates:
                try:
                    (pts, met, split, failures), control = calculate(*candidate)
                except RouteInfeasible:
                    continue
                if not failures:
                    points, metrics, pnr, issues, controls = pts, met, split, [], control
                    break
            if issues:
                navigation.forbid(issues)

        variant = {"variant": "balanced", "label": "Ruta de travesía", "points": points, "metrics": metrics,
                   "control_points": controls, "notes": [], "pnr": pnr,
                   "asset_metrics": {"profile": profile, "resources": metrics["resources"], "duration_s": metrics["duration_s"]}}
        direct = direct_route(t, cm, o, d)
        return {**result, "variants": [variant], "recommended": variant["variant"], "direct": direct,
                "slope_limit_deg": cm.params.slope_limit(), "walkback_limit_m": walk_limit}

    def dynamic_replan(self, req: dict) -> dict:
        region = req.get("region_key") or self.default_region()
        pts = req.get("route_points") or []
        obstacles = req.get("obstacles") or []
        overlay = self.harness.apply({"obstacles": []})
        obstacles = obstacles + overlay.get("obstacles", [])
        compromised = [ob for ob in obstacles if path_hits_obstacle(pts, ob)] if pts else obstacles
        params = req.get("params") or {}
        if pts and not compromised and not self.harness.active and not req.get("reevaluate") and params.get("resources_available") is None:
            return {"status": "nominal", "replanned": False, "reason": "El corredor actual no cruza obstáculos.",
                    "route_points": pts}
        current = req["current"]
        prefix = list(req.get("return_prefix") or [])
        if pts and all(p.get("elevation_m") is not None for p in pts):
            nearest = min(range(len(pts)), key=lambda i: haversine_m(
                current["lat"], current["lon"], pts[i]["lat"], pts[i]["lon"]))
            prefix.extend(pts[:nearest + 1])
            elevation = self.terrain(region).elevation_at(current["lat"], current["lon"])
            if elevation is not None:
                prefix.append({**current, "elevation_m": elevation})
        sub = {"region_key": region, "session_id": req.get("session_id"), "origin": current,
               "return_prefix": prefix, "destination": req["destination"],
               "profile": req.get("profile", "rover"), "asset_id": req.get("asset_id"), "variants": False,
               "params": {**(req.get("params") or {}), "obstacles": [{**o, "tier": "forbidden"} for o in obstacles]}}
        res = self.plan_route(sub)
        if res["static_origin"]:
            return {"status": "measurement", "replanned": False, "reason": "Origen sin activo móvil.",
                    "route_points": res["direct"]["points"]}
        v = res["variants"][0]
        still = [ob for ob in obstacles if path_hits_obstacle(v["points"], ob)]
        return {"status": "compromised", "replanned": True, "obstacles": obstacles, "route_points": v["points"],
                "metrics": v["metrics"], "pnr": v["pnr"], "return_prefix": prefix, "evasion_ok": not still,
                "reason": ("Se replanificó con las condiciones actuales." if not compromised else
                           f"{len(compromised)} obstáculo(s) en el corredor; se replanificó evitando la zona.")}

    def ingest_region(self, key: str, name: str, bounds: dict) -> dict:
        from khipu_data.regions import MOLA_LABEL, build_region, sha256_file
        if key in self.regions.manifests() and key == MACRO_KEY:
            raise ValueError("no se puede sobrescribir la macrorregión base")
        m = build_region(key, name, bounds["lat_min"], bounds["lat_max"], bounds["lon_min"], bounds["lon_max"],
                         "Región personalizada derivada", source_sha=None)
        self.regions._terrain.pop(key, None)
        return m

    def voice(self, text: str, interface: str, points: list[dict] | None = None, language: str = "es",
              *, audio: str = "", mime_type: str = "", prefer_local: bool = False) -> dict:
        pois = points or [e for e in self.all_entities() if e.get("kind") in (
            "poi", "sample", "landmark", "base", "rover", "astronaut", "antenna", "habitat")]
        if not prefer_local and not voice.is_explicit_emergency(text) and (text.strip() or audio) and self.gemini_voice.enabled:
            layers = {key: layer.name for key, layer in self.layer_catalog().items() if layer.available}
            if interface == "rover":
                layers["relief"] = "Relieve"
                if self.science.track:
                    layers["recorded_traverse"] = "Recorrido histórico de Perseverance"
            context = voice.voice_context(interface, language, pois[:100], layers)
            try:
                result = self.gemini_voice.classify(context, text=text, audio=audio, mime_type=mime_type)
                action = voice.from_gemini(result, context, pois[:100], text)
                return {**action, "provider": "gemini"}
            except (GeminiVoiceError, ValueError) as exc:
                if audio:
                    raise GeminiVoiceError(getattr(exc, "reason", "invalid_command")) from None
        if audio:
            raise GeminiVoiceError("disabled")
        result = voice.interpret(text, pois, interface, language)
        return {**result, "provider": "local"}

    def export(self, fmt: str, route: dict, name: str = "travesia") -> dict:
        if fmt == "geojson":
            return {"format": "geojson", "content": exporters.to_geojson(route, name), "filename": f"{name}.geojson"}
        if fmt == "sasf":
            return {"format": "sasf", "content": exporters.to_sasf(route, name.upper().replace(" ", "_")[:24]),
                    "filename": f"{name}.sasf"}
        if fmt == "csv":
            return {"format": "csv", "content": exporters.to_csv(route), "filename": f"{name}.csv"}
        raise ValueError(fmt)

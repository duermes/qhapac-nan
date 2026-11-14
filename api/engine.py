"""Engine service: wires Khipu core with data adapters. One shared instance
serves Hatun Wasi, Chaski and Ñawi (no divergent engines)."""
from __future__ import annotations

import base64
import json
import math
import time
from pathlib import Path

import numpy as np

from khipu import exporters, inspection, voice
from khipu.costmap import CostParams, HazardZone, compute_costmap
from khipu.domain import MOBILE_KINDS, AssetKind, make_asset
from khipu.geodesy import haversine_m
from khipu.layers import LayerContext, SnapshotManager, build_catalog, realtime_params
from khipu.operations import DemoHarness, MissionFSM, PeerSwarm
from khipu.resources import PNR_DEFAULTS, ResourceLedger, evaluate_pnr, route_metrics
from khipu.router import RouteInfeasible, RouterConfig, direct_route, path_hits_obstacle, plan, plan_variants
from khipu.terrain import TerrainContext
from khipu_data.nasa_client import NasaClient
from khipu_data.regions import DATA, MACRO_KEY, RegionStore
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
        self.scenario = json.loads(SCENARIO_PATH.read_text()) if SCENARIO_PATH.exists() else {"assets": [], "hazards": [], "pois": []}
        self.store = JsonStore(store_dir) if store_dir else JsonStore()
        self.assets = AssetRepository(self.store)
        self.nasa = NasaClient()
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
            self._managers[t.key] = SnapshotManager(LayerContext(t, self.scenario), build_catalog(self.scenario))
        return self._managers[t.key]

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
        for a in self.scenario.get("assets", []):
            ents.append({**a, "provenance": "synthetic", "source": "scenario", "mobile": a["kind"] in ("rover", "astronaut")})
        for p in self.scenario.get("pois", []):
            ents.append({**p, "provenance": "synthetic", "source": "scenario", "mobile": False})
        user = self.assets.list(session_id)
        for a in user["general"] + user["session"]:
            ents.append({**a, "source": "user", "mobile": a.get("kind") in ("rover", "astronaut")})
        return ents

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
    def hazards(self, extra: list[dict] | None = None) -> list[HazardZone]:
        hz = [HazardZone.from_dict(h) for h in self.scenario.get("hazards", [])]
        for e in extra or []:
            hz.append(HazardZone.from_dict({**e, "tier": e.get("tier", "forbidden")}))
        return hz

    def costmap(self, region_key: str, profile: str = "rover", max_slope_deg: float | None = None,
                weights: dict | None = None, extra_hazards: list[dict] | None = None, walkback: dict | None = None):
        t = self.terrain(region_key)
        w = weights or {}
        cp = CostParams(profile=profile, max_slope_deg=max_slope_deg, hazard_zones=self.hazards(extra_hazards),
                        w_slope=w.get("slope", 1.0), w_roughness=w.get("roughness", 0.5),
                        w_hazard=w.get("hazard", 1.0), w_context=w.get("context", 0.6), w_science=w.get("science", 0.0))
        if w.get("context", 0.6) > 0:
            mgr = self.manager(region_key)
            try:
                tel = mgr.snapshot("telecom", {}).data
                cp.comms_risk = np.clip((6.0 - np.nan_to_num(tel, nan=-20.0)) / 26.0, 0, 1)
            except LookupError:
                pass
        if w.get("science"):
            cp.science_interest = self.manager(region_key).snapshot("science_vs_risk", {"alpha": 1.0}).data
        if walkback:
            cp.walkback_origin = (walkback["lat"], walkback["lon"])
            cp.walkback_radius_m = walkback["radius_m"]
        return t, compute_costmap(t, cp)

    def plan_route(self, req: dict) -> dict:
        region = req.get("region_key") or self.default_region()
        session_id = req.get("session_id")
        origin = req["origin"]
        dest = req["destination"]
        params = req.get("params") or {}
        asset = self.find_entity(req.get("asset_id"), session_id) if req.get("asset_id") else None
        if asset and asset.get("kind") not in ("rover", "astronaut"):
            raise RouteInfeasible("static_asset", f"'{asset['name']}' es un activo estático ({asset['kind']}); "
                                  "solo rovers y astronautas pueden enrutarse.")
        profile = (asset or {}).get("kind") or req.get("profile") or "rover"
        if profile not in ("rover", "astronaut"):
            profile = "rover"
        origin_ent = self.find_entity(origin.get("id"), session_id) if origin.get("id") else None
        origin_kind = (origin_ent or origin).get("kind")
        static_origin = asset is None and (origin_kind is None or origin_kind not in ("rover", "astronaut"))
        max_slope = params.get("max_slope_deg") or (asset or {}).get("max_slope_deg")
        walk_limit = float(params.get("walkback_limit_m") or self.scenario.get("eva_policy", {}).get("walkback_limit_m", 2000))
        walk_limit = max(1000.0, min(2000.0, walk_limit))
        o = (float(origin["lat"]), float(origin["lon"]))
        d = (float(dest["lat"]), float(dest["lon"]))
        legs = [o] + [(float(w["lat"]), float(w["lon"])) for w in req.get("waypoints", [])] + [d]
        if profile == "astronaut":
            far = max(haversine_m(*o, *p) for p in legs[1:])
            if far > walk_limit:
                raise RouteInfeasible("walkback_exceeded",
                                      f"El destino está a {far:.0f} m del origen; el límite a pie (walkback) es {walk_limit:.0f} m.",
                                      distance_m=far, walkback_limit_m=walk_limit)
        t, cm = self.costmap(region, profile, max_slope, params.get("weights"), params.get("obstacles"))
        cfg = RouterConfig(max_step_slope_deg=cm.params.slope_limit())
        variants: dict[str, list] = {}
        for a, b in zip(legs[:-1], legs[1:]):
            if req.get("variants", True):
                for v in plan_variants(t, cm, a, b, cfg):
                    variants.setdefault(v["variant"], []).append(v)
            else:
                v = plan(t, cm, a, b, RouterConfig(max_step_slope_deg=cfg.max_step_slope_deg))
                v["variant"], v["label"] = "balanced", "Equilibrada"
                variants.setdefault("balanced", []).append(v)
        speed = params.get("speed_mps") or (asset or {}).get("speed_mps")
        out_variants = []
        for key, legs_res in variants.items():
            pts = []
            for i, lr in enumerate(legs_res):
                pts.extend(lr["points"] if i == 0 else lr["points"][1:])
            # re-accumulate distance across legs
            cum = 0.0
            for i in range(len(pts)):
                if i:
                    cum += haversine_m(pts[i - 1]["lat"], pts[i - 1]["lon"], pts[i]["lat"], pts[i]["lon"])
                pts[i] = {**pts[i], "distance_m": cum}
            metrics = route_metrics(pts, profile, speed)
            if profile == "astronaut":
                # walking home follows the path back: its length must fit the walkback envelope
                if metrics["distance_m"] > walk_limit:
                    raise RouteInfeasible("walkback_exceeded",
                                          f"El recorrido a pie es de {metrics['distance_m']:.0f} m; supera el walkback de {walk_limit:.0f} m.",
                                          distance_m=metrics["distance_m"], walkback_limit_m=walk_limit)
            entry = {"variant": key, "label": legs_res[0]["label"], "points": pts, "metrics": metrics,
                     "control_points": sum((lr["control_points"] for lr in legs_res), []),
                     "notes": [lr["note"] for lr in legs_res if lr.get("note")]}
            if static_origin:
                entry["asset_metrics"] = None
                entry["pnr"] = None
            else:
                avail = params.get("resources_available")
                cap = params.get("resources_capacity")
                if asset:
                    lg = self.ledger(asset["id"], profile)
                    cap = cap or lg.capacity
                    if avail is None:
                        avail = lg.replan_budget()  # cumulative: never refilled by re-planning
                entry["pnr"] = evaluate_pnr(pts, profile, avail, cap,
                                            params.get("reserve_fraction"), speed)
                entry["asset_metrics"] = {"profile": profile, "resources": metrics["resources"],
                                          "duration_s": metrics["duration_s"]}
            out_variants.append(entry)
        direct = direct_route(t, cm, o, d)
        return {
            "feasible": True, "region_key": region, "profile": profile,
            "asset_id": (asset or {}).get("id"), "static_origin": static_origin,
            "metrics_suppressed_reason": ("Origen estático (base/waypoint) sin activo móvil: se omiten métricas de rover/EVA."
                                          if static_origin else None),
            "slope_limit_deg": cm.params.slope_limit(), "walkback_limit_m": walk_limit if profile == "astronaut" else None,
            "variants": out_variants, "recommended": "balanced",
            "direct": {"distance_m": direct["distance_m"], "crosses_forbidden": direct["crosses_forbidden"],
                       "points": direct["points"][:: max(1, len(direct["points"]) // 60)] + [direct["points"][-1]]},
            "costmap_version": self.swarm.costmap_version,
        }

    def dynamic_replan(self, req: dict) -> dict:
        region = req.get("region_key") or self.default_region()
        pts = req.get("route_points") or []
        obstacles = req.get("obstacles") or []
        overlay = self.harness.apply({"obstacles": []})
        obstacles = obstacles + overlay.get("obstacles", [])
        compromised = [ob for ob in obstacles if path_hits_obstacle(pts, ob)] if pts else obstacles
        if pts and not compromised:
            return {"status": "nominal", "replanned": False, "reason": "El corredor actual no cruza obstáculos.",
                    "route_points": pts}
        sub = {"region_key": region, "origin": req["current"], "destination": req["destination"],
               "profile": req.get("profile", "rover"), "asset_id": req.get("asset_id"), "variants": False,
               "params": {**(req.get("params") or {}), "obstacles": [{**o, "tier": "forbidden"} for o in obstacles]}}
        res = self.plan_route(sub)
        v = res["variants"][0]
        still = [ob for ob in obstacles if path_hits_obstacle(v["points"], ob)]
        return {"status": "compromised", "replanned": True, "obstacles": obstacles, "route_points": v["points"],
                "metrics": v["metrics"], "pnr": v["pnr"], "evasion_ok": not still,
                "reason": f"{len(compromised)} obstáculo(s) en el corredor; se replanificó evitando la zona."}

    def ingest_region(self, key: str, name: str, bounds: dict) -> dict:
        from khipu_data.regions import MOLA_LABEL, build_region, sha256_file
        if key in self.regions.manifests() and key == MACRO_KEY:
            raise ValueError("no se puede sobrescribir la macrorregión base")
        m = build_region(key, name, bounds["lat_min"], bounds["lat_max"], bounds["lon_min"], bounds["lon_max"],
                         "Región personalizada derivada", source_sha=None)
        self.regions._terrain.pop(key, None)
        return m

    def voice(self, text: str, interface: str) -> dict:
        pois = [e for e in self.all_entities() if e.get("kind") in ("poi", "sample", "landmark", "base", "rover", "astronaut", "antenna", "habitat")]
        return voice.interpret(text, pois, interface)

    def export(self, fmt: str, route: dict, name: str = "travesia") -> dict:
        if fmt == "geojson":
            return {"format": "geojson", "content": exporters.to_geojson(route, name), "filename": f"{name}.geojson"}
        if fmt == "sasf":
            return {"format": "sasf", "content": exporters.to_sasf(route, name.upper().replace(" ", "_")[:24]),
                    "filename": f"{name}.sasf"}
        if fmt == "csv":
            return {"format": "csv", "content": exporters.to_csv(route), "filename": f"{name}.csv"}
        raise ValueError(fmt)

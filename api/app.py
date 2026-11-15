"""Qhapaq Ñan HTTP API and page server.

Run: .venv/bin/uvicorn api.app:app --port 8000  (from workspace/)"""
from __future__ import annotations

import base64
import binascii
import math
import os
import time
from threading import BoundedSemaphore
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from khipu.resources import EVA_DEMO_WATER_CAPACITY_KG, ROVER_DEMO_CAPACITY_WH
from khipu.operations import CONTINGENCIES, Localizer, PurePursuit
from khipu.physics import ephemeris as eph
from khipu.physics import metabolic as met
from khipu.physics import terramechanics as tm
from khipu.router import RouteInfeasible
from khipu import inspection
from khipu_data.gemini import GeminiVoiceError
from khipu_data.pds3 import PDS3Error

from . import schemas as S
from .engine import Engine, encode_grid, strided

WEB = Path(__file__).resolve().parents[1] / "web"
PAGES = {"home": "home/index.html", "console": "console/index.html", "rover": "rover/index.html", "hud": "hud/index.html"}

app = FastAPI(title="Qhapaq Ñan — Khipu API", version="1.0.0")
engine = Engine(Path(os.environ["QN_STATE_DIR"]) if os.environ.get("QN_STATE_DIR") else None)
planning_gate = BoundedSemaphore(1)


def bounded_plan(callback, req):
    if not planning_gate.acquire(blocking=False):
        raise HTTPException(429, "El planificador está ocupado. Espera a que termine la solicitud actual.", headers={"Retry-After": "2"})
    try:
        return ok(callback(req.model_dump()))
    finally:
        planning_gate.release()


def _clean(o):
    """JSON-safe: replace NaN/inf with None recursively."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.generic):
        return _clean(o.item())
    return o


def ok(payload) -> JSONResponse:
    return JSONResponse(_clean(payload))


@app.exception_handler(RouteInfeasible)
async def infeasible_handler(_: Request, exc: RouteInfeasible):
    return JSONResponse(_clean({**exc.to_dict(), "error": "route_infeasible"}), status_code=422)


@app.exception_handler(LookupError)
async def lookup_handler(_: Request, exc: LookupError):
    return JSONResponse({"error": "not_found", "detail": str(exc)}, status_code=404)


@app.exception_handler(RequestValidationError)
async def validation_handler(_: Request, exc: RequestValidationError):
    errs = [{"field": ".".join(str(x) for x in e["loc"][1:]), "message": e["msg"]} for e in exc.errors()]
    return JSONResponse({"error": "validation_error", "detail": "Datos de entrada inválidos.", "fields": errs},
                        status_code=422)


# ------------------------------------------------------------------ pages

@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse("/home", status_code=307)


def _page(name: str):
    return FileResponse(WEB / PAGES[name], media_type="text/html")


@app.get("/home", include_in_schema=False)
def home():
    return _page("home")


@app.get("/console", include_in_schema=False)
def console():
    return _page("console")


@app.get("/rover", include_in_schema=False)
def rover():
    return _page("rover")


@app.get("/hud", include_in_schema=False)
def hud():
    return _page("hud")


app.mount("/static", StaticFiles(directory=WEB), name="static")


@app.get("/api/map-icons")
def map_icons():
    directory = WEB / "shared" / "assets" / "markers"
    return {"kinds": [path.stem for path in directory.glob("*.svg") if path.is_file()]}

# ------------------------------------------------------------------ core


@app.get("/api/health")
def health():
    return ok({"status": "ok", "service": "khipu", "version": app.version, "uptime_s": time.time() - engine.started,
               "data": engine.regions.status(), "offline_mode": engine.nasa.offline,
               "simulation_active": bool(engine.harness.active), "time": datetime.now(timezone.utc).isoformat()})


@app.get("/api/regions")
def regions():
    ms = engine.regions.manifests()
    return ok({"default": engine.default_region(), "regions": list(ms.values())})


@app.get("/api/data/manifest")
def data_manifest():
    from khipu_data.regions import MANIFEST
    import json as _json
    m = _json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {"schema_version": "1.0", "datasets": []}
    return ok({"kickoff_manifest": m, "regions": list(engine.regions.manifests().values()),
               "science_sources": engine.science.data["sources"],
               "scenario": {"classification": engine.scenario.get("classification"), "label": engine.scenario.get("label"),
                            "notes": engine.scenario.get("notes")},
               "layers": engine.manager(engine.default_region()).list() if engine.regions.manifests() else []})


@app.get("/api/scenario")
def scenario():
    return ok({**engine.scenario, "science_points": engine.science.entities})


@app.get("/api/science")
def science_catalog():
    return ok(engine.science.data)


@app.get("/api/terrain/{region_key}")
def terrain(region_key: str, include_grid: bool = False, stride: int = Query(1, ge=1, le=16)):
    return ok(engine.terrain_payload(region_key, include_grid, stride))


@app.get("/api/terrain/{region_key}/sample")
def terrain_sample(region_key: str, lat: float, lon: float):
    t = engine.terrain(region_key)
    return ok({"region_key": region_key, **t.sample(lat, lon)})


@app.get("/api/official_routes/{region_key}")
def official_routes(region_key: str):
    manifest = engine.regions.manifest(region_key)
    if manifest is None:
        raise HTTPException(404, f"region '{region_key}' not available")
    track = engine.science.track
    bbox = manifest.get("focus_bbox") or manifest["geometry"]
    segments = []
    if track:
        segments = [s for s in track["segments"] if any(
            bbox["lat_min"] <= lat <= bbox["lat_max"] and bbox["lon_min"] <= lon <= bbox["lon_max"]
            for path in s["paths"] for lon, lat, *_ in path
        )]
    return ok({"region_key": region_key, "official": [{**track, "segments": segments}] if segments else [],
               "classification": "official_nasa" if segments else "unavailable",
               "message": ("Trayectoria histórica registrada por Mars Trek."
                           if segments else "Sin recorridos oficiales en esta región.")})



@app.get("/api/mars_time")
def mars_time(lon: float = 77.45, lat: float = 18.44):
    mt = eph.mars_time(datetime.now(timezone.utc), lon)
    sol = eph.solar_position(lat, mt["ltst_h"], mt["declination_deg"])
    return ok({**mt, "sun": sol, "lat": lat, "lon": lon})


@app.post("/api/route")
def route(req: S.RouteRequest):
    return bounded_plan(engine.plan_route, req)


@app.post("/api/route/dynamic_replan")
def dynamic_replan(req: S.ReplanRequest):
    return bounded_plan(engine.dynamic_replan, req)


@app.post("/api/costmap")
def costmap(req: S.CostmapRequest):
    region = req.region_key or engine.default_region()
    t, cm = engine.costmap(region, req.profile, req.max_slope_deg, req.weights, req.hazards, req.walkback)
    out = {"region_key": region, "summary": cm.summary(), "provenance": "derived_from_nasa",
           "hazards": [h.__dict__ for h in engine.hazards(req.hazards)]}
    if req.include_grid:
        out["cost"] = encode_grid(strided(np.where(np.isfinite(cm.cost), cm.cost, np.nan), req.stride), 8)
        out["tiers"] = encode_grid(strided(cm.tiers.astype(float), req.stride), 8, 0, 3)
    return ok(out)


# ------------------------------------------------------------------ assets


@app.get("/api/assets")
def assets(session_id: str | None = None):
    return ok({"scenario": [e for e in engine.all_entities(session_id) if e["source"] == "scenario"],
               **engine.assets.list(session_id)})


@app.post("/api/assets")
def add_asset(a: S.AssetIn):
    t = engine.regions.terrain(engine.default_region())
    if any(a.id == p["id"] for p in engine.all_entities() if p["source"] in {"scenario", "official_science"}):
        raise HTTPException(409, "El identificador pertenece a un punto de solo lectura")
    data = a.model_dump(exclude_none=True)
    if a.kind in ("rover", "astronaut"):
        data["virtual"] = True
        data.setdefault("resources", {"battery_wh": ROVER_DEMO_CAPACITY_WH} if a.kind == "rover" else
                        {"o2_kg": 1.2, "water_kg": EVA_DEMO_WATER_CAPACITY_KG, "battery_wh": 1100})
    if t is not None and data.get("elevation_m") is None:
        data["elevation_m"] = t.elevation_at(a.lat, a.lon)
    return ok(engine.assets.add({k: v for k, v in data.items() if k != "session_id"}, a.session_id))


@app.patch("/api/assets/{asset_id}")
def patch_asset(asset_id: str, p: S.AssetPatch):
    if any(asset_id == e["id"] for e in engine.all_entities() if e["source"] in {"scenario", "official_science"}):
        raise HTTPException(409, "Punto de solo lectura")
    try:
        patch = p.model_dump(exclude_none=True)
        terrain = engine.regions.terrain(engine.default_region())
        res = engine.assets.update(asset_id, patch, terrain=terrain)
    except PermissionError as e:
        raise HTTPException(409, str(e))
    if res is None:
        raise HTTPException(404, "asset not found")
    return ok(res)


@app.delete("/api/assets/{asset_id}")
def delete_asset(asset_id: str):
    if any(asset_id == e["id"] for e in engine.all_entities() if e["source"] in {"scenario", "official_science"}):
        raise HTTPException(409, "Punto de solo lectura")
    return ok({"deleted": engine.assets.delete(asset_id)})


@app.post("/api/assets/save_to_general")
def save_to_general(a: S.SessionAction):
    return ok({"moved": engine.assets.save_to_general(a.session_id, a.ids)})


@app.post("/api/assets/clear_session")
def clear_session(a: S.SessionAction):
    return ok({"cleared": engine.assets.clear_session(a.session_id)})


@app.get("/api/workspace")
def get_workspace():
    return ok(engine.store.read("workspace", {"sessions": [], "preferences": {}}))


@app.put("/api/workspace")
def put_workspace(ws: dict = Body(...)):
    if len(str(ws)) > 2_000_000:
        raise HTTPException(413, "workspace too large")
    engine.store.write("workspace", {**ws, "saved_at": time.time()})
    return ok({"saved": True})


# ------------------------------------------------------------------ analysis


@app.get("/api/inspection/risk_factors")
def risk_factors(lat: float, lon: float, region_key: str | None = None, profile: S.Profile = "rover",
                 ltst_h: float | None = None, tau: float | None = None):
    mgr = engine.manager(region_key or engine.default_region())
    params = {k: v for k, v in {"ltst_h": ltst_h, "tau": tau}.items() if v is not None}
    return ok(inspection.risk_factors(mgr, lat, lon, profile, params))


@app.get("/api/layers")
def layers(region_key: str | None = None):
    region = region_key or engine.default_region()
    mgr = engine.manager(region)
    return ok({"region_key": region, "layers": mgr.list(), "realtime": _rt(mgr)})


def _rt(mgr):
    from khipu.layers import realtime_params
    return realtime_params(mgr.ctx)


@app.get("/api/layers/{field_id}")
def layer_snapshot(field_id: str, region_key: str | None = None, stride: int = Query(2, ge=1, le=16),
                   row: int | None = Query(None, ge=0), col: int | None = Query(None, ge=0),
                   rows: int | None = Query(None, ge=1, le=1024), cols: int | None = Query(None, ge=1, le=1024),
                   ltst_h: float | None = Query(None, ge=0, le=24),
                   tau: float | None = Query(None, ge=0, le=10),
                   alpha: float | None = Query(None, ge=0, le=1),
                   profile: S.Profile | None = None, max_slope_deg: float | None = Query(None, gt=0, le=45),
                   receiver_height_m: float | None = Query(None, ge=0.1, le=20),
                   link_margin_offset_db: float | None = Query(None, ge=-40, le=40),
                   walkback_m: float | None = Query(None, gt=0, le=50000),
                   helio_au: float | None = Query(None, ge=1.3, le=1.7),
                   science_radius_scale: float | None = Query(None, ge=0.1, le=5),
                   hazard_weight: float | None = Query(None, ge=0, le=5),
                   realtime: bool = False, include_grid: bool = True):
    mgr = engine.manager(region_key or engine.default_region())
    if field_id not in mgr.catalog:
        raise HTTPException(404, f"layer '{field_id}' not in catalog")
    d = mgr.catalog[field_id]
    if not d.available:
        return ok({"field_id": field_id, "available": False, "reason": d.unavailable_reason, "layer": d.describe()})
    params = {"ltst_h": ltst_h, "tau": tau, "alpha": alpha, "profile": profile, "max_slope_deg": max_slope_deg,
              "receiver_height_m": receiver_height_m, "link_margin_offset_db": link_margin_offset_db,
              "walkback_m": walkback_m, "helio_au": helio_au, "science_radius_scale": science_radius_scale,
              "hazard_weight": hazard_weight, "realtime": realtime}
    if engine.harness.active:
        ov = engine.harness.apply({"tau": tau if tau is not None else 0.5, "link_margin_db": 0.0})
        if "tau" in d.describe()["controls"]:
            params["tau"] = ov["tau"]
        if field_id in ("telecom", "survival_astronaut", "survival_rover"):
            params["link_margin_offset_db"] = (link_margin_offset_db or 0) - ov["link_margin_db"]
    if field_id == "telecom":
        params["telecom_stride"] = 1 if row is not None and stride == 1 else min(4, stride)
    snap = mgr.snapshot(field_id, {k: v for k, v in params.items() if v is not None and v is not False})
    stats = snap.stats()
    lo, hi = d.range_hint or (stats["min"], stats["max"])
    out = {"field_id": field_id, "available": True, "layer": d.describe(), "params": snap.params, "stats": stats,
           "color_domain": [lo, hi],
           "units": snap.units, "provenance": snap.provenance.value, "simulation": bool(engine.harness.active)}
    if include_grid:
        window = (row, col, rows, cols)
        if any(value is not None for value in window):
            if any(value is None for value in window) or row + rows > snap.data.shape[0] or col + cols > snap.data.shape[1]:
                raise HTTPException(422, "Ventana fuera de la cuadrícula")
            grid = snap.data[row:row + rows, col:col + cols]
        else:
            row, col = 0, 0
            rows, cols = snap.data.shape
            grid = snap.data
        g = encode_grid(strided(grid, stride), 8, lo, hi)
        g.update(stride=stride, row=row, col=col, width=cols, height=rows)
        out["grid"] = g
    return ok(out)


# ------------------------------------------------------------------ NASA & ingest


@app.get("/api/nasa/weather")
def nasa_weather():
    return ok(engine.nasa.fetch("weather"))


@app.get("/api/nasa/apod")
def nasa_apod():
    return ok(engine.nasa.fetch("apod"))


@app.post("/api/ingest/extract_mola")
def extract_mola(req: S.IngestRequest):
    if req.lat_min >= req.lat_max or req.lon_min >= req.lon_max:
        raise HTTPException(422, "bounds must satisfy min < max")
    if (req.lat_max - req.lat_min) * (req.lon_max - req.lon_min) > 64:
        raise HTTPException(422, "requested window too large (max 64 square degrees)")
    try:
        m = engine.ingest_region(req.key, req.name, req.model_dump())
    except (PDS3Error, FileNotFoundError) as e:
        raise HTTPException(409, f"MOLA original unavailable or invalid: {e}")
    except ValueError as e:
        raise HTTPException(409, str(e))
    return ok({"created": True, "manifest": m})


# ------------------------------------------------------------------ simulation & redundancy


@app.get("/api/harness")
def harness_status():
    return ok({"active": engine.harness.active, "available": CONTINGENCIES, "simulation": bool(engine.harness.active)})


@app.post("/api/harness/inject")
def harness_inject(req: S.InjectRequest):
    try:
        ev = engine.harness.inject(req.kind, req.params)
    except ValueError as e:
        raise HTTPException(422, str(e))
    engine.swarm.broadcast_costmap()
    return ok({"injected": ev, "active": engine.harness.active, "simulation": True,
               "production_model_untouched": True})


@app.delete("/api/harness")
def harness_clear():
    engine.harness.clear()
    engine.swarm.broadcast_costmap()
    return ok({"active": [], "simulation": False})


@app.get("/api/swarm/status")
def swarm_status():
    now = time.time()
    for pid in list(engine.swarm.peers):
        if engine.swarm.peers[pid].last_heartbeat > 0:
            engine.swarm.heartbeat(pid, now)  # local peers share this process
    return ok(engine.swarm.status(now))


@app.post("/api/swarm/failover")
def swarm_failover(req: S.FailoverRequest = S.FailoverRequest()):
    res = engine.swarm.failover(force_out=req.force_out)
    return ok({**res, "status": engine.swarm.status()})


# ------------------------------------------------------------------ export


@app.post("/api/export/geojson")
def export_geojson(req: S.ExportRequest):
    return ok(engine.export("geojson", req.route, req.name))


@app.post("/api/export/sasf")
def export_sasf(req: S.ExportRequest):
    return ok(engine.export("sasf", req.route, req.name))


@app.post("/api/export/csv")
def export_csv(req: S.ExportRequest):
    return ok(engine.export("csv", req.route, req.name))


# ------------------------------------------------------------------ operations helpers


@app.get("/api/voice/status")
def voice_status():
    return ok({"provider": "gemini" if engine.gemini_voice.enabled else "local",
               "audio": engine.gemini_voice.enabled})


@app.post("/api/voice/audio")
def voice_audio(req: S.VoiceAudioRequest):
    try:
        base64.b64decode(req.audio, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(422, "La grabación no es Base64 válido.") from None
    try:
        return ok(engine.voice("", req.interface, [p.model_dump() for p in req.points], req.language,
                               audio=req.audio, mime_type=req.mime_type))
    except GeminiVoiceError as exc:
        return JSONResponse({"error": "voice_provider_unavailable", "provider_reason": exc.reason,
                             "detail": "Gemini no pudo interpretar la grabación."}, status_code=503)


@app.post("/api/voice/command")
def voice_command(req: S.VoiceRequest):
    return ok(engine.voice(req.text, req.interface, [p.model_dump() for p in req.points], req.language,
                           prefer_local=req.prefer_local))


@app.post("/api/fsm/evaluate")
def fsm_evaluate(s: S.TelemetrySnapshot):
    state = engine.fsm.evaluate(s.model_dump())
    return ok({**engine.fsm.to_dict(), "state": state})


@app.post("/api/localization")
def localization(req: S.LocalizationRequest):
    st = req.state
    loc = Localizer(st["lat"], st["lon"], st.get("heading_deg", 0.0), st.get("sigma_along_m", 5.0),
                    st.get("sigma_cross_m", 5.0), odometer_m=st.get("odometer_m", 0.0))
    if req.step:
        loc.advance(req.step.get("distance_m", 0.0), req.step.get("heading_deg", loc.heading_deg), req.step.get("slip", 0.0))
    if req.fix:
        loc.absolute_fix(req.fix["lat"], req.fix["lon"], req.fix.get("sigma_m"))
    return ok({"state": {"lat": loc.lat, "lon": loc.lon, "heading_deg": loc.heading_deg, "sigma_along_m": loc.sigma_along_m,
                         "sigma_cross_m": loc.sigma_cross_m, "odometer_m": loc.odometer_m}, "ellipse": loc.ellipse(),
               "last_fix": loc.last_fix})


@app.post("/api/autopilot/command")
def autopilot(req: S.AutopilotRequest):
    return ok(PurePursuit().command(req.lat, req.lon, req.heading_deg, req.path, req.slope_deg, req.roll_deg,
                                    req.link_ok, req.emergency))


@app.get("/api/rover/traction")
def rover_traction(slope_deg: float = 0.0, roll_deg: float = 0.0):
    r = tm.Rover()
    slip = tm.equilibrium_slip(r, max(0.0, min(35.0, slope_deg)))
    dp = tm.drawbar_pull(r, slope_deg, max(slip, 0.05))
    return ok({"slip": slip, "state": tm.traction_state(slip), "tipover_risk": tm.tipover_risk(r, roll_deg),
               "static_tipover_deg": tm.static_tipover_angle_deg(r), "sinkage_m": dp["sinkage_m"],
               "drawbar_pull_n": dp["drawbar_pull_n"], "model": "Bekker-Wong + Janosi-Hanamoto (suelo nominal)"})


@app.post("/api/eva/vitals")
def eva_vitals(req: S.EvaVitalsRequest):
    power = met.metabolic_power_w(req.gradient, req.speed_mps, 160.0) if req.speed_mps > 0 else 150.0
    hr = met.heart_rate_from_power(power)
    rates = met.plss_rates(power)
    cons = met.SuitConsumables(o2_kg=req.o2_kg, water_kg=req.water_kg, battery_wh=req.battery_wh)
    left = cons.hours_left(rates)
    fatigue = met.glove_fatigue(req.grip_fraction, req.grip_minutes)
    stamina = met.stamina_model(hr, power, fatigue)
    wb = met.walkback_envelope_m(cons, policy_limit_m=req.walkback_limit_m)
    alerts = []
    if left["o2"] * 60 < 30:
        alerts.append({"level": "critical", "code": "O2_LOW", "text": f"O₂ para {left['o2'] * 60:.0f} min"})
    nominal = met.SuitConsumables()
    for code, label, remaining, capacity in (
            ("O2_RESERVE", "Oxígeno", req.o2_kg, nominal.o2_kg),
            ("WATER_RESERVE", "Agua", req.water_kg, nominal.water_kg),
            ("BATTERY_RESERVE", "Batería", req.battery_wh, nominal.battery_wh)):
        fraction = remaining / capacity
        if fraction <= 0.25:
            alerts.append({"level": "critical" if fraction <= 0.1 else "warning", "code": code,
                           "text": f"{label} al {fraction:.0%}: dentro de la reserva del traje."})
    if req.distance_to_base_m > wb["walkback_m"]:
        alerts.append({"level": "critical", "code": "WALKBACK", "text": "Fuera del radio de retorno a pie"})
    elif req.distance_to_base_m > 0.8 * wb["walkback_m"]:
        alerts.append({"level": "warning", "code": "WALKBACK_NEAR", "text": "Cerca del límite de retorno"})
    if stamina["stamina"] < 35:
        alerts.append({"level": "warning", "code": "STAMINA", "text": "Estamina baja: reduzca el ritmo"})
    if hr > 160:
        alerts.append({"level": "warning", "code": "HR", "text": f"FC {hr:.0f} bpm"})
    if fatigue > 0.7:
        alerts.append({"level": "warning", "code": "GLOVE", "text": "Fatiga de guantes"})
    order = {"critical": 0, "warning": 1, "info": 2}
    alerts.sort(key=lambda a: order[a["level"]])
    return ok({"metabolic_w": power, "heart_rate_bpm": hr, "rates": rates.__dict__, "hours_left": left,
               "stamina": stamina, "walkback": wb, "glove_fatigue": fatigue, "alerts": alerts,
               "model": "Minetti 2002 (g Marte, traje) + PLSS + Rohmert"})


@app.post("/api/eva/surface-route")
def eva_surface_route(req: S.EvaSurfaceRoute):
    from khipu import navigation
    from khipu.geodesy import TangentPlane, haversine_m
    from khipu.resources import route_metrics

    asset = engine.find_entity(req.asset_id)
    if not asset or asset.get("kind") != "astronaut":
        raise HTTPException(422, "El activo debe ser un astronauta")
    base = next((a for a in engine.scenario["assets"] if a["kind"] == "base"), None)
    points = [p.model_dump() for p in req.points]
    walk_limit = engine.eva_walkback_limit()
    if base is None or any(haversine_m(base["lat"], base["lon"], p["lat"], p["lon"]) > walk_limit for p in points):
        raise RouteInfeasible("walkback_exceeded", "La ruta excede el radio de retorno a pie")
    training = engine.scenario.get("eva_policy", {})
    lava = training.get("lava_tubes")
    if lava:
        projection = TangentPlane(base["lat"], base["lon"])
        center = (lava["x"] + 65, -lava["z"] - 60)
        vertices = [projection.to_xy(p["lat"], p["lon"]) for p in points]
        for (ax, ay), (bx, by) in zip(vertices, vertices[1:]):
            dx, dy = bx - ax, by - ay
            length_sq = dx * dx + dy * dy
            fraction = max(0, min(1, ((center[0] - ax) * dx + (center[1] - ay) * dy) / length_sq)) if length_sq else 0
            if math.hypot(ax + fraction * dx - center[0], ay + fraction * dy - center[1]) <= lava["radius_m"]:
                navigation.forbid([navigation.issue("hazard", "El sendero cruza los tubos de lava.")])
    surface_slope = training.get("local_max_slope_deg", 24)
    params = {"max_distance_m": walk_limit, "max_slope_deg": surface_slope, "ltst_h": req.ltst_h,
              "eva_return_distance_m": walk_limit}
    terrain, costmap, link = engine.operational_costmap(engine.default_region(), "astronaut", params, asset=asset)
    navigation.check_endpoints(terrain, costmap, [((points[0]["lat"], points[0]["lon"]), "origen"),
                                                  ((points[-1]["lat"], points[-1]["lon"]), "destino")])
    navigation.check_surface_geometry(terrain, costmap, points)
    if route_metrics(points, "astronaut")["max_grade_deg"] > surface_slope + 0.01:
        navigation.forbid([navigation.issue("slope", "El sendero de entrenamiento cruza una pendiente no transitable.")])
    telemetry = {key: value for key, value in {"o2_kg": req.available_o2_kg, "water_kg": req.available_water_kg,
                                                "battery_wh": req.available_battery_wh}.items() if value is not None}
    points, metrics, pnr, issues = engine.evaluate_corridor(
        terrain, points, "astronaut", params, asset, link, 1.4, telemetry,
        manager=engine.manager(engine.default_region()), costmap=costmap, region=engine.default_region())
    if issues:
        navigation.forbid(issues)
    return ok({"points": points, "metrics": metrics, "pnr": pnr,
               "provenance": "synthetic", "terrain_model": "MOLA regional + relieve local de entrenamiento"})


@app.post("/api/eva/resupply")
def eva_resupply(req: S.EvaResupplyRequest):
    from khipu.geodesy import haversine_m

    asset = engine.find_entity(req.asset_id)
    if not asset or asset.get("kind") != "astronaut":
        raise HTTPException(422, "El activo debe ser un astronauta")
    base = next((a for a in engine.scenario["assets"] if a["kind"] == "base"), None)
    if base is None or haversine_m(base["lat"], base["lon"], req.lat, req.lon) > 30:
        raise HTTPException(422, "La recarga requiere regresar al hábitat")
    ledger = engine.ledger(req.asset_id, "astronaut")
    ledger.history.append({"event": "habitat_resupply", "previous_consumed": ledger.consumed, "remaining": ledger.capacity})
    ledger.consumed = 0
    return ok({"ledger": ledger.to_dict(), "o2_kg": ledger.capacity, "water_kg": EVA_DEMO_WATER_CAPACITY_KG, "battery_wh": 1100})


@app.get("/api/ledger/{asset_id}")
def ledger_get(asset_id: str, profile: S.Profile = "rover"):
    return ok(engine.ledger(asset_id, profile).to_dict())


@app.post("/api/ledger/{asset_id}/consume")
def ledger_consume(asset_id: str, req: S.LedgerConsume):
    lg = engine.ledger(asset_id, req.profile)
    lg.consume(req.amount, req.note)
    return ok(lg.to_dict())

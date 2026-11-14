"""Route exporters: GeoJSON, SASF-style activity sequence and CSV telemetry."""
from __future__ import annotations

import csv
import io
import math
from datetime import datetime, timedelta, timezone

from .geodesy import bearing_deg, haversine_m


def to_geojson(route: dict, name: str = "route", properties: dict | None = None) -> dict:
    pts = route.get("points", [])
    coords = [[round(p["lon"], 7), round(p["lat"], 7), round(p.get("elevation_m") or 0.0, 2)] for p in pts]
    features = [{
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {"name": name, "vertex_count": len(coords), "crs": "IAU2000:49900 planetocentric east",
                       "elevation_reference": "MOLA areoid (m)", **(properties or {})},
    }]
    for i, p in enumerate(route.get("waypoints", [])):
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
                         "properties": {"role": "waypoint", "index": i, "name": p.get("name")}})
    return {"type": "FeatureCollection", "name": name, "features": features}


def to_sasf(route: dict, sequence_id: str = "QN_TRAV_001", asset: str = "ROVER", speed_mps: float = 0.12,
            start: datetime | None = None, decimate_m: float = 400.0) -> str:
    """Spacecraft Activity Sequence File (SASF-like text) with DRIVE steps.

    The format mirrors the SASF header/request/step structure; it is a
    planning artefact, not a command load validated by JPL ground software."""
    start = start or datetime.now(timezone.utc)
    pts = route.get("points", [])
    keep = [pts[0]] if pts else []
    for p in pts[1:]:
        if haversine_m(keep[-1]["lat"], keep[-1]["lon"], p["lat"], p["lon"]) >= decimate_m:
            keep.append(p)
    if pts and keep[-1] is not pts[-1]:
        keep.append(pts[-1])
    lines = [
        "CCSD3ZF0000100000001NJPL3KS0L015$$MARK$$;",
        "MISSION_NAME = QHAPAQ_NAN;",
        f"SPACECRAFT_NAME = {asset};",
        "DATA_SET_ID = SPACECRAFT_ACTIVITY_SEQUENCE;",
        f"FILE_NAME = {sequence_id}.sasf;",
        f"APPLICABLE_START_TIME = {start.strftime('%Y-%jT%H:%M:%S')};",
        "PRODUCER_ID = KHIPU_PLANNER;",
        "CCSD3RE00000$$MARK$$NJPL3IF0M01300000001;",
        "$$EOH",
        "request(" + sequence_id + ",",
        f"    START_TIME, {start.strftime('%Y-%jT%H:%M:%S')},",
        "    REQUESTOR, \"KHIPU\",",
        "    PROCESSOR, \"VC2\",",
        "    KEY, \"No_Key\")",
    ]
    t = 0.0
    for i, (a, b) in enumerate(zip(keep[:-1], keep[1:]), start=1):
        d = haversine_m(a["lat"], a["lon"], b["lat"], b["lon"])
        hdg = bearing_deg(a["lat"], a["lon"], b["lat"], b["lon"])
        dur = d / speed_mps
        lines += [
            f"    command({i},",
            f"        SCHEDULED_TIME, \\{_fmt_dur(t)}\\, FROM_REQUEST_START,",
            f"        DRIVE_ARC_TO(\"{b['lat']:.6f}\", \"{b['lon']:.6f}\", {d:.1f}, {hdg:.1f}, {b.get('elevation_m', 0):.1f})",
            "    ),",
        ]
        t += dur
    lines += ["end;", "$$EOF"]
    return "\n".join(lines) + "\n"


def _fmt_dur(seconds: float) -> str:
    td = timedelta(seconds=int(seconds))
    h, rem = divmod(td.seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{td.days:03d}T{h:02d}:{m:02d}:{s:02d}"


def to_csv(route: dict, speed_mps: float = 0.12) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["index", "lat_deg", "lon_deg", "elevation_m", "distance_m", "elapsed_s", "grade_deg", "tier",
                "pnr_state"])
    seg_state = {s["to"]: s["state"] for s in (route.get("pnr") or {}).get("segments", [])}
    for i, p in enumerate(route.get("points", [])):
        w.writerow([i, f"{p['lat']:.7f}", f"{p['lon']:.7f}", f"{p.get('elevation_m', 0):.2f}",
                    f"{p.get('distance_m', 0):.1f}", f"{p.get('distance_m', 0) / speed_mps:.0f}",
                    f"{p.get('grade_deg', 0):.2f}", p.get("tier", ""), seg_state.get(i, "safe" if i else "")])
    return buf.getvalue()

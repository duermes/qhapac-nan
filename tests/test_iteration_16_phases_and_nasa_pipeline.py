"""REF-083..089."""
import io
import json

import numpy as np
import pytest

from conftest import ROVER, BASE, DELTA, needs_mola
from khipu import exporters
from khipu_data.nasa_client import NasaClient
from khipu_data.pds3 import PDS3Error, extract_subgrid, open_mola, parse_label
from khipu_data.regions import MOLA_LABEL

LABEL = """PDS_VERSION_ID = PDS3
^IMAGE = "T.IMG"
PRODUCT_ID = "T.IMG"
DESCRIPTION = "multi
 line"
OBJECT = IMAGE
 LINES = 4
 LINE_SAMPLES = 6
 SAMPLE_TYPE = MSB_INTEGER
 SAMPLE_BITS = 16
 UNIT = METER
END_OBJECT = IMAGE
OBJECT = IMAGE_MAP_PROJECTION
 A_AXIS_RADIUS = 3396.0 <KM>
 MAP_RESOLUTION = 2.0 <PIXEL/DEGREE>
 MAXIMUM_LATITUDE = 2.0 <DEGREE>
 MINIMUM_LATITUDE = 0.0 <DEGREE>
 WESTERNMOST_LONGITUDE = 10.0 <DEGREE>
 EASTERNMOST_LONGITUDE = 13.0 <DEGREE>
END_OBJECT = IMAGE_MAP_PROJECTION
END
"""


def make_product(tmp_path, data=None):
    (tmp_path / "t.lbl").write_text(LABEL)
    arr = np.arange(24, dtype=">i2").reshape(4, 6) if data is None else data
    (tmp_path / "t.img").write_bytes(arr.tobytes())
    return tmp_path / "t.lbl"


def test_parse_pds3_mola_label(tmp_path):
    lab = parse_label(LABEL)
    assert lab["IMAGE"]["LINES"] == 4 and lab["IMAGE_MAP_PROJECTION"]["A_AXIS_RADIUS"] == {"value": 3396.0, "unit": "KM"}
    assert "multi" in lab["DESCRIPTION"]
    if MOLA_LABEL.exists():
        p = open_mola(MOLA_LABEL)
        assert p.lines == 5632 and p.samples == 11520 and p.dtype.str == ">i2" and p.ppd == 128


def test_mola_subgrid_extraction_and_nodata(tmp_path):
    p = open_mola(make_product(tmp_path))
    sub = extract_subgrid(p, 0.5, 1.5, 11.0, 12.0, nodata_values=(9,))
    assert sub["rows"] == 2 and sub["cols"] == 2 and not sub["empty"]
    assert np.isnan(sub["data"]).sum() == 1  # value 9 marked no-data
    out = extract_subgrid(p, 30, 40, 50, 60)
    assert out["empty"] and out["data"].size == 0
    (tmp_path / "t.img").write_bytes(b"\x00" * 10)
    with pytest.raises(PDS3Error):
        open_mola(tmp_path / "t.lbl")  # size mismatch rejected


def test_nasa_data_client_weather(tmp_path, monkeypatch):
    payload = {"sol_keys": ["675"], "675": {"AT": {"av": -62.3, "mn": -96, "mx": -15}, "PRE": {"av": 750.6}, "Season": "fall"}}

    class R(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setenv("QN_OFFLINE", "0")
    live = NasaClient(cache_dir=tmp_path, opener=lambda url, timeout: R(json.dumps(payload).encode())).fetch("weather")
    assert live["status"] == "live" and live["summary"]["temp_avg_c"] == -62.3 and "api_key" not in live["source"]

    def boom(url, timeout):
        raise TimeoutError("down")
    cached = NasaClient(cache_dir=tmp_path, opener=boom).fetch("weather")
    assert cached["status"] == "cached" and cached["error"]
    none = NasaClient(cache_dir=tmp_path / "x", opener=boom).fetch("weather")
    assert none["status"] == "fallback" and none["data"] is None


@needs_mola
def test_dynamic_continuous_replan_nominal(client):
    plan = client.post("/api/route", json={"origin": ROVER, "destination": DELTA, "variants": False}).json()
    r = client.post("/api/route/dynamic_replan", json={"current": ROVER, "destination": DELTA, "route_points": plan["variants"][0]["points"],
                                                       "obstacles": [{"lat": 17.0, "lon": 75.0, "radius_m": 300}]}).json()
    assert r["status"] == "nominal" and r["replanned"] is False


@needs_mola
def test_dynamic_continuous_replan_compromised_evasion(client):
    plan = client.post("/api/route", json={"origin": ROVER, "destination": DELTA, "variants": False}).json()
    pts = plan["variants"][0]["points"]
    mid = pts[len(pts) // 2]
    r = client.post("/api/route/dynamic_replan", json={"current": ROVER, "destination": DELTA, "route_points": pts,
                                                       "obstacles": [{"lat": mid["lat"], "lon": mid["lon"], "radius_m": 600}]}).json()
    assert r["status"] == "compromised" and r["evasion_ok"]


def test_astronautic_route_exporter_formats():
    route = {"points": [{"lat": 18.44 + i * 0.004, "lon": 77.45, "elevation_m": -2500.0, "distance_m": i * 237.0, "tier": 0} for i in range(8)],
             "pnr": {"segments": [{"from": i, "to": i + 1, "state": "safe"} for i in range(7)]}}
    gj = exporters.to_geojson(route)
    sasf = exporters.to_sasf(route, decimate_m=400)
    csv = exporters.to_csv(route)
    assert gj["features"][0]["geometry"]["type"] == "LineString"
    assert sasf.startswith("CCSD3ZF") and "$$EOH" in sasf and sasf.strip().endswith("$$EOF") and "DRIVE_ARC_TO" in sasf
    assert csv.splitlines()[0].startswith("index,lat_deg") and len(csv.splitlines()) == 9


@needs_mola
def test_api_endpoints_phases_1_2_3(client):
    assert client.get("/api/nasa/weather").status_code == 200
    assert client.get("/api/nasa/apod").status_code == 200
    r = client.post("/api/ingest/extract_mola", json={"key": "test_custom", "name": "T", "lat_min": 19, "lat_max": 19.5, "lon_min": 76, "lon_max": 76.5})
    assert r.status_code == 200 and r.json()["manifest"]["geometry"]["rows"] == 64
    bad = client.post("/api/ingest/extract_mola", json={"key": "syrtis_jezero_nili", "name": "x", "lat_min": 19, "lat_max": 20, "lon_min": 76, "lon_max": 77})
    assert bad.status_code == 409  # never overwrites the base derived region
    import shutil
    from khipu_data.regions import PROCESSED
    shutil.rmtree(PROCESSED / "test_custom", ignore_errors=True)

"""REF-012..014 — domain model and inspection."""
import numpy as np
import pytest

from conftest import BASE, needs_mola
from khipu.domain import (Asset, GeoPoint, GeoRegion, MobileAsset, Provenance, RealtimeField, Snapshot, StaticAsset,
                          StaticField, TimeSeries, make_asset)
from khipu.geodesy import GridGeometry


def test_domain_poo_instantiation():
    rover = make_asset({"id": "R", "name": "Rover", "kind": "rover", "lat": 18.4, "lon": 77.4})
    base = make_asset({"id": "B", "name": "Base", "kind": "base", "lat": 18.4, "lon": 77.4})
    assert isinstance(rover, MobileAsset) and isinstance(rover, Asset) and rover.is_mobile
    assert isinstance(base, StaticAsset) and not base.is_mobile
    rover.move_to(18.41, 77.41)
    assert rover.position.lat == 18.41
    with pytest.raises(PermissionError):
        base.move_to(18.5, 77.5)
    g = GridGeometry(18.6, 77.3, 128, 10, 10)
    region = GeoRegion("r", "R", g, Provenance.DERIVED_FROM_NASA)
    assert region.to_dict()["geometry"]["rows"] == 10
    sf = StaticField("e", "Elev", "m", Provenance.OFFICIAL_NASA, data=np.zeros((2, 2)))
    rf = RealtimeField("t", "Temp", "K", Provenance.MODEL, evaluator=lambda p: np.full((2, 2), p["v"]))
    assert sf.value().shape == (2, 2) and rf.value({"v": 3})[0, 0] == 3 and rf.temporal
    ts = TimeSeries("bat", "%")
    ts.append(0, 100)
    ts.append(10, 90)
    assert ts.rate() == -1.0
    with pytest.raises(ValueError):
        ts.append(5, 80)
    snap = Snapshot("e", {}, np.array([[1.0, np.nan]]), "m", Provenance.OFFICIAL_NASA)
    assert snap.stats()["coverage"] == 0.5
    assert GeoPoint(18.0, 77.0).distance_to(GeoPoint(18.0, 77.01)) > 0


def test_api_assets_and_persistence(client):
    a = {"id": "WP_TEST_1", "name": "Waypoint prueba", "kind": "waypoint", "lat": 18.45, "lon": 77.44, "session_id": "S9"}
    r = client.post("/api/assets", json=a)
    assert r.status_code == 200 and r.json()["elevation_m"] is not None
    lst = client.get("/api/assets", params={"session_id": "S9"}).json()
    assert any(x["id"] == "WP_TEST_1" for x in lst["session"])
    assert lst["scenario"] and all(x["provenance"] == "synthetic" for x in lst["scenario"])
    assert client.post("/api/assets/save_to_general", json={"session_id": "S9"}).json()["moved"] == 1
    lst = client.get("/api/assets", params={"session_id": "S9"}).json()
    assert any(x["id"] == "WP_TEST_1" for x in lst["general"]) and not lst["session"]
    client.post("/api/assets", json={**a, "id": "WP_TEST_2"})
    assert client.post("/api/assets/clear_session", json={"session_id": "S9"}).json()["cleared"] == 1
    assert client.post("/api/assets", json={**a, "kind": "spaceship"}).status_code == 422
    assert client.delete("/api/assets/WP_TEST_1").json()["deleted"]


@needs_mola
def test_api_inspection_risk_factors(client):
    r = client.get("/api/inspection/risk_factors", params={"lat": BASE["lat"], "lon": BASE["lon"]})
    j = r.json()
    assert r.status_code == 200 and j["inside"]
    ids = {f["id"] for f in j["factors"]}
    assert {"slope", "roughness", "slip", "illumination", "telecom"} <= ids
    assert all("source" in f for f in j["factors"])
    out = client.get("/api/inspection/risk_factors", params={"lat": 40.0, "lon": 10.0}).json()
    assert out["inside"] is False and out["factors"] == []
    hz = client.get("/api/inspection/risk_factors", params={"lat": 18.53, "lon": 77.42}).json()
    assert hz["forbidden"] and any(f["id"].startswith("zone:") for f in hz["factors"])

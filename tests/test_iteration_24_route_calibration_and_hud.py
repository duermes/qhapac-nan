"""REF-126..128."""
from conftest import BASE, DELTA, needs_mola, read


@needs_mola
def test_api_route_enforces_walkback_limit(client):
    near = client.post("/api/route", json={"origin": BASE, "destination": {"lat": 18.452, "lon": 77.462}, "asset_id": "EVA_01"})
    far = client.post("/api/route", json={"origin": BASE, "destination": DELTA, "asset_id": "EVA_01"})
    assert near.status_code == 200 and near.json()["walkback_limit_m"] == 2000
    assert far.status_code == 422 and far.json()["reason"] == "walkback_exceeded"
    tight = client.post("/api/route", json={"origin": BASE, "destination": {"lat": 18.452, "lon": 77.462}, "asset_id": "EVA_01", "params": {"walkback_limit_m": 1000}})
    assert tight.status_code == 422  # ~1.4 km exceeds a 1 km policy


def test_route_layer_solid_color_segmentation():
    m2 = read("shared/js/map2d.js")
    assert "solid colour segmentation by PNR state" in m2 and 'no_return: "#e0534a"' in m2


@needs_mola
def test_planner_bridge_multicriteria_calibration(client):
    j = client.post("/api/route", json={"origin": BASE, "destination": {"lat": 17.89, "lon": 77.16}, "profile": "rover"}).json()
    v = {x["variant"]: x for x in j["variants"]}
    assert v["safe"]["metrics"]["high_risk_fraction"] <= v["fast"]["metrics"]["high_risk_fraction"]
    assert j["recommended"] == "balanced"

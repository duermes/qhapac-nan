"""REF-126..128."""
from conftest import ROVER, EVA, BASE, DELTA, needs_mola, read


@needs_mola
def test_api_route_enforces_walkback_limit(client):
    near = client.post("/api/route", json={"origin": EVA, "destination": {"lat": 18.470, "lon": 77.462}, "asset_id": "EVA_01"})
    far = client.post("/api/route", json={"origin": EVA, "destination": {"lat": 18.46, "lon": 77.29}, "asset_id": "EVA_01"})
    assert near.status_code == 200 and near.json()["walkback_limit_m"] == 8000
    assert far.status_code == 422 and far.json()["reason"] == "walkback_exceeded"
    tight = client.post("/api/route", json={"origin": EVA, "destination": {"lat": 18.470, "lon": 77.462}, "asset_id": "EVA_01", "params": {"walkback_limit_m": 1000}})
    assert tight.status_code == 422  # ~1.4 km exceeds a 1 km policy


def test_route_layer_solid_color_segmentation():
    m2 = read("shared/js/map2d.js")
    assert "solid colour segmentation by PNR state" in m2 and 'no_return: "#ff8c36"' in m2


@needs_mola
def test_planner_bridge_multicriteria_calibration(client):
    j = client.post("/api/route", json={"origin": ROVER, "destination": {"lat": 18.455, "lon": 77.46},
                                        "variants": True}).json()
    assert len(j["variants"]) == 1
    variant = j["variants"][0]
    assert variant["metrics"]["distance_m"] >= j["direct"]["distance_m"]
    assert variant["variant"] == j["recommended"]

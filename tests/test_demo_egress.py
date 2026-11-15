from conftest import BASE, ROVER, needs_mola
from khipu.geodesy import TangentPlane


@needs_mola
def test_chaski_egress_allows_an_initial_overlap_and_rejects_an_unsafe_destination(client):
    zone = {"id": "TRAPPED", "name": "Área de prueba", "lat": ROVER["lat"], "lon": ROVER["lon"], "radius_m": 140}
    request = {"origin": ROVER, "destination": {"lat": 18.455, "lon": 77.46},
               "params": {"obstacles": [zone]}}
    regular = client.post("/api/route", json=request)
    assert regular.status_code == 422 and regular.json()["reason"] == "origen_hazard"

    live = client.post("/api/route", json={**request, "live_navigation": True})
    assert live.status_code == 200, live.json()
    route = live.json()
    assert route["emergency_exit"]["zones"] == [zone["name"]]
    assert route["variants"][0]["pnr"] is None

    unsafe = client.post("/api/route", json={**request, "destination": ROVER, "live_navigation": True})
    assert unsafe.status_code == 422 and unsafe.json()["reason"] == "destino_hazard"


@needs_mola
def test_eva_lava_tubes_block_a_segment_even_if_endpoints_are_outside(client, engine):
    lava = engine.scenario["eva_policy"]["lava_tubes"]
    plane = TangentPlane(BASE["lat"], BASE["lon"])
    points = []
    for offset in (-20, 20):
        lat, lon = plane.to_latlon(lava["x"] + 65 + offset, -lava["z"] - 60)
        points.append({"lat": lat, "lon": lon, "elevation_m": -2600})
    response = client.post("/api/eva/surface-route", json={"asset_id": "EVA_01", "points": points, "available_o2_kg": 1.2})
    assert response.status_code == 422
    assert "tubos de lava" in response.json()["detail"]

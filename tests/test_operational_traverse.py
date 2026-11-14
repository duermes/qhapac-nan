"""Regression coverage for the single-route, resource-limited planning contract."""
import pytest

from conftest import BASE, ROVER, needs_mola
from khipu.geodesy import haversine_m
from khipu.resources import assess_route, route_metrics


@needs_mola
def test_distance_only_has_exact_endpoints_even_inside_an_exclusion(client):
    target = {"lat": 18.530123, "lon": 77.421234}
    result = client.post("/api/route", json={"origin": BASE, "destination": target, "asset_id": ROVER["id"]}).json()
    assert result["static_origin"] and not result["variants"]
    assert result["direct"]["points"] == [{"lat": BASE["lat"], "lon": BASE["lon"]}, target]
    assert result["direct"]["distance_m"] == pytest.approx(haversine_m(BASE["lat"], BASE["lon"], *target.values()))


@needs_mola
def test_virtual_resources_are_used_and_deployed_assets_are_readonly(client):
    origin = {"id": "VIRTUAL_ROUTE_TEST", "lat": ROVER["lat"], "lon": ROVER["lon"]}
    destination = {"lat": 18.448, "lon": 77.48}
    session = "S_ROUTE_TEST"
    created = client.post("/api/assets", json={**origin, "kind": "rover", "name": "Rover virtual",
                                              "session_id": session, "resources": {"battery_wh": 1}})
    assert created.status_code == 200 and created.json()["virtual"]
    body = {"origin": origin, "destination": destination, "session_id": session}
    try:
        depleted = client.post("/api/route", json=body)
        assert depleted.status_code == 422 and depleted.json()["reason"] == "resources"
        patch = client.patch(f"/api/assets/{origin['id']}", json={"lat": 18.439, "resources": {"battery_wh": 50000}})
        assert patch.status_code == 200 and patch.json()["lat"] == 18.439
        body["origin"]["lat"] = 18.439
        route = client.post("/api/route", json=body).json()["variants"][0]
        assert route["pnr"]["available"] == 50000 and route["pnr"]["reserve"] == 15000
        assert client.patch("/api/assets/ROVER_PR1", json={"lat": 20}).status_code == 409
    finally:
        client.delete(f"/api/assets/{origin['id']}")


@needs_mola
def test_infeasibility_orders_endpoint_restrictions_and_reports_a_corridor_failure(client, engine):
    forbidden = {"lat": 18.53, "lon": 77.42}
    result = client.post("/api/route", json={"origin": ROVER, "destination": forbidden,
                                           "params": {"ltst_h": 0, "min_temperature_c": -50}})
    errors = result.json()["reasons"]
    assert result.status_code == 422 and "COSPAR" in errors[0]["detail"]
    assert {"hazard", "temperature", "darkness"} <= {e["code"] for e in errors}

    engine.harness.inject("comms_blackout")
    try:
        result = client.post("/api/route", json={"origin": ROVER, "destination": {"lat": 18.46, "lon": 77.49},
                                               "params": {"max_distance_m": 50, "min_link_db": 40, "max_blackout_s": 0}})
        assert result.status_code == 422
        assert {e["code"] for e in result.json()["reasons"]} >= {"distance", "blackout"}
    finally:
        engine.harness.clear()


def test_pnr_splits_one_path_at_the_limiting_resource_with_exact_along_path_distance():
    points = [{"lat": 18.44, "lon": 77.45, "elevation_m": -2500},
              {"lat": 18.441, "lon": 77.455, "elevation_m": -2480},
              {"lat": 18.444, "lon": 77.455, "elevation_m": -2455}]
    limits = {"o2_kg": 0.25, "water_kg": 0.25, "battery_wh": 0.25}
    forward = route_metrics(points, "astronaut")["resources"]["water_kg"]
    home = route_metrics(list(reversed(points)), "astronaut")["resources"]["water_kg"]
    water = 0.9 + forward + 0.5 * home
    path, split = assess_route(points, "astronaut", {"o2_kg": (1.2, 1.2), "battery_wh": (1100, 1100),
                                                    "water_kg": (water, 3.6)}, limits)
    assert split["status"] == "pnr_exceeded" and split["limiting_resource"] == "water_kg"
    idx = split["pnr_index"]
    assert 0 < idx < len(path) - 1
    assert split["segments"][idx - 1]["state"] == "safe" and split["segments"][idx]["state"] == "no_return"
    marker = split["pnr_point"]
    assert path[idx]["distance_m"] == marker["distance_m"]
    assert marker["distance_m"] > haversine_m(points[0]["lat"], points[0]["lon"], marker["lat"], marker["lon"])
    assert split["one_way_margin"] > 0 > split["round_trip_margin"]


@needs_mola
def test_non_temporal_model_control_changes_layer_and_temporal_controls_match_catalog(client):
    catalog = {d["id"]: d for d in client.get("/api/layers").json()["layers"]}
    assert catalog["dust"]["controls"] == ["tau"]
    assert catalog["shadow"]["controls"] == ["ltst_h"]
    assert catalog["elevation"]["inputs"] == ["Topografía MOLA"]
    a = client.get("/api/layers/insolation?ltst_h=13&helio_au=1.3&include_grid=false").json()
    b = client.get("/api/layers/insolation?ltst_h=13&helio_au=1.7&include_grid=false").json()
    assert a["stats"]["max"] > b["stats"]["max"]

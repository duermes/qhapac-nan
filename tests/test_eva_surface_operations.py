from conftest import BASE


def surface_route(**overrides):
    return {
        "asset_id": "EVA_01",
        "available_o2_kg": 1.2,
        "points": [
            {"lat": BASE["lat"], "lon": BASE["lon"], "elevation_m": -2600},
            {"lat": BASE["lat"] + 0.001, "lon": BASE["lon"], "elevation_m": -2598},
            {"lat": BASE["lat"] + 0.002, "lon": BASE["lon"], "elevation_m": -2596},
        ],
        **overrides,
    }


def test_surface_route_evaluates_local_elevations_and_resource_budget(client):
    response = client.post("/api/eva/surface-route", json=surface_route())
    assert response.status_code == 200
    route = response.json()
    assert route["provenance"] == "synthetic"
    assert route["metrics"]["ascent_m"] > 3.9
    assert route["metrics"]["resources"]["o2_kg"] > 0
    assert route["pnr"]["status"] == "round_trip_safe"
    low = client.post("/api/eva/surface-route", json=surface_route(available_o2_kg=0.01))
    assert low.status_code == 422 and low.json()["reason"] == "resources"


def test_surface_route_uses_lower_ledger_budget(client, engine):
    ledger = engine.ledger("EVA_01", "astronaut")
    consumed, history = ledger.consumed, list(ledger.history)
    try:
        ledger.consume(1.19)
        route = client.post("/api/eva/surface-route", json=surface_route())
        assert route.status_code == 422 and route.json()["reason"] == "resources"
    finally:
        ledger.consumed, ledger.history = consumed, history


def test_surface_route_rejects_remote_points_steep_grades_and_static_assets(client):
    remote = surface_route()
    remote["points"][-1]["lat"] += 1
    assert client.post("/api/eva/surface-route", json=remote).status_code == 422
    steep = surface_route()
    steep["points"][-1]["elevation_m"] = -2000
    assert client.post("/api/eva/surface-route", json=steep).status_code == 422
    assert client.post("/api/eva/surface-route", json=surface_route(asset_id="BASE_ALFA")).status_code == 422


def test_resupply_requires_habitat_proximity(client, engine):
    ledger = engine.ledger("EVA_01", "astronaut")
    consumed, history = ledger.consumed, list(ledger.history)
    try:
        ledger.consume(0.2)
        far = client.post("/api/eva/resupply", json={"asset_id": "EVA_01", "lat": 19, "lon": 77})
        assert far.status_code == 422
        assert ledger.consumed == consumed + 0.2
        nearby = client.post("/api/eva/resupply", json={"asset_id": "EVA_01", "lat": BASE["lat"], "lon": BASE["lon"]})
        assert nearby.status_code == 200
        assert nearby.json()["ledger"]["consumed"] == 0
        assert nearby.json()["ledger"]["history"][-1]["event"] == "habitat_resupply"
    finally:
        ledger.consumed, ledger.history = consumed, history


def test_resupply_rejects_static_asset(client):
    assert client.post("/api/eva/resupply", json={"asset_id": "BASE_ALFA", "lat": BASE["lat"], "lon": BASE["lon"]}).status_code == 422

from khipu.pnr import search_pnr
from khipu.router import RouteInfeasible


def test_no_pnr_requires_complete_declared_coverage():
    result = search_pnr(1000, lambda s: {"viable": True}, tolerance=25)
    assert result["analysis_status"] == "NO_PNR_VERIFIED"
    assert result["classification"] == "NO_PNR"
    assert result["distance_m"] is None
    assert result["verified_until_m"] == 1000
    assert not result["monotonicity_assumed"]


def test_nonmonotone_island_precedes_later_persistent_failure():
    def evaluator(s):
        return {"viable": not (200 <= s <= 240 or s >= 800)}
    result = search_pnr(1000, evaluator, tolerance=10, max_queries=256)
    assert result["classification"] == "PNR_FOUND"
    assert 200 <= result["distance_m"] <= 210


def test_insufficient_work_cannot_assert_no_pnr():
    result = search_pnr(100000, lambda s: {"viable": True}, tolerance=10, max_queries=8)
    assert result["classification"] == "INDETERMINATE"
    assert result["distance_m"] is None
    assert result["evaluations"] == 8
    assert result["verified_until_m"] < 100000


def test_certified_intervals_skip_costly_queries():
    result = search_pnr(100000, lambda s: {"viable": True}, tolerance=1,
                        certify=lambda a, b: True)
    assert result["analysis_status"] == "NO_PNR_VERIFIED"
    assert result["evaluations"] == 1


def test_a_failed_departure_return_has_a_real_zero_boundary():
    result = search_pnr(100, lambda s: {"viable": False})
    assert result["classification"] == "PNR_FOUND"
    assert result["distance_m"] == 0


def test_rejected_outbound_route_never_exports_a_pnr():
    result = RouteInfeasible("hazard", "Forbidden destination").to_dict()
    assert result["classification"] == "INVALID_ROUTE"
    assert result["pnr"] is None


def test_search_budget_failure_is_not_a_proof_of_invalid_route():
    result = RouteInfeasible("search_budget", "Work budget", classification="INDETERMINATE").to_dict()
    assert result["classification"] == "INDETERMINATE"
    assert result["pnr"] is None



def test_eva_demo_has_a_stable_return_boundary_on_mola(client, monkeypatch, tmp_path):
    from conftest import EVA, HAS_MOLA
    from khipu.geodesy import TangentPlane
    import pytest

    if not HAS_MOLA:
        pytest.skip("MOLA derived region missing")
    from api.engine import Engine
    monkeypatch.setattr("api.app.engine", Engine(tmp_path))
    projection = TangentPlane(EVA["lat"], EVA["lon"])
    checks = []
    for length in (2000, 5000, 7500):
        lat, lon = projection.to_latlon(length, 0)
        response = client.post("/api/route", json={"origin": EVA, "destination": {"lat": lat, "lon": lon}})
        assert response.status_code == 200, response.json()
        result = response.json()
        assert result["slope_limit_deg"] == 20
        checks.append(result["variants"][0]["pnr"])

    short, medium, long = checks
    assert short["classification"] == "NO_PNR" and not short["show_pnr"]
    boundaries = [result["pnr_point"]["distance_m"] for result in (medium, long)]
    assert all(3000 <= distance <= 4200 for distance in boundaries)
    assert abs(boundaries[0] - boundaries[1]) <= 100
    for result in (medium, long):
        index = result["pnr_index"]
        assert index > 0
        assert all(s["state"] == "safe" for s in result["segments"][:index])
        assert all(s["state"] == "no_return" for s in result["segments"][index:])



def test_eva_return_range_applies_with_full_consumables():
    from khipu.geodesy import TangentPlane
    from khipu.navigation import check_retreat
    from khipu.resources import assess_route, segment_cost

    class ClearForecast:
        profile = "astronaut"
        speed = 0.9
        params = {}

        @staticmethod
        def violations(points, start_s):
            return []

    projection = TangentPlane(0, 0)
    end_lat, end_lon = projection.to_latlon(6000, 0)
    points = [
        {"lat": 0, "lon": 0, "elevation_m": 0, "distance_m": 0},
        {"lat": end_lat, "lon": end_lon, "elevation_m": 0, "distance_m": 6000},
    ]
    inventory = {"o2_kg": (1.2, 1.2), "water_kg": (3.6, 3.6), "battery_wh": (1100, 1100)}
    reserve = dict.fromkeys(inventory, 0.25)
    marked, pnr = assess_route(points, "astronaut", inventory, reserve, 0.9)
    assert not pnr["show_pnr"]
    marked, pnr = check_retreat(marked, pnr, ClearForecast(), inventory, reserve, return_distance_limit=8000)
    assert pnr["pnr_point"]["distance_m"] == 4000
    assert pnr["return_reasons"][0]["code"] == "distance"
    assert [segment["state"] for segment in pnr["segments"]] == ["safe", "no_return"]
    assert marked[pnr["pnr_index"]]["distance_m"] == 4000
    assert set(pnr["consumables_at_pnr"]) == set(inventory)
    for key, values in pnr["consumables_at_pnr"].items():
        assert 25 < values["percent"] < 100
        assert values["percent"] == 100 * values["amount"] / inventory[key][1]
        assert abs(values["amount"] - (inventory[key][0] - segment_cost("astronaut", 4000, 0, 0.9)[key])) < 1e-8

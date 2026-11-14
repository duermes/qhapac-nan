"""REF-001..007 — API basics and console static files."""
from conftest import ROVER, BASE, DELTA, WEB, needs_mola


def test_api_health_endpoint(client):
    j = client.get("/api/health").json()
    assert j["status"] == "ok" and "data" in j and "offline_mode" in j


@needs_mola
def test_api_terrain_jezero_metadata(client):
    j = client.get("/api/terrain/jezero").json()
    assert j["available"] and j["data_region"] == "syrtis_jezero_nili"
    assert j["manifest"]["key"] == "jezero" and j["manifest"]["parent"] == "syrtis_jezero_nili"
    assert -4500 < j["elevation_stats"]["min"] < j["elevation_stats"]["max"] < 2000
    empty = client.get("/api/terrain/atlantis").json()
    assert empty["available"] is False and empty["elevation"] is None  # no invented elevations


@needs_mola
def test_api_costmap_calculation(client):
    j = client.post("/api/costmap", json={"profile": "rover", "include_grid": True, "stride": 8}).json()
    s = j["summary"]
    assert abs(s["free_fraction"] + s["caution_fraction"] + s["high_fraction"] + s["forbidden_fraction"] - 1) < 1e-6
    assert s["slope_limit_deg"] == 20 and j["cost"]["encoding"] == "uint8" and j["tiers"]["max"] == 3


@needs_mola
def test_api_route_planning_three_variants(client):
    j = client.post("/api/route", json={"origin": ROVER, "destination": DELTA, "asset_id": "ROVER_PR1"}).json()
    assert [v["variant"] for v in j["variants"]] == ["balanced"]
    for v in j["variants"]:
        assert v["points"] and v["metrics"]["distance_m"] > 0 and v["pnr"]


def test_api_harness_fault_injection(client):
    r = client.post("/api/harness/inject", json={"kind": "dust_storm"}).json()
    assert r["simulation"] and r["production_model_untouched"] and r["injected"]["id"].startswith("INJ-")
    assert client.post("/api/harness/inject", json={"kind": "meteor"}).status_code == 422
    assert client.delete("/api/harness").json()["active"] == []


def test_api_swarm_status(client):
    j = client.get("/api/swarm/status").json()
    assert j["leader"] and len(j["peers"]) >= 3 and all("health" in p for p in j["peers"])


def test_static_console_files_exist():
    for f in ("console/index.html", "console/css/console.css", "console/js/app.js", "console/js/planning.js",
              "console/js/decks.js", "console/js/menus.js", "console/js/popover.js", "console/js/traverses.js",
              "shared/css/qn.css", "shared/js/map2d.js", "shared/js/map3d.js", "vendor/three/three.module.js"):
        assert (WEB / f).exists(), f

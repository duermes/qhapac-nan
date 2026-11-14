"""REF-063..074."""
import numpy as np

from api.schemas import RouteRequest
from conftest import BASE, DELTA, needs_mola, read
from khipu.resources import evaluate_pnr


def straight(n=50, step_lat=0.002, rise=0.0):
    return [{"lat": 18.44 + i * step_lat, "lon": 77.45, "elevation_m": -2500 + i * rise} for i in range(n)]


def test_pnr_rover_battery_full_vs_exhaustion():
    pts = straight(60)
    full = evaluate_pnr(pts, "rover", available=60000, capacity=60000)
    low = evaluate_pnr(pts, "rover", available=5500, capacity=20000)  # 1500 Wh above reserve, round trip needs ~2750
    assert full["status"] == "round_trip_safe" and not full["show_pnr"]
    assert low["status"] == "pnr_exceeded" and 0 < low["pnr_index"] < len(pts) - 1


def test_pnr_astronaut_eva_oxygen_reserve_thresholds():
    pts = straight(10, 0.0002)
    ok = evaluate_pnr(pts, "astronaut", available=1.2, capacity=1.2)
    assert ok["reserve"] == 1.2 * 0.25 and ok["status"] == "round_trip_safe"
    low = evaluate_pnr(pts, "astronaut", available=0.29, capacity=1.2)
    assert low["status"] == "infeasible"  # already inside the reserve


@needs_mola
def test_multi_route_variants_incorporate_pnr_metadata(client):
    j = client.post("/api/route", json={"origin": BASE, "destination": DELTA, "asset_id": "ROVER_RS3"}).json()
    for v in j["variants"]:
        for k in ("status", "pnr_index", "segments", "outbound_total", "return_total", "asymmetry"):
            assert k in v["pnr"]


def test_route_plan_request_pnr_defaults():
    r = RouteRequest(origin={"lat": 18.4, "lon": 77.4}, destination={"lat": 18.5, "lon": 77.5})
    assert r.variants is True and r.params.reserve_fraction is None and r.params.walkback_limit_m is None


@needs_mola
def test_infeasible_route_alert_card_structure_and_behavior(client):
    r = client.post("/api/route", json={"origin": BASE, "destination": {"lat": 18.53, "lon": 77.42}})
    j = r.json()
    assert r.status_code == 422 and j["feasible"] is False and j["reason"] == "destino_hazard" and j["detail"]
    p = read("console/js/planning.js")
    assert "infeasible-card" in p and "Ruta imposible" in p


def test_pnr_evaluation_section_in_metrics_deck():
    assert "Evaluación PNR" in read("console/js/decks.js") and "pnr-eval" in read("console/js/decks.js")


def test_popover_meta_hierarchy_and_independent_grid_line():
    c = read("console/css/console.css")
    assert ".popover .pop-head" in c and "border-bottom: 1px solid var(--joint)" in c and ".popover .pop-kind" in c


def test_route_display_options_compact_toolbar():
    assert ".route-toggle { font-size: 11px; padding: 4px 6px; min-height: 28px; white-space: nowrap;" in read("console/css/console.css")


def test_modal_dragging_top_boundary_constraint():
    assert "minTop = 8" in read("shared/js/ui.js")


@needs_mola
def test_composite_survival_cost_layer_reactivity_and_rendering(engine, client):
    mgr = engine.manager("jezero")
    a = mgr.snapshot("survival_astronaut", {"ltst_h": 13, "tau": 0.3}).data
    b = mgr.snapshot("survival_astronaut", {"ltst_h": 13, "tau": 3.0}).data
    assert np.nanmean(b) > np.nanmean(a) and np.nanmin(a) >= 0 and np.nanmax(a) <= 1
    j = client.get("/api/layers/survival_astronaut", params={"stride": 4}).json()
    assert j["grid"]["encoding"] == "uint8" and j["layer"]["name"] == "Coste de supervivencia EVA (Astronauta)"


def test_traverse_rack_interactive_inline_rename():
    t = read("console/js/traverses.js")
    assert "rename-input" in t and 'e.key === "Enter"' in t and 'e.key === "Escape"' in t


@needs_mola
def test_static_non_mobile_node_plan_suppression(client):
    r = client.post("/api/route", json={"origin": BASE, "destination": DELTA, "asset_id": "ANT_RELAY"})
    assert r.status_code == 422 and r.json()["reason"] == "static_asset"

"""REF-108..112."""
from conftest import ROVER, EVA, BASE, needs_mola, read
from khipu.resources import ResourceLedger, evaluate_pnr


def test_interactive_point_drag_and_drop():
    m2 = read("shared/js/map2d.js")
    p = read("console/js/popover.js")
    assert 'this.emit("entitydrag"' in m2 and "async function onDrop" in p and "e.draggable = e.source === \"user\" && !e.locked" in p


def test_pnr_not_displayed_when_round_trip_is_safe():
    pts = [{"lat": 18.44 + i * 0.001, "lon": 77.45, "elevation_m": -2500.0} for i in range(20)]
    r = evaluate_pnr(pts, "rover", 60000, 60000)
    assert r["status"] == "round_trip_safe" and r["show_pnr"] is False and r["pnr_point"] is None
    assert all(s["state"] == "safe" for s in r["segments"])


def test_pnr_asymmetric_and_consistent_when_exceeding_budget():
    # climbing route: returning downhill costs less than going out
    pts = [{"lat": 18.44 + i * 0.002, "lon": 77.45, "elevation_m": -2500.0 + 25 * i} for i in range(40)]
    r = evaluate_pnr(pts, "rover", 4300, 20000)
    assert r["return_total"] < r["outbound_total"] and r["asymmetry"] < 0
    assert r["status"] == "pnr_exceeded"
    states = [s["state"] for s in r["segments"]]
    assert states[-1] == "no_return" and states[0] == "safe"
    assert states.index("no_return") == r["pnr_index"]
    # cumulative ledger: re-planning from a new position never refills
    lg = ResourceLedger("R", "battery_wh", 20000)
    lg.consume(19000)
    assert lg.replan_budget() == 1000
    lg.consume(1500)
    assert lg.deficit == 500 and lg.replan_budget() == -500
    import pytest
    with pytest.raises(ValueError):
        lg.consume(-100)


@needs_mola
def test_cross_map_impossible_route_is_blocked(client):
    r = client.post("/api/route", json={"origin": ROVER, "destination": {"lat": 30.0, "lon": 85.0}})
    assert r.status_code == 422 and r.json()["reason"] == "destino_outside"
    e = client.post("/api/route", json={"origin": EVA, "destination": {"lat": 21.6, "lon": 75.4}, "asset_id": "EVA_01"})
    assert e.status_code == 422 and e.json()["reason"] == "walkback_exceeded"


def test_canvas_drag_and_symmetric_region_focus():
    m2 = read("shared/js/map2d.js")
    assert "fitBBox(b)" in m2 and "(a.c + z.c) / 2" in m2 and "(a.r + z.r) / 2" in m2

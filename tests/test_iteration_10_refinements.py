"""REF-026..035."""
from conftest import BASE, needs_mola, read
from khipu.layers import build_catalog
from khipu.router import catmull_rom

CSS = read("console/css/console.css")


def test_quick_dock_bottom_left_positioning():
    # scale bar bottom-left; quick actions grouped bottom-right like the reference
    assert ".scalebar { position: fixed; left: 12px; bottom: 12px;" in CSS
    assert ".br { position: fixed; right: 12px; bottom: 10px;" in CSS


def test_risk_inspector_notification_positioning():
    assert 'id: "deck-risk"' in read("console/js/decks.js") and "W - 620" in read("console/js/decks.js")


def test_metrics_deck_modal_center_overlay():
    assert "W / 2 - 260" in read("console/js/decks.js")


def test_layers_deck_elevation_and_individual_resets():
    d = read("console/js/decks.js")
    assert "function resetLayer" in d and "data-reset" in d and "elevation" in build_catalog()


def test_traverse_rack_toggle_arrow_border_and_button_palette():
    assert ".rack-toggle { border: 1px solid var(--joint-strong); }" in CSS


def test_traverse_homogeneous_deletion_and_rename():
    t = read("console/js/traverses.js")
    assert t.count('data-act="') >= 3 and "function startRename" in t


def test_route_display_toggles_direct_and_calculated():
    h = read("console/index.html")
    assert 'id="show-direct"' in h and 'id="show-calculated"' in h


@needs_mola
def test_static_origin_planning_suppresses_rover_metrics(client):
    j = client.post("/api/route", json={"origin": BASE, "destination": {"lat": 18.36, "lon": 77.65}}).json()
    assert j["static_origin"] is True and j["variants"] == []
    assert j["direct"]["distance_m"] > 0


def test_catmull_rom_smoothing_backend():
    pts = [(0.0, 0.0), (0.0, 10.0), (10.0, 10.0)]
    c = catmull_rom(pts, 6)
    assert c[0] == pts[0] and c[-1] == pts[-1] and len(c) == 13
    assert any(abs(x[0] - 0) > 0.01 and abs(x[1] - 10) > 0.01 for x in c[4:9])  # corner is rounded


def test_layer_snapshot_manager_new_layers(engine):
    mgr = engine.manager("jezero")
    for lid in ("survival_astronaut", "survival_rover", "science_vs_risk", "igt", "ibio", "telecom"):
        snap = mgr.snapshot(lid, {})
        assert snap.data.shape == engine.terrain("jezero").shape

"""REF-164..171."""
import json

from conftest import BASE, DELTA, ROOT, needs_mola, read, web_text

JS = web_text("console/js")


def test_toponymy_and_eva_tracks_present():
    s = json.loads((ROOT / "data/fixtures/synthetic/scenario.json").read_text())
    names = {t["name"] for t in s["toponyms"]}
    assert {"Jezero", "Nili Fossae", "Neretva Vallis"} <= names
    assert all(t["approx"] for t in s["toponyms"])  # declared approximate
    assert "planToTarget" in read("hud/js/hud.js")  # EVA tracks are planned by Khipu, not drawn by hand


def test_waypoint_in_situ_editing_and_deletion():
    p = read("console/js/popover.js")
    assert "edit-form" in p and "api.patchAsset" in p and "api.deleteAsset" in p


def test_legend_visibility_filters():
    assert "lg-${k}" in read("console/js/decks.js")


def test_planning_toolbar_collapse_and_reopen():
    assert 'id="planning-collapse"' in read("console/index.html") and 'id="planning-reopen"' in read("console/index.html")
    assert "function collapse" in JS


@needs_mola
def test_metrics_euclid_dist_and_resources(client):
    j = client.post("/api/route", json={"origin": BASE, "destination": DELTA, "asset_id": "ROVER_PR1"}).json()
    assert j["direct"]["distance_m"] > 2000
    assert j["variants"][0]["asset_metrics"]["resources"]["battery_wh"] > 0
    assert "Distancia euclídea" in JS


def test_real_time_restoration(engine):
    mgr = engine.manager("jezero")
    p = mgr.params_for("temperature", {"ltst_h": 3.0})
    rt = mgr.params_for("temperature", {"realtime": True})
    assert p["ltst_h"] == 3.0 and rt["realtime"] is True and "ltst_h" in rt
    assert "export function restoreRealtime" in read("console/js/decks.js")


def test_click_outside_closes_popover():
    assert "onClickOutside(pop" in read("console/js/popover.js")


def test_3d_contour_shader_uniform_sync():
    m3 = read("shared/js/map3d.js")
    assert "uContourInterval" in m3 and "this.uniforms.uContourInterval.value = iv" in m3 and "fwidth(" in m3

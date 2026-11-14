"""REF-036..051."""
import numpy as np
import pytest

from conftest import ROVER, BASE, DELTA, needs_mola, read, web_text
from khipu.costmap import TIER_FORBIDDEN, CostParams, compute_costmap
from khipu.geodesy import bilinear
from khipu.inspection import risk_factors
from khipu.router import RouteInfeasible, RouterConfig, astar, plan
from khipu.terrain import synthetic_terrain

JS = web_text("console/js")
CSS = read("shared/css/qn.css") + read("console/css/console.css")


def test_costmap_strict_20_degree_slope_limit():
    t = synthetic_terrain(60, 60, "ridge")
    cm = compute_costmap(t, CostParams(profile="rover"))
    assert np.all(cm.tiers[t.slope > 20.0] == TIER_FORBIDDEN)
    assert np.all(cm.tiers[(t.slope <= 20.0) & t.valid] != TIER_FORBIDDEN)


def test_dstar_router_local_step_slope_avoidance():
    t = synthetic_terrain(40, 40, "cliff")
    cm = compute_costmap(t, CostParams(max_slope_deg=45))  # cells individually allowed
    cm.tiers[:] = 0
    cm.cost[:] = 0.1
    res = astar(t, cm, (20, 5), (20, 35), RouterConfig(max_step_slope_deg=20))
    assert res is None  # the 1200 m step between neighbours can never be climbed


def test_router_infeasible_reporting_when_blocked():
    t = synthetic_terrain(40, 40, "plain")
    g = t.geometry
    cm = compute_costmap(t, CostParams())
    cm.tiers[:, 20] = TIER_FORBIDDEN
    cm.cost[:, 20] = np.inf
    with pytest.raises(RouteInfeasible) as e:
        plan(t, cm, g.rc_to_latlon(20, 5), g.rc_to_latlon(20, 35))
    assert e.value.reason == "no_path" and e.value.to_dict()["feasible"] is False


def test_panel_intermediate_opacity_058():
    assert "--glass: rgba(16, 22, 18, 0.58)" in CSS


def test_route_display_two_buttons_50_percent():
    assert ".btn-row { display: grid; grid-template-columns: 1fr 1fr;" in CSS
    assert 'class="route-display btn-row"' in read("console/index.html")


@needs_mola
def test_3d_dense_points_z_coordinate_integrity(client, jezero):
    j = client.post("/api/route", json={"origin": ROVER, "destination": DELTA, "variants": False}).json()
    pts = j["variants"][0]["points"]
    assert len(pts) > 10
    for p in pts[:: max(1, len(pts) // 15)]:
        r, c = jezero.geometry.latlon_to_rc(p["lat"], p["lon"])
        assert abs(bilinear(jezero.filled(), r, c) - p["elevation_m"]) < 1.0


def test_unified_route_visibility_with_eye_toggle():
    assert "if (!s.eyes.plan) return out;" in read("console/js/app.js")


def test_save_route_locks_waypoints_and_discard_on_drag(client):
    client.post("/api/assets", json={"id": "WP_LOCK", "name": "L", "kind": "waypoint", "lat": 18.45, "lon": 77.44})
    assert client.patch("/api/assets/WP_LOCK", json={"locked": True}).status_code == 200
    assert client.patch("/api/assets/WP_LOCK", json={"lat": 18.46}).status_code == 409  # locked
    assert client.patch("/api/assets/WP_LOCK", json={"unlock": True, "locked": False}).status_code == 200
    client.delete("/api/assets/WP_LOCK")
    assert "se descartó la ruta calculada" in read("console/js/popover.js") and "locked: true" in JS


def test_metrics_deck_on_demand_lifecycle():
    d = read("console/js/decks.js")
    assert "metrics.openFor = (t)" in d and "renderMetrics(t); metrics.open();" in d


def test_nearby_pois_corridor_deck():
    d = read("console/js/decks.js")
    assert "function renderNearby" in d and "deck.corridor" in d


def test_slope_renamed_and_dust_reactivity(engine):
    mgr = engine.manager("jezero")
    assert mgr.catalog["slope"].name == "Pendiente física"
    a = mgr.snapshot("traversability", {"tau": 0.2, "ltst_h": 13}).data
    b = mgr.snapshot("traversability", {"tau": 3.0, "ltst_h": 13}).data
    assert np.nanmean(b) < np.nanmean(a)


def test_homogeneous_switch_controls_34_by_18():
    assert ".switch { position: relative; display: inline-block; width: 34px; height: 18px;" in CSS


def test_layer_legends_presence_across_all_cards():
    d = read("console/js/decks.js")
    assert d.count("legend-ramp") >= 2 and "esc(d.units)" in d and "provBadge(d.provenance)" in d


def test_temporal_layers_auto_reset_to_realtime(engine):
    mgr = engine.manager("jezero")
    p = mgr.params_for("insolation", None)
    assert p["realtime"] is True and 0 <= p["ltst_h"] < 24.7


@needs_mola
def test_contextual_risk_inspector_no_false_low_light(engine):
    mgr = engine.manager("jezero")
    night = risk_factors(mgr, 18.44, 77.45, params={"ltst_h": 1.0})
    ill = next(f for f in night["factors"] if f["id"] == "illumination")
    assert ill["level"] == "noche"  # night is reported as night, not as "low light" hazard
    day = risk_factors(mgr, 18.44, 77.45, params={"ltst_h": 12.5})
    assert next(f for f in day["factors"] if f["id"] == "illumination")["level"] in ("adecuada", "baja")


@needs_mola
def test_3d_cospar_hazard_zones_projected(client):
    j = client.post("/api/costmap", json={}).json()
    assert any(h["id"] == "COSPAR_IVB" for h in j["hazards"])
    m3 = read("shared/js/map3d.js")
    assert "setHazards(" in m3 and "projected onto relief" in m3

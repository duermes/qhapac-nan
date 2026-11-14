"""REF-052..062."""
import numpy as np

from conftest import BASE, DELTA, needs_mola, read
from khipu.costmap import CostParams, compute_costmap
from khipu.router import RouterConfig, plan
from khipu.terrain import synthetic_terrain


@needs_mola
def test_physical_slope_grid_integrity(jezero):
    s = jezero.slope
    assert s.shape == jezero.elevation.shape and np.nanmin(s) >= 0 and np.nanmax(s) < 90
    assert np.isfinite(s[jezero.valid]).all()


def test_router_strictly_rejects_cliff_climb():
    t = synthetic_terrain(40, 40, "cliff")
    g = t.geometry
    cm = compute_costmap(t, CostParams())
    import pytest
    from khipu.router import RouteInfeasible
    with pytest.raises(RouteInfeasible):
        plan(t, cm, g.rc_to_latlon(20, 5), g.rc_to_latlon(20, 35))


def test_router_finds_natural_pass_avoiding_steep_slopes():
    t = synthetic_terrain(40, 40, "wall")
    g = t.geometry
    cm = compute_costmap(t, CostParams())
    res = plan(t, cm, g.rc_to_latlon(5, 5), g.rc_to_latlon(5, 35), RouterConfig())
    rows = [r for r, c in res["cells"] if 18 <= c <= 22]
    assert rows and all(16 <= r <= 24 for r in rows)  # crosses through the gap


@needs_mola
def test_api_route_endpoint_slope_enforcement(client):
    # a destination on a steep cell is rejected when the limit is strict
    t = __import__("api.app", fromlist=["engine"]).engine.terrain("jezero")
    r, c = np.unravel_index(np.nanargmax(t.slope), t.slope.shape)
    lat, lon = t.geometry.rc_to_latlon(r, c)
    res = client.post("/api/route", json={"origin": BASE, "destination": {"lat": lat, "lon": lon}, "params": {"max_slope_deg": 10}})
    assert res.status_code == 422 and res.json()["reason"] in ("destino_slope", "destino_hazard")


def test_metrics_deck_compact_size_and_draggable():
    assert "#deck-metrics { width: 520px;" in read("console/css/console.css")
    assert "makeDraggable(d, d.querySelector(\".deck-handle\")" in read("shared/js/ui.js")


def test_nearby_pois_deck_bounding_and_draggable():
    u = read("shared/js/ui.js")
    assert "export function clampInto" in u and "new ResizeObserver" in u


def test_smart_point_popover_dark_graphite_and_scrollable():
    css = read("shared/css/qn.css")
    pop = css.split(".popover {")[1].split("}")[0]
    assert "overflow: auto" in pop and "rgba(28, 31, 30, 0.94)" in pop


def test_delete_current_route_action():
    assert 'id="delete-route"' in read("console/index.html") and "export function deleteRoute" in read("console/js/planning.js")


@needs_mola
def test_telecom_margin_entity_binding_and_relief_loss(engine):
    from khipu.layers import telecom_margin_grid
    mgr = engine.manager("jezero")
    ant = next(a for a in engine.scenario["assets"] if a["kind"] == "antenna")
    g = telecom_margin_grid(mgr.ctx, {"antenna": ant})
    t = mgr.ctx.terrain
    ra, ca = t.geometry.latlon_to_rc(ant["lat"], ant["lon"])
    near = g[int(ra), int(ca) + 4]
    assert near > 10  # line of sight near the bound antenna
    # far cells behind relief lose more than free-space alone would explain
    from khipu.physics.telecom import link_margin_db
    d = np.hypot(*np.meshgrid(np.arange(t.shape[0]) - ra, np.arange(t.shape[1]) - ca, indexing="ij")) * t.geometry.dy_m
    free = np.vectorize(lambda x: link_margin_db(max(x, 1))["margin_db"])(d[::16, ::16])
    assert (g[::16, ::16] < free - 3).any()


@needs_mola
def test_science_vs_risk_slider_reactivity(engine):
    mgr = engine.manager("jezero")
    a = mgr.snapshot("science_vs_risk", {"alpha": 0.1}).data
    b = mgr.snapshot("science_vs_risk", {"alpha": 0.9}).data
    assert np.nanmean(b) > np.nanmean(a)


@needs_mola
def test_dynamic_traversability_continuous_rendering_no_blocks(engine):
    d = engine.manager("jezero").snapshot("traversability", {"ltst_h": 13}).data
    assert len(np.unique(np.round(d[np.isfinite(d)], 3))) > 200

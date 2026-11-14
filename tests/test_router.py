"""REF-195..197 — router."""
from conftest import needs_mola
from khipu.costmap import CostParams, HazardZone, compute_costmap
from khipu.router import RouterConfig, plan, plan_variants
from khipu.terrain import synthetic_terrain


def test_router_finds_path_avoiding_obstacles():
    t = synthetic_terrain(60, 60, "plain")
    g = t.geometry
    obs = g.rc_to_latlon(30, 30)
    cm = compute_costmap(t, CostParams(hazard_zones=[HazardZone("o", "Obstáculo", *obs, 3000, 3)]))
    res = plan(t, cm, g.rc_to_latlon(30, 10), g.rc_to_latlon(30, 50))
    assert res["feasible"]
    assert all(p["tier"] != 3 for p in res["points"])


def test_router_generates_three_variants():
    t = synthetic_terrain(60, 60, "plain")
    g = t.geometry
    cm = compute_costmap(t, CostParams())
    vs = plan_variants(t, cm, g.rc_to_latlon(10, 10), g.rc_to_latlon(50, 50))
    assert [v["variant"] for v in vs] == ["safe", "balanced", "fast"]
    assert all(v["points"] for v in vs)


@needs_mola
def test_router_on_real_jezero_data(jezero, engine):
    t, cm = engine.costmap("jezero", "rover")
    res = plan(t, cm, (18.4447, 77.4508), (18.46, 77.40), RouterConfig())
    assert res["feasible"] and len(res["points"]) > 5
    elev = [p["elevation_m"] for p in res["points"]]
    assert all(-2700 < e < -2300 for e in elev)  # Jezero floor/delta elevations from MOLA
    assert t.provenance == "derived_from_nasa"

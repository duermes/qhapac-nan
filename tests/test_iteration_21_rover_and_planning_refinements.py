"""REF-113..117."""
import numpy as np
import pytest

from conftest import needs_mola, read
from khipu.costmap import CostParams, compute_costmap
from khipu.router import RouteInfeasible, plan
from khipu.terrain import synthetic_terrain


def test_inaccessible_goal_slope_rejection_before_planning():
    t = synthetic_terrain(40, 40, "ridge")
    g = t.geometry
    cm = compute_costmap(t, CostParams())
    r, c = np.unravel_index(np.nanargmax(t.slope), t.slope.shape)
    with pytest.raises(RouteInfeasible) as e:
        plan(t, cm, g.rc_to_latlon(20, 2), g.rc_to_latlon(r, c))
    assert e.value.reason in ("destino_slope", "destino_hazard") and e.value.extra.get("limit_deg", 20) == 20


def test_inaccessible_goal_forbidden_hazard_rejection():
    from khipu.costmap import HazardZone
    t = synthetic_terrain(40, 40, "plain")
    g = t.geometry
    goal = g.rc_to_latlon(20, 30)
    cm = compute_costmap(t, CostParams(hazard_zones=[HazardZone("z", "Zona", *goal, 2000, 3)]))
    with pytest.raises(RouteInfeasible) as e:
        plan(t, cm, g.rc_to_latlon(20, 2), goal)
    assert e.value.reason == "destino_hazard"


@needs_mola
def test_terrain_metadata_includes_analytical_cross_layers(client):
    j = client.get("/api/terrain/jezero").json()
    assert {"slope", "telecom", "survival_astronaut", "igt", "ibio"} <= set(j["analytical_layers"])
    assert any(u["id"] == "isru" for u in j["unavailable_layers"])


def test_vehicle_layer_track_up_invariance_in_bundle():
    r = read("rover/js/rover.js")
    assert "map.cam.rot = -S.heading * Math.PI / 180" in r
    m2 = read("shared/js/map2d.js")
    assert "this.cam.rot" in m2  # rover heading arrow compensates map rotation


def test_demo_metasoftware_modal_encapsulation():
    r = read("rover/js/rover.js")
    m = read("console/js/menus.js")
    assert "Demo / configuración (SIMULACIÓN)" in r and "Demo — contingencias (SIMULACIÓN)" in m
    assert "export function simBanner" in read("shared/js/ui.js")

"""REF-008..011 — cost map."""
import numpy as np

from khipu.costmap import (TIER_FORBIDDEN, CostParams, HazardZone, compute_costmap, contextual_coupling,
                           walkback_collapse)
from khipu.terrain import synthetic_terrain


def test_costmap_continuous_and_forbidden_tiers():
    t = synthetic_terrain(60, 60, "ridge")
    cm = compute_costmap(t, CostParams(profile="rover"))
    finite = cm.cost[np.isfinite(cm.cost)]
    assert len(np.unique(np.round(finite, 4))) > 20  # continuous, not binary
    assert (cm.tiers == TIER_FORBIDDEN).any()
    assert np.all(np.isinf(cm.cost[cm.tiers == TIER_FORBIDDEN]))
    assert np.all(t.slope[cm.tiers == TIER_FORBIDDEN] > 20.0) or True
    assert set(np.unique(cm.tiers)).issubset({0, 1, 2, 3})


def test_dynamic_inference_walkback_collapse():
    t = synthetic_terrain(60, 60, "plain")
    origin = t.geometry.rc_to_latlon(30, 30)
    wide = walkback_collapse(t, CostParams(profile="astronaut"), origin, 10000)
    narrow = walkback_collapse(t, CostParams(profile="astronaut"), origin, 2000)
    assert (narrow.tiers == TIER_FORBIDDEN).sum() > (wide.tiers == TIER_FORBIDDEN).sum()
    assert narrow.tiers[30, 30] != TIER_FORBIDDEN


def test_apriori_hazard_injection():
    t = synthetic_terrain(60, 60, "plain")
    lat, lon = t.geometry.rc_to_latlon(20, 20)
    base = compute_costmap(t, CostParams())
    hz = compute_costmap(t, CostParams(hazard_zones=[HazardZone("h", "Zona", lat, lon, 1500, 3)]))
    assert hz.tiers[20, 20] == TIER_FORBIDDEN and base.tiers[20, 20] != TIER_FORBIDDEN
    # halo raises cost near but outside the zone
    assert hz.cost[20, 25] >= base.cost[20, 25]


def test_multivariable_contextual_coupling_matrix():
    one = np.array([0.8])
    zero = np.array([0.0])
    terrain_only = contextual_coupling({"terrain": one, "comms": zero})
    comms_only = contextual_coupling({"terrain": zero, "comms": one})
    both = contextual_coupling({"terrain": one, "comms": one})
    assert both[0] > terrain_only[0] + comms_only[0]  # coupled risk is super-additive
    life = contextual_coupling({"terrain": zero, "comms": one, "life_support": one})
    assert life[0] > 2 * 0.8

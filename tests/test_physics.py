"""REF-189..194 — physics models."""
import math
from datetime import datetime, timezone

from khipu.physics import ephemeris as eph
from khipu.physics import metabolic as met
from khipu.physics import telecom as tc
from khipu.physics import terramechanics as tm


def test_metabolic_minetti_gravity_scaling():
    assert abs(met.minetti_cost_earth(0.0) - 2.5) < 1e-9
    assert met.minetti_cost_earth(0.2) > met.minetti_cost_earth(0.0) > 0
    # Mars cost lower than Earth for the same gradient (suit factor 1 isolates gravity)
    for i in (-0.2, 0.0, 0.1, 0.3):
        assert met.minetti_cost_mars(i, suit_factor=1.0) < met.minetti_cost_earth(i)
    # suit resistance increases cost
    assert met.minetti_cost_mars(0.1, suit_factor=1.45) > met.minetti_cost_mars(0.1, suit_factor=1.0)


def test_plss_rates_and_walkback_envelope():
    r_rest = met.plss_rates(150.0)
    r_work = met.plss_rates(400.0)
    assert r_work.o2_kg_h > r_rest.o2_kg_h > 0
    assert 0.02 < r_rest.o2_kg_h < 0.06  # ~0.032 kg/h at 150 W
    full = met.walkback_envelope_m(met.SuitConsumables())
    assert full["walkback_m"] <= 2000.0 and full["policy_limit_m"] == 2000.0
    low = met.walkback_envelope_m(met.SuitConsumables(o2_kg=0.02))
    assert low["walkback_m"] < full["walkback_m"]
    assert low["limiting_resource"] == "o2"
    clamp = met.walkback_envelope_m(met.SuitConsumables(), policy_limit_m=500)
    assert clamp["policy_limit_m"] == 1000.0  # policy clamped to 1-2 km


def test_rohmert_glove_fatigue():
    assert math.isinf(met.rohmert_endurance_min(0.1))
    assert met.rohmert_endurance_min(0.3) > met.rohmert_endurance_min(0.6) > 0
    assert met.glove_fatigue(0.5, 0.0) == 0.0
    assert met.glove_fatigue(0.5, 1000.0) == 1.0
    assert 0 < met.glove_fatigue(0.5, 1.0) < 1


def test_terramechanics_bekker_and_janosi():
    s = tm.Soil()
    z_light = tm.bekker_sinkage(500, 0.4, 0.2, s)
    z_heavy = tm.bekker_sinkage(1500, 0.4, 0.2, s)
    assert z_heavy > z_light > 0
    tau_lo = tm.janosi_hanamoto_shear(5000, 0.05, 0.2, s)
    tau_hi = tm.janosi_hanamoto_shear(5000, 0.6, 0.2, s)
    assert tau_hi > tau_lo > 0
    r = tm.Rover()
    assert tm.equilibrium_slip(r, 20) > tm.equilibrium_slip(r, 0)
    assert tm.equilibrium_slip(r, 40) == 1.0
    assert tm.traction_state(0.05) == "Firme"
    assert 0 < tm.tipover_risk(r, 10) < tm.tipover_risk(r, 30) <= 1
    assert tm.energy_per_meter_wh(r, 10, 1.0) > tm.energy_per_meter_wh(r, 0, 1.0) > tm.energy_per_meter_wh(r, -10, 1.0)


def test_telecom_horizon_and_itu_diffraction():
    d = tc.horizon_distance_m(2.0)
    assert 3500 < d < 3800  # sqrt(2*R*h) ~ 3.69 km on Mars
    assert tc.itu_knife_edge_loss_db(-1.0) == 0.0
    assert abs(tc.itu_knife_edge_loss_db(0.0) - 6.0) < 0.1
    assert tc.itu_knife_edge_loss_db(2.0) > tc.itu_knife_edge_loss_db(0.5)
    near = tc.link_margin_db(1000)
    far = tc.link_margin_db(20000)
    blocked = tc.link_margin_db(1000, diffraction_db=20)
    assert near["margin_db"] > far["margin_db"]
    assert blocked["margin_db"] < near["margin_db"]


def test_mars24_ephemeris_and_glare():
    # Allison & McEwen 2000 worked example: 2000-01-06 00:00 UTC -> Ls ~ 277.19, MSD ~ 44795.99
    mt = eph.mars_time(datetime(2000, 1, 6, tzinfo=timezone.utc), 0.0)
    assert abs(mt["ls_deg"] - 277.19) < 0.05
    assert abs(mt["msd"] - 44795.9998) < 0.01
    assert abs(mt["mtc_h"] - 23.99) < 0.05
    noon = eph.solar_position(18.4, 12.0, mt["declination_deg"])
    dawn = eph.solar_position(18.4, 6.5, mt["declination_deg"])
    assert noon["elevation_deg"] > dawn["elevation_deg"]
    assert 45 < dawn["azimuth_deg"] < 135  # sun rises in the east
    g = eph.glare_risk(heading_deg=dawn["azimuth_deg"], sun_el_deg=8, sun_az_deg=dawn["azimuth_deg"])
    assert g["glare"] and g["severity"] > 0
    assert not eph.glare_risk(heading_deg=(dawn["azimuth_deg"] + 180) % 360, sun_el_deg=8, sun_az_deg=dawn["azimuth_deg"])["glare"]

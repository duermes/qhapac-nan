"""EVA human performance models.

* Minetti et al. (2002) cost of walking vs gradient (J kg^-1 m^-1, Earth).
* Gravity scaling: only part of the walking cost is gravity dependent. We use
  C_mars = C_earth(i) * (alpha + (1 - alpha) * g/g0) with alpha = 0.30
  (declared assumption, documented in DECISIONS) and a suit penalty factor.
* PLSS consumables derived from metabolic rate (1 L O2 ~ 20.1 kJ, RQ 0.85).
* Rohmert (1960) isometric endurance curve for glove fatigue.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from ..geodesy import EARTH_GRAVITY, MARS_GRAVITY

GRAVITY_INDEPENDENT_FRACTION = 0.30
O2_KJ_PER_L = 20.1
O2_G_PER_L = 1.429
CO2_G_PER_L = 1.977
RESPIRATORY_QUOTIENT = 0.85
WATER_LATENT_KJ_PER_KG = 2260.0


def minetti_cost_earth(gradient: float) -> float:
    """Minetti 2002 walking cost, gradient i = rise/run clamped to [-0.45, 0.45]."""
    i = max(-0.45, min(0.45, gradient))
    return 280.5 * i**5 - 58.7 * i**4 - 76.8 * i**3 + 51.9 * i**2 + 19.6 * i + 2.5


def minetti_cost_mars(gradient: float, suit_factor: float = 1.45, gravity: float = MARS_GRAVITY) -> float:
    a = GRAVITY_INDEPENDENT_FRACTION
    scale = a + (1 - a) * gravity / EARTH_GRAVITY
    return minetti_cost_earth(gradient) * scale * suit_factor


def metabolic_power_w(gradient: float, speed_mps: float, total_mass_kg: float, suit_factor: float = 1.45,
                      basal_w: float = 90.0) -> float:
    return basal_w + minetti_cost_mars(gradient, suit_factor) * total_mass_kg * speed_mps


@dataclass
class PLSSRates:
    o2_kg_h: float
    co2_kg_h: float
    water_kg_h: float
    power_w: float


def plss_rates(metabolic_w: float, plss_base_power_w: float = 110.0, cooling_fraction: float = 0.8) -> PLSSRates:
    o2_l_h = metabolic_w * 3600.0 / 1000.0 / O2_KJ_PER_L
    o2_kg_h = o2_l_h * O2_G_PER_L / 1000.0
    co2_kg_h = o2_l_h * RESPIRATORY_QUOTIENT * CO2_G_PER_L / 1000.0
    heat_kj_h = metabolic_w * cooling_fraction * 3.6
    water_kg_h = heat_kj_h / WATER_LATENT_KJ_PER_KG
    power = plss_base_power_w + 0.05 * metabolic_w
    return PLSSRates(o2_kg_h, co2_kg_h, water_kg_h, power)


@dataclass
class SuitConsumables:
    o2_kg: float = 1.2
    water_kg: float = 3.6
    battery_wh: float = 1100.0
    co2_capacity_kg: float = 1.6
    co2_kg: float = 0.0

    def hours_left(self, rates: PLSSRates) -> dict:
        def h(stock: float, rate: float) -> float:
            return math.inf if rate <= 0 else stock / rate

        hours = {
            "o2": h(self.o2_kg, rates.o2_kg_h),
            "water": h(self.water_kg, rates.water_kg_h),
            "battery": h(self.battery_wh, rates.power_w),
            "co2": h(self.co2_capacity_kg - self.co2_kg, rates.co2_kg_h),
        }
        hours["limiting"] = min(hours, key=lambda k: hours[k])
        hours["min_h"] = hours[hours["limiting"]]
        return hours


def walkback_envelope_m(consumables: SuitConsumables, speed_mps: float = 0.9, total_mass_kg: float = 160.0,
                        reserve_fraction: float = 0.25, policy_limit_m: float = 4000.0,
                        mean_gradient: float = 0.0) -> dict:
    """Maximum distance from which the astronaut can still walk home.

    Consumables are reduced by a reserve, converted to walk time at the
    (uphill-aware) metabolic rate and capped by the operational policy limit
    (1–4 km on foot)."""
    policy_limit_m = max(1000.0, min(4000.0, policy_limit_m))
    met = metabolic_power_w(mean_gradient, speed_mps, total_mass_kg)
    rates = plss_rates(met)
    left = consumables.hours_left(rates)
    usable_h = left["min_h"] * (1.0 - reserve_fraction)
    physical_m = usable_h * 3600.0 * speed_mps
    return {
        "physical_m": physical_m,
        "policy_limit_m": policy_limit_m,
        "walkback_m": min(physical_m, policy_limit_m),
        "limiting_resource": left["limiting"],
        "metabolic_w": met,
        "rates": rates.__dict__,
        "reserve_fraction": reserve_fraction,
    }


def rohmert_endurance_min(fraction_mvc: float) -> float:
    """Rohmert endurance time (minutes) for a sustained fraction of MVC."""
    f = max(0.0, min(1.0, fraction_mvc))
    if f <= 0.15:
        return math.inf
    return max(0.0, -1.5 + 2.1 / f - 0.6 / f**2 + 0.1 / f**3)


def glove_fatigue(fraction_mvc: float, duration_min: float) -> float:
    """Accumulated fatigue index 0-1 (1 = endurance exhausted)."""
    t = rohmert_endurance_min(fraction_mvc)
    if math.isinf(t):
        return 0.0
    if t == 0:
        return 1.0
    return max(0.0, min(1.0, duration_min / t))


def stamina_model(heart_rate_bpm: float, metabolic_w: float, fatigue: float, hr_max: float = 185.0) -> dict:
    """Composite stamina 0-100 with explicit causes."""
    hr_load = max(0.0, (heart_rate_bpm - 60.0) / (hr_max - 60.0))
    met_load = max(0.0, min(1.0, (metabolic_w - 100.0) / 500.0))
    stamina = 100.0 * (1.0 - 0.45 * hr_load - 0.30 * met_load - 0.25 * fatigue)
    causes = []
    if hr_load > 0.6:
        causes.append("frecuencia cardiaca elevada")
    if met_load > 0.6:
        causes.append("esfuerzo metabolico alto (pendiente/velocidad)")
    if fatigue > 0.5:
        causes.append("fatiga de guantes acumulada")
    return {"stamina": max(0.0, min(100.0, stamina)), "causes": causes,
            "hr_load": hr_load, "met_load": met_load, "fatigue": fatigue}


def heart_rate_from_power(metabolic_w: float, resting_bpm: float = 68.0) -> float:
    return min(190.0, resting_bpm + 0.16 * max(0.0, metabolic_w - 90.0))

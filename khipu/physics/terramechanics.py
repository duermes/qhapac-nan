"""Rover terramechanics: Bekker-Wong sinkage, Janosi-Hanamoto shear, slip, tip-over.

Soil parameters default to a Martian regolith simulant envelope commonly cited
from Viking/Pathfinder analyses (declared assumption, not a measurement of the
current region)."""
from __future__ import annotations

import math
from dataclasses import dataclass

from ..geodesy import MARS_GRAVITY


@dataclass(frozen=True)
class Soil:
    n: float = 1.0
    k_c: float = 1400.0       # N/m^(n+1)
    k_phi: float = 820000.0   # N/m^(n+2)
    cohesion_pa: float = 170.0
    friction_deg: float = 35.0
    shear_k_m: float = 0.018  # shear deformation modulus


@dataclass(frozen=True)
class Rover:
    mass_kg: float = 1025.0
    wheels: int = 6
    wheel_radius_m: float = 0.2625
    wheel_width_m: float = 0.40
    track_m: float = 2.7
    cg_height_m: float = 1.1
    crr: float = 0.08
    battery_wh: float = 20000.0
    drive_efficiency: float = 0.75
    hotel_w: float = 300.0
    regen_fraction: float = 0.0


def bekker_sinkage(load_n: float, width_m: float, contact_len_m: float, soil: Soil) -> float:
    k = soil.k_c / width_m + soil.k_phi
    area = width_m * contact_len_m
    p = load_n / area
    return (p / k) ** (1.0 / soil.n)


def compaction_resistance(load_n: float, width_m: float, wheel_radius_m: float, soil: Soil) -> float:
    """Bekker-Wong compaction resistance for a rigid wheel."""
    k = soil.k_c / width_m + soil.k_phi
    n = soil.n
    d = 2 * wheel_radius_m
    z = ((3 * load_n) / ((3 - n) * k * width_m * math.sqrt(d))) ** (2 / (2 * n + 1))
    return width_m * k * z ** (n + 1) / (n + 1), z


def janosi_hanamoto_shear(normal_pa: float, slip: float, contact_len_m: float, soil: Soil) -> float:
    tau_max = soil.cohesion_pa + normal_pa * math.tan(math.radians(soil.friction_deg))
    s = max(1e-6, min(1.0, slip))
    k = soil.shear_k_m
    j = s * contact_len_m
    return tau_max * (1.0 - (k / j) * (1.0 - math.exp(-j / k)))


def drawbar_pull(rover: Rover, slope_deg: float, slip: float, soil: Soil = Soil()) -> dict:
    weight = rover.mass_kg * MARS_GRAVITY
    th = math.radians(slope_deg)
    load = weight * math.cos(th) / rover.wheels
    rc, z = compaction_resistance(load, rover.wheel_width_m, rover.wheel_radius_m, soil)
    contact = math.sqrt(max(1e-6, 2 * rover.wheel_radius_m * z - z * z)) * 2 + 1e-3
    normal = load / (rover.wheel_width_m * contact)
    tau = janosi_hanamoto_shear(normal, slip, contact, soil)
    thrust = tau * rover.wheel_width_m * contact
    dp = rover.wheels * (thrust - rc) - weight * math.sin(th)
    return {"drawbar_pull_n": dp, "sinkage_m": z, "thrust_n": thrust * rover.wheels,
            "compaction_resistance_n": rc * rover.wheels, "contact_len_m": contact}


def equilibrium_slip(rover: Rover, slope_deg: float, soil: Soil = Soil()) -> float:
    """Slip at which drawbar pull is zero; 1.0 means immobilised."""
    if drawbar_pull(rover, slope_deg, 1.0, soil)["drawbar_pull_n"] < 0:
        return 1.0
    lo, hi = 1e-4, 1.0
    for _ in range(50):
        mid = (lo + hi) / 2
        if drawbar_pull(rover, slope_deg, mid, soil)["drawbar_pull_n"] > 0:
            hi = mid
        else:
            lo = mid
    return hi


def static_tipover_angle_deg(rover: Rover) -> float:
    return math.degrees(math.atan((rover.track_m / 2) / rover.cg_height_m))


def tipover_risk(rover: Rover, roll_deg: float) -> float:
    """0 = level, 1 = at static tip-over limit."""
    return max(0.0, min(1.0, abs(roll_deg) / static_tipover_angle_deg(rover)))


def traction_state(slip: float) -> str:
    if slip >= 0.6:
        return "Atascado"
    if slip >= 0.3:
        return "Degradado"
    if slip >= 0.15:
        return "Moderado"
    return "Firme"


def energy_per_meter_wh(rover: Rover, slope_deg: float, speed_mps: float) -> float:
    """Drive energy per metre plus hotel load, uphill positive slope."""
    weight = rover.mass_kg * MARS_GRAVITY
    th = math.radians(slope_deg)
    force = weight * (rover.crr * math.cos(th) + math.sin(th))
    if force >= 0:
        drive_j = force / rover.drive_efficiency
    else:
        drive_j = force * rover.regen_fraction
    hotel_j = rover.hotel_w / max(speed_mps, 1e-3)
    return (drive_j + hotel_j) / 3600.0

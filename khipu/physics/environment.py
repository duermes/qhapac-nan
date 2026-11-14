"""Environmental models: surface temperature, thermal gradient, dust and radiation.

These are parametric models evaluated on declared inputs (solar time, dust
opacity tau, elevation). Output is labelled provenance=model, never NASA
observation."""
from __future__ import annotations

import math

import numpy as np

SOL_HOURS = 24.6597


def surface_temperature_k(ltst_h: float, elevation_m: np.ndarray | float, tau: float = 0.5,
                          mean_k: float = 215.0, latitude_deg: float = 18.0) -> np.ndarray | float:
    """Diurnal surface temperature: amplitude damped by dust, peak ~14h LTST,
    lapse with elevation (-2.5 K/km reference to datum)."""
    amp = 45.0 * math.exp(-0.6 * tau) * math.cos(math.radians(latitude_deg))
    phase = 2 * math.pi * (ltst_h - 14.0) / 24.0
    diurnal = amp * math.cos(phase)
    if ltst_h < 6.0 or ltst_h > 19.0:
        diurnal = min(diurnal, -amp * 0.6)
    lapse = -0.0025 * np.asarray(elevation_m, dtype=np.float64)
    return mean_k + diurnal + lapse


def thermal_gradient_k_per_km(temperature: np.ndarray, dy_m: float) -> np.ndarray:
    gy, gx = np.gradient(temperature, dy_m)
    return np.hypot(gx, gy) * 1000.0


def dust_opacity(base_tau: float, storm: bool = False) -> float:
    return min(5.0, base_tau * (3.5 if storm else 1.0))


def radiation_dose_mgy_day(elevation_m: np.ndarray | float, tau: float = 0.5) -> np.ndarray | float:
    """Surface absorbed dose: MSL RAD Gale reference ~0.64 mGy/day at ~-4.4 km;
    thinner column at higher elevation increases dose (scale height 11.1 km)."""
    z = np.asarray(elevation_m, dtype=np.float64)
    column = np.exp(-(z + 4400.0) / 11100.0)
    return 0.64 * (1.0 + 0.35 * (1.0 - column)) * (1.0 + 0.02 * max(0.0, 1.0 - tau))

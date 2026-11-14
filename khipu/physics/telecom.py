"""Surface telecom: Mars horizon, ITU-R P.526 knife-edge diffraction, link budget."""
from __future__ import annotations

import math

import numpy as np

from ..geodesy import MARS_RADIUS_M

C = 299_792_458.0
BOLTZMANN_DBW = -228.6


def horizon_distance_m(antenna_height_m: float, radius: float = MARS_RADIUS_M) -> float:
    return math.sqrt(2 * radius * max(0.0, antenna_height_m) + antenna_height_m**2)


def radio_horizon_m(h1: float, h2: float, radius: float = MARS_RADIUS_M) -> float:
    return horizon_distance_m(h1, radius) + horizon_distance_m(h2, radius)


def fresnel_nu(h_m: float, d1_m: float, d2_m: float, freq_hz: float) -> float:
    lam = C / freq_hz
    return h_m * math.sqrt(2.0 / lam * (d1_m + d2_m) / (d1_m * d2_m))


def itu_knife_edge_loss_db(nu: float) -> float:
    """ITU-R P.526 approximation J(nu); 0 dB for nu <= -0.78."""
    if nu <= -0.78:
        return 0.0
    return 6.9 + 20 * math.log10(math.sqrt((nu - 0.1) ** 2 + 1) + nu - 0.1)


def itu_knife_edge_loss_db_array(nu: np.ndarray) -> np.ndarray:
    out = 6.9 + 20 * np.log10(np.sqrt((nu - 0.1) ** 2 + 1) + nu - 0.1)
    return np.where(nu <= -0.78, 0.0, out)


def fspl_db(distance_m: float, freq_hz: float) -> float:
    d = max(distance_m, 1.0)
    return 20 * math.log10(4 * math.pi * d * freq_hz / C)


def link_margin_db(distance_m: float, diffraction_db: float = 0.0, freq_hz: float = 401.5e6,
                   tx_power_dbw: float = 10.0, tx_gain_dbi: float = 2.0, rx_gain_dbi: float = 2.0,
                   system_temp_k: float = 500.0, data_rate_bps: float = 256_000.0,
                   required_ebno_db: float = 4.5, misc_losses_db: float = 3.0) -> dict:
    """Proximity UHF link budget (declared nominal parameters)."""
    loss = fspl_db(distance_m, freq_hz)
    prx = tx_power_dbw + tx_gain_dbi + rx_gain_dbi - loss - diffraction_db - misc_losses_db
    n0 = BOLTZMANN_DBW + 10 * math.log10(system_temp_k)
    ebno = prx - n0 - 10 * math.log10(data_rate_bps)
    return {"fspl_db": loss, "diffraction_db": diffraction_db, "received_dbw": prx,
            "ebno_db": ebno, "margin_db": ebno - required_ebno_db}


def path_profile_diffraction(profile_elev: np.ndarray, distances: np.ndarray, h_tx: float, h_rx: float,
                             freq_hz: float = 401.5e6, radius: float = MARS_RADIUS_M) -> dict:
    """Single dominant knife edge (Bullington-like) along a terrain profile.

    profile_elev[0] is the transmitter ground, profile_elev[-1] the receiver ground.
    Earth-bulge (Mars-bulge) correction d1*d2/(2R) is included."""
    total = float(distances[-1])
    if total <= 0 or len(profile_elev) < 3:
        return {"nu": -10.0, "loss_db": 0.0, "los": True, "obstruction_m": 0.0}
    z_tx = profile_elev[0] + h_tx
    z_rx = profile_elev[-1] + h_rx
    d1 = distances[1:-1]
    d2 = total - d1
    bulge = d1 * d2 / (2 * radius)
    los_line = z_tx + (z_rx - z_tx) * d1 / total
    h = profile_elev[1:-1] + bulge - los_line
    lam = C / freq_hz
    nu = h * np.sqrt(2.0 / lam * total / np.maximum(d1 * d2, 1e-6))
    k = int(np.argmax(nu))
    nu_max = float(nu[k])
    return {"nu": nu_max, "loss_db": itu_knife_edge_loss_db(nu_max), "los": bool(h.max() <= 0),
            "obstruction_m": float(max(0.0, h[k]))}

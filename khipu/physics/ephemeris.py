"""Mars time and solar geometry (Allison & McEwen 2000, NASA GISS Mars24 algorithm).

Pure functions; terrain shadowing works on a supplied elevation grid."""
from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np

from ..geodesy import GridGeometry

DEG = math.pi / 180.0
SOL_SECONDS = 88775.244


def julian_date_utc(dt: datetime) -> float:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp() / 86400.0 + 2440587.5


def mars_time(dt: datetime, east_lon_deg: float = 0.0) -> dict:
    jd_ut = julian_date_utc(dt)
    jd_tt = jd_ut + (37 + 32.184) / 86400.0
    d2000 = jd_tt - 2451545.0
    m = (19.3871 + 0.52402073 * d2000) % 360.0
    alpha_fms = (270.3871 + 0.524038496 * d2000) % 360.0
    pbs = 0.0
    for a, tau, phi in ((0.0071, 2.2353, 49.409), (0.0057, 2.7543, 168.173), (0.0039, 1.1177, 191.837),
                        (0.0037, 15.7866, 21.736), (0.0021, 2.1354, 15.704), (0.0020, 2.4694, 95.528),
                        (0.0018, 32.8493, 49.095)):
        pbs += a * math.cos((0.985626 * d2000 / tau + phi) * DEG)
    mr = m * DEG
    nu_m = ((10.691 + 3.0e-7 * d2000) * math.sin(mr) + 0.623 * math.sin(2 * mr) + 0.050 * math.sin(3 * mr)
            + 0.005 * math.sin(4 * mr) + 0.0005 * math.sin(5 * mr) + pbs)
    ls = (alpha_fms + nu_m) % 360.0
    eot = 2.861 * math.sin(2 * ls * DEG) - 0.071 * math.sin(4 * ls * DEG) + 0.002 * math.sin(6 * ls * DEG) - nu_m
    msd = (d2000 - 4.5) / 1.0274912517 + 44796.0 - 0.0009626
    mtc = (24.0 * msd) % 24.0
    lmst = (mtc + east_lon_deg / 15.0) % 24.0
    ltst = (lmst + eot / 15.0) % 24.0
    dec = math.asin(0.42565 * math.sin(ls * DEG)) / DEG + 0.25 * math.sin(ls * DEG)
    subsolar_lon = (-(mtc + eot / 15.0 + 12.0) * 15.0) % 360.0  # east longitude
    helio_r = 1.5236 * (1.00436 - 0.09309 * math.cos(mr) - 0.004336 * math.cos(2 * mr)
                        - 0.00031 * math.cos(3 * mr) - 0.00003 * math.cos(4 * mr))
    return {"jd_tt": jd_tt, "msd": msd, "mtc_h": mtc, "lmst_h": lmst, "ltst_h": ltst, "ls_deg": ls,
            "eot_deg": eot, "declination_deg": dec, "subsolar_lon_deg": subsolar_lon, "helio_au": helio_r,
            "sol": int(msd)}


def solar_position(lat_deg: float, ltst_h: float, declination_deg: float) -> dict:
    """Solar elevation and azimuth (clockwise from north) from local true solar time."""
    h = (ltst_h - 12.0) * 15.0 * DEG
    lat = lat_deg * DEG
    dec = declination_deg * DEG
    sin_el = math.sin(lat) * math.sin(dec) + math.cos(lat) * math.cos(dec) * math.cos(h)
    el = math.asin(max(-1.0, min(1.0, sin_el)))
    az = math.atan2(-math.sin(h) * math.cos(dec),
                    math.cos(lat) * math.sin(dec) - math.sin(lat) * math.cos(dec) * math.cos(h))
    return {"elevation_deg": el / DEG, "azimuth_deg": (az / DEG + 360.0) % 360.0}


def sun_vector(elevation_deg: float, azimuth_deg: float) -> tuple[float, float, float]:
    """Unit vector (east, north, up)."""
    el, az = elevation_deg * DEG, azimuth_deg * DEG
    return (math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el))


def glare_risk(heading_deg: float, sun_el_deg: float, sun_az_deg: float, fov_half_deg: float = 25.0,
               max_el_deg: float = 20.0) -> dict:
    diff = abs((heading_deg - sun_az_deg + 180.0) % 360.0 - 180.0)
    risky = sun_el_deg > 0 and sun_el_deg < max_el_deg and diff < fov_half_deg
    severity = 0.0
    if risky:
        severity = (1 - diff / fov_half_deg) * (1 - sun_el_deg / max_el_deg)
    return {"glare": risky, "severity": severity, "relative_azimuth_deg": diff}


def terrain_shadow(elev: np.ndarray, geom: GridGeometry, sun_el_deg: float, sun_az_deg: float,
                   max_steps: int = 60) -> np.ndarray:
    """Boolean mask of cells shadowed by terrain (ray march toward the sun)."""
    if sun_el_deg <= 0:
        return np.ones_like(elev, dtype=bool)
    rows, cols = elev.shape
    tan_el = math.tan(sun_el_deg * DEG)
    az = sun_az_deg * DEG
    step_e, step_n = math.sin(az), math.cos(az)
    dy = geom.dy_m
    dx = float(np.mean(geom.dx_rows()))
    rr, cc = np.mgrid[0:rows, 0:cols]
    shadow = np.zeros(elev.shape, dtype=bool)
    base = elev.astype(np.float64)
    for k in range(1, max_steps + 1):
        r = np.clip(np.rint(rr - step_n * k).astype(int), 0, rows - 1)
        c = np.clip(np.rint(cc + step_e * k).astype(int), 0, cols - 1)
        dist = k * math.hypot(step_e * dx, step_n * dy)
        shadow |= elev[r, c] > base + dist * tan_el
    return shadow


def insolation_w_m2(elev: np.ndarray, slope_deg: np.ndarray, aspect_deg: np.ndarray, sun_el_deg: float,
                    sun_az_deg: float, helio_au: float, tau: float, shadow: np.ndarray | None = None) -> np.ndarray:
    """Direct + diffuse irradiance on the inclined surface."""
    s0 = 1361.0 / helio_au**2
    if sun_el_deg <= 0:
        return np.zeros_like(slope_deg)
    zen = (90.0 - sun_el_deg) * DEG
    direct_normal = s0 * math.exp(-tau / max(math.cos(zen), 0.05))
    sl = slope_deg * DEG
    # aspect is downslope direction; surface normal points toward aspect
    cos_inc = (np.cos(sl) * math.cos(zen) + np.sin(sl) * math.sin(zen) * np.cos((sun_az_deg - aspect_deg) * DEG))
    direct = direct_normal * np.clip(cos_inc, 0, None)
    if shadow is not None:
        direct = np.where(shadow, 0.0, direct)
    diffuse = s0 * math.cos(zen) * (1 - math.exp(-tau)) * 0.35 * (1 + np.cos(sl)) / 2
    return direct + diffuse

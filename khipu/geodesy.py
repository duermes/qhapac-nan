"""Mars geodesy helpers (pure, no I/O).

Conventions
-----------
* Planetocentric latitude, east-positive longitude (IAU2000), as used by MOLA MEGDR.
* Sphere radius 3 396 000 m (MEGDR label ``A_AXIS_RADIUS``).
* Local tangent-plane projection centred on (lat0, lon0) keeps metres isotropic:
  x (east) = R * cos(lat0) * dlon,  y (north) = R * dlat.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

MARS_RADIUS_M = 3_396_000.0
MARS_GRAVITY = 3.721  # m/s^2
EARTH_GRAVITY = 9.80665
DEG = math.pi / 180.0


def meters_per_degree_lat(radius: float = MARS_RADIUS_M) -> float:
    return radius * DEG


def meters_per_degree_lon(lat_deg: float, radius: float = MARS_RADIUS_M) -> float:
    """Geodesic factor: an east-west degree shrinks with cos(latitude)."""
    return radius * DEG * math.cos(lat_deg * DEG)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float, radius: float = MARS_RADIUS_M) -> float:
    p1, p2 = lat1 * DEG, lat2 * DEG
    dp = p2 - p1
    dl = (lon2 - lon1) * DEG
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial bearing clockwise from Mars north (0-360)."""
    p1, p2 = lat1 * DEG, lat2 * DEG
    dl = (lon2 - lon1) * DEG
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


@dataclass(frozen=True)
class TangentPlane:
    """Isotropic local projection around a reference point."""

    lat0: float
    lon0: float
    radius: float = MARS_RADIUS_M

    def to_xy(self, lat: float, lon: float) -> tuple[float, float]:
        x = self.radius * math.cos(self.lat0 * DEG) * (lon - self.lon0) * DEG
        y = self.radius * (lat - self.lat0) * DEG
        return x, y

    def to_latlon(self, x: float, y: float) -> tuple[float, float]:
        lat = self.lat0 + (y / self.radius) / DEG
        lon = self.lon0 + (x / (self.radius * math.cos(self.lat0 * DEG))) / DEG
        return lat, lon


@dataclass(frozen=True)
class GridGeometry:
    """Simple-cylindrical raster geometry (row 0 = northernmost)."""

    lat_max: float
    lon_min: float
    pixels_per_degree: float
    rows: int
    cols: int
    radius: float = MARS_RADIUS_M

    @property
    def lat_min(self) -> float:
        return self.lat_max - self.rows / self.pixels_per_degree

    @property
    def lon_max(self) -> float:
        return self.lon_min + self.cols / self.pixels_per_degree

    @property
    def dy_m(self) -> float:
        return self.radius * DEG / self.pixels_per_degree

    def row_lat(self, row: float) -> float:
        """Latitude of a pixel centre (fractional row accepted)."""
        return self.lat_max - (row + 0.5) / self.pixels_per_degree

    def col_lon(self, col: float) -> float:
        return self.lon_min + (col + 0.5) / self.pixels_per_degree

    def dx_m(self, row: float) -> float:
        return self.dy_m * math.cos(self.row_lat(row) * DEG)

    def dx_rows(self) -> np.ndarray:
        lats = self.lat_max - (np.arange(self.rows) + 0.5) / self.pixels_per_degree
        return self.dy_m * np.cos(lats * DEG)

    def latlon_to_rc(self, lat: float, lon: float) -> tuple[float, float]:
        row = (self.lat_max - lat) * self.pixels_per_degree - 0.5
        col = (lon - self.lon_min) * self.pixels_per_degree - 0.5
        return row, col

    def rc_to_latlon(self, row: float, col: float) -> tuple[float, float]:
        return self.row_lat(row), self.col_lon(col)

    def contains(self, lat: float, lon: float) -> bool:
        return self.lat_min <= lat <= self.lat_max and self.lon_min <= lon <= self.lon_max

    def to_dict(self) -> dict:
        return {
            "lat_max": self.lat_max,
            "lat_min": self.lat_min,
            "lon_min": self.lon_min,
            "lon_max": self.lon_max,
            "pixels_per_degree": self.pixels_per_degree,
            "rows": self.rows,
            "cols": self.cols,
            "dy_m": self.dy_m,
            "radius_m": self.radius,
        }


def slope_aspect(elev: np.ndarray, geom: GridGeometry) -> tuple[np.ndarray, np.ndarray]:
    """Slope (deg) and aspect (deg, clockwise from north, downslope direction).

    Uses central differences with the east-west spacing corrected per row by
    cos(latitude) so the metric is isotropic in metres.
    """
    z = np.asarray(elev, dtype=np.float64)
    dx = geom.dx_rows()[:, None]
    dy = geom.dy_m
    dzdx = np.zeros_like(z)
    dzdy = np.zeros_like(z)
    dzdx[:, 1:-1] = (z[:, 2:] - z[:, :-2]) / (2 * dx)
    dzdx[:, 0] = (z[:, 1] - z[:, 0]) / dx[:, 0]
    dzdx[:, -1] = (z[:, -1] - z[:, -2]) / dx[:, 0]
    # rows increase southwards: north gradient = -(d/drow)
    dzdy[1:-1, :] = -(z[2:, :] - z[:-2, :]) / (2 * dy)
    dzdy[0, :] = -(z[1, :] - z[0, :]) / dy
    dzdy[-1, :] = -(z[-1, :] - z[-2, :]) / dy
    grad = np.hypot(dzdx, dzdy)
    slope = np.degrees(np.arctan(grad))
    aspect = (np.degrees(np.arctan2(-dzdx, -dzdy)) + 360.0) % 360.0
    return slope, aspect


def local_relief(elev: np.ndarray, radius_px: int = 2) -> np.ndarray:
    """Max-min elevation range in a square window (roughness proxy, metres)."""
    z = np.asarray(elev, dtype=np.float64)
    pad = np.pad(z, radius_px, mode="edge")
    hi = np.full_like(z, -np.inf)
    lo = np.full_like(z, np.inf)
    n = 2 * radius_px + 1
    for dr in range(n):
        for dc in range(n):
            win = pad[dr : dr + z.shape[0], dc : dc + z.shape[1]]
            hi = np.maximum(hi, win)
            lo = np.minimum(lo, win)
    return hi - lo


def bilinear(grid: np.ndarray, row: float, col: float) -> float:
    r = min(max(row, 0.0), grid.shape[0] - 1.0)
    c = min(max(col, 0.0), grid.shape[1] - 1.0)
    r0, c0 = int(math.floor(r)), int(math.floor(c))
    r1, c1 = min(r0 + 1, grid.shape[0] - 1), min(c0 + 1, grid.shape[1] - 1)
    fr, fc = r - r0, c - c0
    top = grid[r0, c0] * (1 - fc) + grid[r0, c1] * fc
    bot = grid[r1, c0] * (1 - fc) + grid[r1, c1] * fc
    return float(top * (1 - fr) + bot * fr)

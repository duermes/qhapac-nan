"""Terrain context: elevation grid plus derived geometry, shared by all engines."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .geodesy import GridGeometry, bilinear, local_relief, slope_aspect


@dataclass
class TerrainContext:
    key: str
    elevation: np.ndarray            # metres, NaN = no data
    geometry: GridGeometry
    provenance: str = "derived_from_nasa"
    slope: np.ndarray = field(init=False)
    aspect: np.ndarray = field(init=False)
    relief: np.ndarray = field(init=False)
    valid: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        z = np.asarray(self.elevation, dtype=np.float64)
        self.valid = np.isfinite(z)
        filled = np.where(self.valid, z, np.nanmean(z) if self.valid.any() else 0.0)
        self.elevation = z
        self.slope, self.aspect = slope_aspect(filled, self.geometry)
        self.relief = local_relief(filled, 1)
        self.slope = np.where(self.valid, self.slope, np.nan)
        self._filled = filled

    @property
    def shape(self) -> tuple[int, int]:
        return self.elevation.shape

    def sample(self, lat: float, lon: float) -> dict:
        """Point query with explicit no-data handling (never invents elevations)."""
        if not self.geometry.contains(lat, lon):
            return {"inside": False, "elevation_m": None, "slope_deg": None, "aspect_deg": None,
                    "relief_m": None, "row": None, "col": None}
        r, c = self.geometry.latlon_to_rc(lat, lon)
        ri = int(round(min(max(r, 0), self.shape[0] - 1)))
        ci = int(round(min(max(c, 0), self.shape[1] - 1)))
        if not self.valid[ri, ci]:
            return {"inside": True, "elevation_m": None, "slope_deg": None, "aspect_deg": None,
                    "relief_m": None, "row": ri, "col": ci, "no_data": True}
        return {
            "inside": True,
            "elevation_m": bilinear(self._filled, r, c),
            "slope_deg": float(self.slope[ri, ci]),
            "aspect_deg": float(self.aspect[ri, ci]),
            "relief_m": float(self.relief[ri, ci]),
            "row": ri,
            "col": ci,
        }

    def elevation_at(self, lat: float, lon: float) -> float | None:
        return self.sample(lat, lon)["elevation_m"]

    def filled(self) -> np.ndarray:
        return self._filled


def synthetic_terrain(rows: int = 80, cols: int = 80, kind: str = "plain",
                      lat_max: float = 18.6, lon_min: float = 77.3, ppd: float = 128.0) -> TerrainContext:
    """Deterministic synthetic grids for tests/demo (provenance = synthetic)."""
    rr, cc = np.mgrid[0:rows, 0:cols].astype(float)
    if kind == "plain":
        z = 5.0 * np.sin(rr / 9.0) + 5.0 * np.cos(cc / 11.0)
    elif kind == "wall":
        # cliff wall with a single natural pass in the middle
        z = np.zeros((rows, cols))
        wall = (cc >= cols // 2 - 1) & (cc <= cols // 2 + 1)
        z[wall] = 900.0
        gap = (rr >= rows // 2 - 3) & (rr <= rows // 2 + 3)
        z[wall & gap] = 0.0
    elif kind == "cliff":
        z = np.where(cc > cols // 2, 1200.0, 0.0)
    elif kind == "ridge":
        z = 1500.0 * np.exp(-((cc - cols / 2) ** 2) / 30.0)
    elif kind == "spikes":
        z = np.zeros((rows, cols))
        z[rows // 2, cols // 2] = 800.0
    else:
        z = np.zeros((rows, cols))
    geom = GridGeometry(lat_max=lat_max, lon_min=lon_min, pixels_per_degree=ppd, rows=rows, cols=cols)
    return TerrainContext(f"synthetic_{kind}", z, geom, provenance="synthetic")

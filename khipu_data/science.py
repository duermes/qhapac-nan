"""Read the versioned, portable catalog imported from NASA and USGS."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from khipu.geodesy import GridGeometry

from .regions import DATA


class ScienceCatalog:
    def __init__(self, directory: Path = DATA / "official_science"):
        catalog = directory / "catalog.json"
        self.data = json.loads(catalog.read_text(encoding="utf-8")) if catalog.is_file() else {
            "points": [], "sources": [], "geology_legend": [],
        }
        self.entities = [
            {**point, "provenance": "official_nasa", "source": "official_science",
             "locked": True, "editable": False, "mobile": False}
            for point in self.data["points"]
        ]
        track = directory / "perseverance_traverse.json"
        self.track = json.loads(track.read_text(encoding="utf-8")) if track.is_file() else None
        self.geology = None
        raster = directory / "usgs_geology.npz"
        if raster.is_file():
            with np.load(raster, allow_pickle=False) as archive:
                self.geology = archive["codes"]
                self.bounds = archive["bounds"]

    def covers(self, grid: GridGeometry) -> bool:
        if self.geology is None:
            return False
        west, south, east, north = self.bounds
        return grid.lon_min < east and grid.lon_max > west and grid.lat_min < north and grid.lat_max > south

    def geology_grid(self, grid: GridGeometry) -> np.ndarray:
        west, south, east, north = self.bounds
        rows, cols = self.geology.shape
        lat = grid.row_lat(np.arange(grid.rows))
        lon = grid.col_lon(np.arange(grid.cols))
        r = (north - lat) * rows / (north - south)
        c = (lon - west) * cols / (east - west)
        has_data = ((r >= 0) & (r < rows))[:, None] & ((c >= 0) & (c < cols))[None, :]
        ri = np.clip(r.astype(int), 0, rows - 1)
        ci = np.clip(c.astype(int), 0, cols - 1)
        values = self.geology[np.ix_(ri, ci)]
        return np.where(has_data & (values > 0), values, np.nan)

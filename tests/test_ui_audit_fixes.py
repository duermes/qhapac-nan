"""REF-205..206 — projection scaling and slope peaks."""
import math

import numpy as np

from khipu.geodesy import TangentPlane, meters_per_degree_lat, meters_per_degree_lon
from khipu.terrain import synthetic_terrain


def test_tangent_plane_coordinate_scaling():
    tp = TangentPlane(18.44, 77.45)
    x, y = tp.to_xy(18.44, 77.46)
    x2, y2 = tp.to_xy(18.45, 77.45)
    assert abs(x - meters_per_degree_lon(18.44) * 0.01) < 1
    assert abs(y2 - meters_per_degree_lat() * 0.01) < 1
    assert abs(x / y2 - math.cos(math.radians(18.44))) < 1e-6  # isotropic metres
    lat, lon = tp.to_latlon(*tp.to_xy(18.5, 77.6))
    assert abs(lat - 18.5) < 1e-9 and abs(lon - 77.6) < 1e-9


def test_high_frequency_slope_peaks():
    t = synthetic_terrain(21, 21, "spikes")
    peak = t.slope[10, 9:12]
    assert np.nanmax(t.slope) > 40  # a single-cell spike is not smoothed away
    assert t.slope[0, 0] == 0
    # slope uses latitude-corrected spacing: east-west neighbour steeper than north-south
    assert t.slope[10, 9] > t.slope[9, 10]

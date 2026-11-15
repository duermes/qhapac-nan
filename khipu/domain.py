"""Khipu domain model (pure Python, independent of network and disk)."""
from __future__ import annotations

import math
import time
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Callable

import numpy as np

from .geodesy import GridGeometry, haversine_m


class Provenance(str, Enum):
    OFFICIAL_NASA = "official_nasa"
    OFFICIAL_USGS = "official_usgs"
    DERIVED_FROM_NASA = "derived_from_nasa"
    LIVE_SERVICE = "live_service"
    CACHED = "cached"
    MODEL = "model"  # physics model evaluated on declared parameters
    SYNTHETIC = "synthetic"
    UNAVAILABLE = "unavailable"


class AssetKind(str, Enum):
    ROVER = "rover"
    ASTRONAUT = "astronaut"
    BASE = "base"
    HABITAT = "habitat"
    ANTENNA = "antenna"
    WAYPOINT = "waypoint"
    POI = "poi"
    SAMPLE = "sample"
    HAZARD = "hazard"
    LANDMARK = "landmark"
    LAVA_PIT = "lava_pit"
    LABORATORY = "laboratory"


MOBILE_KINDS = {AssetKind.ROVER, AssetKind.ASTRONAUT}


@dataclass
class GeoPoint:
    lat: float
    lon: float
    elevation_m: float | None = None

    def distance_to(self, other: "GeoPoint") -> float:
        return haversine_m(self.lat, self.lon, other.lat, other.lon)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Asset:
    """Base class of every mapped entity."""

    id: str
    name: str
    kind: AssetKind
    position: GeoPoint
    provenance: Provenance = Provenance.SYNTHETIC
    metadata: dict[str, Any] = field(default_factory=dict)
    locked: bool = False

    @property
    def is_mobile(self) -> bool:
        return False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind.value,
            "lat": self.position.lat,
            "lon": self.position.lon,
            "elevation_m": self.position.elevation_m,
            "provenance": self.provenance.value,
            "mobile": self.is_mobile,
            "locked": self.locked,
            "metadata": self.metadata,
        }


@dataclass
class StaticAsset(Asset):
    """Base, habitat, antenna, POI, waypoint: never routed as a vehicle."""

    def move_to(self, *_: Any) -> None:
        raise PermissionError(f"{self.kind.value} '{self.id}' is static and cannot be driven")


@dataclass
class MobileAsset(Asset):
    """Rover or astronaut able to traverse terrain."""

    max_slope_deg: float = 20.0
    speed_mps: float = 0.1
    resources: dict[str, float] = field(default_factory=dict)
    heading_deg: float = 0.0
    virtual: bool = False

    def to_dict(self) -> dict:
        return {**super().to_dict(), "virtual": self.virtual, "resources": self.resources,
                "max_slope_deg": self.max_slope_deg, "speed_mps": self.speed_mps, "heading_deg": self.heading_deg}

    @property
    def is_mobile(self) -> bool:
        return True

    def move_to(self, lat: float, lon: float, elevation_m: float | None = None) -> None:
        if self.locked:
            raise PermissionError(f"asset '{self.id}' is locked")
        self.position = GeoPoint(lat, lon, elevation_m)


def make_asset(data: dict) -> Asset:
    kind = AssetKind(data["kind"])
    pos = GeoPoint(float(data["lat"]), float(data["lon"]), data.get("elevation_m"))
    common = dict(
        id=str(data["id"]),
        name=str(data.get("name") or data["id"]),
        kind=kind,
        position=pos,
        provenance=Provenance(data.get("provenance", "synthetic")),
        metadata=dict(data.get("metadata") or {}),
        locked=bool(data.get("locked", False)),
    )
    if kind in MOBILE_KINDS:
        default_slope = 20.0 if kind == AssetKind.ROVER else 25.0
        default_speed = 0.12 if kind == AssetKind.ROVER else 1.0
        return MobileAsset(
            **common,
            max_slope_deg=float(data.get("max_slope_deg", default_slope)),
            speed_mps=float(data.get("speed_mps", default_speed)),
            resources=dict(data.get("resources") or {}),
            heading_deg=float(data.get("heading_deg", 0.0)),
            virtual=bool(data.get("virtual", False)),
        )
    return StaticAsset(**common)


@dataclass
class GeoRegion:
    key: str
    name: str
    geometry: GridGeometry
    provenance: Provenance
    parent: str | None = None
    focus_bbox: dict[str, float] | None = None
    description: str = ""

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "name": self.name,
            "geometry": self.geometry.to_dict(),
            "provenance": self.provenance.value,
            "parent": self.parent,
            "focus_bbox": self.focus_bbox,
            "description": self.description,
        }


@dataclass
class Field:
    """A raster quantity defined over a region."""

    id: str
    name: str
    units: str
    provenance: Provenance
    description: str = ""
    temporal: bool = False

    def describe(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "units": self.units,
            "provenance": self.provenance.value,
            "description": self.description,
            "temporal": self.temporal,
            "kind": type(self).__name__,
        }


@dataclass
class StaticField(Field):
    data: np.ndarray | None = None

    def value(self) -> np.ndarray:
        if self.data is None:
            raise ValueError(f"field {self.id} has no data")
        return self.data


@dataclass
class RealtimeField(Field):
    """Field evaluated from parameters (solar time, dust...)."""

    evaluator: Callable[[dict], np.ndarray] | None = None
    temporal: bool = True

    def value(self, params: dict) -> np.ndarray:
        if self.evaluator is None:
            raise ValueError(f"field {self.id} has no evaluator")
        return self.evaluator(params)


@dataclass
class TimeSeries:
    name: str
    units: str
    times: list[float] = field(default_factory=list)
    values: list[float] = field(default_factory=list)

    def append(self, t: float, v: float) -> None:
        if self.times and t < self.times[-1]:
            raise ValueError("time series must be monotonic")
        self.times.append(t)
        self.values.append(v)

    def latest(self) -> float | None:
        return self.values[-1] if self.values else None

    def rate(self) -> float | None:
        if len(self.values) < 2 or self.times[-1] == self.times[-2]:
            return None
        return (self.values[-1] - self.values[-2]) / (self.times[-1] - self.times[-2])


@dataclass
class Snapshot:
    """Immutable view of a field at a given instant and parameter set."""

    field_id: str
    params: dict
    data: np.ndarray
    units: str
    provenance: Provenance
    created_at: float = field(default_factory=time.time)

    def stats(self) -> dict:
        finite = self.data[np.isfinite(self.data)]
        if finite.size == 0:
            return {"min": None, "max": None, "mean": None, "coverage": 0.0}
        return {
            "min": float(finite.min()),
            "max": float(finite.max()),
            "mean": float(finite.mean()),
            "coverage": float(finite.size / self.data.size),
        }


def angle_diff(a: float, b: float) -> float:
    return (a - b + 180.0) % 360.0 - 180.0


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def finite_or_none(v: float | None) -> float | None:
    if v is None or not math.isfinite(v):
        return None
    return float(v)

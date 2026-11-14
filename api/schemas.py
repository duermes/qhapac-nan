"""Validated API contracts shared with the web client (see web/shared/js/api.js)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

Profile = Literal["rover", "astronaut"]


class LatLon(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-360, le=360)
    id: str | None = None
    kind: str | None = None
    name: str | None = None


class RouteParams(BaseModel):
    max_slope_deg: float | None = Field(default=None, gt=0, le=45)
    walkback_limit_m: float | None = Field(default=None, ge=1000, le=2000)
    reserve_fraction: float | None = Field(default=None, ge=0, le=0.8)
    resources_available: float | None = Field(default=None, ge=-1e6)
    resources_capacity: float | None = Field(default=None, gt=0)
    speed_mps: float | None = Field(default=None, gt=0, le=5)
    weights: dict[str, float] | None = None
    obstacles: list[dict[str, Any]] | None = None


class RouteRequest(BaseModel):
    region_key: str | None = None
    session_id: str | None = None
    origin: LatLon
    destination: LatLon
    waypoints: list[LatLon] = []
    asset_id: str | None = None
    profile: Profile | None = None
    variants: bool = True
    params: RouteParams = RouteParams()


class ReplanRequest(BaseModel):
    region_key: str | None = None
    current: LatLon
    destination: LatLon
    route_points: list[dict[str, Any]] = []
    obstacles: list[dict[str, Any]] = []
    profile: Profile = "rover"
    asset_id: str | None = None
    params: RouteParams = RouteParams()


class CostmapRequest(BaseModel):
    region_key: str | None = None
    profile: Profile = "rover"
    max_slope_deg: float | None = Field(default=None, gt=0, le=45)
    weights: dict[str, float] | None = None
    hazards: list[dict[str, Any]] = []
    walkback: dict[str, float] | None = None
    include_grid: bool = False
    stride: int = Field(default=2, ge=1, le=16)


class AssetIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    kind: str
    lat: float
    lon: float
    session_id: str = "S1"
    elevation_m: float | None = None
    metadata: dict[str, Any] = {}
    locked: bool = False

    @field_validator("kind")
    @classmethod
    def kind_ok(cls, v: str) -> str:
        allowed = {"rover", "astronaut", "base", "habitat", "antenna", "waypoint", "poi", "sample", "hazard", "landmark"}
        if v not in allowed:
            raise ValueError(f"kind must be one of {sorted(allowed)}")
        return v


class AssetPatch(BaseModel):
    name: str | None = None
    lat: float | None = None
    lon: float | None = None
    metadata: dict[str, Any] | None = None
    locked: bool | None = None
    unlock: bool = False


class SessionAction(BaseModel):
    session_id: str
    ids: list[str] | None = None


class IngestRequest(BaseModel):
    key: str = Field(pattern=r"^[a-z0-9_]{2,40}$")
    name: str
    lat_min: float
    lat_max: float
    lon_min: float
    lon_max: float


class InjectRequest(BaseModel):
    kind: str
    params: dict[str, Any] = {}


class FailoverRequest(BaseModel):
    force_out: str | None = None


class ExportRequest(BaseModel):
    route: dict[str, Any]
    name: str = "travesia"


class VoiceRequest(BaseModel):
    text: str = Field(max_length=500)
    interface: Literal["console", "rover", "hud"] = "console"


class TelemetrySnapshot(BaseModel):
    battery_pct: float | None = None
    o2_pct: float | None = None
    link_margin_db: float | None = None
    heart_rate_bpm: float | None = None
    slope_deg: float | None = None
    pnr_exceeded: bool = False
    hazard_proximity_m: float | None = None
    emergency_stop: bool = False
    reset: bool = False


class LocalizationRequest(BaseModel):
    state: dict[str, Any]
    step: dict[str, float] | None = None
    fix: dict[str, float] | None = None


class AutopilotRequest(BaseModel):
    lat: float
    lon: float
    heading_deg: float
    path: list[dict[str, Any]]
    slope_deg: float = 0.0
    roll_deg: float = 0.0
    link_ok: bool = True
    emergency: bool = False


class EvaVitalsRequest(BaseModel):
    speed_mps: float = 0.0
    gradient: float = 0.0
    elapsed_s: float = 0.0
    o2_kg: float = 1.2
    water_kg: float = 3.6
    battery_wh: float = 1100.0
    grip_fraction: float = 0.2
    grip_minutes: float = 0.0
    distance_to_base_m: float = 0.0
    walkback_limit_m: float = 2000.0


class LedgerConsume(BaseModel):
    amount: float = Field(ge=0)
    profile: Profile = "rover"
    note: str = ""

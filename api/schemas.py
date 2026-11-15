"""Validated API contracts shared with the web client (see web/shared/js/api.js)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from khipu.domain import AssetKind
from khipu.resources import EVA_WALKBACK_LIMIT_M

Profile = Literal["rover", "astronaut"]


class LatLon(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-360, le=360)
    id: str | None = None
    kind: str | None = None
    name: str | None = None


class MobileSettings(BaseModel):
    max_slope_deg: float | None = Field(default=None, gt=0, le=45)
    speed_mps: float | None = Field(default=None, gt=0, le=5)
    resources: dict[Literal["o2_kg", "water_kg", "battery_wh"], float] | None = None

    @field_validator("resources")
    @classmethod
    def resource_levels(cls, resources):
        import math
        if resources and any(not math.isfinite(v) or v < 0 for v in resources.values()):
            raise ValueError("Los recursos deben ser cantidades finitas y no negativas")
        return resources


class RouteParams(BaseModel):
    ltst_h: float = Field(default=13, ge=0, le=24)
    tau: float = Field(default=0.5, ge=0, le=10)
    min_temperature_c: float = Field(default=-105, ge=-170, le=80)
    max_temperature_c: float = Field(default=45, ge=-160, le=100)
    max_dust_tau: float = Field(default=3, gt=0, le=10)
    min_light_w_m2: float = Field(default=0.1, gt=0, le=1000)
    min_link_db: float = Field(default=0, ge=-40, le=40)
    max_blackout_s: float = Field(default=900, ge=0, le=7200)
    max_distance_m: float | None = Field(default=None, gt=0)

    max_slope_deg: float | None = Field(default=None, gt=0, le=45)
    walkback_limit_m: float | None = Field(default=None, ge=1000, le=EVA_WALKBACK_LIMIT_M)
    reserve_fraction: float | None = Field(default=None, ge=0, le=0.8)
    reserve_o2_fraction: float | None = Field(default=None, ge=0, le=0.8)
    reserve_water_fraction: float | None = Field(default=None, ge=0, le=0.8)
    reserve_battery_fraction: float | None = Field(default=None, ge=0, le=0.8)
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
    variants: bool = False  # legacy request field; the response contains one operational route
    params: RouteParams = RouteParams()


class ReplanRequest(BaseModel):
    region_key: str | None = None
    session_id: str | None = None
    current: LatLon
    destination: LatLon
    reevaluate: bool = False
    return_prefix: list[EvaSurfacePoint] = Field(default_factory=list, max_length=10000)
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


class AssetIn(MobileSettings):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    kind: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-360, le=360)
    session_id: str = "S1"
    elevation_m: float | None = None
    metadata: dict[str, Any] = {}
    locked: bool = False

    @field_validator("kind")
    @classmethod
    def kind_ok(cls, v: str) -> str:
        allowed = {kind.value for kind in AssetKind}
        if v not in allowed:
            raise ValueError(f"kind must be one of {sorted(allowed)}")
        return v


class AssetPatch(MobileSettings):
    name: str | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-360, le=360)
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


class VoicePoint(BaseModel):
    id: str = Field(max_length=80)
    name: str = Field(max_length=160)
    description: str = Field(default="", max_length=500)


class VoiceRequest(BaseModel):
    language: Literal["es", "en"] = "es"
    text: str = Field(max_length=500)
    interface: Literal["console", "rover", "hud"] = "console"
    points: list[VoicePoint] = Field(default_factory=list, max_length=100)


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
    walkback_limit_m: float = Field(default=EVA_WALKBACK_LIMIT_M, ge=1000, le=EVA_WALKBACK_LIMIT_M)


class EvaSurfacePoint(BaseModel):
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=360, allow_inf_nan=False)
    elevation_m: float = Field(allow_inf_nan=False)


class EvaSurfaceRoute(BaseModel):
    asset_id: str
    points: list[EvaSurfacePoint] = Field(min_length=2, max_length=2000)
    ltst_h: float = Field(default=13, ge=0, le=24)
    available_o2_kg: float = Field(ge=0, le=1.2)
    available_water_kg: float | None = Field(default=None, ge=0, le=3.6)
    available_battery_wh: float | None = Field(default=None, ge=0, le=1100)


class EvaResupplyRequest(BaseModel):
    asset_id: str
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=360, allow_inf_nan=False)


class LedgerConsume(BaseModel):
    amount: float = Field(ge=0)
    profile: Profile = "rover"
    note: str = ""

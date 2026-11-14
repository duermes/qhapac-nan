"""Operational engines: localisation, mission FSM, peer redundancy, contingency
harness and autopilot (pure pursuit with safety envelope)."""
from __future__ import annotations

import copy
import math
import time
from dataclasses import dataclass, field

from .geodesy import MARS_RADIUS_M, TangentPlane, bearing_deg, haversine_m

# ---------------------------------------------------------------- localisation


@dataclass
class Localizer:
    """Dead-reckoning with growing uncertainty and absolute geodetic fixes."""

    lat: float
    lon: float
    heading_deg: float = 0.0
    sigma_along_m: float = 5.0
    sigma_cross_m: float = 5.0
    drift_along: float = 0.02   # fraction of distance travelled
    drift_cross: float = 0.035
    odometer_m: float = 0.0
    fix_sigma_m: float = 3.0
    last_fix: dict | None = None

    def advance(self, distance_m: float, heading_deg: float, slip: float = 0.0) -> None:
        """Odometry step: wheel slip shortens true travel and inflates error."""
        true_d = distance_m * (1.0 - slip)
        plane = TangentPlane(self.lat, self.lon)
        x = true_d * math.sin(math.radians(heading_deg))
        y = true_d * math.cos(math.radians(heading_deg))
        self.lat, self.lon = plane.to_latlon(x, y)
        self.heading_deg = heading_deg % 360
        self.odometer_m += distance_m
        self.sigma_along_m = math.hypot(self.sigma_along_m, distance_m * (self.drift_along + slip * 0.5))
        self.sigma_cross_m = math.hypot(self.sigma_cross_m, distance_m * self.drift_cross)

    def absolute_fix(self, lat: float, lon: float, sigma_m: float | None = None, source: str = "orbital") -> None:
        s = sigma_m if sigma_m is not None else self.fix_sigma_m
        self.lat, self.lon = lat, lon
        self.sigma_along_m = s
        self.sigma_cross_m = s
        self.last_fix = {"lat": lat, "lon": lon, "sigma_m": s, "source": source, "odometer_m": self.odometer_m}

    def ellipse(self, confidence_k: float = 2.4477) -> dict:
        """95% ellipse (k for 2 dof)."""
        return {"center": {"lat": self.lat, "lon": self.lon},
                "semi_major_m": confidence_k * max(self.sigma_along_m, self.sigma_cross_m),
                "semi_minor_m": confidence_k * min(self.sigma_along_m, self.sigma_cross_m),
                "orientation_deg": self.heading_deg if self.sigma_along_m >= self.sigma_cross_m else (self.heading_deg + 90) % 360,
                "radius_m": confidence_k * math.hypot(self.sigma_along_m, self.sigma_cross_m) / math.sqrt(2)}


# ---------------------------------------------------------------- mission FSM

GO, CAUTION, ABORT = "GO", "CAUTION", "ABORT"


@dataclass
class MissionFSM:
    state: str = GO
    reasons: list[str] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)
    thresholds: dict = field(default_factory=lambda: {
        "battery_caution": 35.0, "battery_abort": 15.0,
        "o2_caution": 40.0, "o2_abort": 20.0,
        "link_caution_db": 3.0, "link_abort_db": -3.0,
        "hr_caution": 150.0, "hr_abort": 175.0,
        "slope_caution": 15.0, "slope_abort": 25.0,
    })

    def evaluate(self, snap: dict) -> str:
        th = self.thresholds
        abort, caution = [], []

        def check(key, value, c_th, a_th, low_is_bad=True, label=None):
            if value is None:
                return
            label = label or key
            bad_a = value <= a_th if low_is_bad else value >= a_th
            bad_c = value <= c_th if low_is_bad else value >= c_th
            if bad_a:
                abort.append(f"{label}={value:.1f}")
            elif bad_c:
                caution.append(f"{label}={value:.1f}")

        check("battery", snap.get("battery_pct"), th["battery_caution"], th["battery_abort"], label="batería%")
        check("o2", snap.get("o2_pct"), th["o2_caution"], th["o2_abort"], label="O2%")
        check("link", snap.get("link_margin_db"), th["link_caution_db"], th["link_abort_db"], label="enlace dB")
        check("hr", snap.get("heart_rate_bpm"), th["hr_caution"], th["hr_abort"], low_is_bad=False, label="FC")
        check("slope", snap.get("slope_deg"), th["slope_caution"], th["slope_abort"], low_is_bad=False, label="pendiente°")
        if snap.get("pnr_exceeded"):
            abort.append("PNR superado")
        if snap.get("hazard_proximity_m") is not None and snap["hazard_proximity_m"] < 50:
            caution.append("peligro cercano")
        if snap.get("emergency_stop"):
            abort.append("parada de emergencia")
        new = ABORT if abort else (CAUTION if caution else GO)
        # ABORT latches until explicit reset
        if self.state == ABORT and new != ABORT and not snap.get("reset"):
            new = ABORT
            abort = self.reasons or ["latched"]
        if new != self.state:
            self.history.append({"from": self.state, "to": new, "t": snap.get("t", time.time()), "reasons": abort or caution})
        self.state = new
        self.reasons = abort or caution
        return self.state

    def to_dict(self) -> dict:
        return {"state": self.state, "reasons": self.reasons, "history": self.history[-20:]}


# ---------------------------------------------------------------- redundancy


@dataclass
class Peer:
    peer_id: str
    role: str
    priority: int
    endpoint: str = ""
    last_heartbeat: float = 0.0
    costmap_version: int = 0


class PeerSwarm:
    def __init__(self, timeout_s: float = 6.0, degraded_s: float = 3.0):
        self.peers: dict[str, Peer] = {}
        self.timeout_s = timeout_s
        self.degraded_s = degraded_s
        self.leader_id: str | None = None
        self.costmap_version = 0
        self.events: list[dict] = []

    def register(self, peer_id: str, role: str = "node", priority: int = 10, endpoint: str = "", now: float | None = None) -> Peer:
        p = Peer(peer_id, role, priority, endpoint, now if now is not None else time.time())
        self.peers[peer_id] = p
        self.events.append({"event": "discovered", "peer": peer_id})
        if self.leader_id is None:
            self.elect(now)
        return p

    def heartbeat(self, peer_id: str, now: float | None = None, costmap_version: int | None = None) -> None:
        p = self.peers[peer_id]
        p.last_heartbeat = now if now is not None else time.time()
        if costmap_version is not None:
            p.costmap_version = costmap_version

    def health(self, peer_id: str, now: float | None = None) -> str:
        now = now if now is not None else time.time()
        age = now - self.peers[peer_id].last_heartbeat
        if age > self.timeout_s:
            return "lost"
        if age > self.degraded_s:
            return "degraded"
        return "healthy"

    def elect(self, now: float | None = None) -> str | None:
        alive = [p for p in self.peers.values() if self.health(p.peer_id, now) != "lost"]
        if not alive:
            self.leader_id = None
            return None
        leader = min(alive, key=lambda p: (p.priority, p.peer_id))
        if leader.peer_id != self.leader_id:
            self.events.append({"event": "leader", "peer": leader.peer_id, "previous": self.leader_id})
        self.leader_id = leader.peer_id
        return self.leader_id

    def failover(self, now: float | None = None, force_out: str | None = None) -> dict:
        prev = self.leader_id
        if force_out and force_out in self.peers:
            self.peers[force_out].last_heartbeat = -1e12
        new = self.elect(now)
        self.events.append({"event": "failover", "from": prev, "to": new})
        return {"previous_leader": prev, "new_leader": new, "changed": prev != new}

    def broadcast_costmap(self, now: float | None = None) -> int:
        self.costmap_version += 1
        for p in self.peers.values():
            if self.health(p.peer_id, now) != "lost":
                p.costmap_version = self.costmap_version
        self.events.append({"event": "costmap_broadcast", "version": self.costmap_version})
        return self.costmap_version

    def status(self, now: float | None = None) -> dict:
        return {
            "leader": self.leader_id,
            "costmap_version": self.costmap_version,
            "peers": [{"peer_id": p.peer_id, "role": p.role, "priority": p.priority,
                       "health": self.health(p.peer_id, now), "costmap_version": p.costmap_version,
                       "in_sync": p.costmap_version == self.costmap_version} for p in self.peers.values()],
            "events": self.events[-15:],
        }


# ---------------------------------------------------------------- contingency harness

CONTINGENCIES = {
    "dust_storm": {"label": "Tormenta de polvo", "effects": {"tau_multiplier": 3.5, "solar_power_factor": 0.35}},
    "comms_blackout": {"label": "Pérdida de enlace", "effects": {"link_margin_offset_db": -25.0}},
    "battery_fault": {"label": "Falla de batería", "effects": {"battery_capacity_factor": 0.55}},
    "obstacle": {"label": "Obstáculo en ruta", "effects": {"obstacle": True}},
    "suit_leak": {"label": "Fuga en traje", "effects": {"o2_rate_factor": 2.2}},
    "wheel_slip": {"label": "Deslizamiento de rueda", "effects": {"slip_offset": 0.35}},
}


class DemoHarness:
    """Injects simulated contingencies into an overlay copy. The production
    model object passed in is never mutated."""

    def __init__(self):
        self.active: list[dict] = []

    def inject(self, kind: str, params: dict | None = None) -> dict:
        if kind not in CONTINGENCIES:
            raise ValueError(f"unknown contingency '{kind}'")
        ev = {"id": f"INJ-{len(self.active) + 1:03d}", "kind": kind, "label": CONTINGENCIES[kind]["label"],
              "effects": dict(CONTINGENCIES[kind]["effects"]), "params": params or {}, "simulation": True,
              "t": time.time()}
        self.active.append(ev)
        return ev

    def clear(self) -> None:
        self.active.clear()

    def apply(self, model_state: dict) -> dict:
        overlay = copy.deepcopy(model_state)
        overlay["simulation"] = bool(self.active)
        overlay["injections"] = [e["id"] for e in self.active]
        for e in self.active:
            fx = e["effects"]
            if "tau_multiplier" in fx and "tau" in overlay:
                overlay["tau"] = overlay["tau"] * fx["tau_multiplier"]
            if "link_margin_offset_db" in fx and "link_margin_db" in overlay:
                overlay["link_margin_db"] += fx["link_margin_offset_db"]
            if "battery_capacity_factor" in fx and "battery_pct" in overlay:
                overlay["battery_pct"] *= fx["battery_capacity_factor"]
            if "slip_offset" in fx and "slip" in overlay:
                overlay["slip"] = min(1.0, overlay["slip"] + fx["slip_offset"])
            if fx.get("obstacle") and e["params"].get("lat") is not None:
                overlay.setdefault("obstacles", []).append({"lat": e["params"]["lat"], "lon": e["params"]["lon"],
                                                            "radius_m": e["params"].get("radius_m", 400.0)})
        return overlay


# ---------------------------------------------------------------- autopilot


@dataclass
class PurePursuit:
    lookahead_m: float = 900.0
    max_speed_mps: float = 0.15
    max_turn_rate_dps: float = 20.0
    max_slope_deg: float = 20.0
    max_roll_deg: float = 15.0

    def command(self, lat: float, lon: float, heading_deg: float, path: list[dict], slope_deg: float = 0.0,
                roll_deg: float = 0.0, link_ok: bool = True, emergency: bool = False) -> dict:
        if emergency:
            return {"speed_mps": 0.0, "steer_deg": 0.0, "state": "E-STOP", "reason": "parada de emergencia"}
        if slope_deg > self.max_slope_deg or abs(roll_deg) > self.max_roll_deg:
            return {"speed_mps": 0.0, "steer_deg": 0.0, "state": "HOLD", "reason": "fuera de envolvente de seguridad"}
        if not path:
            return {"speed_mps": 0.0, "steer_deg": 0.0, "state": "IDLE", "reason": "sin ruta"}
        # nearest index then look ahead
        dists = [haversine_m(lat, lon, p["lat"], p["lon"]) for p in path]
        i = min(range(len(path)), key=lambda k: dists[k])
        target = path[-1]
        acc = 0.0
        for k in range(i, len(path) - 1):
            acc += haversine_m(path[k]["lat"], path[k]["lon"], path[k + 1]["lat"], path[k + 1]["lon"])
            if acc >= self.lookahead_m:
                target = path[k + 1]
                break
        brg = bearing_deg(lat, lon, target["lat"], target["lon"])
        alpha = (brg - heading_deg + 180) % 360 - 180
        steer = max(-self.max_turn_rate_dps, min(self.max_turn_rate_dps, alpha))
        remaining = haversine_m(lat, lon, path[-1]["lat"], path[-1]["lon"])
        speed = self.max_speed_mps * max(0.3, 1 - abs(alpha) / 90) * max(0.4, 1 - slope_deg / self.max_slope_deg)
        if not link_ok:
            speed *= 0.5
        state = "ARRIVED" if remaining < 30 else "TRACKING"
        if state == "ARRIVED":
            speed = 0.0
        return {"speed_mps": speed, "steer_deg": steer, "target": {"lat": target["lat"], "lon": target["lon"]},
                "bearing_deg": brg, "cross_track_m": dists[i], "remaining_m": remaining, "state": state}

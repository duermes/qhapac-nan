"""JSON persistence for assets, sessions/workspace, preferences and ledgers."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from .regions import DATA

STATE_DIR = DATA / "userstate"


class JsonStore:
    def __init__(self, directory: Path = STATE_DIR):
        self.dir = directory
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, name: str) -> Path:
        return self.dir / f"{name}.json"

    def read(self, name: str, default):
        p = self._path(name)
        if not p.exists():
            return default
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return default

    def write(self, name: str, value) -> None:
        with self._lock:
            tmp = self._path(name).with_suffix(".tmp")
            tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._path(name))


class AssetRepository:
    """General (persistent) assets plus per-session scratch assets."""

    def __init__(self, store: JsonStore):
        self.store = store

    def _all(self) -> dict:
        return self.store.read("assets", {"general": [], "sessions": {}})

    def list(self, session_id: str | None = None) -> dict:
        d = self._all()
        return {"general": d["general"], "session": d["sessions"].get(session_id or "", [])}

    def add(self, asset: dict, session_id: str = "S1") -> dict:
        d = self._all()
        asset = {**asset, "created_at": time.time(), "session_id": session_id}
        lst = d["sessions"].setdefault(session_id, [])
        lst[:] = [a for a in lst if a["id"] != asset["id"]] + [asset]
        self.store.write("assets", d)
        return asset

    def update(self, asset_id: str, patch: dict, session_id: str | None = None, terrain=None) -> dict | None:
        d = self._all()
        pools = [d["general"]] + list(d["sessions"].values())
        for pool in pools:
            for a in pool:
                if a["id"] == asset_id:
                    if a.get("locked") and not patch.get("unlock"):
                        raise PermissionError("asset locked (saved route)")
                    changes = {k: v for k, v in patch.items() if k != "unlock"}
                    if ({"lat", "lon"} & changes.keys()) and terrain is not None:
                        changes["elevation_m"] = terrain.elevation_at(changes.get("lat", a["lat"]), changes.get("lon", a["lon"]))
                    a.update(changes)
                    self.store.write("assets", d)
                    return a
        return None

    def delete(self, asset_id: str) -> bool:
        d = self._all()
        n0 = len(d["general"]) + sum(len(v) for v in d["sessions"].values())
        d["general"] = [a for a in d["general"] if a["id"] != asset_id]
        for k in d["sessions"]:
            d["sessions"][k] = [a for a in d["sessions"][k] if a["id"] != asset_id]
        n1 = len(d["general"]) + sum(len(v) for v in d["sessions"].values())
        self.store.write("assets", d)
        return n1 < n0

    def save_to_general(self, session_id: str, ids: list[str] | None = None) -> int:
        d = self._all()
        sess = d["sessions"].get(session_id, [])
        moving = [a for a in sess if ids is None or a["id"] in ids]
        gen_ids = {a["id"] for a in moving}
        d["general"] = [a for a in d["general"] if a["id"] not in gen_ids] + [{**a, "session_id": None} for a in moving]
        d["sessions"][session_id] = [a for a in sess if a["id"] not in gen_ids]
        self.store.write("assets", d)
        return len(moving)

    def clear_session(self, session_id: str) -> int:
        d = self._all()
        n = len(d["sessions"].get(session_id, []))
        d["sessions"][session_id] = []
        self.store.write("assets", d)
        return n

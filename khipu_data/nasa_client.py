"""NASA open API client (InSight weather, APOD) with cache and explicit fallback.

Key: env NASA_API_KEY (falls back to the public DEMO_KEY). Never logged.
Offline: env QN_OFFLINE=1 or network failure -> cached response, else a
fallback payload labelled as such."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .regions import DATA

CACHE = DATA / "cache" / "nasa"
ENDPOINTS = {
    "weather": "https://api.nasa.gov/insight_weather/",
    "apod": "https://api.nasa.gov/planetary/apod",
}
PARAMS = {"weather": {"feedtype": "json", "ver": "1.0"}, "apod": {}}


def _key() -> str:
    return os.environ.get("NASA_API_KEY") or "DEMO_KEY"


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class NasaClient:
    def __init__(self, cache_dir: Path = CACHE, timeout_s: float = 5.0, opener=None):
        self.cache_dir = cache_dir
        self.timeout_s = timeout_s
        self.opener = opener or urllib.request.urlopen

    @property
    def offline(self) -> bool:
        return os.environ.get("QN_OFFLINE", "0") == "1"

    def _cache_path(self, name: str) -> Path:
        return self.cache_dir / f"{name}.json"

    def fetch(self, name: str) -> dict:
        url = ENDPOINTS[name]
        public_ref = url  # never include the key in payloads/logs
        error = None
        if not self.offline:
            q = urllib.parse.urlencode({**PARAMS[name], "api_key": _key()})
            try:
                with self.opener(f"{url}?{q}", timeout=self.timeout_s) as r:
                    payload = json.loads(r.read().decode("utf-8"))
                result = {"status": "live", "source": public_ref, "fetched_at": _now(), "provenance": "live_service",
                          "data": payload}
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                self._cache_path(name).write_text(json.dumps(result))
                return self._normalize(name, result)
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
                error = type(e).__name__ + ": " + str(e).replace(_key(), "***")[:160]
        else:
            error = "offline mode (QN_OFFLINE=1)"
        p = self._cache_path(name)
        if p.exists():
            cached = json.loads(p.read_text())
            cached.update({"status": "cached", "provenance": "cached", "error": error})
            return self._normalize(name, cached)
        return self._normalize(name, {"status": "fallback", "source": public_ref, "fetched_at": _now(),
                                      "provenance": "unavailable", "error": error, "data": None})

    def _normalize(self, name: str, res: dict) -> dict:
        if name == "weather":
            res["summary"] = self._weather_summary(res.get("data"))
        if name == "apod" and isinstance(res.get("data"), dict):
            d = res["data"]
            res["summary"] = {"title": d.get("title"), "date": d.get("date"), "media_type": d.get("media_type"),
                              "url": d.get("url"), "copyright": d.get("copyright")}
        return res

    @staticmethod
    def _weather_summary(data) -> dict | None:
        if not isinstance(data, dict):
            return None
        sols = data.get("sol_keys") or []
        if not sols:
            return {"available": False, "note": "La API no devolvió soles (InSight finalizó en 2022)."}
        s = sols[-1]
        d = data.get(s, {})
        at = d.get("AT") or {}
        pre = d.get("PRE") or {}
        return {"available": True, "sol": s, "temp_avg_c": at.get("av"), "temp_min_c": at.get("mn"),
                "temp_max_c": at.get("mx"), "pressure_pa": pre.get("av"), "season": d.get("Season"),
                "first_utc": d.get("First_UTC"), "last_utc": d.get("Last_UTC")}

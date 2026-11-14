"""Region store: builds derived regions from MOLA originals, reads manifests,
and serves TerrainContext objects. Originals are never written."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from khipu.domain import Provenance
from khipu.geodesy import GridGeometry
from khipu.terrain import TerrainContext

from .pds3 import PDS3Error, extract_subgrid, open_mola

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RAW = DATA / "official_kickoff" / "raw"
MANIFEST = DATA / "official_kickoff" / "manifest.json"
PROCESSED = DATA / "processed" / "generated" / "regions"
MOLA_LABEL = RAW / "mola" / "megt44n000hb.lbl"

MACRO_KEY = "syrtis_jezero_nili"
MACRO = {"key": MACRO_KEY, "name": "Macrorregión Syrtis Major NE – Jezero – Nili Fossae",
         "lat_min": 16.5, "lat_max": 23.5, "lon_min": 73.5, "lon_max": 79.5,
         "description": "Ventana continua MOLA MEGDR 128 px/° que contiene los tres sectores de enfoque."}

FOCUS_REGIONS = {
    "jezero": {"name": "Cráter Jezero", "quad": "MC-13 Syrtis Major", "center": [18.38, 77.58],
               "bbox": {"lat_min": 17.9, "lat_max": 18.9, "lon_min": 77.0, "lon_max": 78.1}},
    "ne_syrtis": {"name": "Northeast Syrtis Major", "quad": "MC-13 Syrtis Major", "center": [17.85, 77.15],
                  "bbox": {"lat_min": 17.3, "lat_max": 18.3, "lon_min": 76.6, "lon_max": 77.7}},
    "nili_fossae": {"name": "Nili Fossae", "quad": "MC-13 Syrtis Major", "center": [21.6, 75.4],
                    "bbox": {"lat_min": 20.6, "lat_max": 22.6, "lon_min": 74.2, "lon_max": 76.6}},
}


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def build_region(key: str, name: str, lat_min: float, lat_max: float, lon_min: float, lon_max: float,
                 description: str = "", label_path: Path = MOLA_LABEL, out_dir: Path = PROCESSED,
                 source_sha: str | None = None) -> dict:
    if not re.fullmatch(r"[a-z0-9_]{2,40}", key):
        raise ValueError("region key must be lowercase [a-z0-9_]{2,40}")
    prod = open_mola(label_path)
    sub = extract_subgrid(prod, lat_min, lat_max, lon_min, lon_max)
    if sub["empty"]:
        raise PDS3Error(sub["reason"])
    rdir = out_dir / key
    rdir.mkdir(parents=True, exist_ok=True)
    np.save(rdir / "elevation.npy", sub["data"].astype(np.float32))
    data = sub["data"]
    manifest = {
        "schema_version": "1.0",
        "key": key,
        "name": name,
        "description": description,
        "classification": Provenance.DERIVED_FROM_NASA.value,
        "geometry": {"lat_min": sub["lat_min"], "lat_max": sub["lat_max"], "lon_min": sub["lon_min"],
                     "lon_max": sub["lon_max"], "pixels_per_degree": sub["pixels_per_degree"], "rows": sub["rows"],
                     "cols": sub["cols"], "radius_m": prod.radius_m},
        "units": "m (topografía sobre areoide GMM3)",
        "coordinate_reference": "IAU2000 planetocéntrico, longitud este, cilíndrica simple",
        "resolution": f"{sub['pixels_per_degree']:.0f} px/° (~{prod.radius_m * 3.14159265 / 180 / sub['pixels_per_degree']:.0f} m/px)",
        "coverage": {"valid_fraction": float(np.isfinite(data).mean()), "min_m": float(np.nanmin(data)),
                     "max_m": float(np.nanmax(data)), "clipped": sub["clipped"]},
        "source": {"product_id": prod.label.get("PRODUCT_ID"), "data_set_id": prod.label.get("DATA_SET_ID"),
                   "label": str(label_path.relative_to(ROOT)), "image": str(prod.image_path.relative_to(ROOT)),
                   "image_sha256": source_sha, "window": sub["window"]},
        "transformations": ["memmap read-only window of MSB_INTEGER 16-bit samples",
                            "cast to float32 metres (no resampling)"],
        "created_at": _now(),
        "files": {"elevation": "elevation.npy"},
    }
    (rdir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    return manifest


def write_focus_manifests(parent: dict, out_dir: Path = PROCESSED) -> list[dict]:
    out = []
    for key, f in FOCUS_REGIONS.items():
        m = {"schema_version": "1.0", "key": key, "name": f["name"], "quad": f["quad"],
             "classification": Provenance.DERIVED_FROM_NASA.value, "parent": parent["key"],
             "center": {"lat": f["center"][0], "lon": f["center"][1]}, "focus_bbox": f["bbox"],
             "source": parent["source"], "units": parent["units"],
             "coordinate_reference": parent["coordinate_reference"], "resolution": parent["resolution"],
             "note": "Sector de enfoque dentro de la macrorregión continua; comparte la malla del padre."}
        d = out_dir / key
        d.mkdir(parents=True, exist_ok=True)
        (d / "manifest.json").write_text(json.dumps(m, indent=2, ensure_ascii=False))
        out.append(m)
    return out


class RegionStore:
    def __init__(self, processed: Path = PROCESSED, synthetic_dir: Path = DATA / "fixtures" / "synthetic"):
        self.processed = processed
        self.synthetic_dir = synthetic_dir
        self._terrain: dict[str, TerrainContext] = {}

    def manifests(self) -> dict[str, dict]:
        out = {}
        if self.processed.exists():
            for p in sorted(self.processed.glob("*/manifest.json")):
                try:
                    m = json.loads(p.read_text())
                    out[m["key"]] = m
                except (json.JSONDecodeError, KeyError):
                    continue
        return out

    def manifest(self, key: str) -> dict | None:
        return self.manifests().get(key)

    def data_key(self, key: str) -> str | None:
        m = self.manifest(key)
        if m is None:
            return None
        return m.get("parent") or key

    def terrain(self, key: str) -> TerrainContext | None:
        dk = self.data_key(key)
        if dk is None:
            return None
        if dk in self._terrain:
            return self._terrain[dk]
        m = self.manifest(dk)
        f = self.processed / dk / m["files"]["elevation"]
        if not f.exists():
            return None
        z = np.load(f).astype(np.float64)
        g = m["geometry"]
        geom = GridGeometry(lat_max=g["lat_max"], lon_min=g["lon_min"], pixels_per_degree=g["pixels_per_degree"],
                            rows=g["rows"], cols=g["cols"], radius=g.get("radius_m", 3396000.0))
        t = TerrainContext(dk, z, geom, provenance=m["classification"])
        self._terrain[dk] = t
        return t

    def status(self) -> dict:
        ms = self.manifests()
        return {"regions": list(ms.keys()), "macro_available": MACRO_KEY in ms,
                "raw_label_present": MOLA_LABEL.exists(), "raw_image_present": MOLA_LABEL.with_suffix(".img").exists()}


def register_official_dataset(manifest_path: Path = MANIFEST) -> dict:
    """Record the MOLA original in the kickoff manifest (schema nasa-data-manifest)."""
    img = MOLA_LABEL.with_suffix(".img")
    prod = open_mola(MOLA_LABEL)
    entry = {
        "id": "mola-megdr-megt44n000hb",
        "classification": "official_nasa",
        "mission": "Mars Global Surveyor",
        "instrument": "MOLA (Mars Orbiter Laser Altimeter)",
        "product_id": str(prod.label.get("PRODUCT_ID")),
        "source": {"url_or_reference": "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/megt44n000hb.img",
                   "retrieved_at": "2026-11-14T09:35:00Z", "provider": "NASA PDS Geosciences Node"},
        "coverage": "0°N–44°N, 0°E–90°E",
        "coordinate_reference": "IAU2000 planetocentric, east longitude, simple cylindrical, sphere R=3396 km",
        "license_or_attribution": "NASA PDS public data; MGS MOLA Science Team (D. E. Smith, GSFC)",
        "files": [
            {"path": "data/official_kickoff/raw/mola/megt44n000hb.img", "format": "PDS3 IMAGE MSB_INTEGER 16-bit",
             "sha256": sha256_file(img), "units": "m", "resolution": "128 px/deg (0.463 km/px)",
             "notes": "5632 lines x 11520 samples; median topography above GMM3 areoid"},
            {"path": "data/official_kickoff/raw/mola/megt44n000hb.lbl", "format": "PDS3 label (ODL)",
             "sha256": sha256_file(MOLA_LABEL), "units": None, "resolution": None, "notes": "Detached label"},
        ],
        "transformations": [f"derived window '{MACRO_KEY}' in data/processed/generated/regions/ (no resampling)"],
        "notes": "Downloaded from an authorised NASA source before kickoff data was provided; not a kickoff file.",
    }
    m = {"schema_version": "1.0", "datasets": []}
    if manifest_path.exists():
        m = json.loads(manifest_path.read_text())
    m["datasets"] = [d for d in m.get("datasets", []) if d.get("id") != entry["id"]] + [entry]
    manifest_path.write_text(json.dumps(m, indent=2, ensure_ascii=False))
    return entry

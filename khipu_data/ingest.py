"""Kickoff data ingestion: scan data/official_kickoff/raw/, hash every original and
register it in manifest.json without modifying it. Unknown metadata stays null
(never invented); PDS3 labels are parsed when present."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .pds3 import parse_label
from .regions import MANIFEST, RAW, ROOT, sha256_file

SKIP = {"README.md", ".gitkeep", ".DS_Store"}


def _label_meta(path: Path) -> dict:
    try:
        lab = parse_label(path.read_text(errors="replace"))
    except (OSError, UnicodeDecodeError):
        return {}
    return {"product_id": lab.get("PRODUCT_ID"), "mission": lab.get("SPACECRAFT_NAME") or lab.get("MISSION_NAME"),
            "instrument": lab.get("INSTRUMENT_NAME") or lab.get("INSTRUMENT_ID"),
            "units": (lab.get("IMAGE") or {}).get("UNIT")}


def scan_raw(raw: Path = RAW, manifest_path: Path = MANIFEST, now: str | None = None) -> dict:
    m = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"schema_version": "1.0", "datasets": []}
    known = {f["path"] for d in m["datasets"] for f in d.get("files", [])}
    added = []
    groups: dict[Path, list[Path]] = {}
    for p in sorted(raw.rglob("*")):
        if p.is_file() and p.name not in SKIP:
            rel = p.relative_to(ROOT).as_posix()
            if rel not in known:
                groups.setdefault(p.parent, []).append(p)
    for folder, files in groups.items():
        meta = {}
        for f in files:
            if f.suffix.lower() in (".lbl", ".xml"):
                meta = {k: v for k, v in _label_meta(f).items() if v} or meta
        entry = {
            "id": f"kickoff-{folder.relative_to(raw).as_posix().replace('/', '-') or 'root'}-{len(m['datasets']) + 1}",
            "classification": "unknown",   # promoted to official_nasa only after provenance is confirmed
            "mission": meta.get("mission"), "instrument": meta.get("instrument"), "product_id": meta.get("product_id"),
            "source": {"url_or_reference": None, "retrieved_at": now or datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                       "provider": None},
            "coverage": None, "coordinate_reference": None, "license_or_attribution": None,
            "files": [{"path": f.relative_to(ROOT).as_posix(), "format": f.suffix.lstrip(".").upper() or "unknown",
                       "sha256": sha256_file(f), "units": meta.get("units") if f.suffix.lower() != ".lbl" else None,
                       "resolution": None, "notes": f"{f.stat().st_size} bytes"} for f in files],
            "transformations": [],
            "notes": "Registrado automáticamente; completar procedencia (URL, licencia, cobertura) antes de rotularlo como NASA.",
        }
        m["datasets"].append(entry)
        added.append(entry["id"])
    manifest_path.write_text(json.dumps(m, indent=2, ensure_ascii=False))
    return {"added": added, "total": len(m["datasets"])}

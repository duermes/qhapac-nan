"""Register the MOLA original and derive the macro-region + focus manifests.

Usage: .venv/bin/python scripts/bootstrap_data.py
Idempotent; never modifies files under data/official_kickoff/raw/."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from khipu_data.regions import MACRO, MOLA_LABEL, build_region, register_official_dataset, write_focus_manifests  # noqa: E402


def main() -> int:
    if not MOLA_LABEL.exists() or not MOLA_LABEL.with_suffix(".img").exists():
        print("MOLA original missing. Download into data/official_kickoff/raw/mola/:")
        print("  https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/megt44n000hb.lbl")
        print("  https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg128/megt44n000hb.img")
        print("The app will run in synthetic/empty mode until then.")
        return 1
    entry = register_official_dataset()
    sha = entry["files"][0]["sha256"]
    print("registered", entry["id"], sha)
    m = build_region(MACRO["key"], MACRO["name"], MACRO["lat_min"], MACRO["lat_max"], MACRO["lon_min"],
                     MACRO["lon_max"], MACRO["description"], source_sha=sha)
    print("macro", m["geometry"], m["coverage"])
    for f in write_focus_manifests(m):
        print("focus", f["key"], f["focus_bbox"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

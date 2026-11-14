"""Register every new original under data/official_kickoff/raw/ in manifest.json (hash only, originals untouched)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from khipu_data.ingest import scan_raw  # noqa: E402

if __name__ == "__main__":
    print(scan_raw())

"""Shared fixtures. Tests run offline (QN_OFFLINE=1) with an isolated state dir."""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("QN_OFFLINE", "1")
os.environ.setdefault("QN_STATE_DIR", tempfile.mkdtemp(prefix="qn_state_"))

import pytest  # noqa: E402

WEB = ROOT / "web"
BASE = {"lat": 18.4447, "lon": 77.4508, "id": "BASE_ALFA"}
DELTA = {"lat": 18.46, "lon": 77.40, "id": "POI_DELTA_FRONT"}
HAS_MOLA = (ROOT / "data/processed/generated/regions/syrtis_jezero_nili/elevation.npy").exists()
needs_mola = pytest.mark.skipif(not HAS_MOLA, reason="MOLA derived region missing: run scripts/bootstrap_data.py")


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from api.app import app
    return TestClient(app)


@pytest.fixture(scope="session")
def engine():
    from api.app import engine as e
    return e


@pytest.fixture(scope="session")
def jezero(engine):
    return engine.terrain("jezero")


def read(rel: str) -> str:
    return (WEB / rel).read_text(encoding="utf-8")


def web_text(*parts: str) -> str:
    """Concatenate every web source under the given subdirectories."""
    out = []
    for p in parts:
        base = WEB / p
        files = [base] if base.is_file() else sorted(list(base.rglob("*.js")) + list(base.rglob("*.html")) + list(base.rglob("*.css")))
        for f in files:
            if "vendor" in f.parts:
                continue
            out.append(f.read_text(encoding="utf-8"))
    return "\n".join(out)

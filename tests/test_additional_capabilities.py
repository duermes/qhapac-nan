"""Extra capability checks beyond the 206 reference names (FC-067, FC-071, FC-089, FC-091/092, FC-140)."""
import json

import numpy as np

from conftest import BASE, DELTA, needs_mola
from khipu.operations import Localizer
from khipu_data.ingest import scan_raw


def test_localization_uncertainty_grows_and_contracts():
    loc = Localizer(18.44, 77.45)
    r0 = loc.ellipse()["radius_m"]
    for _ in range(10):
        loc.advance(200, 90, slip=0.1)
    r1 = loc.ellipse()["radius_m"]
    assert r1 > r0 * 3 and loc.lon > 77.45 and loc.odometer_m == 2000
    loc.absolute_fix(18.44, 77.47, 3)
    assert loc.ellipse()["radius_m"] < r1 / 10 and loc.last_fix["source"] == "orbital"


@needs_mola
def test_environment_layers_values(engine):
    mgr = engine.manager("jezero")
    noon = mgr.snapshot("temperature", {"ltst_h": 14, "tau": 0.4}).data
    night = mgr.snapshot("temperature", {"ltst_h": 3, "tau": 0.4}).data
    assert np.nanmean(noon) > np.nanmean(night) and -140 < np.nanmin(night) and np.nanmax(noon) < 40
    assert np.nanmax(mgr.snapshot("thermal_gradient", {"ltst_h": 14}).data) > 0
    rad = mgr.snapshot("radiation", {}).data
    assert 0.5 < np.nanmean(rad) < 1.2
    assert mgr.snapshot("shadow", {"ltst_h": 7.0}).data.mean() > mgr.snapshot("shadow", {"ltst_h": 12.0}).data.mean()


def test_workspace_persistence_roundtrip(client):
    ws = {"sessions": [{"id": "S1", "view": "3d"}], "current": "S1", "preferences": {"region": "syrtis_jezero_nili"}}
    assert client.put("/api/workspace", json=ws).json()["saved"]
    back = client.get("/api/workspace").json()
    assert back["sessions"][0]["view"] == "3d" and back["preferences"]["region"] == "syrtis_jezero_nili"


@needs_mola
def test_replan_uses_cumulative_ledger_not_refill(client):
    before = client.post("/api/route", json={"origin": BASE, "destination": DELTA, "asset_id": "ROVER_LRV2", "variants": False}).json()
    a0 = before["variants"][0]["pnr"]["available"]
    client.post("/api/ledger/ROVER_LRV2/consume", json={"amount": 5000, "profile": "rover"})
    after = client.post("/api/route", json={"origin": {"lat": 18.45, "lon": 77.44}, "destination": DELTA, "asset_id": "ROVER_LRV2", "variants": False}).json()
    assert after["variants"][0]["pnr"]["available"] == a0 - 5000  # re-planning from elsewhere does not restore energy


def test_kickoff_ingestion_registers_without_touching_originals(tmp_path, monkeypatch):
    import khipu_data.ingest as ing
    root = tmp_path
    raw = root / "data/official_kickoff/raw/hirise"
    raw.mkdir(parents=True)
    (raw / "ESP_TEST.LBL").write_text('PDS_VERSION_ID = PDS3\nPRODUCT_ID = "ESP_TEST"\nINSTRUMENT_NAME = "HIRISE"\nEND\n')
    (raw / "ESP_TEST.IMG").write_bytes(b"\x01\x02\x03")
    man = root / "data/official_kickoff/manifest.json"
    man.write_text(json.dumps({"schema_version": "1.0", "datasets": []}))
    monkeypatch.setattr(ing, "ROOT", root)
    r = scan_raw(root / "data/official_kickoff/raw", man, now="2026-11-14T00:00:00+00:00")
    d = json.loads(man.read_text())["datasets"][0]
    assert r["added"] and d["classification"] == "unknown" and d["product_id"] == "ESP_TEST" and d["instrument"] == "HIRISE"
    assert all(len(f["sha256"]) == 64 and f["path"].startswith("data/official_kickoff/raw/") for f in d["files"])
    assert (raw / "ESP_TEST.IMG").read_bytes() == b"\x01\x02\x03"
    assert scan_raw(root / "data/official_kickoff/raw", man)["added"] == []  # idempotent


def test_data_provenance_page_and_endpoint(client):
    assert client.get("/static/home/data.html").status_code == 200
    j = client.get("/api/data/manifest").json()
    assert j["scenario"]["classification"] == "synthetic" and "datasets" in j["kickoff_manifest"]

"""REF-075..082."""
import numpy as np

from conftest import WEB, needs_mola, read
from khipu.physics import ephemeris


@needs_mola
def test_region_data_manifests_distinct(client):
    regs = {r["key"]: r for r in client.get("/api/regions").json()["regions"]}
    assert {"syrtis_jezero_nili", "jezero", "ne_syrtis", "nili_fossae"} <= set(regs)
    boxes = {k: tuple(regs[k]["focus_bbox"].values()) for k in ("jezero", "ne_syrtis", "nili_fossae")}
    assert len(set(boxes.values())) == 3


def test_ephemeris_solar_calculation_decoupled():
    import inspect
    src = inspect.getsource(ephemeris)
    assert "import requests" not in src and "open(" not in src  # pure module
    assert callable(ephemeris.solar_position) and callable(ephemeris.mars_time)


@needs_mola
def test_matrix_traversability_igt_endpoint(client):
    j = client.get("/api/layers/igt").json()
    assert j["available"] and 0 <= j["stats"]["min"] and j["stats"]["max"] <= 100


@needs_mola
def test_matrix_astrobiology_ibio_endpoint(client):
    j = client.get("/api/layers/ibio").json()
    assert j["available"] and j["provenance"] == "synthetic" and j["stats"]["max"] > 50


@needs_mola
def test_costmap_integration_with_igt(engine):
    mgr = engine.manager("jezero")
    igt = mgr.snapshot("igt", {}).data
    _, cm = engine.costmap("jezero", "rover")
    finite = np.isfinite(cm.cost)
    corr = np.corrcoef(igt[finite][::50], cm.cost[finite][::50])[0, 1]
    assert corr < -0.3  # easier terrain (high IGT) = lower cost


@needs_mola
def test_data_provenance_metadata_structure(client):
    m = client.get("/api/terrain/syrtis_jezero_nili").json()["manifest"]
    for k in ("classification", "units", "coordinate_reference", "resolution", "coverage", "source", "transformations"):
        assert k in m
    assert m["source"]["product_id"] == "MEGT44N000HB.IMG" and len(m["source"]["image_sha256"]) == 64


def test_frontend_contains_provenance_badges_and_selector():
    assert "export function provBadge" in read("shared/js/ui.js")
    assert 'id="active-layer-badge"' in read("console/index.html") and "provenanceDialog" in read("console/js/menus.js")


def test_html_templates_modular_architecture():
    for d in ("home", "console", "rover", "hud"):
        assert (WEB / d / "index.html").exists()
    assert len(list((WEB / "console/js").glob("*.js"))) >= 6 and len(list((WEB / "shared/js").glob("*.js"))) >= 8

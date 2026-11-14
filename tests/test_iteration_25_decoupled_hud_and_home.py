"""REF-129..138."""
import json

from conftest import BASE, ROOT, WEB, needs_mola, read
from khipu.domain import AssetKind


def test_root_redirects_to_home(client):
    r = client.get("/", follow_redirects=False)
    assert r.status_code in (302, 307) and r.headers["location"] == "/home"


def test_home_portal_serves_html_and_endpoints(client):
    r = client.get("/home")
    assert r.status_code == 200 and 'href="/console"' in r.text and 'href="/rover"' in r.text and 'href="/hud"' in r.text


def test_console_endpoint_serves_html(client):
    assert "Hatun Wasi" in client.get("/console").text


def test_rover_endpoint_serves_html(client):
    assert "Chaski" in client.get("/rover").text


def test_hud_endpoint_serves_html(client):
    assert "Ñawi" in client.get("/hud").text


def test_eva_hud_three_spatial_invariants_and_elements():
    h = read("hud/index.html")
    for el in ('class="reticle"', 'id="fov-list"', 'id="needle"', 'id="peak"', 'id="valley"', 'id="loc-ll"'):
        assert el in h


def test_eva_hud_modular_src_files_exist():
    for f in ("hud/js/hud.js", "hud/js/scene.js", "hud/js/vitals.js", "hud/css/hud.css"):
        assert (WEB / f).exists()


@needs_mola
def test_planning_rejects_fatal_slope_crest(client):
    import numpy as np
    from api.app import engine
    t = engine.terrain("jezero")
    r, c = np.unravel_index(np.nanargmax(t.slope), t.slope.shape)
    lat, lon = t.geometry.rc_to_latlon(r, c)
    res = client.post("/api/route", json={"origin": BASE, "destination": {"lat": lat, "lon": lon}, "profile": "rover"})
    assert res.status_code == 422 and res.json()["reason"] == "destino_slope"


@needs_mola
def test_planning_rejects_exceeded_walkback_distance(client):
    r = client.post("/api/route", json={"origin": BASE, "destination": {"lat": 18.46, "lon": 77.40}, "profile": "astronaut"})
    assert r.status_code == 422 and r.json()["walkback_limit_m"] == 2000


def test_asset_registry_and_decoupled_icons_and_3d_manifest():
    icons = read("shared/js/icons.js")
    assert "export const ASSET_REGISTRY" in icons
    for k in AssetKind:
        assert f"  {k.value}:" in icons
    s = json.loads((ROOT / "data/fixtures/synthetic/scenario.json").read_text())
    assert s["classification"] == "synthetic" and {a["kind"] for a in s["assets"]} >= {"base", "rover", "astronaut", "antenna"}

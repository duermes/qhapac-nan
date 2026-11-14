"""REF-096..101."""
import math

from conftest import needs_mola, read


@needs_mola
def test_macro_region_ingestion_and_manifest(client):
    m = client.get("/api/terrain/syrtis_jezero_nili").json()["manifest"]
    g = m["geometry"]
    assert (g["lat_min"], g["lat_max"], g["lon_min"], g["lon_max"]) == (16.5, 23.5, 73.5, 79.5)
    assert g["rows"] == 896 and g["cols"] == 768 and m["coverage"]["valid_fraction"] == 1.0


def test_frontend_macro_region_selector_and_navigation():
    assert "Enfocar sector (navegación instantánea)" in read("console/js/menus.js")


def test_session_tabs_homogeneity_and_clean_creation():
    a = read("console/js/app.js")
    assert "export function newSession" in a and "traverses: [], activeTraverse: null" in a


def test_hud_non_interference_with_mode_bar():
    c = read("hud/css/hud.css")
    assert ".voice { position: fixed; bottom: 52px;" in c and ".prompt { position: fixed; bottom: 128px;" in c


@needs_mola
def test_3d_mantle_mesh_drape_and_geodetic_aspect(client):
    g = client.get("/api/terrain/syrtis_jezero_nili").json()["geometry"]
    lat_c = (g["lat_min"] + g["lat_max"]) / 2
    width = g["cols"] * g["dy_m"] * math.cos(math.radians(lat_c))
    height = g["rows"] * g["dy_m"]
    assert abs(width / height - (768 / 896) * math.cos(math.radians(20))) < 1e-6
    assert "this.dxC = this.dy * Math.cos(this.latC * DEG)" in read("shared/js/geo.js")


def test_no_fictional_pentagon_loop_in_eva_tracks():
    hud = read("hud/js/hud.js") + read("hud/js/scene.js")
    assert "pentagon" not in hud.lower() and "api.route(" in hud

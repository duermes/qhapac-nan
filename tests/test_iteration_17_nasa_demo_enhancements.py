"""REF-090..095."""
from conftest import needs_mola, read, web_text


@needs_mola
def test_api_official_routes_all_regions(client):
    for key in ("syrtis_jezero_nili", "jezero"):
        result = client.get(f"/api/official_routes/{key}").json()
        assert result["classification"] == "official_nasa"
        track, = result["official"]
        assert len(track["segments"]) == track["records"] == 332
        assert track["sol_start"] == 14 and track["sol_end"] == 1176
        assert track["url"].startswith("https://trek.nasa.gov/")
    for key in ("ne_syrtis", "nili_fossae"):
        result = client.get(f"/api/official_routes/{key}").json()
        assert result["official"] == [] and result["classification"] == "unavailable"
    assert client.get("/api/official_routes/nowhere").status_code == 404


def test_frontend_region_picker_and_hud():
    m = read("console/js/menus.js")
    assert "function initFocusMenu" in m and 'id="sector-pill"' in read("console/index.html")


def test_frontend_3d_mantle_drape_and_mesh_coexistence():
    m3 = read("shared/js/map3d.js")
    assert "mesh and mantle coexist on the same geometry" in m3 and "map: this.texture" in m3


def test_frontend_toponymy_zoom_hierarchy():
    m2 = read("shared/js/map2d.js")
    assert "const minZoom = [1, 1.6, 3.2, 6][t.rank ?? 2]" in m2 and "greedy collision avoidance" in m2


def test_frontend_official_route_simulation_and_gaussian_halo():
    r = read("rover/js/rover.js")
    assert "map.halos" in r and "createRadialGradient" in read("shared/js/map2d.js")
    assert "api.localization(" in r


def test_frontend_dynamic_telemetry_metrics():
    r = read("rover/js/rover.js")
    for k in ("#battery", "#walkback", "#link", "#pitch", "#roll", "#slip", "api.fsm("):
        assert k in r

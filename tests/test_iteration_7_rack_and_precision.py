"""REF-154..163."""
import math
from datetime import datetime, timezone

from conftest import ROVER, BASE, DELTA, needs_mola, read, web_text
from khipu.physics import ephemeris as eph

HTML = read("console/index.html")
CSS = read("shared/css/qn.css")
JS = web_text("console/js")


def test_planning_origin_and_destination_selectors():
    assert 'id="origin"' in HTML and 'id="destination"' in HTML and 'id="origin-lat"' in HTML and 'id="destination-lon"' in HTML


@needs_mola
def test_planning_execution_and_metrics_deck(client):
    j = client.post("/api/route", json={"origin": ROVER, "destination": DELTA, "asset_id": "ROVER_PR1"}).json()
    m = j["variants"][0]["metrics"]
    for k in ("distance_m", "duration_s", "ascent_m", "descent_m", "risk_mean", "resources"):
        assert k in m
    assert "function renderMetrics" in JS


def test_button_visual_states_no_permanent_bright_glow():
    assert "box-shadow: 0 0 2" not in CSS.split(".btn {")[1].split("}")[0]
    assert '.btn[aria-pressed="true"]' in CSS and ".btn:hover" in CSS


@needs_mola
def test_export_structure_includes_vertices_and_geojson(client):
    r = client.post("/api/route", json={"origin": ROVER, "destination": DELTA, "variants": False}).json()
    route = {"points": r["variants"][0]["points"]}
    gj = client.post("/api/export/geojson", json={"route": route, "name": "t"}).json()["content"]
    coords = gj["features"][0]["geometry"]["coordinates"]
    assert gj["type"] == "FeatureCollection" and len(coords) == len(route["points"]) and len(coords[0]) == 3


def test_click_vs_drag_popover_distinction():
    m = read("shared/js/map2d.js")
    assert "Math.hypot(x - down.x, y - down.y) > 4" in m and 'this.emit("click"' in m and 'this.emit("entitydrop"' in m


def test_zoom_2d_limits_without_drift():
    m = read("shared/js/map2d.js")
    assert "keep the point under the cursor fixed" in m and "this.opts.maxScale" in m and "this.minScale" in m


def test_zoom_3d_micro_scale_capability():
    assert "this.controls.minDistance = 60" in read("shared/js/map3d.js")


def test_solar_3d_direction_physical_consistency():
    # Sun east in the morning: azimuth ~90°, the 3D light uses the same (east, north, up) convention
    mt = eph.mars_time(datetime(2026, 11, 14, tzinfo=timezone.utc), 77.45)
    sp = eph.solar_position(18.44, 8.0, mt["declination_deg"])
    e, n, u = eph.sun_vector(sp["elevation_deg"], sp["azimuth_deg"])
    assert e > 0 and u > 0 and abs(math.hypot(e, n, u) - 1) < 1e-9
    m3 = read("shared/js/map3d.js")
    assert "Math.cos(el) * Math.sin(az) * d" in m3 and "-Math.cos(el) * Math.cos(az) * d" in m3  # x east, z south


def test_traverse_rack_multitrack_features():
    t = read("console/js/traverses.js")
    for a in ('data-act="rename"', 'data-act="eye"', 'data-act="delete"', "export function addTraverse"):
        assert a in t


def test_session_tabs_camera_independence():
    a = read("console/js/app.js")
    assert "ctx.cur.cam2d = { ...ctx.map2d.cam }" in a and "cam3d" in a

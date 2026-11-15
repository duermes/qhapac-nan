"""REF-172..184."""
from conftest import ROVER, EVA, BASE, DELTA, needs_mola, read, web_text

M3 = read("shared/js/map3d.js")
CSS = read("shared/css/qn.css") + read("console/css/console.css")
JS = web_text("console/js")


def test_zoom_normalization_and_camera_targets_3d():
    assert "focusOn(lat, lon, distance" in M3 and "this.controls.target.copy(p)" in M3
    assert "ctx.map2d.cam.scale / ctx.map2d.minScale" in read("console/js/app.js")


def test_3d_labels_magnification_factor():
    assert "magnification(distance)" in M3 and "m.el.style.scale = String(mag)" in M3


def test_semantic_lod_three_levels_3d():
    assert "labelLOD(distance)" in M3 and "return 0;" in M3 and "return 1;" in M3 and "return 2;" in M3


def test_badges_clean_outline_no_opaque_background():
    badge = CSS.split(".badge {")[1].split("}")[0]
    assert "background: transparent" in badge and "border: 1px solid currentColor" in badge


def test_layers_deck_height_and_scroll_bounding():
    assert "#deck-layers { width: 330px; max-height: min(560px, calc(100vh - 160px)); }" in CSS
    assert ".deck .deck-body { overflow: auto;" in CSS


def test_reopen_planning_button_lifecycle():
    assert '$("#planning-reopen").hidden = !planning || !on' in JS


def test_planning_arrows_orientation_semantics():
    assert ".rack-toggle svg { transition: transform .15s; transform: rotate(-90deg); }" in CSS
    assert ".traverses.collapsed .rack-toggle svg { transform: rotate(90deg); }" in CSS


@needs_mola
def test_decoupled_waypoint_creation_and_routing(client):
    client.post("/api/assets", json={"id": "WP_DEC", "name": "WP", "kind": "waypoint", "lat": 18.452, "lon": 77.43, "session_id": "SX"})
    j = client.post("/api/route", json={"origin": ROVER, "destination": DELTA, "waypoints": [{"lat": 18.452, "lon": 77.43, "id": "WP_DEC"}], "profile": "rover"}).json()
    pts = j["variants"][0]["points"]
    from khipu.geodesy import haversine_m
    assert min(haversine_m(p["lat"], p["lon"], 18.452, 77.43) for p in pts) < 50
    client.delete("/api/assets/WP_DEC")


def test_waypoint_read_only_card_with_in_situ_edit():
    p = read("console/js/popover.js")
    assert "editing ? form : read" in p


def test_3d_route_elevation_offset_and_contour_shader_color():
    assert "drapedEdge" in M3 and "surfaceY" in M3 and "uContourColor" in M3


@needs_mola
def test_route_variants_multicriteria_differentiation(client):
    destination = {"lat": 18.46, "lon": 77.45}
    route = client.post("/api/route", json={"origin": ROVER, "destination": destination}).json()
    assert len(route["variants"]) == 1
    points = route["variants"][0]["points"]
    assert abs(points[0]["lat"] - ROVER["lat"]) < 1e-9
    assert abs(points[-1]["lon"] - destination["lon"]) < 1e-9


@needs_mola
def test_dynamic_metrics_per_entity_type(client):
    rv = client.post("/api/route", json={"origin": ROVER, "destination": {"lat": 18.452, "lon": 77.462}, "asset_id": "ROVER_PR1"}).json()
    ev = client.post("/api/route", json={"origin": EVA, "destination": {"lat": 18.452, "lon": 77.462}, "asset_id": "EVA_01"}).json()
    assert rv["variants"][0]["pnr"]["resource"] == "battery_wh"
    assert ev["variants"][0]["pnr"]["resource"] == "o2_kg" and "o2_kg" in ev["variants"][0]["metrics"]["resources"]


def test_ui_homogeneous_transparency_and_no_overlaps():
    assert "--glass: rgba(16, 22, 18, 0.58)" in CSS
    assert "left of the traverse rack, never over it" in read("console/js/decks.js")

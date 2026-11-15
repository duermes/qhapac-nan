"""REF-102..107."""
import time

from conftest import BASE, needs_mola, read


def test_quick_nav_instant_relocation_no_permanent_state():
    m = read("console/js/menus.js")
    focus = m.split("function initFocusMenu()", 1)[1].split("function initShortcuts", 1)[0]
    assert "ctx.map2d.fitBBox" in focus and "open(false)" in focus and "setMode(" not in focus


def test_dynamic_location_hud_over_map():
    a = read("console/js/app.js")
    assert "export function updateSector" in a and 'ctx.map2d.on("camera", () => { updateScaleBar(); updateSector();' in a


def test_no_dashed_perimeter_lines():
    # no fictional region perimeters: dashed strokes only outline declared hazard zones and the direct route
    m2 = read("shared/js/map2d.js")
    assert m2.count("setLineDash([4, 4])") == 1 and "drawHazards" in m2
    assert "perimeter" not in read("console/js/app.js").lower()


def test_click_inspection_displays_point_information():
    p = read("console/js/popover.js")
    assert "function openPoint" in p and "Elevación MOLA" in p and "Pendiente" in p


@needs_mola
def test_route_calculation_from_base_or_waypoint(client):
    a = client.post("/api/route", json={"origin": BASE, "destination": {"lat": 18.36, "lon": 77.65}}).json()
    client.post("/api/assets", json={"id": "WP_ORIG", "name": "O", "kind": "waypoint", "lat": 18.45, "lon": 77.44})
    b = client.post("/api/route", json={"origin": {"lat": 18.45, "lon": 77.44, "id": "WP_ORIG", "kind": "waypoint"}, "destination": {"lat": 18.36, "lon": 77.65}}).json()
    client.delete("/api/assets/WP_ORIG")
    assert a["feasible"] and b["feasible"] and b["static_origin"]


@needs_mola
def test_survival_and_preservation_layers_performance(engine):
    mgr = engine.manager("syrtis_jezero_nili")
    t = time.time()
    mgr.snapshot("survival_astronaut", {"ltst_h": 9.5, "tau": 0.7})
    mgr.snapshot("survival_rover", {"ltst_h": 9.5, "tau": 0.7})
    assert time.time() - t < 6.0  # full macro-region (896x768), two composite layers

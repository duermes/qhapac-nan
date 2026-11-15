"""REF-144..153 — console interactions (structure; live behaviour in tests/e2e/walkthrough.py)."""
from conftest import read, web_text

HTML = read("console/index.html")
CSS = read("console/css/console.css")
JS = web_text("console/js")
UI = read("shared/js/ui.js")


def test_planning_toolbar_location_and_metrics_flow():
    assert 'id="planning"' in HTML and ".planning { position: fixed; left: 12px;" in CSS
    assert "metrics.openFor" in JS and 'ctx.emit("route"' in JS


def test_layer_deck_drag_handle_isolation():
    assert "deck-handle" in UI and 'e.target.closest("button, input, select, a, [data-nodrag]")' in UI


def test_session_workspace_instances_homogeneity():
    s = read("console/js/app.js")
    assert "export function newSession" in s
    for k in ("cam2d", "eyes", "layers", "traverses", "params", "hidden"):
        assert k in s


def test_mode_eye_toggles_independent():
    assert 'data-eye="analyze"' in HTML and 'data-eye="plan"' in HTML
    assert "ctx.cur.eyes[k] = !ctx.cur.eyes[k]" in JS


def test_legend_deck_and_element_filters():
    d = read("console/js/decks.js")
    assert "function renderLegend" in d and "data-kind" in d and "s.hidden" in d


def test_tabs_dimensions_stability_on_expansion():
    assert ".session-tabs .tab { width: 86px;" in CSS


def test_3d_proportional_scaling_and_synchronization():
    m3 = read("shared/js/map3d.js")
    assert "this.g.widthM(), this.g.heightM()" in m3 and "toXZ(" in read("shared/js/geo.js")
    assert "ctx.map3d.drape(composite())" in JS


def test_dynamic_risk_evaluation_skips_new_point_creation():
    assert 'if (!hit && !ctx.cur.addMode) inspectRisk(ll)' in read("console/js/decks.js")
    assert 'if (on) ctx.decks?.risk.close()' in read("console/js/popover.js")


def test_add_point_modal_and_popover_user_controls():
    p = read("console/js/popover.js")
    assert "function addPointDialog" in p and 'title: "Nuevo punto"' in p and 'data-a="edit"' in p and 'data-a="del"' in p


def test_scale_bar_updating_in_3d_mode():
    a = read("console/js/app.js")
    assert 'ctx.map3d.on("frame", () => { updateScaleBar();' in a and "ctx.map3d.metersPerPixel()" in a

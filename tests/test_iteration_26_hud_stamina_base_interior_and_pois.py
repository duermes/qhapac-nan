"""REF-139..143."""
from conftest import read
from khipu.costmap import CostParams, compute_costmap
from khipu.router import RouterConfig, astar
from khipu.terrain import synthetic_terrain
from khipu.voice import interpret


def test_router_directional_slope_penalizes_uphill_more_than_downhill():
    import numpy as np
    t = synthetic_terrain(30, 30, "plain")
    t.elevation[:] = np.arange(30)[None, :] * 60.0  # constant ramp rising eastwards (~7°)
    from khipu.terrain import TerrainContext
    t = TerrainContext("ramp", t.elevation, t.geometry, "synthetic")
    cm = compute_costmap(t, CostParams())
    up = astar(t, cm, (15, 2), (15, 27), RouterConfig())
    down = astar(t, cm, (15, 27), (15, 2), RouterConfig())
    assert up.cost > down.cost * 1.1


def test_hud_html_stamina_and_legend_elements_exist():
    h = read("hud/index.html")
    for el in ('id="stamina-bar"', 'id="effort-detail"', 'id="effort-body"', 'id="suit-alerts"', 'id="alert-count"', 'id="prompt"'):
        assert el in h


def test_hud_css_classes_exist():
    c = read("hud/css/hud.css")
    for cls in (".vitals", ".goal", ".stamina", ".fov", ".suit", ".reticle", ".relief", ".north", ".prompt", ".critical", ".eva-controls", ".help"):
        assert cls in c


def test_rover_voice_copilot_includes_help_and_modes():
    h = interpret("ayuda", interface="rover")
    assert h["intent"] == "help" and h["modes"] == ["Navegación", "Reconocer", "Planificar"]
    assert interpret("modo navegación")["mode"] == "navigate"
    assert 'r.intent === "set_mode"' in read("rover/js/rover.js")


def test_hud_voice_agent_includes_poi_info_and_filters():
    pois = [{"id": "A", "name": "Biofirmas Estromatolito", "description": "carbonatos"},
            {"id": "B", "name": "Muestra M-01 Basalto"}]
    assert interpret("info de estromatolito", pois)["poi_id"] == "A"
    assert interpret("filtra ciencia", pois)["category"] == "science"
    assert interpret("filtra algo raro", pois)["intent"] == "clarify"
    assert interpret("muestra capa", pois)["intent"] == "clarify"
    hud = read("hud/js/hud.js")
    assert 'r.intent === "poi_info"' in hud and 'r.intent === "filter_pois"' in hud

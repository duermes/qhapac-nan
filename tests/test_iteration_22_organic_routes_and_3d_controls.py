"""REF-118..122."""
from conftest import BASE, DELTA, needs_mola, read
from khipu.costmap import CostParams, compute_costmap
from khipu.router import RouterConfig, plan
from khipu.terrain import synthetic_terrain


def test_planner_bridge_organic_smoothing_and_theta_star():
    t = synthetic_terrain(60, 60, "plain")
    g = t.geometry
    cm = compute_costmap(t, CostParams())
    res = plan(t, cm, g.rc_to_latlon(5, 5), g.rc_to_latlon(50, 40), RouterConfig())
    assert len(res["control_points"]) < len(res["cells"])          # any-angle shortcut (Theta*-like)
    assert len(res["points"]) > len(res["control_points"])          # densified / smoothed
    assert all(p["tier"] != 3 for p in res["points"])


@needs_mola
def test_terrain_3d_horizontal_projection_and_texture_mapping():
    m3 = read("shared/js/map3d.js")
    assert "new THREE.PlaneGeometry(W, H" in m3 and "geo.rotateX(-Math.PI / 2)" in m3 and "drawImage(sourceCanvas" in m3


def test_dpad_buttons_and_eva_controls_in_html_and_css():
    rh, rc = read("rover/index.html"), read("rover/css/rover.css")
    hh, hc = read("hud/index.html"), read("hud/css/hud.css")
    for d in ("up", "down", "left", "right", "center", "in", "out"):
        assert f'data-dir="{d}"' in rh
    assert ".dpad" in rc and "glove-friendly" in rc
    for m in ("fwd", "back", "left", "right"):
        assert f'data-move="{m}"' in hh
    assert ".eva-controls" in hc


def test_canvas_navigation_mode_locks_rover_centered():
    r = read("rover/js/rover.js")
    assert "map.opts.lockPan = tracking" in r and "map.cam.rot = -S.heading" in r


def test_bundle_contains_dpad_and_organic_routing():
    r = read("rover/js/rover.js")
    assert '#dpad").addEventListener("click"' in r and "api.route(" in r
    assert "api.autopilot(" not in r

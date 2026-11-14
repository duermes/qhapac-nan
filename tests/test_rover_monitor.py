"""REF-198..204 — Chaski."""
from conftest import BASE, DELTA, WEB, needs_mola, read
from khipu.operations import PurePursuit

JS = read("rover/js/rover.js")
HTML = read("rover/index.html")


def test_rover_monitor_static_files_exist():
    for f in ("rover/index.html", "rover/css/rover.css", "rover/js/rover.js"):
        assert (WEB / f).exists()


def test_rover_monitor_endpoint_mounted(client):
    r = client.get("/rover")
    assert r.status_code == 200 and "Chaski" in r.text


def test_rover_monitor_css_and_js_served(client):
    assert client.get("/static/rover/css/rover.css").status_code == 200
    assert client.get("/static/rover/js/rover.js").status_code == 200


@needs_mola
def test_kinematic_routing_api_for_express_route(client):
    j = client.post("/api/route", json={"origin": {"lat": 18.438, "lon": 77.47, "id": "ROVER_PR1", "kind": "rover"},
                                        "destination": DELTA, "asset_id": "ROVER_PR1", "profile": "rover"}).json()
    assert j["profile"] == "rover" and j["variants"][1]["metrics"]["resources"]["battery_wh"] > 0
    assert "api.route(" in JS  # Chaski uses the same planner


@needs_mola
def test_dynamic_replan_api_for_obstacle_avoidance(client):
    plan = client.post("/api/route", json={"origin": BASE, "destination": DELTA, "profile": "rover", "variants": False}).json()
    pts = plan["variants"][0]["points"]
    mid = pts[len(pts) // 2]
    r = client.post("/api/route/dynamic_replan", json={"current": BASE, "destination": DELTA, "route_points": pts,
                                                       "obstacles": [{"lat": mid["lat"], "lon": mid["lon"], "radius_m": 500}]}).json()
    assert r["replanned"] and r["evasion_ok"]


def test_isolated_operational_modes_in_frontend():
    for m in ('data-mode="navigate"', 'data-mode="recon"', 'data-mode="plan"'):
        assert m in HTML
    assert "function setMode" in JS and "lockPan" in JS


def test_autopilot_safety_envelope_and_pure_pursuit():
    path = [{"lat": 18.44 + i * 0.002, "lon": 77.45} for i in range(20)]
    pp = PurePursuit()
    c = pp.command(18.44, 77.45, 90.0, path)
    assert c["state"] == "TRACKING" and c["steer_deg"] < 0  # target north while heading east: steer left
    assert pp.command(18.44, 77.45, 0, path, slope_deg=30)["state"] == "HOLD"
    assert pp.command(18.44, 77.45, 0, path, emergency=True)["state"] == "E-STOP"
    assert pp.command(path[-1]["lat"], 77.45, 0, path)["state"] == "ARRIVED"

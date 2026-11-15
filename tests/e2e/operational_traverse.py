"""Browser checks for operational planning and ADJ-004. Run against a local server with isolated QN_STATE_DIR."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from uuid import uuid4

from playwright.sync_api import expect, sync_playwright

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8765"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("test-results/operational-traverse")
CHANNEL = sys.argv[3] if len(sys.argv) > 3 else "chromium"
OUT.mkdir(parents=True, exist_ok=True)
proof = {}


def ready(browser, path, viewport=(1440, 900)):
    page = browser.new_page(viewport=dict(zip(("width", "height"), viewport)), has_touch=viewport[0] < 700,
                            reduced_motion="reduce")
    page.add_init_script("""(() => {
      class SpeechMock {
        start() { window.speechProbe = this; this.onstart?.(); }
        stop() { this.onend?.(); }
      }
      window.SpeechRecognition = SpeechMock;
    })()""")
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.on("console", lambda item: errors.append(item.text) if
            item.type == "error" and "Shader" in item.text else None)
    page.goto(BASE + "/" + path, wait_until="domcontentloaded")
    expect(page.locator("body")).to_have_attribute("data-ready", "1", timeout=60000)
    return page, errors


def console(browser):
    page, errors = ready(browser, "console")
    page.reload(wait_until="domcontentloaded")
    expect(page.locator("body")).to_have_attribute("data-ready", "1", timeout=60000)
    expect(page.locator("#planning-empty")).to_be_visible()
    expect(page.locator("#origin")).to_be_hidden()
    expect(page.locator("#dock [data-mode]")).to_have_count(3)
    expect(page.locator("#deck-legend")).to_be_hidden()
    page.click("#legend-btn")
    const_eye = page.locator("#deck-legend button[data-kind=rover]")
    expect(const_eye).to_have_attribute("aria-pressed", "true")
    const_eye.click()
    expect(const_eye).to_have_attribute("aria-pressed", "false")
    const_eye.click()
    page.locator("#deck-legend .deck-close").click()
    page.click("#new-traverse")
    page.locator("#origin").select_option("BASE_ALFA")
    page.locator("#destination").select_option("MET_STATION")
    page.click("#calculate")
    expect(page.locator("#variants")).to_contain_text("Distancia euclídea", timeout=30000)
    expect(page.locator("#metrics")).to_be_hidden()
    assert page.evaluate("""() => {
      const path = qn.map2d.routes[0].points;
      const station = qn.entities.find(e => e.id === "MET_STATION");
      return path[1].lat === station.lat && path[1].lon === station.lon;
    }""")
    page.click("[data-mode=general]")
    expect(page.locator("#planning")).to_be_hidden()
    expect(page.locator("#traverses")).to_be_hidden()
    assert page.evaluate("qn.map2d.routes.length") == 1
    page.click("#focus-btn")
    page.click("#focus-menu [data-f='1']")
    assert page.evaluate("qn.cur.mode") == "general"
    page.evaluate("qn.map2d.zoomAt(1e6)")
    assert page.evaluate("qn.map2d.metersPerPixel() * 100") <= 30.01

    page.click("[data-mode=analyze]")
    expect(page.locator("#planning")).to_be_hidden()
    row = page.locator("[data-layer=dust]")
    row.locator("summary").click()
    expect(row.locator("[data-toggle]")).to_have_attribute("aria-pressed", "false")
    expect(row.locator("#layer-dust-tau")).to_be_visible()
    assert row.locator("[data-param=ltst_h]").count() == 0
    row.locator("#layer-dust-tau").fill("0.83")
    row.locator("#layer-dust-tau").press("Tab")
    row.locator("[data-toggle]").click()
    expect(row.locator("[data-toggle]")).to_have_attribute("aria-pressed", "true", timeout=20000)
    assert page.evaluate("qn.cur.layers.dust.paramsUsed.tau") == 0.83
    page.wait_for_function("qn.map2d.layers.some(layer => layer.detail?.stride === 1)")
    grid = page.evaluate("qn.map2d.layers.find(layer => layer.id === 'dust').detail")
    assert grid["width"] <= 256 and grid["height"] <= 256
    assert page.evaluate("""async () => {
      const { renderLayer } = await import('/static/shared/js/raster.js');
      const grid = { rows: 1, cols: 4, data: new Float32Array([-10, 0, 20, NaN]), min: 0, max: 3 };
      const pixels = renderLayer(grid, 'tiers', 'hazard', 0, 3).getContext('2d').getImageData(0,0,4,1).data;
      return [pixels[3], pixels[7], pixels[11], pixels[15]].join() === '255,255,255,0';
    }""")
    row.locator("summary").click()
    expect(row.locator("#layer-dust-tau")).to_be_hidden()
    expect(row.locator("[data-toggle]")).to_have_attribute("aria-pressed", "true")
    page.screenshot(path=str(OUT / "hatun-wasi-layers.png"))

    page.click("[data-mode=plan]")
    expect(page.locator("#planning")).to_be_visible()
    expect(page.locator("#traverses")).to_be_visible()
    expect(page.locator("#deck-legend")).to_be_hidden()
    assert page.evaluate("qn.map2d.layers.some(layer => layer.id === 'dust' && layer.visible)")
    page.click("[data-eye=analyze]")
    assert page.evaluate("qn.map2d.layers.every(layer => !layer.visible)")
    point = {"lat": 18.439, "lon": 77.469}
    page.evaluate("(p) => qn.map2d.focusOn(p.lat, p.lon, 50)", point)
    page.click("#new-point")
    page.mouse.click(720, 450)
    page.select_option("#ap-kind", "rover")
    rover_name = f"Rover de prueba ADJ-004 {uuid4().hex[:8]}"
    page.fill("#ap-name", rover_name)
    page.get_by_role("button", name="Crear punto", exact=True).click()
    page.wait_for_function("name => qn.entities.some(e => e.name === name)", arg=rover_name)
    rover = page.evaluate("name => qn.entities.find(e => e.name === name)", rover_name)
    assert rover["virtual"] and rover["resources"]["battery_wh"] == 120000
    page.click("#new-traverse")
    page.locator("#origin").select_option(rover["id"])
    page.locator("#destination").select_option("MET_STATION")
    page.click("#calculate")
    expect(page.locator("#variants")).to_contain_text("Ruta de travesía", timeout=30000)
    nominal = page.evaluate("qn.cur.traverses.at(-1).result.variants[0].pnr")
    lease = nominal["outbound_total"] + nominal["return_total"] * 0.55 + 30000
    page.evaluate("(id) => qn.popover.openEntity(qn.entities.find(e => e.id === id))", rover["id"])
    page.locator("#point-popover [data-a=edit]").click()
    page.fill("#mobile-battery_wh", str(round(lease, 3)))
    page.locator("#point-popover").get_by_role("button", name="Guardar", exact=True).click()
    page.wait_for_function("qn.cur.traverses.at(-1).result === null")
    page.locator("#point-popover [data-x]").click()
    page.click("#calculate")
    expect(page.locator("#variants")).to_contain_text("Retorno no garantizado", timeout=30000)
    expect(page.locator("#variants")).to_contain_text("desde el origen")
    split = page.evaluate("qn.cur.traverses.at(-1).result.variants[0].pnr")
    assert split["status"] == "pnr_exceeded" and split["pnr_point"]["distance_m"] > 0
    page.screenshot(path=str(OUT / "hatun-wasi-pnr.png"))
    page.click("#view-3d")
    page.wait_for_function("qn.map3d?.overlay.children.some(obj => obj.userData.route && !obj.isSprite)")
    assert page.evaluate("""() => {
      const scene = qn.map3d;
      const line = scene.overlay.children.find(obj => obj.userData.route && !obj.isSprite);
      const points = line.geometry.attributes.position;
      return Array.from({length: points.count}, (_, i) => Math.abs(points.getY(i) -
        scene.surfaceY(points.getX(i), points.getZ(i)) - .65)).every(error => error < .2);
    }""")
    page.screenshot(path=str(OUT / "hatun-wasi-draped.png"))
    page.click("#view-2d")
    page.click("#mission-params summary")
    page.fill("#p-min_temperature_c", "30")
    page.locator("#p-min_temperature_c").press("Tab")
    page.click("#calculate")
    expect(page.locator("#route-alert")).to_contain_text("Temperatura", timeout=30000)
    page.locator("#traverse-list [data-tid]").first.locator(".trav-name").click()
    expect(page.locator("#variants")).to_contain_text("Distancia euclídea")
    page.evaluate("qn.popover.openEntity(qn.entities.find(e => e.id === 'ROVER_PR1'))")
    expect(page.locator("#point-popover")).to_contain_text("Desplegado")
    assert page.locator("#point-popover [data-a=edit]").count() == 0
    assert not errors, errors
    assert page.request.delete(f"{BASE}/api/assets/{rover['id']}").ok
    proof["Hatun Wasi"] = {"mode_count": 3, "exact_direct_endpoint": True, "zoom_m_per_100px": 30,
                           "layer_model": {"tau": 0.83}, "virtual_rover": True,
                           "pnr": split["pnr_point"], "temperature_rejection": True,
                           "layer_window": True, "color_extremes": True, "draped_3d": True, "legend_on_demand": True}
    page.close()


def chaski(browser):
    page, errors = ready(browser, "rover")
    coordinates = page.evaluate("() => [chaski.lat, chaski.lon]")
    assert page.get_by_text("Control manual", exact=True).count() == 0
    page.click("#panels-toggle")
    expect(page.locator(".col-left")).to_be_hidden()
    expect(page.locator(".col-right")).to_be_hidden()
    expect(page.locator("[data-dir=right]")).to_be_hidden()
    expect(page.locator("[data-dir=in]")).to_be_visible()
    zoom = page.evaluate("chaski.map2d.cam.scale")
    page.click("[data-dir=in]")
    assert page.evaluate("chaski.map2d.cam.scale") > zoom
    page.keyboard.down("w")
    page.wait_for_function("chaski.simDistance > 1")
    page.keyboard.up("w")
    moved = page.evaluate("() => [chaski.lat, chaski.lon]")
    assert moved != coordinates
    page.wait_for_function("""() => {
      const s=chaski, { r,c }=s.map2d.g.toRC(s.lat,s.lon);
      return Math.abs(s.map2d.cam.cx-c-.5)<1e-8 && Math.abs(s.map2d.cam.cy-r-.5)<1e-8 &&
        Math.abs(s.map2d.cam.rot + s.heading*Math.PI/180)<1e-8 && s.map2d.beams.length===1 && s.map2d.halos.length===1;
    }""")
    page.click("[data-mode=recon]")
    base = page.evaluate("chaski.map2d.cam.cx")
    page.click("[data-dir=right]")
    assert page.evaluate("chaski.map2d.cam.cx") > base
    page.click("[data-dir=center]")
    assert abs(page.evaluate("chaski.map2d.cam.cx") - base) < 0.001
    assert page.evaluate("() => [chaski.lat, chaski.lon]") == moved
    for name in ("Pendiente", "Riesgo"):
        page.click("#map-menu-btn")
        expect(page.locator("#map-layer-label")).to_have_text(name)
    page.click("#voice")
    page.evaluate("""() => speechProbe.onresult({ resultIndex: 0, results: [[{ transcript: "muestra capa temperatura" }]] })""")
    assert page.locator(".voice-form").count() == 0
    expect(page.locator("#map-layer-label")).to_contain_text("Temperatura", timeout=20000)
    page.keyboard.press("Escape")
    page.click("#panels-toggle")
    page.locator(".rover-window summary").first.click()
    expect(page.locator("#speed")).to_be_hidden()
    page.locator(".rover-window summary").first.click()
    expect(page.locator("#speed")).to_be_visible()
    page.click("#safe-return")
    expect(page.locator("#inspect-card")).to_contain_text("Ruta a Base Alfa", timeout=30000)
    assert page.evaluate("chaski.route.metrics.resources.battery_wh") > 0
    page.screenshot(path=str(OUT / "chaski-2d.png"))
    page.click("#view-toggle")
    expect(page.locator("#map3d canvas")).to_be_visible(timeout=30000)
    page.click("[data-dir=center]")
    page.wait_for_function("chaski.view === '3d' && [...document.querySelectorAll('#map3d .m3d-rover')].some(e => e.textContent === chaski.name && e.style.display !== 'none')")
    page.screenshot(path=str(OUT / "chaski.png"))
    assert not errors, errors
    proof["Chaski"] = {"pan_and_zoom": True, "position_unchanged": True, "hide_panels": True, "layer_cycle": True,
                       "direct_layer_intent": "temperature", "shared_route": True, "3d": True,
                       "keyboard_demo": True, "bodyframe": True, "location_and_heading_light": True}
    page.close()


def nawi(browser):
    page, errors = ready(browser, "hud")
    expect(page.locator(".vitals")).to_be_visible()
    expect(page.locator(".suit")).to_be_hidden()
    expect(page.locator(".goal")).to_have_count(0)
    expect(page.locator("#eva-demo-controls")).to_be_hidden()
    page.click("#eva-demo-toggle")
    expect(page.locator("#eva-demo-controls")).to_be_visible()
    page.click("#eva-demo-toggle")
    assert page.evaluate("nawi.route.metrics.resources.o2_kg") > 0
    assert page.evaluate("nawi.route.points.length") > 10
    page.wait_for_function("nawi.scene.world.companions.some(a => a.activity === 'walking' && Math.abs(a.group.position.x - a.ax) > 0.1)")
    page.click("#voice-btn")
    page.evaluate("""() => speechProbe.onresult({ resultIndex: 0, results: [[{ transcript: "ruta a base alfa" }]] })""")
    page.wait_for_function("nawi.targets[nawi.ti]?.kind === 'base' && !nawi.planning")
    assert page.locator(".voice-form").count() == 0
    page.click("#camera-btn")
    expect(page.locator("body")).to_have_attribute("data-camera", "third")
    expect(page.locator(".vitals")).to_be_hidden()
    expect(page.locator(".reticle")).to_be_hidden()
    expect(page.locator("#camera-btn")).to_be_hidden()
    page.wait_for_function("""() => {
      const scene = nawi.scene;
      const astronaut = scene.character.position;
      const camera = scene.camera.position;
      return scene.astronaut.visible && !scene.routeGroup.visible &&
        !scene.world.pathBlocked(astronaut.x, astronaut.z, camera.x, camera.z, 0.45);
    }""")
    page.screenshot(path=str(OUT / "nawi-third-person.png"))
    page.keyboard.press("c")
    expect(page.locator(".vitals")).to_be_visible()
    page.wait_for_function("nawi.prompt === 'base'")
    page.keyboard.press("e")
    page.wait_for_function("nawi.inside && !nawi.resupplying")
    page.screenshot(path=str(OUT / "nawi-base.png"))
    page.keyboard.press("e")
    page.wait_for_function("!nawi.inside && !nawi.resupplying")
    page.evaluate("""() => {
      const sample = nawi.scene.world.collectibleSamples[0];
      nawi.x = sample.x + 2; nawi.z = sample.z;
    }""")
    page.wait_for_function("nawi.prompt?.id?.startsWith('EVA_SAMPLE')")
    page.keyboard.press("e")
    expect(page.locator("#samples")).to_have_text("1/16")
    assert page.evaluate("nawi.scene.world.pathBlocked(-80, -60, -50, -60)")
    page.evaluate("""() => {
      const station = nawi.scene.world.interactiveStations.find(s => s.fault);
      nawi.x = station.x + 4.5; nawi.z = station.z;
    }""")
    page.wait_for_function("nawi.prompt?.station?.fault")
    page.keyboard.press("e")
    page.get_by_role("button", name="Reparar").click()
    page.wait_for_function("nawi.scene.world.interactiveStations.every(s => !s.fault)")
    expect(page.locator(".suit")).to_contain_text("volvió a estado operativo", timeout=10000)
    expect(page.locator('[data-code="ACTION"]')).to_have_count(0, timeout=10000)
    assert not errors, errors
    proof["Ñawi"] = {"camera_roundtrip": True, "nominal_suit_hidden": True, "base_with_E": True,
                    "sample_collected": True, "swept_collision": True, "equipment_repaired": True,
                    "animated_companions": True, "demo_controls_hidden": True, "voice_target": True, "timed_notice": True}
    page.close()


def mobile(browser):
    for path, target in (("console", "#dock"), ("rover", "#panels-toggle"), ("hud", "#camera-btn")):
        page, errors = ready(browser, path, (390, 844))
        assert page.evaluate("document.documentElement.scrollWidth") == 390
        if path == "rover":
            expect(page.locator("#panels-toggle")).to_be_visible()
            expect(page.locator(".col-left")).to_be_hidden()
            page.click("#panels-toggle")
            expect(page.locator(".col-left")).to_be_visible()
            page.click("[data-mode=recon]")
            page.locator(".camera-controls summary").click()
            assert page.locator(".camera-controls").bounding_box()["y"] > (
                page.locator(".col-left").bounding_box()["y"] + page.locator(".col-left").bounding_box()["height"]
            )
            page.click("[data-dir=center]")
            page.locator(".camera-controls summary").click()
        elif path == "hud":
            page.click(target)
            expect(page.locator("body")).to_have_attribute("data-camera", "third")
            page.touchscreen.tap(195, 420)
            expect(page.locator("body")).to_have_attribute("data-camera", "first")
        else:
            expect(page.locator(target)).to_be_visible()
            expect(page.locator("#focus-btn")).to_be_visible()
        assert not errors, errors
        page.screenshot(path=str(OUT / f"{path}-mobile.png"))
        page.close()
    proof["mobile"] = {"width": 390, "surfaces": ["console", "rover", "hud"], "nawi_touch_return": True}


if __name__ == "__main__":
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=CHANNEL, args=[
            "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        ])
        try:
            request = browser.new_context().request
            assert request.put(BASE + "/api/workspace", data={"sessions": []}).ok
            assert request.delete(BASE + "/api/harness").ok
            for test in (console, chaski, nawi, mobile):
                test(browser)
                print(f"PASS {test.__name__}", flush=True)
        finally:
            (OUT / "operational-traverse.json").write_text(json.dumps(proof, ensure_ascii=False, indent=2), encoding="utf-8")
            browser.close()

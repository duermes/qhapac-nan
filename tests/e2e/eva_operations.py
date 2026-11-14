import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
out = Path(sys.argv[2] if len(sys.argv) > 2 else "test-results/eva")
out.mkdir(parents=True, exist_ok=True)
errors = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="chromium", args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    page.on("pageerror", lambda e: errors.append(str(e)))
    try:
        page.goto(url + "/hud", wait_until="networkidle", timeout=90000)
        page.wait_for_selector('body[data-ready="1"]', timeout=90000)
        page.wait_for_function("nawi.vitals.last !== null && nawi.route !== null", timeout=30000)
        initial = page.evaluate("""() => ({
          samples: nawi.scene.world.collectibleSamples.length,
          colliders: nawi.scene.world.colliders.length,
          interior: nawi.scene.world.baseInteriorGroup.children.length,
          route: nawi.route.metrics,
          x: nawi.x, z: nawi.z,
          stamina: nawi.vitals.effort.staminaPct
        })""")
        assert initial["samples"] == 16
        assert initial["colliders"] > 50
        assert initial["interior"] > 8
        page.screenshot(path=str(out / "exterior.png"))
        page.keyboard.down("w")
        page.wait_for_timeout(2000)
        page.keyboard.up("w")
        walking = page.evaluate("() => ({ x: nawi.x, z: nawi.z, stamina: nawi.vitals.effort.staminaPct, leg: nawi.scene.character.leftLeg.rotation.x })")
        assert abs(walking["x"] - initial["x"]) + abs(walking["z"] - initial["z"]) > 0.5
        assert walking["stamina"] < initial["stamina"]
        page.wait_for_timeout(2500)
        assert page.evaluate("nawi.vitals.effort.staminaPct") > walking["stamina"]
        collision = page.evaluate("""() => {
          const c = nawi.scene.character;
          return { base: c.checkCollision(-65, -60), open: c.checkCollision(-65, -44) };
        }""")
        assert collision == {"base": True, "open": False}
        page.evaluate("""() => {
          const sample = nawi.scene.world.collectibleSamples[0];
          nawi.x = sample.x + 2; nawi.z = sample.z;
        }""")
        page.wait_for_function("nawi.prompt?.id === 'EVA_SAMPLE_01'")
        before_sample = page.evaluate("nawi.vitals.o2_kg")
        page.keyboard.press("e")
        page.wait_for_function("nawi.samples.length === 1")
        assert page.locator("#samples").inner_text() == "1/16"
        assert page.evaluate("nawi.scene.world.collectibleSamples[0].mesh.parent === null")
        assert page.evaluate("nawi.vitals.o2_kg") < before_sample
        page.keyboard.press("e")
        assert page.evaluate("nawi.samples.length") == 1
        page.evaluate("nawi.x = -65; nawi.z = -44")
        page.wait_for_function("nawi.scene.character.nearBaseAirlock")
        page.keyboard.press("f")
        page.wait_for_function("nawi.inside && !nawi.resupplying")
        assert page.evaluate("nawi.scene.world.baseInteriorGroup.visible")
        assert page.evaluate("nawi.vitals.o2_kg") == 1.2
        assert page.evaluate("nawi.vitals.effort.staminaPct") == 100
        assert page.evaluate("nawi.scene.character.checkCollision(-40, -60)")
        page.screenshot(path=str(out / "interior.png"))
        page.evaluate("nawi.x = -65; nawi.z = -64; nawi.scene.pitch = 0")
        page.wait_for_function("nawi.prompt === 'monitor'")
        page.keyboard.press("e")
        page.wait_for_selector(".modal")
        assert "Monitor de misión" in page.locator(".modal").inner_text()
        page.keyboard.press("Escape")
        page.evaluate("nawi.x = -65; nawi.z = -52.5")
        page.wait_for_function("nawi.scene.character.nearBaseAirlock")
        page.keyboard.press("f")
        page.wait_for_function("!nawi.inside")
        page.keyboard.press("c")
        assert page.evaluate("nawi.scene.cameraMode") == "third"
        page.screenshot(path=str(out / "astronaut.png"))
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(1000)
        assert page.locator("#act-btn").is_visible()
        page.screenshot(path=str(out / "mobile.png"))
        assert not errors, errors
        print(json.dumps({"status": "passed", "initial": initial, "walking": walking, "errors": errors}, ensure_ascii=False))
    except Exception:
        page.screenshot(path=str(out / "failure.png"))
        print(json.dumps({"errors": errors, "body": page.locator("body").inner_text()[:2500]}, ensure_ascii=False))
        raise
    finally:
        browser.close()

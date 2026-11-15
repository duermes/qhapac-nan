import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
out = Path(sys.argv[2] if len(sys.argv) > 2 else "test-results/home-journey")
out.mkdir(parents=True, exist_ok=True)
errors = []


def state(page):
    return page.evaluate("""() => ({
      stage: document.body.dataset.stage,
      progress: document.querySelector('#journey-viewport').dataset.progress,
      cameraX: document.querySelector('#journey-viewport').dataset.cameraX,
      scroll: document.querySelector('#journey').scrollTop,
      range: document.querySelector('#journey').scrollHeight - document.querySelector('#journey').clientHeight,
      html: getComputedStyle(document.documentElement).overflow,
      body: getComputedStyle(document.body).overflow,
      viewport: document.querySelector('#journey-viewport').getBoundingClientRect().toJSON(),
      window: {width: innerWidth, height: innerHeight}
    })""")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="chromium")
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script("""new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === 1 && node.id === 'journey-entry-cover') document.documentElement.dataset.transitionSeen = '1';
      }
    }).observe(document, {childList:true,subtree:true});""")
    try:
        page.goto(base + "/home", wait_until="networkidle")
        page.wait_for_selector('body[data-ready="1"]')
        assert page.locator('svg').count() == 0
        assert page.locator('.chapter-kicker,.journey-counter,.enter-arrow,.cue-arrow').count() == 0
        assert page.locator('#scroll-cue').count() == 0
        assert page.locator('#eyes-scene,#eyes-art').count() == 2
        assert page.locator('.header-products .waypoint').count() == 3
        panorama = page.locator('#world-art').get_attribute('src')
        print(json.dumps({"initial": state(page)}, ensure_ascii=False), flush=True)
        page.screenshot(path=str(out / "01-intiwatana.png"))
        page.mouse.move(1100,400)
        page.mouse.wheel(0,900)
        page.wait_for_function("Number(document.querySelector('#journey-viewport').dataset.progress) > 0.18")
        wheel_state = state(page)
        assert float(wheel_state["cameraX"]) > 0
        assert wheel_state["viewport"]["top"] == 0
        assert page.evaluate("document.querySelector('#journey-viewport').scrollTop") == 0
        page.get_by_role("button", name="Ir a Chaski, monitor del rover", exact=True).click()
        page.wait_for_function("Number(document.querySelector('#journey-viewport').dataset.progress) > 0.42", timeout=8000)
        page.wait_for_function("Math.abs(Number(document.querySelector('#journey-viewport').dataset.progress) - 0.435) < 0.001")
        print(json.dumps({"chaski": state(page)}, ensure_ascii=False), flush=True)
        page.screenshot(path=str(out / "02-chaski.png"))
        assert page.locator("#copy-chaski").get_attribute("aria-hidden") == "false"
        page.get_by_role("button", name="Ir a Ñawi, guerrero y visor EVA", exact=True).click()
        page.wait_for_function("Math.abs(Number(document.querySelector('#journey-viewport').dataset.progress) - 0.735) < 0.001")
        page.screenshot(path=str(out / "03-warrior.png"))
        page.get_by_role("button", name="Acércate a sus ojos", exact=True).click()
        page.wait_for_selector('body[data-eye-ready="true"]')
        page.wait_for_function("Number(document.querySelector('#journey-viewport').dataset.progress) > 0.999")
        page.screenshot(path=str(out / "04-eyes.png"))
        assert page.locator('#world-art').get_attribute('src') == panorama
        assert page.locator('#eyes-art').get_attribute('src').endswith('nawi-eyes.png')
        assert page.locator('#eyes-scene').evaluate('e => Number(getComputedStyle(e).opacity)') == 1
        assert 1 < float(page.locator('#journey-viewport').evaluate("e => e.style.getPropertyValue('--camera-zoom')")) <= 2.2
        assert page.locator("#go-hud").is_visible()
        assert page.locator("#go-hud").get_attribute("href") == "/hud"
        page.mouse.wheel(0,-1250)
        page.wait_for_function("document.body.dataset.eyeReady === 'false'")
        page.keyboard.press("End")
        page.wait_for_selector('body[data-eye-ready="true"]')
        page.locator("#go-hud").click()
        page.wait_for_selector('.product-loading-runner[src$="chaski-running.svg"]')
        page.screenshot(path=str(out / "07-loading-nawi.png"))
        page.wait_for_url(base + "/hud",timeout=15000)
        page.wait_for_selector('body[data-ready="1"]',timeout=90000)
        page.wait_for_selector("#journey-entry-cover",state="detached",timeout=15000)
        assert page.locator("html").get_attribute("data-transition-seen") == "1"
        for index,selector,path in [(0,"#go-console","/console"),(1,"#go-rover","/rover")]:
            page.goto(base + "/home",wait_until="networkidle")
            page.locator(f'[data-stop="{index}"]').click()
            page.wait_for_selector(f'#copy-{"intiwatana" if index == 0 else "chaski"}[aria-hidden="false"]')
            page.locator(selector).click()
            page.wait_for_selector('.product-loading-runner[src$="chaski-running.svg"]')
            page.wait_for_url(base + path,timeout=15000)
            page.wait_for_selector('body[data-ready="1"]',timeout=60000)
            page.wait_for_selector("#journey-entry-cover",state="detached",timeout=15000)
            assert page.locator("html").get_attribute("data-transition-seen") == "1"
        page.goto(base + "/home",wait_until="networkidle")
        page.get_by_role("button",name="Acerca de la misión",exact=True).click()
        page.wait_for_selector("#mission-dialog[open]")
        page.wait_for_function("document.querySelector('#st-health').textContent.includes('operativo')")
        page.keyboard.press("Escape")
        assert not page.locator("#mission-dialog").is_visible()
        mobile = browser.new_context(viewport={"width":390,"height":844},is_mobile=True,has_touch=True)
        m = mobile.new_page()
        m.on("pageerror",lambda error:errors.append(str(error)))
        m.goto(base + "/home",wait_until="networkidle")
        m.screenshot(path=str(out / "05-mobile-intiwatana.png"))
        m.evaluate("""() => {
          const target = document.querySelector('#journey-viewport');
          const first = new Touch({identifier:1,target,clientX:330,clientY:330});
          target.dispatchEvent(new TouchEvent('touchstart',{touches:[first],bubbles:true}));
          const last = new Touch({identifier:1,target,clientX:70,clientY:335});
          target.dispatchEvent(new TouchEvent('touchmove',{touches:[last],bubbles:true,cancelable:true}));
          target.dispatchEvent(new TouchEvent('touchend',{touches:[],bubbles:true}));
        }""")
        m.wait_for_function("Number(document.querySelector('#journey-viewport').dataset.progress) > 0.2")
        m.locator('[data-stop="2"]').tap()
        m.wait_for_selector('#copy-warrior[aria-hidden="false"]')
        m.locator("#approach-eyes").tap()
        m.wait_for_selector('body[data-eye-ready="true"]')
        m.wait_for_function("Number(document.querySelector('#journey-viewport').dataset.progress) > 0.999")
        eye_box = m.locator("#go-hud").bounding_box()
        assert eye_box["x"] >= 0 and eye_box["x"] + eye_box["width"] <= 390
        assert eye_box["y"] >= 84 and eye_box["y"] + eye_box["height"] < 650
        m.screenshot(path=str(out / "06-mobile-eyes.png"))
        assert m.evaluate("document.documentElement.scrollWidth <= innerWidth")
        mobile.close()
        reduced = browser.new_context(viewport={"width":1280,"height":800},reduced_motion="reduce")
        r = reduced.new_page()
        r.goto(base + "/home",wait_until="networkidle")
        r.keyboard.press("End")
        r.wait_for_selector('body[data-eye-ready="true"]')
        assert r.locator("#journey-viewport").evaluate("e => e.style.getPropertyValue('--camera-zoom')") == "1.00000"
        reduced.close()
        assert not errors, errors
        print(json.dumps({"status": "passed", "wheel": wheel_state, "destinations": ["/console","/rover","/hud"], "mobile_eye": eye_box, "reduced_motion": True, "errors": errors}, ensure_ascii=False), flush=True)
    except Exception:
        details = state(page) if page.locator("#journey-viewport").count() else {"url":page.url}
        print(json.dumps({"failed": details, "errors": errors}, ensure_ascii=False), flush=True)
        page.screenshot(path=str(out / "failure.png"))
        raise
    finally:
        browser.close()

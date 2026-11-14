"""Quick UI smoke: load each page, capture console errors and a screenshot.
Usage: .venv/bin/python tests/e2e/smoke.py http://127.0.0.1:8765 OUTDIR"""
import sys, json
from playwright.sync_api import sync_playwright

base, out = sys.argv[1], sys.argv[2]
pages = ["home", "console", "rover", "hud"]
res = {}
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    for name in pages:
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        errs = []
        pg.on("console", lambda m, errs=errs: errs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e, errs=errs: errs.append(f"pageerror: {e}"))
        pg.goto(f"{base}/{name}", wait_until="networkidle")
        try:
            pg.wait_for_selector("body[data-ready='1']", timeout=20000) if name != "home" else pg.wait_for_timeout(1500)
        except Exception as e:
            errs.append(f"not ready: {e}")
        pg.wait_for_timeout(2500)
        print("shot", name, flush=True); pg.screenshot(path=f"{out}/{name}.png", timeout=60000)
        res[name] = errs
        pg.close()
    b.close()
print(json.dumps(res, indent=1, ensure_ascii=False))

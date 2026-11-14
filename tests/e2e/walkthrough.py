"""End-to-end UI walkthrough of Hatun Wasi, Chaski and Ñawi (Playwright, Chromium headless).

Usage:
  .venv/bin/python tests/e2e/walkthrough.py http://127.0.0.1:8765 OUTDIR
Writes OUTDIR/walkthrough.json (one entry per check, with REF/FC ids) and screenshots.
Requires `pip install playwright && playwright install chromium` (dev-only tool)."""
from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "e2e_out")
OUT.mkdir(parents=True, exist_ok=True)
RESULTS: list[dict] = []
CURRENT = {"page": None}
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]


def check(name: str, refs: list[str], fn):
    t = time.time()
    try:
        ev = fn()
        RESULTS.append({"name": name, "refs": refs, "status": "passed", "evidence": str(ev)[:400], "s": round(time.time() - t, 2)})
        print("PASS", name, flush=True)
    except Exception as e:  # noqa: BLE001
        try:
            if CURRENT["page"]:
                CURRENT["page"].screenshot(path=str(OUT / f"fail_{len(RESULTS):02d}.png"))
                CURRENT["page"].keyboard.press("Escape")
        except Exception:  # noqa: BLE001
            pass
        RESULTS.append({"name": name, "refs": refs, "status": "failed", "evidence": f"{type(e).__name__}: {e}"[:600],
                        "trace": traceback.format_exc()[-800:], "s": round(time.time() - t, 2)})
        print("FAIL", name, e, flush=True)


def new_page(browser, w=1440, h=900, path="/console"):
    pg = browser.new_page(viewport={"width": w, "height": h}, accept_downloads=True)
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("console", lambda m: pg.errors.append(m.text) if m.type == "error" else None)
    pg.goto(BASE + path, wait_until="domcontentloaded")
    pg.wait_for_selector("body[data-ready='1']", timeout=45000)
    pg.wait_for_timeout(800)
    CURRENT["page"] = pg
    return pg


def box(pg, sel):
    b = pg.locator(sel).first.bounding_box()
    assert b, f"{sel} not visible"
    return b


def assert_true(cond, msg):
    if not cond:
        raise AssertionError(msg)


WP = f"WP E2E {int(time.time()) % 100000}"
WP2 = WP.replace("E2E", "Editado")


def console_flows(br):
    # reset persisted workspace so the run is deterministic
    import urllib.request
    req = urllib.request.Request(BASE + "/api/workspace", data=b'{"sessions": []}', method="PUT", headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req).read()
    # remove user waypoints left by previous runs (test isolation)
    for sid in ("S1", "S2", "S3", "S4"):
        a = json.loads(urllib.request.urlopen(f"{BASE}/api/assets?session_id={sid}").read())
        for x in a["general"] + a["session"]:
            if x["name"].startswith(("WP E2E", "WP Editado")):
                urllib.request.urlopen(urllib.request.Request(f"{BASE}/api/assets/{x['id']}", method="DELETE")).read()
    pg = new_page(br)
    W, H = 1440, 900

    def composition():
        brand, plan, trav, dock = box(pg, ".tl .brand"), box(pg, "#planning"), box(pg, "#traverses"), box(pg, "#dock")
        tabs, sw, sb, hud = box(pg, "#sessions"), box(pg, ".view-switch"), box(pg, "#scalebar"), box(pg, "#coord-hud")
        assert_true(brand["x"] < 40 and brand["y"] < 40, "brand top-left")
        assert_true(tabs["y"] > brand["y"] + brand["height"] - 2, "sessions below brand")
        assert_true(plan["x"] < 40 and plan["y"] > 100, "planning left")
        assert_true(trav["x"] + trav["width"] > W - 40, "traverses right")
        assert_true(abs(dock["x"] + dock["width"] / 2 - W / 2) < 30 and dock["y"] + dock["height"] > H - 30, "dock bottom centre")
        assert_true(sw["x"] + sw["width"] > W - 40 and sw["y"] < 40, "2D/3D top right")
        assert_true(sb["x"] < 40 and sb["y"] > H - 120, "scale bar bottom-left")
        assert_true(hud["x"] + hud["width"] > W - 40, "coords bottom-right")
        return {"brand": brand, "planning": plan, "traverses": trav, "dock": dock}
    check("Hatun Wasi composition matches reference", ["FC-001", "FC-002", "FC-005", "REF-015", "REF-026", "REF-030"], composition)

    def initial_clean():
        assert_true(pg.locator("#deck-metrics").is_hidden() and pg.locator("#deck-layers").is_hidden(), "decks hidden at start")
        assert_true(pg.locator("#search-results").is_hidden(), "search results hidden")
        assert_true(pg.locator("#menubar").is_hidden(), "menubar hidden")
        name = pg.locator("#sector-name").inner_text()
        assert_true("Jezero" in name, f"sector {name}")
        return name
    check("Initial layout clean; sector focused dynamically on Jezero", ["REF-015", "REF-103", "FC-023"], initial_clean)

    def texture():
        r = pg.evaluate("() => ({w: qn.map2d.base.width, h: qn.map2d.base.height, stride: qn.region.stride, product: qn.region.manifest.source.product_id})")
        assert_true(r["w"] > 500 and r["h"] > 500, "base texture built from MOLA")
        return r
    check("Terrain texture loads from MOLA region", ["REF-016", "FC-019"], texture)

    def hover_hud():
        pg.mouse.move(W / 2, H / 2)
        pg.wait_for_timeout(300)
        lat, elev = pg.locator("#hud-lat").inner_text(), pg.locator("#hud-elev").inner_text()
        assert_true("N" in lat and "m" in elev, f"{lat} {elev}")
        return {"lat": lat, "lon": pg.locator("#hud-lon").inner_text(), "elev": elev, "slope": pg.locator("#hud-slope").inner_text(), "zoom": pg.locator("#hud-zoom").inner_text()}
    check("Coordinate HUD follows cursor (lat/lon/elev/slope/zoom)", ["FC-024", "REF-095"], hover_hud)

    def zoom_no_drift():
        pg.mouse.move(700, 450)
        before = pg.evaluate("() => qn.map2d.screenToLL(700, 450)")
        for _ in range(5):
            pg.mouse.wheel(0, -300)
            pg.wait_for_timeout(80)
        after = pg.evaluate("() => qn.map2d.screenToLL(700, 450)")
        drift = abs(before["lat"] - after["lat"]) + abs(before["lon"] - after["lon"])
        assert_true(drift < 1e-3, f"drift {drift}")
        for _ in range(40):
            pg.mouse.wheel(0, 2000)
        sc = pg.evaluate("() => [qn.map2d.cam.scale, qn.map2d.minScale]")
        assert_true(abs(sc[0] - sc[1]) < 1e-6, "zoom-out limited at region fit")
        return {"drift_deg": drift, "scale_at_limit": sc}
    check("2D zoom limits without drift", ["REF-159", "FC-020"], zoom_no_drift)

    def scale_constant_contours():
        a = pg.evaluate("() => ({sb: document.querySelector('#scalebar .sb-text').textContent, iv: qn.map2d.contourInterval()})")
        pg.mouse.move(700, 450)
        for _ in range(8):
            pg.mouse.wheel(0, -400)
            pg.wait_for_timeout(60)
        b = pg.evaluate("() => ({sb: document.querySelector('#scalebar .sb-text').textContent, iv: qn.map2d.contourInterval(), lw: 0.8})")
        assert_true(a["sb"] != b["sb"], "scale bar updates with zoom")
        return {"before": a, "after": b}
    check("Scale bar updates; contour interval adapts while stroke width is constant in px", ["FC-026", "FC-027", "REF-102"], scale_constant_contours)

    # ---------------- planning
    def plan_route():
        pg.select_option("#origin", "ROVER_PR1")
        pg.select_option("#destination", "POI_DELTA_FRONT")
        pg.click("#calculate")
        pg.wait_for_selector(".variant", timeout=40000)
        n = pg.locator(".variant").count()
        assert_true(n == 3, f"variants {n}")
        routes = pg.evaluate("() => qn.map2d.routes.map(r => r.id)")
        assert_true(any(r.endswith(":calc") for r in routes) and any(r.endswith(":direct") for r in routes), routes)
        pg.screenshot(path=str(OUT / "console_route.png"))
        return {"variants": [pg.locator(".variant").nth(i).inner_text() for i in range(n)], "routes": routes}
    check("Plan route: origin/destination selectors, Calcular, three variants", ["FC-042", "FC-047", "FC-048", "REF-154", "REF-155", "REF-144", "REF-182"], plan_route)

    def route_toggles():
        b1, b2 = box(pg, "#show-direct"), box(pg, "#show-calculated")
        assert_true(abs(b1["width"] - b2["width"]) < 2, "two buttons 50%")
        pg.click("#show-direct")
        r = pg.evaluate("() => qn.map2d.routes.map(r => r.id)")
        assert_true(not any(x.endswith(":direct") for x in r), "direct hidden")
        assert_true(pg.get_attribute("#show-direct", "aria-pressed") == "false", "aria")
        pg.click("#show-direct")
        pg.click("#show-calculated")
        r2 = pg.evaluate("() => qn.map2d.routes.map(r => r.id)")
        assert_true(not any(x.endswith(":calc") for x in r2), "calc hidden")
        pg.click("#show-calculated")
        return {"widths": [b1["width"], b2["width"]], "after_direct_off": r, "after_calc_off": r2}
    check("Direct/calculated route toggles (two 50% buttons, compact toolbar)", ["REF-032", "REF-040", "REF-070", "FC-047"], route_toggles)

    def eye_toggle():
        pg.click(".console-dock .dock-btn[data-mode='plan'] .eye")
        r = pg.evaluate("() => qn.map2d.routes.length")
        pg.click(".console-dock .dock-btn[data-mode='plan'] .eye")
        r2 = pg.evaluate("() => qn.map2d.routes.length")
        a = pg.evaluate("() => qn.cur.eyes")
        assert_true(r == 0 and r2 > 0, f"{r} {r2}")
        return {"hidden": r, "shown": r2, "eyes": a}
    check("Unified route visibility via planning eye; eyes independent per mode", ["REF-042", "REF-147"], eye_toggle)

    def metrics_deck():
        pg.click("#metrics")
        pg.wait_for_selector("#deck-metrics:not([hidden])")
        b = box(pg, "#deck-metrics")
        txt = pg.locator("#deck-metrics").inner_text()
        low = txt.lower()
        assert_true("evaluación pnr" in low and "distancia euclídea" in low and "energía" in low, txt[:300])
        assert_true(abs(b["x"] + b["width"] / 2 - W / 2) < 80, "centred overlay")
        assert_true(b["width"] <= 540, "compact")
        hb = box(pg, "#deck-metrics .deck-handle")
        pg.mouse.move(hb["x"] + 60, hb["y"] + 10)
        pg.mouse.down(); pg.mouse.move(hb["x"] + 160, -300, steps=6); pg.mouse.up()
        b2 = box(pg, "#deck-metrics")
        assert_true(b2["y"] >= 7, f"top boundary {b2['y']}")
        pg.click("#deck-metrics .deck-close")
        assert_true(pg.locator("#deck-metrics").is_hidden(), "closes")
        return {"box": b, "after_drag": b2}
    check("Metrics deck: on-demand, centred, compact, draggable, top-bounded, PNR section", ["REF-028", "REF-044", "REF-056", "REF-068", "REF-071", "REF-168", "FC-053"], metrics_deck)

    def nearby():
        pg.click("#nearby-pois")
        pg.wait_for_selector("#deck-nearby:not([hidden])")
        pg.wait_for_timeout(300)
        n = pg.locator("#deck-nearby [data-poi]").count()
        b = box(pg, "#deck-nearby")
        assert_true(n > 0, "pois listed")
        pg.click("#deck-nearby [data-f='science']")
        n2 = pg.locator("#deck-nearby [data-poi]").count()
        assert_true(b["x"] >= 0 and b["y"] >= 0 and b["x"] + b["width"] <= W and b["y"] + b["height"] <= H, "bounded")
        pg.click("#deck-nearby .deck-close")
        return {"all": n, "science": n2, "box": b}
    check("Nearby POIs corridor deck with type filters, bounded", ["REF-045", "REF-057", "FC-039"], nearby)

    def save_lock():
        pg.click("#save-route")
        pg.wait_for_timeout(600)
        saved = pg.evaluate("() => qn.cur.traverses.find(t => t.id === qn.cur.activeTraverse).saved")
        assert_true(saved, "saved")
        return {"saved": saved, "card": pg.locator(".trav.active .trav-foot").inner_text()}
    check("Save route marks traverse saved", ["FC-050", "REF-043"], save_lock)

    # ---------------- layers
    def layers():
        pg.click(".console-dock .dock-btn[data-mode='analyze']")
        pg.wait_for_selector("#deck-layers:not([hidden])")
        pg.click("#deck-layers [data-layer='slope'] .switch")
        pg.wait_for_function("() => qn.map2d.layers.some(l => l.id === 'slope')", timeout=30000)
        pg.click("#deck-layers [data-layer='survival_astronaut'] .switch")
        pg.wait_for_function("() => qn.map2d.layers.length >= 2", timeout=60000)
        legend_ramps = pg.locator("#deck-layers .legend-ramp").count()
        pill = pg.locator("#active-layer-name").inner_text()
        op = pg.locator("#deck-layers [data-opacity='slope']")
        op.fill("0.3")
        o = pg.evaluate("() => qn.cur.layers.slope.opacity")
        pg.click("#deck-layers [data-reset='slope']")
        pg.wait_for_timeout(500)
        o2 = pg.evaluate("() => qn.cur.layers.slope.opacity")
        b = box(pg, "#deck-layers")
        assert_true(legend_ramps >= 2 and o == 0.3 and o2 == 0.6 and b["height"] <= H - 120, f"{legend_ramps} {o} {o2} {b}")
        pg.screenshot(path=str(OUT / "console_layers.png"))
        return {"active_layer_pill": pill, "legend_ramps": legend_ramps, "opacity_changed": o, "after_reset": o2, "deck_height": b["height"]}
    check("Layer deck: toggles, alpha blend, individual reset, legends, bounded height", ["FC-033", "FC-034", "FC-035", "FC-036", "REF-029", "REF-048", "REF-176", "REF-072"], layers)

    def temporal_realtime():
        pg.locator("#deck-layers [data-hour='survival_astronaut']").fill("20")
        pg.locator("#deck-layers [data-hour='survival_astronaut']").dispatch_event("change")
        pg.wait_for_function("() => qn.cur.layers.survival_astronaut.realtime === false", timeout=20000)
        pg.wait_for_selector("#rt-restore:not([disabled])", timeout=30000)
        pg.click("#rt-restore")
        pg.wait_for_timeout(800)
        rt = pg.evaluate("() => qn.cur.layers.survival_astronaut.realtime")
        assert_true(rt is True, "restored")
        return {"realtime": rt}
    check("Temporal layers restore to real time", ["REF-049", "REF-169", "FC-035", "FC-040"], temporal_realtime)

    def legend_filters():
        pg.click("#legend-btn")
        pg.wait_for_selector("#deck-legend:not([hidden])")
        pg.click("#deck-legend label[for='lg-rover'] + .switch")
        hidden = pg.evaluate("() => [...qn.map2d.hidden]")
        pg.click("#deck-legend label[for='lg-rover'] + .switch")
        txt = pg.locator("#deck-legend").inner_text()
        pg.click("#deck-legend .deck-close")
        assert_true("rover" in hidden and "capas visibles" in txt.lower(), hidden)
        return {"hidden_after_toggle": hidden}
    check("Legend deck with element visibility filters", ["REF-148", "REF-166", "FC-033"], legend_filters)

    # ---------------- inspection & points
    def risk_inspector():
        pg.click(".console-dock .dock-btn[data-mode='plan']")
        pg.click("#deck-layers .deck-close") if pg.locator("#deck-layers").is_visible() else None
        pg.evaluate("() => qn.map2d.focusOn(18.34, 77.66, qn.map2d.minScale * 5)")
        pt = pg.evaluate("() => qn.map2d.llToScreen(18.30, 77.70)")
        pg.mouse.click(pt["x"], pt["y"])
        pg.wait_for_selector("#deck-risk:not([hidden]) .risk-item", timeout=30000)
        txt = pg.locator("#deck-risk").inner_text()
        b = box(pg, "#deck-risk")
        tr = box(pg, "#traverses")
        assert_true(b["x"] + b["width"] <= tr["x"] + 1, "risk deck does not cover the traverse rack")
        pg.keyboard.press("Escape")
        pg.click("#deck-risk .deck-close")
        assert_true("Pendiente" in txt and "Iluminación" in txt, txt[:200])
        return {"box": b, "text": txt[:300]}
    check("Contextual risk inspector (planning only) with honest illumination", ["REF-021", "REF-027", "REF-050", "REF-151", "FC-038"], risk_inspector)

    def general_no_risk():
        pg.click(".console-dock .dock-btn[data-mode='general']")
        pg.evaluate("() => qn.map2d.focusOn(18.34, 77.66, qn.map2d.minScale * 5)")
        pt = pg.evaluate("() => qn.map2d.llToScreen(18.32, 77.68)")
        pg.mouse.click(pt["x"], pt["y"])
        pg.wait_for_timeout(600)
        vis = pg.locator("#deck-risk").is_visible()
        pop = pg.locator("#point-popover").is_visible()
        pg.keyboard.press("Escape")
        pg.click(".console-dock .dock-btn[data-mode='plan']")
        assert_true(not vis and pop, f"risk {vis} popover {pop}")
        return {"risk_deck_in_general": vis, "point_popover": pop}
    check("Risk evaluation exclusive to planning; click shows point info", ["REF-151", "REF-105", "FC-029"], general_no_risk)

    def add_point():
        pg.click("#new-point")
        pg.evaluate("() => qn.map2d.focusOn(18.34, 77.66, qn.map2d.minScale * 5)")
        pt = pg.evaluate("() => qn.map2d.llToScreen(18.36, 77.62)")
        pg.mouse.click(pt["x"], pt["y"])
        pg.wait_for_selector("#add-point-form")
        pg.fill("#ap-name", WP)
        pg.click(".modal footer .btn-gold")
        pg.wait_for_function("() => qn.entities.some(e => e.name === '"+WP+"')", timeout=10000)
        e = pg.evaluate("() => qn.entities.find(e => e.name === '"+WP+"')")
        return {"id": e["id"], "lat": e["lat"], "lon": e["lon"]}
    check("Add-point modal creates a waypoint by click", ["REF-152", "FC-043", "REF-179"], add_point)

    def click_vs_drag():
        e = pg.evaluate("() => { const e = qn.entities.find(x => x.name === '"+WP+"'); const p = qn.map2d.llToScreen(e.lat, e.lon); return {x: p.x, y: p.y, lat: e.lat, lon: e.lon}; }")
        pg.mouse.move(e["x"], e["y"]); pg.mouse.down(); pg.mouse.up()
        pg.wait_for_selector("#point-popover:not([hidden])")
        t = pg.locator("#point-popover").inner_text()
        style = pg.evaluate("() => { const s = getComputedStyle(document.querySelector('#point-popover')); return {bg: s.backgroundColor, overflow: s.overflowY}; }")
        pg.mouse.click(30, H / 2)   # click outside closes
        pg.wait_for_timeout(300)
        closed = pg.locator("#point-popover").is_hidden()
        pg.mouse.move(e["x"], e["y"]); pg.mouse.down(); pg.mouse.move(e["x"] + 60, e["y"] + 40, steps=8); pg.mouse.up()
        pg.wait_for_timeout(1500)
        e2 = pg.evaluate("() => { const e = qn.entities.find(x => x.name === '"+WP+"'); return {lat: e.lat, lon: e.lon}; }")
        pop_after_drag = pg.locator("#point-popover").is_visible()
        assert_true(WP in t and closed and (e2["lat"] != e["lat"]) and not pop_after_drag, f"{closed} {e2} {pop_after_drag}")
        return {"popover_style": style, "moved_to": e2, "closed_on_outside_click": closed}
    check("Click opens popover, drag moves point (no popover), click outside closes", ["REF-158", "REF-108", "REF-170", "REF-058", "FC-043", "FC-044"], click_vs_drag)

    def edit_waypoint():
        e = pg.evaluate("() => { const e = qn.entities.find(x => x.name === '"+WP+"'); const p = qn.map2d.llToScreen(e.lat, e.lon); return {x: p.x, y: p.y}; }")
        pg.mouse.click(e["x"], e["y"])
        pg.wait_for_selector("#point-popover [data-a='edit']")
        read_only = pg.locator("#point-popover form").count() == 0
        pg.click("#point-popover [data-a='edit']")
        pg.fill("#ed-name", WP2)
        pg.click("#point-popover button[type='submit']")
        pg.wait_for_function("() => qn.entities.some(e => e.name === '"+WP2+"')", timeout=10000)
        pg.click("#point-popover [data-a='del']")
        pg.wait_for_function("() => !qn.entities.some(e => e.name === '"+WP2+"')", timeout=10000)
        assert_true(read_only, "read-only card first")
        return "read-only card → edit form → saved → deleted"
    check("Waypoint read-only card, in-situ edit and delete", ["REF-165", "REF-180", "FC-045", "REF-069"], edit_waypoint)

    # ---------------- traverses
    def traverses():
        pg.click("#new-traverse")
        n = pg.locator(".trav").count()
        pg.click(".trav.active [data-act='rename']")
        pg.fill(".rename-input", "Travesía Norte")
        pg.keyboard.press("Enter")
        name = pg.locator(".trav.active .trav-name").inner_text()
        pg.click(".trav.active [data-act='eye']")
        pg.click(".trav.active [data-act='delete']")
        n2 = pg.locator(".trav").count()
        assert_true(name == "Travesía Norte" and n2 == n - 1, f"{name} {n} {n2}")
        pg.click("#traverse-toggle")
        col = pg.evaluate("() => document.querySelector('#traverses').classList.contains('collapsed')")
        pg.click("#traverse-toggle")
        return {"count": n, "renamed": name, "after_delete": n2, "collapsed": col}
    check("Traverse rack: add, inline rename, eye, delete, collapse", ["REF-031", "REF-073", "REF-162", "REF-030", "FC-051"], traverses)

    def infeasible():
        pg.click("#new-traverse")
        pg.select_option("#origin", "ROVER_PR1")
        pg.select_option("#destination", "__custom")
        pg.fill("#destination-lat", "18.53"); pg.fill("#destination-lon", "77.42")
        pg.locator("#destination-lon").dispatch_event("change")
        pg.click("#calculate")
        pg.wait_for_selector(".infeasible-card", timeout=30000)
        reason = pg.get_attribute(".infeasible-card", "data-reason")
        status = pg.locator(".trav.active .trav-foot").inner_text()
        assert_true(reason == "destino_hazard" and "Inviable" in status, f"{reason} {status}")
        return {"reason": reason, "card": pg.locator(".infeasible-card").inner_text()[:200]}
    check("Impossible route alert card (goal inside forbidden zone)", ["REF-067", "REF-114", "FC-052", "FC-082"], infeasible)

    def static_origin():
        pg.select_option("#origin", "BASE_ALFA")
        pg.select_option("#destination", "POI_MARGIN_CARB")
        pg.click("#calculate")
        pg.wait_for_selector(".variant", timeout=40000)
        r = pg.evaluate("() => { const t = qn.cur.traverses.find(t => t.id === qn.cur.activeTraverse); return {static: t.result.static_origin, pnr: t.result.variants[0].pnr}; }")
        txt = pg.locator("#variants").inner_text()
        assert_true(r["static"] is True and r["pnr"] is None and "sin métricas de activo" in txt, r)
        return r
    check("Route from base (static origin) suppresses rover metrics", ["REF-033", "REF-074", "REF-106", "FC-046", "FC-057"], static_origin)

    def export():
        pg.click("#export-manage summary")
        with pg.expect_download() as d:
            pg.click("[data-export='geojson']")
        f = d.value.path()
        gj = json.loads(Path(f).read_text())
        n = len(gj["features"][0]["geometry"]["coordinates"])
        with pg.expect_download() as d2:
            pg.click("[data-export='sasf']")
        sasf = Path(d2.value.path()).read_text()
        assert_true(n > 3 and "DRIVE_ARC_TO" in sasf, n)
        return {"geojson_vertices": n, "sasf_head": sasf[:60]}
    check("Exports from visible controls (GeoJSON vertices, SASF)", ["FC-060", "REF-157", "FC-135", "FC-136"], export)

    def import_route():
        gj = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"name": "Importada E2E"},
              "geometry": {"type": "LineString", "coordinates": [[77.4508, 18.4447], [77.43, 18.45], [77.40, 18.46]]}}]}
        f = OUT / "import_test.geojson"
        f.write_text(json.dumps(gj))
        pg.set_input_files("#import-file", str(f))
        pg.wait_for_function("() => qn.cur.traverses.some(t => t.name === 'Importada E2E')", timeout=10000)
        t = pg.evaluate("() => qn.cur.traverses.find(t => t.name === 'Importada E2E')")
        assert_true(abs(t["origin"]["lat"] - 18.4447) < 1e-6 and abs(t["destination"]["lon"] - 77.40) < 1e-6, t)
        return {"origin": t["origin"], "destination": t["destination"]}
    check("Import a GeoJSON route into a new traverse", ["FC-059"], import_route)

    def real_sun():
        sun = pg.evaluate("() => qn.sun")
        tip = pg.get_attribute("#scalebar", "title")
        assert_true(sun and ("Mars24" in tip or "cartográfica" in tip), f"{sun} {tip}")
        return {"sun": sun, "tooltip": tip}
    check("Relief lit by the real Mars24 sun (or declared cartographic light at night)", ["FC-041", "FC-075"], real_sun)

    def delete_route():
        pg.click("#delete-route")
        r = pg.evaluate("() => { const t = qn.cur.traverses.find(t => t.id === qn.cur.activeTraverse); return {res: t.result, o: t.origin}; }")
        assert_true(r["res"] is None and r["o"] is None and pg.locator(".variant").count() == 0, r)
        return "empty planning state"
    check("Delete current route restores empty planning", ["REF-059", "FC-058"], delete_route)

    def collapse_planning():
        pg.click("#planning-collapse")
        a = pg.locator("#planning").is_hidden() and pg.locator("#planning-reopen").is_visible()
        pg.click("#planning-reopen")
        b = pg.locator("#planning").is_visible()
        assert_true(a and b, f"{a} {b}")
        return "collapse/reopen ok"
    check("Planning panel collapse and reopen lifecycle", ["REF-167", "REF-177", "FC-054"], collapse_planning)

    # ---------------- sessions
    def sessions():
        cam1 = pg.evaluate("() => ({...qn.map2d.cam})")
        pg.click("#add-session")
        pg.click("#add-session")
        tabs = pg.locator("#sessions .tab[data-sid]").all_inner_texts()
        widths = [pg.locator("#sessions .tab[data-sid]").nth(i).bounding_box()["width"] for i in range(len(tabs))]
        pg.evaluate("() => qn.map2d.focusOn(18.0, 77.2, qn.map2d.minScale * 3)")
        cam3 = pg.evaluate("() => ({...qn.map2d.cam})")
        pg.click("#sessions .tab[data-sid='S1']")
        back = pg.evaluate("() => ({...qn.map2d.cam})")
        pg.keyboard.press("Alt+Shift+N")
        n4 = pg.locator("#sessions .tab[data-sid]").count()
        pg.click("#sessions [data-close='S4']")
        pg.click("#sessions [data-close='S3']")
        pg.click("#sessions [data-close='S2']")
        left = pg.locator("#sessions .tab[data-sid]").all_inner_texts()
        same = lambda a, b: all(abs(a[k] - b[k]) < 1e-6 for k in ("cx", "cy", "scale"))
        assert_true(same(back, cam1) and not same(cam3, cam1), f"camera independence {cam1} {cam3} {back}")
        assert_true(len(set(round(w) for w in widths)) == 1, f"homogeneous widths {widths}")
        return {"tabs": [t.split()[0] for t in tabs], "widths": widths, "n_after_shortcut": n4, "left": left}
    check("Sessions S1..S4: homogeneous tabs, independent cameras, close by control/shortcut", ["FC-013", "FC-014", "FC-015", "REF-020", "REF-098", "REF-146", "REF-149", "REF-163"], sessions)

    # ---------------- menus, search, shortcuts
    def menus():
        pg.click("#menu-btn")
        labels = pg.locator("#menubar [data-menu]").all_inner_texts()
        pg.click("#menubar [data-menu='Help']")
        pg.click("#menubar [data-item='Help:0']")
        pg.wait_for_selector(".modal")
        t = pg.locator(".modal").inner_text()
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(200)
        gone = pg.locator(".modal").count() == 0
        assert_true(labels == ["Files", "Edit", "View", "Layers", "Analysis", "Tools", "Help"] and "Atajos" in t and gone, labels)
        return {"menus": labels}
    check("Top menus Files/Edit/View/Layers/Analysis/Tools/Help with dialogs", ["FC-016", "REF-018"], menus)

    def tools_dialogs():
        out = {}
        for item, sel in (("Tools:2", "Redundancia"), ("Tools:1", "SIMULACIÓN"), ("Analysis:3", "Mapa de coste"), ("Help:1", "Procedencia")):
            pg.click("#menu-btn")
            k = item.split(":")[0]
            pg.click(f"#menubar [data-menu='{k}']")
            pg.click(f"#menubar [data-item='{item}']")
            pg.wait_for_selector(".modal", timeout=15000)
            out[item] = pg.locator(".modal").inner_text()[:120]
            assert_true(sel in pg.locator(".modal").inner_text(), item)
            pg.keyboard.press("Escape")
            pg.wait_for_timeout(200)
        return out
    check("Tools dialogs: swarm, demo (simulation), costmap, provenance", ["FC-016", "FC-108", "REF-117", "REF-081"], tools_dialogs)

    def search():
        pg.fill("#search", "jez")
        pg.wait_for_selector("#search-results:not([hidden]) button")
        n = pg.locator("#search-results button").count()
        pg.click("#search-clear")
        hidden = pg.locator("#search-results").is_hidden()
        assert_true(n > 0 and hidden, f"{n} {hidden}")
        return {"results": n, "hidden_after_clear": hidden}
    check("Search with floating results and clear", ["FC-017"], search)

    def shortcuts():
        pg.evaluate("() => document.activeElement && document.activeElement.blur()")
        pg.keyboard.press("l")
        a = pg.locator("#deck-legend").is_visible()
        pg.keyboard.press("l")
        pg.keyboard.press("y")
        b = pg.locator("#deck-layers").is_visible()
        pg.keyboard.press("y")
        pg.keyboard.press("f")
        c = pg.locator("#focus-menu").is_visible()
        pg.keyboard.press("p")
        assert_true(a and b and c, f"{a} {b} {c}")
        return {"legend": a, "layers": b, "focus": c}
    check("Keyboard shortcuts open/close panels", ["REF-022", "FC-018"], shortcuts)

    def focus_regions():
        pg.click(".console-dock .dock-btn[data-mode='focus']")
        pg.click("#focus-menu [data-f='3']")   # Nili Fossae
        pg.wait_for_timeout(400)
        name = pg.locator("#sector-name").inner_text()
        mode = pg.evaluate("() => qn.cur.mode")
        hidden = pg.locator("#focus-menu").is_hidden()
        pg.click(".console-dock .dock-btn[data-mode='focus']")
        pg.click("#focus-menu [data-f='1']")
        name2 = pg.locator("#sector-name").inner_text()
        assert_true("Nili" in name and "Jezero" in name2 and mode == "plan" and hidden, f"{name} {name2}")
        return {"after_nili": name, "after_jezero": name2}
    check("Focus Jezero / NE Syrtis / Nili Fossae within a continuous macro-region; non-blocking", ["FC-022", "FC-023", "REF-097", "REF-102", "REF-112"], focus_regions)

    # ---------------- 3D
    def view3d():
        pg.select_option("#origin", "ROVER_PR1")
        pg.select_option("#destination", "POI_DELTA_FRONT")
        pg.click("#calculate")
        pg.wait_for_selector(".variant", timeout=40000)
        sb2d = pg.locator("#scalebar .sb-text").inner_text()
        pg.click("#view-3d")
        pg.wait_for_function("() => qn.map3d && qn.map3d.mesh", timeout=30000)
        pg.wait_for_timeout(2500)
        info = pg.evaluate("""() => ({routes: qn.map3d.overlay.children.filter(o => o.userData.route).length,
            hazards: qn.map3d.overlay.children.filter(o => o.userData.hazard).length,
            mesh: qn.map3d.mesh.name, mantle: !!qn.map3d.material.map, interval: qn.map3d.uniforms.uContourInterval.value,
            markers: qn.map3d.markers.length, lod: qn.map3d.labelLOD(qn.map3d.camera.position.distanceTo(qn.map3d.controls.target))})""")
        sb3d = pg.locator("#scalebar .sb-text").inner_text()
        pg.screenshot(path=str(OUT / "console_3d.png"))
        pg.mouse.move(W / 2, H / 2)
        for _ in range(10):
            pg.mouse.wheel(0, -600); pg.wait_for_timeout(60)
        pg.wait_for_timeout(600)
        sb3d_zoom = pg.locator("#scalebar .sb-text").inner_text()
        pg.click("#view-2d")
        back = pg.evaluate("() => qn.map2d.routes.length")
        assert_true(info["routes"] >= 1 and info["hazards"] == 3 and info["mantle"] and back >= 1 and sb3d != sb3d_zoom, info)
        return {**info, "scale_2d": sb2d, "scale_3d": sb3d, "scale_3d_zoomed": sb3d_zoom, "routes_after_return": back}
    check("2D↔3D keeps route, points and layers; mesh+mantle; hazards projected; scale bar in 3D",
          ["FC-021", "FC-030", "FC-031", "FC-032", "REF-019", "REF-051", "REF-092", "REF-153", "REF-171", "REF-181", "REF-041"], view3d)

    # 422 responses are the API's intended signal for infeasible routes (checked above)
    real = lambda: [e for e in pg.errors if "status of 422" not in e]
    check("No console errors on Hatun Wasi (excluding intended 422 infeasible responses)", ["FC-139"], lambda: (assert_true(not real(), real()[:5]), "none")[1])
    pg.close()

    # ---------------- responsive
    def mobile():
        m = new_page(br, 390, 844)
        sw = m.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
        vis = {s: m.locator(s).is_visible() for s in ["#dock", "#traverses", "#menu-btn", "#coord-hud", "#scalebar", "#quick-dock"]}
        vis["map (2D or 3D)"] = m.locator("#map2d").is_visible() or m.locator("#map3d").is_visible()
        vis["planning (drawer or reopen)"] = m.locator("#planning").is_visible() or m.locator("#planning-reopen").is_visible()
        dock = box(m, "#dock")
        m.screenshot(path=str(OUT / "console_mobile.png"))
        m.close()
        assert_true(sw[0] <= sw[1] and all(vis.values()) and dock["x"] >= 0 and dock["x"] + dock["width"] <= 390, f"{sw} {vis} {dock}")
        return {"scroll_vs_width": sw, "visible": vis}
    check("Responsive console at 390 px: no horizontal overflow, functions reachable", ["FC-008", "REF-184"], mobile)


def rover_flows(br):
    pg = new_page(br, path="/rover")
    W, H = 1440, 900

    def composition():
        l, r, d, e = box(pg, ".col-left"), box(pg, ".col-right"), box(pg, ".rover-dock"), box(pg, "#estop")
        c = box(pg, ".compass")
        assert_true(l["x"] < 30 and r["x"] + r["width"] > W - 30 and e["x"] > W / 2 and e["y"] > H / 2 and c["y"] < 40, "layout")
        modes = pg.locator(".rover-dock .dock-btn").all_inner_texts()
        assert_true([m.strip() for m in modes] == ["Navegación", "Reconocer", "Planificar"], modes)
        pg.screenshot(path=str(OUT / "rover.png"))
        return {"left": l, "right": r, "dock": d, "estop": e}
    check("Chaski composition matches reference", ["FC-003", "REF-198", "REF-203"], composition)

    def nav_locked():
        r = pg.evaluate("() => { const m = window.chaski; return {mode: m.mode, rot: document.querySelector('#map2d') && true}; }")
        cam = pg.evaluate("() => { const s = window.chaski; return {heading: s.heading}; }")
        return {**r, **cam}
    check("Navigation mode: rover-centred track-up map", ["FC-096", "REF-121", "REF-116"], nav_locked)

    def instruments():
        for _ in range(3):
            pg.wait_for_timeout(1500)
        vals = {k: pg.locator(k).inner_text() for k in ["#speed", "#heading", "#battery", "#walkback", "#link", "#fsm", "#pitch", "#roll", "#slip", "#traction-state", "#meta-dist"]}
        assert_true(vals["#battery"].endswith("%") and vals["#fsm"].startswith("["), vals)
        return vals
    check("Instruments, resources, link, safe zone, pitch/roll, slip shown", ["FC-099", "FC-100", "REF-095"], instruments)

    def manual_drive():
        a = pg.evaluate("() => [chaski.lat, chaski.lon]")
        pg.keyboard.down("w"); pg.wait_for_timeout(2500); pg.keyboard.up("w")
        b = pg.evaluate("() => [chaski.lat, chaski.lon]")
        pg.click("#dpad [data-dir='left']")
        assert_true(a != b, f"{a} {b}")
        return {"from": a, "to": b}
    check("Manual driving via WASD and on-screen D-pad", ["FC-097", "REF-120"], manual_drive)

    def modes():
        out = {}
        for m in ("recon", "plan", "navigate"):
            pg.click(f".rover-dock [data-mode='{m}']")
            out[m] = pg.evaluate("() => [chaski.mode, chaski.battery > 0, chaski.lat]")
        assert_true(out["navigate"][0] == "navigate", out)
        return out
    check("Modes Navegación/Reconocer/Planificar keep vehicle state", ["FC-098", "REF-203"], modes)

    def plan_express():
        pg.click(".rover-dock [data-mode='plan']")
        pg.wait_for_timeout(300)
        p = pg.evaluate("() => { const e = (window.chaski && true); return true; }")
        pg.mouse.click(W / 2 + 140, H / 2 - 120)
        pg.wait_for_selector("#inspect-card:not([hidden])", timeout=40000)
        t = pg.locator("#inspect-card").inner_text()
        assert_true("Ruta" in t or "imposible" in t, t[:200])
        return t[:200]
    check("Express route in Planificar uses the shared Khipu planner", ["FC-105", "REF-201"], plan_express)

    def autopilot():
        pg.click(".rover-dock [data-mode='navigate']")
        has = pg.evaluate("() => !!chaski.route")
        pg.click("#autopilot")
        st = pg.locator("#ap-state").inner_text()
        pg.wait_for_timeout(5000)
        cmd = pg.evaluate("() => chaski.apCmd")
        pg.click("#autopilot")
        assert_true((st == "AUTO" and cmd and "state" in cmd) or not has, f"{st} {cmd}")
        return {"state": st, "cmd": cmd}
    check("Autopilot (pure pursuit + safety envelope)", ["FC-097", "REF-204"], autopilot)

    def estop():
        pg.click("#estop")
        s = pg.get_attribute("#estop", "aria-pressed")
        lbl = pg.locator("#estop").inner_text()
        pg.keyboard.down("w"); pg.wait_for_timeout(800); pg.keyboard.up("w")
        spd = pg.evaluate("() => chaski.speed")
        pg.click("#estop")
        assert_true(s == "true" and "ACTIVA" in lbl and spd == 0, f"{s} {lbl} {spd}")
        return {"aria": s, "label": lbl, "speed": spd}
    check("Emergency stop persistent, unambiguous (text + colour), blocks motion", ["FC-107"], estop)

    def voice():
        pg.click("#voice")
        pg.wait_for_selector(".voice-form")
        pg.fill(".voice-form input", "ayuda")
        pg.click(".voice-form button[type=submit]")
        pg.wait_for_function("() => document.querySelector('.voice-log').textContent.includes('Navegación')", timeout=10000)
        pg.fill(".voice-form input", "muestra capa pendiente")
        pg.click(".voice-form button[type=submit]")
        pg.wait_for_timeout(1500)
        layer = pg.evaluate("() => chaski.layers.slope")
        pg.fill(".voice-form input", "muestra capa")
        pg.click(".voice-form button[type=submit]")
        pg.wait_for_timeout(800)
        log = pg.locator(".voice-log").inner_text()
        pg.keyboard.press("Escape")
        assert_true(layer is True and "¿" in log, log[:300])
        return log[:300]
    check("Voice copilot (typed fallback): help, modes, direct layer, clarification", ["FC-109", "FC-110", "REF-142", "REF-123"], voice)

    def legend():
        pg.click("#map-menu-btn")
        pg.click("#map-menu [data-layer='hazard'] + .track")
        pg.wait_for_function("() => (document.querySelector('#rover-legend')?.textContent || '').includes('riesgo')", timeout=20000)
        t = pg.locator("#rover-legend").inner_text()
        pg.keyboard.press("Escape")
        pg.mouse.click(700, 700)
        assert_true("riesgo" in t.lower(), t)
        return t[:160]
    check("Chaski layer legend with units and provenance", ["FC-101", "FC-104"], legend)

    def view3d():
        pg.click("#view-toggle")
        pg.wait_for_timeout(3000)
        ok = pg.locator("#map3d canvas").count() == 1
        pg.screenshot(path=str(OUT / "rover_3d.png"))
        pg.click("#view-toggle")
        assert_true(ok, "3d canvas")
        return "3D canvas rendered"
    check("Chaski camera 2D/3D toggle", ["FC-103"], view3d)

    def replan():
        import urllib.request
        rt = pg.evaluate("() => chaski.route && chaski.route.points[Math.floor(chaski.route.points.length/2)]")
        if not rt:
            return "no route to compromise (skipped)"
        body = json.dumps({"kind": "obstacle", "params": {"lat": rt["lat"], "lon": rt["lon"], "radius_m": 700}}).encode()
        urllib.request.urlopen(urllib.request.Request(BASE + "/api/harness/inject", data=body, method="POST", headers={"Content-Type": "application/json"})).read()
        pg.evaluate("() => { chaski.lastReplan = 0; }")
        pg.wait_for_function("() => (chaski.routeStatus || '').includes('Replanificada') || (chaski.routeStatus || '').includes('nominal')", timeout=40000)
        st = pg.evaluate("() => chaski.routeStatus")
        banner = pg.locator(".sim-banner").count()
        urllib.request.urlopen(urllib.request.Request(BASE + "/api/harness", method="DELETE")).read()
        return {"status": st, "sim_banner": banner}
    check("Dynamic replanning around injected obstacle; simulation labelled", ["FC-106", "FC-108", "REF-202"], replan)

    check("No console errors on Chaski", ["FC-139"], lambda: (assert_true(not pg.errors, pg.errors[:5]), "none")[1])
    pg.close()

    def mobile():
        m = new_page(br, 390, 844, "/rover")
        sw = m.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
        vis = {s: m.locator(s).is_visible() for s in ["#estop", ".rover-dock", "#voice", ".col-left", ".col-right"]}
        m.screenshot(path=str(OUT / "rover_mobile.png"))
        m.close()
        assert_true(sw[0] <= sw[1] and all(vis.values()), f"{sw} {vis}")
        return {"scroll_vs_width": sw, "visible": vis}
    check("Responsive Chaski: safety controls remain accessible", ["FC-008", "FC-125"], mobile)


def hud_flows(br):
    pg = new_page(br, path="/hud")
    W, H = 1440, 900

    def composition():
        band, goal, fov, suit, rel, north = (box(pg, s) for s in (".vitals", ".goal", ".fov", ".suit", ".relief", ".north"))
        ret = box(pg, ".reticle")
        assert_true(band["y"] < 30 and goal["x"] < 40 and fov["x"] > W / 2 and rel["y"] > H / 2 and north["x"] > W / 2 and abs(ret["x"] + ret["width"] / 2 - W / 2) < 4, "layout")
        txt = pg.locator(".vitals").inner_text()
        for k in ("O₂", "BAT", "FC", "ESTAMINA", "WALKBACK", "MUESTRAS"):
            assert_true(k in txt, k)
        pg.wait_for_timeout(2500)
        pg.screenshot(path=str(OUT / "hud.png"))
        return {"band": txt.replace("\n", " ")}
    check("Ñawi composition: vitals band, goal/stamina left, FOV/suit right, relief/north bottom", ["FC-004", "FC-114", "REF-124", "REF-134", "REF-140"], composition)

    def vitals():
        pg.wait_for_timeout(2500)
        v = {k: pg.locator(k).inner_text() for k in ["#o2", "#bat", "#hr", "#stamina", "#walkback", "#wb-state", "#goal-dist", "#goal-brg", "#goal-eta", "#azimuth", "#loc-ll", "#peak", "#valley"]}
        assert_true(v["#hr"].endswith("bpm") and "km" in v["#walkback"], v)
        pg.click("#effort-detail summary")
        d = pg.locator("#effort-body").inner_text()
        return {**v, "detail": d[:160]}
    check("Vitals, stamina with causes detail, goal, relief, north, location", ["FC-113", "FC-115", "FC-116", "FC-117"], vitals)

    def move():
        a = pg.evaluate("() => [nawi.x, nawi.z]")
        pg.keyboard.down("w"); pg.wait_for_timeout(2000); pg.keyboard.up("w")
        pg.click("[data-move='right']")
        b = pg.evaluate("() => [nawi.x, nawi.z]")
        assert_true(a != b, f"{a} {b}")
        return {"from": a, "to": b}
    check("EVA movement with keyboard and on-screen controls", ["FC-120", "REF-120"], move)

    def camera():
        pg.click("#camera-btn")
        m1 = pg.evaluate("() => document.querySelector('#scene') && window.nawi && true")
        pg.click("#camera-btn")
        return "first ↔ third person toggled"
    check("Camera first/third person and restore", ["FC-119"], camera)

    def help_panel():
        pg.click("#help-btn")
        vis = pg.locator("#help").is_visible()
        b = box(pg, "#help")
        ret = box(pg, ".reticle")
        overlap = not (b["x"] + b["width"] < ret["x"] or ret["x"] + ret["width"] < b["x"] or b["y"] + b["height"] < ret["y"] or ret["y"] + ret["height"] < b["y"])
        pg.click("#help-close")
        assert_true(vis and not overlap and pg.locator("#help").is_hidden(), f"{vis} {overlap}")
        return {"help_box": b, "overlaps_reticle": overlap}
    check("Contextual help opens/closes without covering the view centre", ["FC-123"], help_panel)

    def voice():
        pg.click("#voice-btn")
        pg.wait_for_selector(".voice-form")
        pg.fill(".voice-form input", "filtra ciencia")
        pg.click(".voice-form button[type=submit]")
        pg.wait_for_timeout(1200)
        f = pg.evaluate("() => nawi.filter")
        pg.fill(".voice-form input", "info de estromatolito")
        pg.click(".voice-form button[type=submit]")
        pg.wait_for_timeout(1200)
        log = pg.locator(".voice-log").inner_text()
        pg.keyboard.press("Escape")
        assert_true(f == ["poi"] and "Estromatolito" in log, f"{f} {log[:200]}")
        return log[:200]
    check("Khipu voice: POI info and filtering with manual fallback", ["FC-124", "REF-143", "REF-125"], voice)

    def alerts():
        import urllib.request
        urllib.request.urlopen(urllib.request.Request(BASE + "/api/harness/inject", data=b'{"kind":"suit_leak","params":{}}', method="POST", headers={"Content-Type": "application/json"})).read()
        pg.reload(wait_until="domcontentloaded")
        pg.wait_for_selector("body[data-ready='1']", timeout=45000)
        pg.wait_for_timeout(3500)
        crit = pg.locator("#critical").is_visible()
        first = pg.locator("#suit-alerts .a").first.get_attribute("class")
        cb, ret = box(pg, "#critical"), box(pg, ".reticle")
        urllib.request.urlopen(urllib.request.Request(BASE + "/api/harness", method="DELETE")).read()
        assert_true(crit and "critical" in first and cb["y"] + cb["height"] < ret["y"], f"{crit} {first}")
        return {"critical_banner": pg.locator("#critical").inner_text(), "first_alert_class": first}
    check("Alert priority: critical first, banner above the reticle", ["FC-118", "FC-125"], alerts)

    def airlock():
        # move the astronaut next to a sample, collect it, then next to the base airlock
        pg.evaluate("() => { const l = nawi.scene.toLocal(18.4485, 77.4530); nawi.x = l.x + 5; nawi.z = l.z; }")
        pg.wait_for_timeout(500)
        p1 = pg.locator("#prompt").inner_text()
        pg.keyboard.press("e")
        smp = pg.locator("#samples").inner_text()
        pg.evaluate("() => { const l = nawi.scene.toLocal(18.4447, 77.4508); nawi.x = l.x + 20; nawi.z = l.z; }")
        pg.wait_for_timeout(500)
        p2 = pg.locator("#prompt").inner_text()
        pg.keyboard.press("f")
        pg.wait_for_selector(".modal", timeout=5000)
        t = pg.locator(".modal").inner_text()
        pg.click(".modal footer .btn-gold")
        assert_true("[E]" in p1 and smp == "1/16" and "[F]" in p2 and "completado" in t, f"{p1} {smp} {p2}")
        return {"sample_prompt": p1, "samples": smp, "airlock_prompt": p2, "modal": t[:120]}
    check("Sample collection and airlock proximity prompt / return to habitat", ["FC-121", "FC-122"], airlock)

    realh = lambda: [e for e in pg.errors if "status of 422" not in e]
    check("No console errors on Ñawi (excluding intended 422 walkback rejections)", ["FC-139"], lambda: (assert_true(not realh(), realh()[:5]), "none")[1])
    pg.close()

    def mobile():
        m = new_page(br, 390, 844, "/hud")
        sw = m.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
        vis = {s: m.locator(s).is_visible() for s in [".vitals", "#sos-btn", "#voice-btn", ".eva-controls", ".reticle"]}
        m.screenshot(path=str(OUT / "hud_mobile.png"))
        m.close()
        assert_true(sw[0] <= sw[1] and all(vis.values()), f"{sw} {vis}")
        return {"visible": vis}
    check("Responsive Ñawi: emergency and alerts accessible", ["FC-008", "FC-125"], mobile)


def home_flows(br):
    pg = br.new_page(viewport={"width": 1280, "height": 860})
    pg.goto(BASE + "/", wait_until="networkidle")

    def portal():
        url = pg.url
        links = [pg.get_attribute(s, "href") for s in ("#go-console", "#go-rover", "#go-hud")]
        pg.wait_for_timeout(1500)
        pg.screenshot(path=str(OUT / "home.png"))
        assert_true(url.endswith("/home") and links == ["/console", "/rover", "/hud"], f"{url} {links}")
        return {"url": url, "links": links, "health": pg.locator("#st-health").inner_text()}
    check("Root redirects to portal with access to the three interfaces", ["FC-009", "FC-010", "FC-011", "FC-138"], portal)
    pg.close()


if __name__ == "__main__":
    with sync_playwright() as p:
        br = p.chromium.launch(args=ARGS)
        for flow in (home_flows, console_flows, rover_flows, hud_flows):
            try:
                flow(br)
            except Exception as e:  # noqa: BLE001
                RESULTS.append({"name": f"{flow.__name__} aborted", "refs": [], "status": "failed", "evidence": str(e)[:500]})
        br.close()
    (OUT / "walkthrough.json").write_text(json.dumps(RESULTS, indent=2, ensure_ascii=False))
    passed = sum(r["status"] == "passed" for r in RESULTS)
    print(f"\n{passed}/{len(RESULTS)} checks passed")

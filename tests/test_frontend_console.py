"""REF-015..022 — Hatun Wasi structure (behaviour verified live in tests/e2e/walkthrough.py)."""
from conftest import read, web_text

HTML = read("console/index.html")
JS = web_text("console/js")


def test_frontend_initial_layout_is_clean():
    for el in ('id="planning"', 'id="traverses"', 'id="dock"', 'id="sessions"', 'id="scalebar"', 'id="coord-hud"'):
        assert el in HTML
    assert 'id="menubar" class="menubar panel" hidden' in HTML
    assert 'id="search-results" class="search-results panel" role="listbox" hidden' in HTML
    assert 'hidden = true' in read("shared/js/ui.js")  # decks start hidden


def test_frontend_texture_loading():
    m2 = read("shared/js/map2d.js")
    assert "hillshade(" in m2 and "drawImage(this.base" in m2
    assert "drape(" in read("shared/js/map3d.js") and "CanvasTexture" in read("shared/js/map3d.js")


def test_frontend_quick_dock_and_deck_toggles():
    assert 'id="quick-dock"' in HTML and 'id="new-point"' in HTML and 'id="legend-btn"' in HTML
    assert "legend.toggle()" in JS and "layers.toggle()" in JS


def test_frontend_top_menu_actions_and_modals():
    for m in ("Files:", "Edit:", "View:", "Layers:", "Analysis:", "Tools:", "Help:"):
        assert m in JS
    for d in ("shortcutsDialog", "demoDialog", "swarmDialog", "ingestDialog", "nasaDialog", "provenanceDialog"):
        assert f"function {d}" in JS


def test_frontend_view_mode_switching():
    assert 'id="view-2d"' in HTML and 'id="view-3d"' in HTML
    assert "export async function setView" in JS and 'import("/static/shared/js/map3d.js")' in JS


def test_frontend_project_tabs_and_modes():
    assert "export function addSession" in JS and "export function closeSession" in JS and "export function switchSession" in JS
    for mode in ('data-mode="general"', 'data-mode="analyze"', 'data-mode="plan"'):
        assert mode in HTML
    assert 'id="focus-btn"' in HTML and 'data-mode="focus"' not in HTML


def test_frontend_risk_factor_inspection_logic():
    d = read("console/js/decks.js")
    assert 'ctx.cur.mode === "plan"' in d and "api.risk(" in d and "inspectRisk" in d


def test_frontend_keyboard_shortcuts():
    m = read("console/js/menus.js")
    for k in ('e.code === "KeyN"', 'e.code === "KeyW"', '"Enter"', "Escape:", "ArrowLeft"):
        assert k in m

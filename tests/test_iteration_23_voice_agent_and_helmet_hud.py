"""REF-123..125."""
from conftest import read
from khipu.voice import interpret


def test_voice_copilot_agent_and_gemini_integration(client):
    # Local rule-based agent: no AI provider/key required (Gemini integration intentionally replaced; DEC-010)
    j = client.post("/api/voice/command", json={"text": "muestra capa pendiente", "interface": "console"}).json()
    assert j["intent"] == "select_layer" and j["layer_id"] == "slope"
    assert interpret("parada de emergencia")["intent"] == "emergency_stop"
    assert interpret("modo reconocer")["mode"] == "recon"
    assert interpret("")["intent"] == "none"
    assert "GEMINI" not in read("shared/js/voice.js").upper()


def test_screen_hud_layer_helmet_visor_and_3_indicators():
    h = read("hud/index.html")
    assert 'class="visor-mask"' in h
    assert 'aria-label="Objetivo"' not in h
    for t in ("2. RELIEVE LOCAL (R=180M)", "3. NORTE MARCIANO"):
        assert t in h


def test_ui_and_bundle_voice_copilot_presence():
    assert 'id="voice"' in read("rover/index.html") and 'id="voice-btn"' in read("hud/index.html")
    assert "new VoiceCopilot" in read("console/js/menus.js") and "new VoiceCopilot" in read("rover/js/rover.js") and "new VoiceCopilot" in read("hud/js/hud.js")

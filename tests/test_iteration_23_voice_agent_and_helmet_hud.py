"""REF-123..125."""
import base64
import io
import json

from conftest import read
from khipu_data.gemini import GeminiVoiceError
from khipu.voice import interpret


def test_voice_copilot_agent_and_gemini_integration(client):
    # The local path remains available in offline mode.
    j = client.post("/api/voice/command", json={"text": "muestra capa pendiente", "interface": "console"}).json()
    assert j["intent"] == "select_layer" and j["layer_id"] == "slope"
    assert interpret("parada de emergencia")["intent"] == "emergency_stop"
    assert interpret("modo reconocer")["mode"] == "recon"
    assert interpret("")["intent"] == "none"
    assert j["provider"] == "local"
    assert client.get("/api/voice/status").json() == {"provider": "local", "audio": False}
    assert "GEMINI_API_KEY" not in read("shared/js/voice.js")


def test_screen_hud_layer_helmet_visor_and_3_indicators():
    h = read("hud/index.html")
    assert 'class="visor-mask"' in h
    assert 'aria-label="Objetivo"' not in h
    for t in ("2. RELIEVE LOCAL (R=180M)", "3. NORTE MARCIANO"):
        assert t in h


def test_ui_and_bundle_voice_copilot_presence():
    assert 'id="voice"' in read("rover/index.html") and 'id="voice-btn"' in read("hud/index.html")
    assert "new VoiceCopilot" in read("console/js/menus.js") and "new VoiceCopilot" in read("rover/js/rover.js") and "new VoiceCopilot" in read("hud/js/hud.js")


def test_gemini_audio_command_uses_server_key_and_validated_destination(client, engine, monkeypatch):
    monkeypatch.setenv("QN_OFFLINE", "0")
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    source = base64.b64encode(b"audio payload used by the test double").decode()
    candidate = {"transcript": "Llévame a Base Alfa.", "intent": "plan_target", "argument": "BASE_ALFA"}

    def opener(request, timeout):
        assert request.full_url.endswith("/gemini-3.5-flash-lite:generateContent")
        assert "test-gemini-key" not in request.full_url
        assert request.get_header("X-goog-api-key") == "test-gemini-key"
        payload = json.loads(request.data)
        parts = payload["contents"][0]["parts"]
        assert parts[-1]["inlineData"] == {"mimeType": "audio/wav", "data": source}
        context = json.loads(parts[0]["text"])
        assert context["points"] == [{"id": "BASE_ALFA", "name": "Base Alfa"}]
        return io.StringIO(json.dumps({"candidates": [{
            "finishReason": "STOP", "content": {"parts": [{"text": json.dumps(candidate)}]},
        }]}))

    monkeypatch.setattr(engine.gemini_voice, "opener", opener)
    body = {"audio": source, "mime_type": "audio/wav", "interface": "hud",
            "points": [{"id": "BASE_ALFA", "name": "Base Alfa"}]}
    assert client.get("/api/voice/status").json() == {"provider": "gemini", "audio": True}
    result = client.post("/api/voice/audio", json=body).json()
    assert result["provider"] == "gemini" and result["poi_id"] == "BASE_ALFA"
    candidate["argument"] = "unknown-destination"
    result = client.post("/api/voice/audio", json=body).json()
    assert result["intent"] == "clarify" and "poi_id" not in result


def test_gemini_failure_falls_back_for_text_and_reports_unavailable_audio(client, engine, monkeypatch):
    monkeypatch.setenv("QN_OFFLINE", "0")
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    calls = []

    def unavailable(*args, **kwargs):
        calls.append(True)
        raise GeminiVoiceError("http_503")

    monkeypatch.setattr(engine.gemini_voice, "classify", unavailable)
    text = {"text": "muestra capa pendiente", "interface": "console"}
    response = client.post("/api/voice/command", json=text).json()
    assert response["provider"] == "local" and response["layer_id"] == "slope"
    response = client.post("/api/voice/command", json={**text, "prefer_local": True}).json()
    assert response["provider"] == "local" and len(calls) == 1
    invalid = {"audio": "?" * 44, "mime_type": "audio/wav"}
    assert client.post("/api/voice/audio", json=invalid).status_code == 422
    audio = {**invalid, "audio": base64.b64encode(b"audio payload used by the test double").decode()}
    response = client.post("/api/voice/audio", json=audio)
    assert response.status_code == 503 and response.json()["provider_reason"] == "http_503"

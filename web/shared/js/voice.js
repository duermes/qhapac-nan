// Browser speech capture and playback. Intent execution stays in Khipu.
import { api } from "./api.js";
import { toast } from "./ui.js";
import { currentLanguage, translate } from "./language.js";

const speechLocale = () => currentLanguage() === "en" ? "en-US" : "es-PE";

const ERRORS = {
  "not-allowed": "Autoriza el micrófono para usar Khipu.",
  "service-not-allowed": "El navegador bloqueó el servicio de reconocimiento.",
  "audio-capture": "No se encontró un micrófono disponible.",
  "no-speech": "No se detectó voz. Vuelve a intentarlo.",
  network: "El servicio de reconocimiento perdió la conexión.",
};

export class VoiceCopilot {
  constructor({ iface, onIntent, points = () => [], button = null }) {
    this.iface = iface;
    this.onIntent = onIntent;
    this.points = points;
    this.button = button;
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return;
    this.rec = new Recognition();
    this.rec.lang = speechLocale();
    this.rec.interimResults = false;
    this.rec.maxAlternatives = 1;
    this.rec.onstart = () => toast("Khipu está escuchando…", "safe", 2200);
    this.rec.onresult = (event) => this.handle(event.results[event.resultIndex || 0][0].transcript);
    this.rec.onend = () => this.setListening(false);
    this.rec.onerror = (event) => {
      this.setListening(false);
      if (event.error !== "aborted") toast(ERRORS[event.error] || "El reconocimiento de voz no está disponible.", "warn", 4400);
    };
  }

  setListening(active) {
    this.listening = active;
    this.button?.setAttribute("aria-pressed", String(active));
  }

  start() {
    if (!this.rec) { toast("Este navegador no tiene reconocimiento de voz.", "warn"); return; }
    if (this.listening) { this.rec.stop(); return; }
    try {
      window.speechSynthesis?.cancel();
      this.setListening(true);
      this.rec.lang = speechLocale();
      this.rec.start();
    } catch {
      this.setListening(false);
      toast("No se pudo iniciar el micrófono.", "warn");
    }
  }

  async handle(text) {
    try {
      const result = await api.voice(text, this.iface, this.points(), currentLanguage());
      const response = await this.onIntent?.(result);
      const speech = typeof response === "string" ? response : result.speech;
      this.speak(speech);
      if (speech) toast(speech, ["clarify", "unknown", "none"].includes(result.intent) ? "warn" : "", 4500);
      return result;
    } catch {
      const speech = "Khipu no pudo procesar la orden.";
      this.speak(speech);
      toast(speech, "warn");
      return null;
    }
  }

  speak(text) {
    if (!text || !window.speechSynthesis) return;
    try {
      const utterance = new SpeechSynthesisUtterance(translate(text));
      utterance.lang = speechLocale();
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch { /* visible feedback is already rendered */ }
  }
}

// Gemini accepts short mic recordings. Khipu retains control of all app actions.
import { api } from "./api.js";
import { toast } from "./ui.js";
import { currentLanguage, translate } from "./language.js";

const speechLocale = () => currentLanguage() === "en" ? "en-US" : "es-PE";
const CAPTURE_MS = 6000;
const AUDIO_FORMATS = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];

function encodeAudio(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",", 2)[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

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
    this.captureFormat = navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder &&
      AUDIO_FORMATS.find((type) => MediaRecorder.isTypeSupported(type));
    window.addEventListener("pagehide", () => this.releaseCapture());
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

  async start() {
    if (this.recorder?.state === "recording") { this.recorder.stop(); return; }
    if (this.starting || this.processing) return;
    if (this.listening) { this.rec?.stop(); return; }

    window.speechSynthesis?.cancel();
    this.starting = true;
    try {
      const status = this.captureFormat && !this.browserOnly
        ? await api.voiceStatus().catch(() => null) : null;
      if (status?.audio) await this.startCapture();
      else this.startRecognition();
    } catch (error) {
      this.releaseCapture();
      const message = { NotAllowedError: ERRORS["not-allowed"], NotFoundError: ERRORS["audio-capture"] };
      toast(message[error.name] || "No se pudo iniciar el micrófono.", "warn");
    } finally {
      this.starting = false;
    }
  }

  startRecognition() {
    if (!this.rec) { toast("Este navegador no tiene reconocimiento de voz.", "warn"); return; }
    this.rec.lang = speechLocale();
    this.rec.start();
    this.setListening(true);
  }

  async startCapture() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(this.stream, { mimeType: this.captureFormat });
    this.recorder = recorder;
    const chunks = [];
    recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
    recorder.onerror = () => {
      recorder.onstop = null;
      this.releaseCapture();
      toast("No se pudo grabar la orden.", "warn");
    };
    recorder.onstop = () => {
      const mime = (recorder.mimeType || this.captureFormat).split(";")[0];
      this.releaseCapture();
      const audio = new Blob(chunks, { type: mime });
      if (audio.size) this.handleAudio(audio, mime === "audio/mp4" ? "audio/m4a" : mime);
      else toast(ERRORS["no-speech"], "warn");
    };
    recorder.start();
    this.setListening(true);
    this.captureTimer = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, CAPTURE_MS);
    toast("Gemini está escuchando. Pulsa de nuevo para enviar.", "safe", CAPTURE_MS);
  }

  releaseCapture() {
    clearTimeout(this.captureTimer);
    if (this.recorder?.state === "recording") {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.setListening(false);
  }

  requestPoints() {
    return this.points().slice(0, 100).map(({ id, name, description }) => ({
      id: String(id).slice(0, 80), name: String(name).slice(0, 160), description: (description || "").slice(0, 500),
    }));
  }

  handle(text) {
    return this.runCommand(() => api.voice(text, this.iface, this.requestPoints(), currentLanguage(), this.browserOnly));
  }

  handleAudio(audio, mimeType) {
    return this.runCommand(async () =>
      api.voiceAudio(await encodeAudio(audio), mimeType, this.iface, this.requestPoints(), currentLanguage()), true);
  }

  async runCommand(request, audio = false) {
    if (this.processing) return null;
    this.processing = true;
    this.button?.setAttribute("aria-busy", "true");
    if (audio) toast("Gemini está procesando la orden…", "", 2400);
    try {
      const result = await request();
      const response = await this.onIntent?.(result);
      const speech = typeof response === "string" ? response : result.speech;
      this.speak(speech);
      if (speech) toast(speech, ["clarify", "unknown", "none"].includes(result.intent) ? "warn" : "", 4500);
      return result;
    } catch {
      if (audio) this.browserOnly = true;
      const speech = audio && this.rec
        ? "Gemini no respondió. Pulsa Voz otra vez para usar el reconocimiento del navegador."
        : "Khipu no pudo procesar la orden.";
      this.speak(speech);
      toast(speech, "warn");
      return null;
    } finally {
      this.processing = false;
      this.button?.removeAttribute("aria-busy");
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

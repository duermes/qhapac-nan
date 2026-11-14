// Khipu voice copilot client: Web Speech API when available, typed fallback otherwise.
// Intent interpretation happens in Khipu (POST /api/voice/command) — no AI provider.
import { api } from "./api.js";
import { esc, modal, toast } from "./ui.js";
import { icon } from "./icons.js";

export class VoiceCopilot {
  constructor({ iface, onIntent }) {
    this.iface = iface;
    this.onIntent = onIntent;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.speechSupported = !!SR;
    if (SR) {
      this.rec = new SR();
      this.rec.lang = "es-ES";
      this.rec.interimResults = false;
      this.rec.maxAlternatives = 1;
      this.rec.onresult = (e) => this.handle(e.results[0][0].transcript);
      this.rec.onerror = (e) => { toast(`Micrófono no disponible (${e.error}). Usa la entrada de texto.`, "warn"); };
    }
  }

  /** Always opens the copilot console: typed input is the guaranteed fallback,
   *  dictation is offered when the browser exposes speech recognition. */
  start() {
    if (this.modal && document.body.contains(this.modal.el)) return;
    this.openTyped();
  }

  dictate() {
    if (!this.rec) return;
    try { this.rec.start(); toast("Khipu escuchando…", "safe", 2500); } catch { toast("Micrófono ocupado o no disponible", "warn"); }
  }

  openTyped() {
    const body = document.createElement("div");
    body.innerHTML = `<p class="muted" style="margin-top:0">${this.speechSupported ? "" : "Reconocimiento de voz no disponible en este navegador. "}Escribe la orden para Khipu (p. ej. <em>ayuda</em>, <em>muestra capa pendiente</em>, <em>info de delta</em>).</p>
      <form class="voice-form" style="display:flex;gap:8px"><input class="input" name="cmd" aria-label="Orden para Khipu" autocomplete="off" />
      ${this.speechSupported ? `<button class="btn" type="button" data-dictate aria-label="Dictar por voz">${icon("mic")}</button>` : ""}
      <button class="btn btn-gold" type="submit">${icon("radio")} Enviar</button></form>
      <div class="voice-log" style="margin-top:10px;font-size:12px" aria-live="polite"></div>`;
    const m = modal({ title: "Khipu — copiloto", body });
    const log = body.querySelector(".voice-log");
    this.log = log;
    body.querySelector("[data-dictate]")?.addEventListener("click", () => this.dictate());
    body.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = e.target.cmd.value.trim();
      if (!text) return;
      e.target.cmd.value = "";
      await this.handle(text);
    });
    this.modal = m;
  }

  async handle(text) {
    let res;
    try {
      res = await api.voice(text, this.iface);
    } catch (e) {
      res = { intent: "offline", speech: "Khipu no responde. Usa los controles de la interfaz." };
    }
    this.speak(res.speech);
    try { this.onIntent?.(res); } catch (err) { console.error(err); }
    const open = this.modal && document.body.contains(this.modal.el);
    if (open && this.log) this.log.innerHTML = `<div><span class="dim">Tú:</span> ${esc(text)}</div><div><span style="color:var(--gold)">Khipu:</span> ${esc(res?.speech || "")}</div>` + this.log.innerHTML;
    else toast(res.speech, res.intent === "clarify" ? "warn" : "");
    return res;
  }

  speak(text) {
    if (!text || !window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "es-ES";
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch { /* silent */ }
  }
}

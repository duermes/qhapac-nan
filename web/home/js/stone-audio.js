let context;
let buffer;
let lastPlayed = -Infinity;

export function stoneSamples(sampleRate = 44100) {
  const samples = new Float32Array(Math.ceil(sampleRate * 0.44));
  let seed = 91347;
  let low = 0;
  let mid = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const noise = (seed >>> 0) / 2147483648 - 1;
    low += 0.045 * (noise - low);
    mid += 0.22 * (noise - mid);
    const roll = t < 0.33 ? Math.sin(Math.PI * t / 0.33) ** 2 : 0;
    const grain = 0.72 + 0.28 * Math.sin(2 * Math.PI * (14 * t + 18 * t * t));
    const seat = t > 0.27 ? Math.sin(Math.PI * Math.min(1, (t - 0.27) / 0.17)) ** 2 : 0;
    const slide = ((mid - low) * 0.52 + low * 0.4) * roll * grain;
    const settling = (low * 0.18 + Math.sin(2 * Math.PI * 118 * t) * 0.025) * seat;
    samples[i] = slide + settling;
  }
  return samples;
}

export function playStoneClick() {
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio || performance.now() - lastPlayed < 55) return;
    context ||= new Audio();
    if (context.state === "suspended") context.resume().catch(() => {});
    if (!buffer) {
      buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.44), context.sampleRate);
      buffer.copyToChannel(stoneSamples(context.sampleRate), 0);
    }
    const source = context.createBufferSource();
    const volume = context.createGain();
    source.buffer = buffer;
    volume.gain.value = 0.64;
    source.connect(volume);
    volume.connect(context.destination);
    source.onended = () => { source.disconnect(); volume.disconnect(); };
    source.start();
    lastPlayed = performance.now();
  } catch {}
}

export const STOPS = [0, 0.435, 0.735];
export const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export const mix = (from, to, progress) => from + (to - from) * progress;

export function smooth(from, to, value) {
  const t = clamp((value - from) / (to - from));
  return t * t * (3 - 2 * t);
}

export function interpolate(progress, frames) {
  for (let i = 1; i < frames.length; i++) {
    if (progress <= frames[i][0]) return mix(frames[i - 1][1], frames[i][1], smooth(frames[i - 1][0], frames[i][0], progress));
  }
  return frames.at(-1)[1];
}

export function journeyState(progress, width, height, reduced = false) {
  const p = clamp(progress);
  const baseWidth = Math.max(width * 2.4, height * 4.6);
  const worldWidth = baseWidth;
  const x0 = clamp(baseWidth * 0.14 - width * 0.55, 0, baseWidth - width);
  const x1 = clamp(baseWidth * 0.45 - width * 0.48, 0, baseWidth - width);
  const x2 = clamp(worldWidth * 0.867 - width * 0.72, 0, worldWidth - width);
  const stage = p < 0.285 ? 0 : p < 0.645 ? 1 : 2;
  const approach = smooth(0.745, 1, p);
  const maxZoom = width <= 650 ? 1.8 : 2.2;
  return {
    progress: p, stage, worldWidth,
    cameraX: interpolate(p, [[0,x0],[0.12,x0],[0.435,x1],[0.5,x1],[0.735,x2],[1,x2]]),
    zoom: reduced ? 1 : mix(1, maxZoom, approach),
    approach,
    eyeOpacity: reduced ? (p >= 0.94 ? 1 : 0) : smooth(0.81, 0.965, p),
    eyeReveal: reduced ? (p >= 0.94 ? 1 : 0) : smooth(0.805, 0.965, p),
    eyeScale: reduced ? 1 : mix(0.96, 1, smooth(0.81, 1, p)),
    eyeReady: p > 0.955,
    copies: [
      1 - smooth(0.18, 0.32, p),
      smooth(0.22, 0.35, p) * (1 - smooth(0.55, 0.68, p)),
      smooth(0.59, 0.71, p) * (1 - smooth(0.825, 0.93, p)),
      smooth(0.885, 0.975, p)
    ]
  };
}

export function eyeGeometry(state, width, height, ratio = 4416 / 960) {
  const worldHeight = state.worldWidth / ratio;
  const focusX = state.worldWidth * 0.867 - state.cameraX;
  const focusY = (height - worldHeight) / 2 + worldHeight * 0.302;
  const shiftX = (width * (width <= 650 ? 0.5 : 0.68) - focusX) * state.approach;
  const shiftY = (height * 0.38 - focusY) * state.approach;
  const eyeWidth = Math.max(44, state.worldWidth * 0.012 * state.zoom);
  const eyeHeight = Math.max(44, worldHeight * 0.012 * state.zoom);
  return { focusX, focusY, shiftX, shiftY, left: focusX + shiftX - eyeWidth / 2, top: focusY + shiftY - eyeHeight / 2, width: eyeWidth, height: eyeHeight };
}

export function closeupGeometry(width, height, imageWidth = 1672, imageHeight = 941) {
  const scale = Math.max(width / imageWidth, height / imageHeight);
  const renderedWidth = imageWidth * scale;
  const renderedHeight = imageHeight * scale;
  const targetX = width * (width <= 900 ? 0.5 : 0.7);
  const positionX = renderedWidth > width ? clamp((targetX - renderedWidth * 0.7205) / (width - renderedWidth)) : 0.5;
  const x = (width - renderedWidth) * positionX;
  const y = (height - renderedHeight) * 0.48;
  return { positionX, left: x + renderedWidth * 0.623, top: y + renderedHeight * 0.405, width: renderedWidth * 0.195, height: renderedHeight * 0.16 };
}

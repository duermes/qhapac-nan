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

export const PANORAMA_PROFILES = {
  classic: {
    id: "classic",
    width: 2172,
    height: 724,
    ratio: 2172 / 724,
    heightMultiplier: 3.2,
    targets: {
      intiwatana: { left: "21%", top: "56%" },
      chaski: { left: "46%", top: "55%" },
      warrior: { left: "83%", top: "47%" }
    },
    camera: {
      x0: (bw, w) => bw * 0.18 - w * 0.63,
      x1: (bw, w) => bw * 0.465 - w * 0.55,
      x2: (ww, w) => ww * 0.783 - w * 0.66
    },
    eye: {
      focusXFactor: 0.784,
      focusYFactor: 0.344,
      shiftXRatio: w => (w <= 650 ? 0.5 : 0.68),
      shiftYRatio: 0.4,
      eyeWidthFactor: 0.012,
      eyeHeightFactor: 0.008
    }
  },
  wide: {
    id: "wide",
    width: 4416,
    height: 960,
    ratio: 4416 / 960,
    heightMultiplier: 4.6,
    targets: {
      intiwatana: { left: "13%", top: "51%" },
      chaski: { left: "45.3%", top: "56%" },
      warrior: { left: "86.7%", top: "31%" }
    },
    camera: {
      x0: (bw, w) => bw * 0.14 - w * 0.55,
      x1: (bw, w) => bw * 0.45 - w * 0.48,
      x2: (ww, w) => ww * 0.867 - w * 0.72
    },
    eye: {
      focusXFactor: 0.867,
      focusYFactor: 0.302,
      shiftXRatio: w => (w <= 650 ? 0.5 : 0.68),
      shiftYRatio: 0.38,
      eyeWidthFactor: 0.012,
      eyeHeightFactor: 0.012
    }
  }
};

export function getPanoramaProfile(identifierOrRatio) {
  if (typeof identifierOrRatio === "string" && PANORAMA_PROFILES[identifierOrRatio]) {
    return PANORAMA_PROFILES[identifierOrRatio];
  }
  if (typeof identifierOrRatio === "object" && identifierOrRatio !== null && identifierOrRatio.camera) {
    return identifierOrRatio;
  }
  const ratio = typeof identifierOrRatio === "number" && Number.isFinite(identifierOrRatio) ? identifierOrRatio : (2172 / 724);
  return ratio > 3.8 ? PANORAMA_PROFILES.wide : PANORAMA_PROFILES.classic;
}

export function journeyState(progress, width, height, reduced = false, profileOrRatio = "classic") {
  const profile = getPanoramaProfile(profileOrRatio);
  const p = clamp(progress);
  const baseWidth = Math.max(width * 2.4, height * profile.heightMultiplier);
  const worldWidth = baseWidth;
  const x0 = clamp(profile.camera.x0(baseWidth, width), 0, baseWidth - width);
  const x1 = clamp(profile.camera.x1(baseWidth, width), 0, baseWidth - width);
  const x2 = clamp(profile.camera.x2(worldWidth, width), 0, worldWidth - width);
  const stage = p < 0.285 ? 0 : p < 0.645 ? 1 : 2;
  const approach = smooth(0.745, 1, p);
  const maxZoom = width <= 650 ? 1.8 : 2.2;
  return {
    progress: p, stage, worldWidth, profile,
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

export function eyeGeometry(state, width, height, ratioOrProfile = 2172 / 724) {
  const profile = state?.profile || getPanoramaProfile(ratioOrProfile);
  const ratio = typeof ratioOrProfile === "number" && Number.isFinite(ratioOrProfile) ? ratioOrProfile : profile.ratio;
  const worldHeight = state.worldWidth / ratio;
  const focusX = state.worldWidth * profile.eye.focusXFactor - state.cameraX;
  const focusY = (height - worldHeight) / 2 + worldHeight * profile.eye.focusYFactor;
  const shiftX = (width * profile.eye.shiftXRatio(width) - focusX) * state.approach;
  const shiftY = (height * profile.eye.shiftYRatio - focusY) * state.approach;
  const eyeWidth = Math.max(44, state.worldWidth * profile.eye.eyeWidthFactor * state.zoom);
  const eyeHeight = Math.max(44, worldHeight * profile.eye.eyeHeightFactor * state.zoom);
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

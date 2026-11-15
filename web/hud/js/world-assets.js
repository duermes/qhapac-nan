import { currentLanguage } from "/static/shared/js/language.js";

const preset = {
  sky: { sunColor: 0xffecd2, sunIntensity: 1.45, fogColor: 0xd47551 },
  terrain: { diffuseColor: "#9c422b", rippleColor: "rgba(195,105,65,.45)", noiseSpread: 45 }
};

export const HUD_MANIFEST = { presets: { JEZERO_MARS: preset } };
export const AssetRegistry = { getHudPreset: key => HUD_MANIFEST.presets[key] || preset };

export const MONITOR_IMAGES = Object.freeze({
    hatunWasi: "/static/hud/assets/monitors/hatun-wasi.jpg",
    chaski: "/static/hud/assets/monitors/chaski.jpg",
});

export function monitorImage(key) {
    const path = MONITOR_IMAGES[key];
    return currentLanguage() === "en" ? path.replace(/\.jpg$/, ".en.jpg") : path;
}

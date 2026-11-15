import { english, englishPatterns } from "./translations-en.js";
import { correctionEnglish, correctionPatterns } from "./translations-corrections.js";
Object.assign(english, correctionEnglish);

const key = "qn-language";
const attributes = ["aria-label", "title", "alt", "placeholder", "label"];
const untouched = "script,style,svg,[contenteditable],[data-no-localize]";
const html = document.documentElement;
let language = "es";
try { if (localStorage.getItem(key) === "en") language = "en"; } catch {}
let original = new WeakMap();
const dictionary = new Map(Object.entries(english));
const patterns = [...correctionPatterns, ...englishPatterns];
const fragments = [...dictionary.keys()].filter(key => key.length > 3 && dictionary.get(key) !== key)
  .sort((a,b) => b.length - a.length).map(key => key.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"));
const fragmentPattern = new RegExp(`(?<![\\p{L}])(?:${fragments.join("|")})(?![\\p{L}])`, "gu");
const observer = new MutationObserver(updateMutations);

export const currentLanguage = () => language;

export function translate(text) {
  if (language !== "en" || typeof text !== "string") return text;
  const value = text.trim();
  if (!value) return text;
  const routeError = value.match(/^(Punto de (?:origen|destino|waypoint \d+) inviable|Sin corredor viable)\. (.+)$/);
  if (routeError) {
    return text.replace(value, () => translate(routeError[1]) + ". " + translate(routeError[2]));
  }
  const routeReason = value.match(/^(origen|destino|waypoint \d+) · (.+)$/);
  if (routeReason) {
    return text.replace(value, () => translate(routeReason[1]) + " · " + translate(routeReason[2]));
  }
  let result = dictionary.get(value);
  if (result === undefined) {
    for (const [pattern, replacement] of patterns) {
      if (!pattern.test(value)) continue;
      result = value.replace(pattern, replacement);
      break;
    }
  }
  const output = result === undefined ? value : result;
  return text.replace(value, () => output.replace(fragmentPattern, match => dictionary.get(match) || match));
}

function convert(node, property, value, assign) {
  const saved = original.get(node);
  if (language === "es") {
    if (saved?.has(property) && saved.get(property).translated === value) assign(saved.get(property).value);
    return;
  }
  if (saved?.get(property)?.translated === value) return;
  const translated = translate(value);
  if (translated !== value) {
    const entries = saved || new Map();
    entries.set(property, { value, translated });
    original.set(node, entries);
    assign(translated);
  } else {
    saved?.delete(property);
  }
}

function updateText(node) {
  convert(node, "text", node.data, (value) => { node.data = value; });
}

function updateElement(element) {
  for (const attr of attributes) {
    if (element.hasAttribute(attr)) convert(element, attr, element.getAttribute(attr), (value) => element.setAttribute(attr, value));
  }
}

function walk(root) {
  const element = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
  if (!element || element.closest(untouched)) return;
  if (root.nodeType === Node.TEXT_NODE) { updateText(root); return; }
  updateElement(element);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.nodeType === Node.ELEMENT_NODE && node.matches(untouched)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE) updateText(node);
    else updateElement(node);
  }
}

function observe() {
  observer.observe(html, { attributeFilter: attributes, characterData: true, childList: true, subtree: true });
}

function updateMutations(records) {
  observer.disconnect();
  const changed = new Set();
  for (const record of records) {
    if (record.type === "childList") for (const node of record.addedNodes) changed.add(node);
    else changed.add(record.target);
  }
  for (const node of changed) if (node.isConnected) walk(node);
  observe();
}

export function setLanguage(next) {
  if (next === language || !["es", "en"].includes(next)) return;
  observer.disconnect();
  language = next;
  html.lang = next;
  try { localStorage.setItem(key, next); } catch {}
  walk(html);
  if (next === "en") observe();
  else original = new WeakMap();
  document.dispatchEvent(new Event("qn:language"));
}

html.lang = language;
if (language === "en") { walk(html); observe(); }
window.addEventListener("storage", (event) => {
  if (event.key === key) setLanguage(event.newValue === "en" ? "en" : "es");
});

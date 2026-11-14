"""Khipu voice copilot: local rule-based intent parser (ES/EN), no AI provider.

Returns an intent dict the UI executes. Ambiguous commands ask for clarification."""
from __future__ import annotations

import re
import unicodedata

LAYER_ALIASES = {
    "slope": ["pendiente", "slope", "inclinacion"],
    "elevation": ["elevacion", "altura", "altitud", "elevation", "topografia"],
    "roughness": ["rugosidad", "relieve local", "roughness"],
    "hazard": ["riesgo", "peligro", "hazard", "niveles de riesgo"],
    "costmap": ["coste", "costo", "costmap", "mapa de coste"],
    "temperature": ["temperatura", "temperature"],
    "insolation": ["insolacion", "sol", "irradiancia", "luz"],
    "shadow": ["sombra", "sombras", "shadow"],
    "dust": ["polvo", "dust", "opacidad"],
    "telecom": ["enlace", "comunicaciones", "telecom", "senal", "radio"],
    "traversability": ["transitabilidad", "traversability"],
    "igt": ["igt"],
    "ibio": ["ibio", "astrobiologia", "biofirmas"],
    "science_vs_risk": ["ciencia frente a riesgo", "ciencia vs riesgo", "ciencia contra riesgo"],
    "survival_astronaut": ["supervivencia", "survival"],
    "radiation": ["radiacion", "radiation", "dosis"],
}

MODES = {"navegacion": "navigate", "navegar": "navigate", "reconocer": "recon", "reconocimiento": "recon",
         "planificar": "plan", "planificacion": "plan"}

HELP_TEXT = ("Puedo: mostrar una capa (\"muestra capa pendiente\"), cambiar modo (Navegación, Reconocer, "
             "Planificar), informar de un POI (\"info de delta\"), filtrar POIs (\"filtra ciencia\"), "
             "estado de recursos, retorno seguro y parada de emergencia.")


def normalize(text: str) -> str:
    t = unicodedata.normalize("NFD", text.lower())
    t = "".join(ch for ch in t if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9ñ ]", " ", t)).strip()


def _match_layers(t: str) -> list[str]:
    hits = []
    for lid, aliases in LAYER_ALIASES.items():
        for a in aliases:
            if re.search(rf"\b{re.escape(a)}\b", t):
                hits.append((lid, len(a)))
                break
    if not hits:
        return []
    # longer alias wins when one alias contains another (e.g. "ciencia frente a riesgo" vs "riesgo")
    hits.sort(key=lambda x: -x[1])
    best = [hits[0][0]]
    for lid, ln in hits[1:]:
        if not any(a in " ".join(LAYER_ALIASES[best[0]]) for a in LAYER_ALIASES[lid]):
            best.append(lid)
    return best


def interpret(text: str, pois: list[dict] | None = None, interface: str = "console") -> dict:
    t = normalize(text)
    pois = pois or []
    if not t:
        return {"intent": "none", "speech": "No te escuché. Repite la orden o usa los controles manuales."}
    if re.search(r"\b(ayuda|help|que puedes|comandos)\b", t):
        return {"intent": "help", "speech": HELP_TEXT, "modes": ["Navegación", "Reconocer", "Planificar"]}
    if re.search(r"\b(parada|detener|stop|emergencia|alto total)\b", t):
        return {"intent": "emergency_stop", "speech": "Parada de emergencia activada.", "confirm": True}
    if re.search(r"\b(retorno|volver|regresar|return)\b", t):
        return {"intent": "safe_return", "speech": "Calculando retorno seguro a la base."}
    for word, mode in MODES.items():
        if re.search(rf"\b(modo )?{word}\b", t):
            return {"intent": "set_mode", "mode": mode, "speech": f"Modo {word} activado."}
    if re.search(r"\b(recursos|bateria|oxigeno|estado)\b", t):
        return {"intent": "status", "speech": "Leyendo estado de recursos."}
    m = re.search(r"\b(filtra|filtrar|filter|solo)\b (.+)", t)
    if m:
        cat = m.group(2)
        cats = {"ciencia": "science", "science": "science", "peligro": "hazard", "riesgo": "hazard",
                "vehiculo": "vehicle", "vehiculos": "vehicle", "rover": "vehicle", "base": "base",
                "muestras": "sample", "todo": "all", "todos": "all"}
        for k, v in cats.items():
            if k in cat:
                return {"intent": "filter_pois", "category": v, "speech": f"Filtrando POIs: {k}."}
        return {"intent": "clarify", "speech": "¿Qué tipo de POI filtro: ciencia, peligro, vehículos, muestras o todos?"}
    if re.search(r"\b(info|informacion|que es|describe|detalle)\b", t):
        words = set(t.split()) - {"info", "informacion", "de", "del", "la", "el", "que", "es", "describe", "detalle", "sobre"}
        scored = []
        for p in pois:
            name = normalize(p.get("name", ""))
            score = sum(1 for w in words if len(w) > 2 and w in name)
            if score:
                scored.append((score, p))
        scored.sort(key=lambda x: -x[0])
        if not scored:
            return {"intent": "clarify", "speech": "No identifiqué el punto. ¿Cuál POI quieres consultar?"}
        if len(scored) > 1 and scored[0][0] == scored[1][0]:
            names = ", ".join(p["name"] for _, p in scored[:3])
            return {"intent": "clarify", "speech": f"Hay varios candidatos: {names}. ¿Cuál?",
                    "candidates": [p["id"] for _, p in scored[:3]]}
        p = scored[0][1]
        desc = p.get("description") or p.get("kind", "")
        return {"intent": "poi_info", "poi_id": p["id"], "speech": f"{p['name']}: {desc}"}
    if re.search(r"\b(capa|muestra|mostrar|activa|layer|show|ver)\b", t) or _match_layers(t):
        layers = _match_layers(t)
        if len(layers) == 1:
            return {"intent": "select_layer", "layer_id": layers[0], "speech": f"Capa {layers[0]} activada."}
        if len(layers) > 1:
            return {"intent": "clarify", "candidates": layers,
                    "speech": "La orden coincide con varias capas: " + ", ".join(layers) + ". ¿Cuál activo?"}
        return {"intent": "clarify", "speech": "¿Qué capa quieres ver? Por ejemplo pendiente, enlace o temperatura."}
    return {"intent": "unknown", "speech": "No entendí la orden. Di \"ayuda\" para ver opciones."}

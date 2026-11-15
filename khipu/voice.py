"""Khipu voice copilot: local rule-based intent parser (ES/EN), no AI provider.

Returns an intent dict the UI executes. Ambiguous commands ask for clarification."""
from __future__ import annotations

import re
import unicodedata

LAYER_ALIASES = {
    "slope": ["pendiente", "slope", "inclinacion"],
    "elevation": ["elevacion", "altura", "altitud", "elevation", "topografia", "terrain"],
    "roughness": ["rugosidad", "relieve local", "roughness"],
    "hazard": ["riesgo", "peligro", "hazard", "niveles de riesgo"],
    "costmap": ["coste", "costo", "costmap", "mapa de coste"],
    "temperature": ["temperatura", "temperature"],
    "insolation": ["insolacion", "sol", "irradiancia", "luz", "sunlight", "insolation"],
    "shadow": ["sombra", "sombras", "shadow"],
    "dust": ["polvo", "dust", "opacidad"],
    "telecom": ["enlace", "comunicaciones", "telecom", "senal", "radio"],
    "traversability": ["transitabilidad", "traversability"],
    "igt": ["igt"],
    "ibio": ["ibio", "astrobiologia", "biofirmas"],
    "science_vs_risk": ["ciencia frente a riesgo", "ciencia vs riesgo", "ciencia contra riesgo", "science versus risk"],
    "survival_astronaut": ["supervivencia", "survival"],
    "radiation": ["radiacion", "radiation", "dosis"],
}

MODES = {"navegacion": "navigate", "navegar": "navigate", "reconocer": "recon", "reconocimiento": "recon",
         "planificar": "plan", "planificacion": "plan", "plan": "plan", "planning": "plan",
         "navigation": "navigate", "navigate": "navigate", "general": "navigate",
         "survey": "recon", "analyze": "recon", "analyse": "recon", "analizar": "recon"}

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


def interpret(text: str, pois: list[dict] | None = None, interface: str = "console", language: str = "es") -> dict:
    def line(es, en):
        return en if language == "en" else es

    t = normalize(text)
    pois = pois or []
    if not t:
        return {"intent": "none", "speech": line("No te escuché. Repite la orden o usa los controles manuales.", "I didn’t hear you. Repeat the command or use the controls.")}
    if re.search(r"\b(ayuda|help|que puedes|comandos)\b", t):
        hud = line("Di ruta a, seguido del nombre. También puedes decir siguiente objetivo, vuelve a base, estado o borra ruta.",
                   "Say route to followed by the name. You can also say next target, return to base, status or clear route.")
        console = line(HELP_TEXT, "Try show slope, switch mode, describe a point, filter science, status or return to base.")
        return {"intent": "help", "speech": hud if interface == "hud" else console,
                "modes": line(["Navegación", "Reconocer", "Planificar"], ["Navigation", "Survey", "Plan"])}
    if re.search(r"\b(parada|detener|stop|emergencia|emergency|alto total)\b", t):
        if interface == "rover":
            return {"intent": "emergency_stop", "speech": line("Emergencia. Contacta al operador del rover.", "Emergency. Contact the rover operator.")}
        return {"intent": "emergency_stop", "speech": line("Parada de emergencia activada.", "Emergency stop activated."), "confirm": True}
    if re.search(r"\b(retorno|volver|regresar|vuelve a base|return)\b", t):
        return {"intent": "safe_return", "speech": line("Calculando retorno seguro a la base.", "Calculating a return route to base.")}
    navigation_command = re.search(r"\b(?:ruta a|navega a|llevame a|ir a|guiame a|objetivo|route to|navigate to|take me to|go to|guide me to)\s+(.+)", t)
    if not navigation_command:
        for word, mode in MODES.items():
            if re.search(rf"\b(modo |mode )?{word}\b", t):
                names = {"navigate": ("Navegación", "Navigation"), "recon": ("Reconocer", "Survey"), "plan": ("Planificar", "Plan")}
                es, en = names[mode]
                return {"intent": "set_mode", "mode": mode, "speech": line(f"Modo {es} activado.", f"{en} mode activated.")}
    if re.search(r"\b(recursos|bateria|oxigeno|estado|resources|battery|oxygen|status)\b", t) and not navigation_command and not re.search(r"\b(?:info|describe|detalle)\b", t):
        return {"intent": "status", "speech": line("Leyendo estado de recursos.", "Checking resource status.")}
    m = re.search(r"\b(filtra|filtrar|filter|solo)\b (.+)", t)
    if m:
        cat = m.group(2)
        cats = {"ciencia": "science", "science": "science", "peligro": "hazard", "riesgo": "hazard",
                "vehiculo": "vehicle", "vehiculos": "vehicle", "rover": "vehicle", "base": "base",
                "muestras": "sample", "samples": "sample", "hazards": "hazard", "vehicles": "vehicle",
                "todo": "all", "todos": "all", "all": "all"}
        for k, v in cats.items():
            if k in cat:
                return {"intent": "filter_pois", "category": v, "speech": line(f"Filtrando POIs: {k}.", f"Filtering points by {v}.")}
        return {"intent": "clarify", "speech": line("¿Qué tipo de POI filtro: ciencia, peligro, vehículos, muestras o todos?", "Which points should I show: science, hazards, vehicles, samples or all?")}
    if interface == "hud":
        if re.search(r"\b(?:borra|quita|cancela|clear|cancel)\s+(?:la\s+|the\s+)?(?:ruta|route)\b", t):
            return {"intent": "clear_route", "speech": line("Ruta retirada.", "Route cleared.")}
        if re.search(r"\b(?:siguiente objetivo|objetivo siguiente|next target|next waypoint)\b", t):
            return {"intent": "next_target", "speech": line("Buscando el siguiente objetivo.", "Finding the next target.")}
    info_command = re.search(r"\b(?:info|informacion|que es|describe|detalle)\b", t)
    if navigation_command or info_command:
        words = set((navigation_command.group(1) if navigation_command else t).split()) - {
            "info", "informacion", "de", "del", "la", "el", "que", "es", "describe", "detalle", "sobre"}
        scored = []
        for p in pois:
            name = normalize(p.get("name", ""))
            score = sum(1 for w in words if len(w) > 1 and re.search(rf"\b{re.escape(w)}\b", name))
            score = score or sum(1 for w in words if len(w) > 2 and w in name)
            if score:
                scored.append((score, p))
        scored.sort(key=lambda x: -x[0])
        if not scored:
            return {"intent": "clarify", "speech": line("No identifiqué el punto. Di el nombre del objetivo.", "I couldn’t identify the point. Say the target’s name.")}
        if len(scored) > 1 and scored[0][0] == scored[1][0]:
            names = ", ".join(p["name"] for _, p in scored[:3])
            return {"intent": "clarify", "speech": line(f"Hay varios candidatos: {names}. ¿Cuál?", f"I found multiple candidates: {names}. Which one?"),
                    "candidates": [p["id"] for _, p in scored[:3]]}
        p = scored[0][1]
        if navigation_command:
            return {"intent": "plan_target", "poi_id": p["id"], "speech": line(f"Calculando ruta a {p['name']}.", f"Calculating a route to {p['name']}.")}
        desc = p.get("description") or p.get("kind", "")
        return {"intent": "poi_info", "poi_id": p["id"], "speech": f"{p['name']}: {desc}"}
    if re.search(r"\b(capa|muestra|mostrar|activa|layer|show|ver)\b", t) or _match_layers(t):
        layers = _match_layers(t)
        if len(layers) == 1:
            return {"intent": "select_layer", "layer_id": layers[0], "speech": line(f"Capa {layers[0]} activada.", f"{layers[0].replace('_', ' ').capitalize()} layer enabled.")}
        if len(layers) > 1:
            return {"intent": "clarify", "candidates": layers,
                    "speech": line(f"La orden coincide con varias capas: {', '.join(layers)}. ¿Cuál activo?",
                                   f"Several layers match: {', '.join(layers)}. Which one should I show?")}
        return {"intent": "clarify", "speech": line("¿Qué capa quieres ver? Por ejemplo pendiente, enlace o temperatura.", "Which layer should I show? Try slope, signal or temperature.")}
    return {"intent": "unknown", "speech": line('No entendí la orden. Di "ayuda" para ver opciones.', 'I didn’t understand. Say "help" for options.')}

# Qhapaq Ñan — Mars Surface Navigation Engine (reconstrucción)

Aplicación de planificación y guía de navegación de superficie marciana. **Khipu** es el núcleo analítico compartido por las tres interfaces: **Hatun Wasi** (consola de misión), **Chaski** (monitor de rover) y **Ñawi** (visor EVA).

> Apoyo de decisión dentro de los datos, umbrales y supuestos declarados. No certifica seguridad operacional.

## Arranque

```bash
cd workspace
uv venv .venv --python 3.12            # o: python3.12 -m venv .venv
uv pip install --python .venv/bin/python -r requirements-dev.txt
.venv/bin/python scripts/bootstrap_data.py   # registra MOLA y deriva la macrorregión
.venv/bin/uvicorn api.app:app --port 8000
# abre http://127.0.0.1:8000/  (redirige a /home)
```

`scripts/bootstrap_data.py` necesita el original NASA en `data/official_kickoff/raw/mola/` (el script imprime las URLs de PDS si falta). Sin datos la app arranca en estado vacío y **no inventa elevaciones**.

## Verificación

```bash
.venv/bin/python -m pytest                       # suite por capacidad (nombres = casos de referencia)
.venv/bin/python -m playwright install chromium  # una vez
.venv/bin/python tests/e2e/walkthrough.py http://127.0.0.1:8000 /tmp/qn_e2e   # recorrido UI con capturas
```

## Estructura

| Ruta | Contenido |
| --- | --- |
| `khipu/` | Núcleo científico puro (sin red ni disco): dominio, geodesia, física (Minetti/PLSS/Rohmert, Bekker-Wong/Janosi, ITU-R P.526, Mars24), costmap, router, PNR y libro de recursos, capas, operaciones (localización, FSM, swarm, harness, piloto automático), exportadores, voz, inspección. |
| `khipu_data/` | Adaptadores de I/O: PDS3/MOLA, regiones y manifiestos, cliente NASA con caché/fallback, persistencia JSON. |
| `api/` | FastAPI: contratos Pydantic (`schemas.py`), servicio del motor (`engine.py`), rutas y páginas (`app.py`). |
| `web/` | `home/` portal, `console/` Hatun Wasi, `rover/` Chaski, `hud/` Ñawi, `shared/` (estilos, fuentes OFL locales, mapa 2D/3D, cliente Khipu, voz) y `vendor/three/` (Three.js 0.170.0). |
| `data/` | `official_kickoff/raw/` originales NASA (no versionados), `manifest.json`, `processed/generated/` derivados regenerables, `fixtures/synthetic/scenario.json` escenario sintético, `cache/`, `userstate/`. |
| `tests/` | pytest por capacidad y `e2e/walkthrough.py` (Playwright). |

## Datos y procedencia

- Topografía: **MGS MOLA MEGDR `MEGT44N000HB`** (128 px/°, ~463 m/px), NASA PDS Geosciences, SHA-256 en `data/official_kickoff/manifest.json`.
- Macrorregión derivada `syrtis_jezero_nili` (16.5–23.5°N, 73.5–79.5°E) y sectores de enfoque Jezero, NE Syrtis y Nili Fossae.
- Base, vehículos, astronautas, zonas de exclusión, muestras y POI: **escenario sintético** rotulado en API y UI.
- Capas ambientales (temperatura, insolación, polvo, radiación, enlace): **modelos** evaluados con parámetros declarados.
- ISRU: no disponible (faltan datos de hidratación/hielo); la capa no se inventa.
- Clima InSight / APOD: servicio en vivo con `NASA_API_KEY` o `DEMO_KEY`; si falla se usa caché o fallback y se muestra el estado.

## Modo sin conexión

`QN_OFFLINE=1` evita llamadas externas. El motor, la planificación, las capas y las tres interfaces funcionan con MOLA local; el clima NASA muestra «no disponible/caché». Ninguna función requiere claves de IA: Khipu Voz interpreta órdenes con reglas locales y ofrece entrada de texto si no hay micrófono.

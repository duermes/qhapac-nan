# Qhapaq Ñan — Mars Surface Navigation Engine (reconstrucción)

Aplicación de planificación y guía de navegación de superficie marciana. **Khipu** es el núcleo analítico compartido por las tres interfaces: **Hatun Wasi** (consola de misión), **Chaski** (monitor de rover) y **Ñawi** (visor EVA).

> Apoyo de decisión dentro de los datos, umbrales y supuestos declarados. No certifica seguridad operacional.

## Arranque

Con Python 3.12 o 3.13, desde la raíz del repositorio:

**Windows (PowerShell)**

```powershell
.\start.ps1
```

**Linux (Bash)**

```bash
bash ./start.sh
```

El script prepara el entorno, descarga MOLA de NASA PDS si falta y verifica los archivos con SHA-256 antes de generar el terreno. El portal y las tres interfaces se sirven en [localhost:8000](http://127.0.0.1:8000/). Ambos scripts aceptan `--port 8765`, `--host` y `--reload`. Se necesita conexión para instalar dependencias o descargar MOLA por primera vez. Para las consultas de APOD y clima, copia `.env.example` a `.env` y configura `NASA_API_KEY`.

## Operación

En el portal y en cada interfaz, abre **ES** o **EN** para elegir el idioma o iniciar el **Tutorial**. Usa los botones, las flechas del teclado o desliza la tarjeta para repasar la pantalla. La preferencia de idioma se guarda en el navegador.

- **Hatun Wasi.** Crea una travesía en el rack de Planificar antes de elegir sus puntos. Origen móvil usa una ruta operativa de Khipu. Para un origen estático se muestra la distancia directa. Enfocar está junto a Nuevo punto y Leyenda.
- **Khipu.** La distancia directa se dibuja con puntos amarillos. La ruta de ida se pinta de celeste mientras el regreso cumple los límites de terreno, condiciones y reserva previstos. Si el retorno deja de ser viable, a partir del PNR la ruta va en naranja. La ida debe conservar la reserva vital: 25 % de la capacidad de cada recurso por defecto, ajustable por travesía. La hora solar nominal de planificación es 13:00 local de Marte y se puede simular otra condición.
- **Chaski.** Pulsa el botón de capa para recorrer las vistas del mapa. Khipu Voz admite selección directa. El zoom está disponible en todos los modos. En Navegación el mapa sigue la posición y rumbo del rover. En Reconocer y Planificar se habilitan el paneo y el centrado. Los paneles se pueden plegar juntos o por ventana. En la demo puedes simular el movimiento del rover con WASD o las flechas del teclado.
- **Ñawi.** Usa C para cambiar de perspectiva y E para interactuar con compañeros, instrumentos, muestras, equipos o la esclusa. El menú Demo muestra los controles de simulación bajo demanda. La elección de destino se hace por voz. En pantalla táctil, toca la escena externa para volver al visor.

## Verificación

```bash
.venv/bin/python -m pytest
node --test tests/eva_comfort.test.mjs tests/home_journey.test.mjs
.venv/bin/python -m playwright install chromium
.venv/bin/python tests/e2e/operational_traverse.py http://127.0.0.1:8765 /tmp/qn_e2e
```

Para el recorrido de navegador inicia el servidor de pruebas en el puerto 8765 con un directorio `QN_STATE_DIR` aislado. El recorrido utiliza ese servidor para guardar travesías y contingencias de prueba.

## Estructura

| Ruta | Contenido |
| --- | --- |
| `khipu/` | Núcleo científico puro (sin red ni disco): dominio, geodesia, física (Minetti/PLSS/Rohmert, Bekker-Wong/Janosi, ITU-R P.526, Mars24), costmap, router, PNR y libro de recursos, capas, operaciones (localización, FSM, swarm, harness, piloto automático), exportadores, voz, inspección. |
| `khipu_data/` | Adaptadores de I/O: PDS3/MOLA, regiones y manifiestos, cliente NASA con caché/fallback, persistencia JSON. |
| `api/` | FastAPI: contratos Pydantic (`schemas.py`), servicio del motor (`engine.py`), rutas y páginas (`app.py`). |
| `web/` | `home/` portal, `console/` Hatun Wasi, `rover/` Chaski, `hud/` Ñawi, `shared/` (estilos, fuentes OFL locales, mapa 2D/3D, cliente Khipu, voz) y `vendor/three/` (Three.js 0.170.0). |
| `data/` | `official_kickoff/raw/` originales NASA (no versionados), `manifest.json`, `processed/generated/` derivados regenerables, `fixtures/synthetic/scenario.json` escenario sintético, `cache/`, `userstate/`. |
| `tests/` | pytest por capacidad, controles EVA con Node y recorrido operativo de Playwright. |

## Datos y procedencia

- Topografía: **MGS MOLA MEGDR `MEGT44N000HB`** (128 px/°, ~463 m/px), NASA PDS Geosciences, SHA-256 en `data/official_kickoff/manifest.json`.
- Macrorregión derivada `syrtis_jezero_nili` (16.5–23.5°N, 73.5–79.5°E) y sectores de enfoque Jezero, NE Syrtis y Nili Fossae.
- Base, vehículos, astronautas, zonas de exclusión, muestras y POI: **escenario sintético** rotulado en API y UI.
- Capas ambientales (temperatura, insolación, polvo, radiación, enlace): **modelos** evaluados con parámetros declarados.
- ISRU: no disponible (faltan datos de hidratación/hielo); la capa no se inventa.
- Clima InSight / APOD: servicio en vivo con `NASA_API_KEY` o `DEMO_KEY`; si falla se usa caché o fallback y se muestra el estado.

## Modo sin conexión

`QN_OFFLINE=1` evita las llamadas externas de la API de datos. El motor, la planificación, las capas y las tres interfaces funcionan con MOLA local; el clima NASA muestra «no disponible/caché». Khipu Voz interpreta las órdenes en `POST /api/voice/command` y funciona con reconocimiento y síntesis del navegador en Hatun Wasi, Chaski y Ñawi. Usa un navegador compatible y permite el micrófono desde localhost o HTTPS. El reconocimiento puede requerir conexión según el servicio de voz del navegador. No se necesita una API key de Gemini.

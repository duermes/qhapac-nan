"""Refresh the portable catalog with Mars Trek, NASA PDS and USGS data."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import subprocess
import tempfile
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data/official_kickoff/raw"
OUT = ROOT / "data/official_science"
REGION = (73.5, 16.5, 79.5, 23.5)
TREK = "https://trek.nasa.gov/mars/trekarcgis/rest/services/"
PDS = "https://pds-geosciences.wustl.edu/m2020/urn-nasa-pds-mars2020_sample_dossier/initial_reports/"
USGS = "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Jezero_FeatureServiceFromPro/FeatureServer/8"
TREK_LAYERS = {
    "aqueous": ("Minerales acuosos", "Aquieous_Mineral_Distribution_Options_clon0", "Class", "CRISM, OMEGA, THEMIS"),
    "hydrous": ("Minerales hidratados", "Hydrous_Mineral_Detections_OMEGA_CRISM_clon0", "Type", "CRISM, OMEGA"),
}
MATERIALS = {
    "olivino": r"olivine", "piroxeno": r"pyroxenes?", "carbonatos": r"carbonates?",
    "sulfatos": r"sulfates?", "filosilicatos": r"phyllosilicates?", "sílice": r"silica",
    "feldespato": r"feldspars?", "magnetita": r"magnetite", "fosfatos": r"phosphates?",
    "hematita": r"hematite", "cloruros": r"chlorides?", "serpentina": r"serpentine|serpentinite",
    "cromita": r"chromite", "ilmenita": r"ilmenite", "arenisca": r"sandstones?",
    "arcilla": r"clays?|mudstones?", "basalto": r"basalts?|basaltic",
}
CLASS_ES = {"silica": "sílice", "phyllosilicates": "filosilicatos", "sulfates": "sulfatos",
            "chloride": "cloruros", "carbonates": "carbonatos", "hydrous mineral detection": "minerales hidratados"}
PROVIDER_TREK = "NASA/JPL · Mars Trek"
TREK_TRAVERSE = f"{TREK}Perseverance_Traverse_Path/MapServer/0"
PROVIDER_PDS = "NASA PDS · Mars 2020 Sample Dossier"
PROVIDER_USGS = "USGS · SIM 3464"


def download(url, target, force=False):
    if target.exists() and not force:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    pending = target.with_suffix(target.suffix + ".tmp")
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers={"User-Agent": "Qhapaq-Nan/1.0"}), timeout=36) as src, pending.open("wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
            pending.replace(target)
            return target
        except OSError:
            pending.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def json_source(url, filename, refresh):
    path = download(url, RAW / "science" / filename, refresh)
    result = json.loads(path.read_text(encoding="utf-8-sig"))
    if "error" in result or result.get("exceededTransferLimit"):
        raise ValueError(f"Incomplete ArcGIS response for {filename}: {result.get('error')}")
    return result


def arc_query(base, **params):
    return base + "/query?" + urlencode({"where": "1=1", "f": "json", **params})


def in_region(lat, lon):
    west, south, east, north = REGION
    return south <= lat <= north and west <= lon <= east


def minerals(text):
    return [name for name, pattern in MATERIALS.items() if re.search(r"\b(?:" + pattern + r")\b", text, re.I)]


def collect_trek(refresh):
    observations, sources = [], []
    for key, (title, slug, material_col, default_instrument) in TREK_LAYERS.items():
        base = f"{TREK}{slug}/MapServer/0"
        url = arc_query(base, geometry=",".join(map(str, REGION)), geometryType="esriGeometryEnvelope", outFields="*")
        raw = json_source(url, f"trek_{key}.json", refresh)
        groups = {}
        for feature in raw["features"]:
            x, y = (float(feature["geometry"][name]) for name in ("x", "y"))
            if not in_region(y, x):
                continue
            a = feature["attributes"]
            group = groups.setdefault((x, y), {"materials": set(), "instruments": set(), "records": []})
            original = str(a[material_col])
            group["materials"].add(CLASS_ES.get(original.casefold(), original))
            group["instruments"].add(a.get("Instrument") or default_instrument)
            group["records"].append(a["FID"])
        for (lon, lat), g in sorted(groups.items()):
            records = sorted(g["records"])
            materials = sorted(g["materials"])
            observations.append({
                "id": f"TREK_{key.upper()}_{records[0]}", "kind": "poi",
                "name": " · ".join(materials).capitalize() + f" · {records[0]}",
                "lat": lat, "lon": lon, "category": "orbital", "materials": materials,
                "description": "Detección espectral orbital del catálogo Mars Trek.",
                "instrument": ", ".join(sorted(g["instruments"])), "record_ids": records,
                "provider": PROVIDER_TREK, "source_url": base,
            })
        sources.append({"id": f"trek_{key}", "title": title, "provider": PROVIDER_TREK,
                        "url": base, "records": len(raw["features"]), "map_points": len(groups)})
    return observations, sources


_SAMPLE_ID = re.compile(r"(?:Sample Designation|Sample ID|Witness Tube Designation)\s*:\s*(M2020-\d+-\d+[A-Z]?)\s+([^\n]+)", re.I)
_SAMPLE_POSITION = re.compile(
    r"Latitude\s*\(N\)\s*,\s*Longitude\s*\(E\)\s*,\s*Elevation\s*:\s*"
    r"([+-]?\d+(?:\.\d+)?)\s*[°˚]?\s*,\s*([+-]?\d+(?:\.\d+)?)\s*[°˚]?\s*,\s*"
    r"([+−–-]?\s*\d+(?:\.\d+)?)", re.I)


def report_samples(pages, url):
    samples = {}
    for index, page in enumerate(pages.split("\f"), 1):
        normalized = " ".join(page.split())
        found = _SAMPLE_POSITION.search(normalized)
        identity = _SAMPLE_ID.search(page)
        if not (found and identity):
            continue
        ident, name = identity.groups()
        witness = identity[0].startswith("Witness Tube")
        lat, lon, elevation = (float(value.replace("−", "-").replace("–", "-").replace(" ", "")) for value in found.groups())
        if not in_region(lat, lon):
            continue
        lithology = re.search(r"Lithology:\s*(.+?)(?=(?:Estimated Volume|Coring Bit|Core Orientation|Sample Serial|\Z))", normalized, re.I)
        campaign = re.search(r"Campaign:\s*(.+?)(?=(?:Region of Interest|Lithology)\s*:)", normalized, re.I)
        sol = re.search(r"Core Sealing:.{0,80}?\bSol\s*(\d+)", normalized, re.I)
        samples[ident] = {
            "id": ident, "name": name.strip(), "kind": "sample", "category": "rover_sample",
            "lat": lat, "lon": lon, "reported_elevation_m": elevation,
            "sol": int(sol[1]) if sol else None, "campaign": campaign[1].strip() if campaign else "",
            "materials": minerals(lithology[1]) if lithology else [],
            "sample_type": "witness_tube" if witness else "documented_sample",
            "description": ("Lugar de sellado de un tubo testigo de contaminación de Mars 2020." if witness else
                            "Lugar de muestreo documentado por la misión Mars 2020."),
            "instrument": "Perseverance · Mars 2020", "provider": PROVIDER_PDS,
            "source_url": url + f"#page={index}",
        }
    return list(samples.values())


def collect_reports(download_reports, refresh):
    folder = RAW / "perseverance"
    reports = [(folder / f"initial_reports_volume{n}.pdf", f"initial_reports_volume{n}.pdf") for n in range(1, 6)]
    if download_reports:
        with ThreadPoolExecutor(max_workers=3) as executor:
            tasks = [executor.submit(download, PDS + name, path, refresh) for path, name in reports]
            for task in tasks:
                task.result()
    samples, sources = {}, []
    for index, ((path, name), count) in enumerate(zip(reports, (10, 11, 3, 4, 5)), 1):
        if not path.is_file():
            raise FileNotFoundError(f"{path.name} is missing; run again with --download-reports")
        text = subprocess.check_output(["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"]).decode("utf-8")
        points = report_samples(text, PDS + name)
        if len(points) != count:
            raise ValueError(f"Extracted {len(points)}/{count} coordinates from {name}")
        samples.update((p["id"], p) for p in points)
        sources.append({"id": f"pds_volume_{index}", "title": f"Informes iniciales de Perseverance · volumen {index}",
                        "provider": PROVIDER_PDS, "url": PDS + name, "records": len(points), "map_points": len(points)})
    return list(samples.values()), sources


def collect_traverse(refresh):
    raw = json_source(arc_query(TREK_TRAVERSE, outFields="FID,sol,length,fromRMC,toRMC"),
                      "trek_perseverance_traverse.json", refresh)
    if raw.get("geometryType") != "esriGeometryPolyline" or raw.get("spatialReference", {}).get("wkid") != 104905:
        raise ValueError("Unexpected Mars Trek traverse geometry")
    segments = []
    for feature in raw["features"]:
        a = feature["attributes"]
        segments.append({"id": a["FID"], "sol": a["sol"], "distance_m": a["length"],
                         "from_rmc": a["fromRMC"], "to_rmc": a["toRMC"], "paths": feature["geometry"]["paths"]})
    sols = [segment["sol"] for segment in segments]
    source = {"id": "trek_perseverance_traverse", "title": "Recorrido histórico de Perseverance",
              "provider": PROVIDER_TREK, "url": TREK_TRAVERSE, "records": len(segments),
              "sol_start": min(sols), "sol_end": max(sols)}
    return source, segments


def raster_geology(refresh):
    meta = json_source(USGS + "?f=json", "usgs_geology_metadata.json", refresh)
    url = arc_query(USGS, outFields="OBJECTID,unit,name,symbol,Additional_Characteristics", maxAllowableOffset=16)
    raw = json_source(url, "usgs_geology_units.json", refresh)
    wkt = raw["spatialReference"]["wkt"]
    if 'Transverse_Mercator' not in wkt or '3396190' not in wkt or '77.5' not in wkt:
        raise ValueError("Unexpected USGS Mars coordinate system")
    renderer = meta["drawingInfo"]["renderer"]["uniqueValueInfos"]
    by_unit = {}
    for row in renderer:
        by_unit[str(row["value"])] = {
            "code": len(by_unit) + 1, "label": row["label"],
            "color": "#" + "".join(f"{v:02x}" for v in row["symbol"]["color"][:3]),
        }
    west, east, south, north, ppd = 76.8, 77.8, 17.7, 18.7, 512
    lon, lat = np.meshgrid(west + (np.arange(ppd) + .5) / ppd, north - (np.arange(ppd) + .5) / ppd)
    rlat, delta = np.radians(lat), np.radians(lon - 77.5)
    x = 3396190 * np.arctanh(np.cos(rlat) * np.sin(delta))
    y = 3396190 * np.arctan2(np.tan(rlat), np.cos(delta))
    grid = np.zeros(x.shape, dtype=np.uint8)
    for feature in raw["features"]:
        a = feature["attributes"]
        category = by_unit[str(a["unit"])]
        category.update(symbol=a["symbol"], materials=minerals(a.get("Additional_Characteristics") or ""))
        rings = [np.array(ring) for ring in feature["geometry"]["rings"] if len(ring) > 3]
        vertices = np.concatenate(rings)
        x0, y0 = vertices.min(axis=0)
        x1, y1 = vertices.max(axis=0)
        candidates = (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)
        px, py = x[candidates], y[candidates]
        inside = np.zeros(px.shape, dtype=bool)
        for ring in rings:
            for (ax, ay), (bx, by) in zip(ring, np.roll(ring, -1, axis=0)):
                if ay == by:
                    continue
                inside ^= ((ay > py) != (by > py)) & (px < ax + (py - ay) * (bx - ax) / (by - ay))
        grid[candidates] = np.where(inside, category["code"], grid[candidates])
    source = {"id": "usgs_sim3464", "title": "Cartografía geológica de Jezero y Nili Planum",
              "provider": PROVIDER_USGS, "url": USGS, "publication": "https://pubs.usgs.gov/publication/sim3464",
              "records": len(raw["features"]), "unit_types": len(by_unit)}
    return list(by_unit.values()), source, grid, [west, south, east, north]


def write_json(path, value):
    pending = path.with_suffix(".tmp")
    pending.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    pending.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--download-reports", action="store_true", help="Download large official PDS reports")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as executor:
        trek = executor.submit(collect_trek, args.refresh)
        reports = executor.submit(collect_reports, args.download_reports, args.refresh)
        traverse = executor.submit(collect_traverse, args.refresh)
        geology = executor.submit(raster_geology, args.refresh)
        points, trek_sources = trek.result()
        samples, pds_sources = reports.result()
        geology_legend, usgs, codes, bounds = geology.result()
        track_source, segments = traverse.result()
    payload = {"imported_at": datetime.now(timezone.utc).isoformat(), "extent": REGION,
               "points": samples + points, "sources": trek_sources + [track_source] + pds_sources + [usgs],
               "geology_legend": geology_legend}
    with tempfile.TemporaryDirectory(dir=OUT.parent) as pending:
        staging = Path(pending)
        write_json(staging / "catalog.json", payload)
        write_json(staging / "perseverance_traverse.json", {**track_source, "segments": segments})
        np.savez_compressed(staging / "usgs_geology.npz", codes=codes, bounds=bounds)
        for path in staging.iterdir():
            path.replace(OUT / path.name)
    target = OUT / "catalog.json"
    print(json.dumps({"points": dict(Counter(p["category"] for p in payload["points"])),
                      "geologic_features": usgs["records"], "sha256": hashlib.sha256(target.read_bytes()).hexdigest()},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()

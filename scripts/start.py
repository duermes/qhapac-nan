"""Start the shared API and all web interfaces from the checkout root."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from khipu_data.regions import MACRO_KEY, MANIFEST, PROCESSED, sha256_file


def prepare_terrain() -> None:
    macro = PROCESSED / MACRO_KEY
    if (macro / "elevation.npy").is_file() and (macro / "manifest.json").is_file():
        return
    datasets = json.loads(MANIFEST.read_text(encoding="utf-8"))["datasets"]
    source = next(item for item in datasets if item["id"] == "mola-megdr-megt44n000hb")
    url_base = source["source"]["url_or_reference"].rsplit("/", 1)[0]
    for item in source["files"]:
        path = ROOT / item["path"]
        if path.is_file():
            if sha256_file(path) != item["sha256"]:
                raise RuntimeError(f"SHA-256 inválido para {path}; comprueba el original local.")
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        pending = path.with_suffix(path.suffix + ".part")
        print(f"Descargando {path.name} desde NASA PDS…", flush=True)
        try:
            with urlopen(f"{url_base}/{path.name}", timeout=45) as response, pending.open("wb") as file:
                shutil.copyfileobj(response, file, length=1024 * 1024)
            if sha256_file(pending) != item["sha256"]:
                raise RuntimeError(f"SHA-256 inválido para {path.name}")
            pending.replace(path)
        finally:
            pending.unlink(missing_ok=True)
    subprocess.run([sys.executable, "-X", "utf8", str(ROOT / "scripts/bootstrap_data.py")], cwd=ROOT, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Arranca Qhapaq Ñan")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    os.chdir(ROOT)
    prepare_terrain()
    command = [sys.executable, "-X", "utf8", "-m", "uvicorn", "api.app:app",
               "--host", args.host, "--port", str(args.port)]
    if args.reload:
        command.append("--reload")
    if (ROOT / ".env").is_file():
        command.extend(["--env-file", str(ROOT / ".env")])
    print(f"Qhapaq Ñan · http://{args.host}:{args.port}/home", flush=True)
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())

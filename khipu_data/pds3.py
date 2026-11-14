"""PDS3 label parser and MOLA MEGDR subgrid extraction (read-only on originals)."""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

REQUIRED_IMAGE_KEYS = ("LINES", "LINE_SAMPLES", "SAMPLE_TYPE", "SAMPLE_BITS")


class PDS3Error(ValueError):
    pass


def _clean(value: str):
    v = value.strip()
    if v.startswith('"') and v.endswith('"'):
        return v[1:-1].replace("\n", " ").strip()
    m = re.match(r"^(-?[0-9.]+(?:[eE][-+]?\d+)?)\s*(<([^>]+)>)?$", v)
    if m:
        num = float(m.group(1))
        if m.group(3) is None and re.fullmatch(r"-?\d+", m.group(1)):
            num = int(m.group(1))
        return {"value": num, "unit": m.group(3)} if m.group(3) else num
    return v


def parse_label(text: str) -> dict:
    """Parse PDS3 ODL into nested dicts. OBJECT blocks become sub-dicts."""
    root: dict = {}
    stack = [root]
    lines = text.replace("\r\n", "\n").split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        s = line.strip()
        if not s or s.startswith("/*"):
            continue
        if s == "END":
            break
        if "=" not in s:
            continue
        key, _, val = s.partition("=")
        key, val = key.strip(), val.strip()
        if val.startswith('"') and not (val.endswith('"') and len(val) > 1):
            while i < len(lines) and not lines[i].rstrip().endswith('"'):
                val += "\n" + lines[i].strip()
                i += 1
            if i < len(lines):
                val += "\n" + lines[i].strip()
                i += 1
        if key == "OBJECT":
            obj: dict = {}
            stack[-1][val] = obj
            stack.append(obj)
        elif key == "END_OBJECT":
            if len(stack) > 1:
                stack.pop()
        else:
            stack[-1][key] = _clean(val)
    return root


def _num(v):
    return v["value"] if isinstance(v, dict) else v


@dataclass
class MolaProduct:
    label_path: Path
    image_path: Path
    label: dict

    @property
    def image(self) -> dict:
        return self.label["IMAGE"]

    @property
    def projection(self) -> dict:
        return self.label["IMAGE_MAP_PROJECTION"]

    @property
    def lines(self) -> int:
        return int(self.image["LINES"])

    @property
    def samples(self) -> int:
        return int(self.image["LINE_SAMPLES"])

    @property
    def ppd(self) -> float:
        return float(_num(self.projection["MAP_RESOLUTION"]))

    @property
    def lat_max(self) -> float:
        return float(_num(self.projection["MAXIMUM_LATITUDE"]))

    @property
    def lat_min(self) -> float:
        return float(_num(self.projection["MINIMUM_LATITUDE"]))

    @property
    def lon_min(self) -> float:
        return float(_num(self.projection["WESTERNMOST_LONGITUDE"]))

    @property
    def lon_max(self) -> float:
        return float(_num(self.projection["EASTERNMOST_LONGITUDE"]))

    @property
    def radius_m(self) -> float:
        return float(_num(self.projection["A_AXIS_RADIUS"])) * 1000.0

    @property
    def dtype(self) -> np.dtype:
        st = str(self.image["SAMPLE_TYPE"]).upper()
        bits = int(self.image["SAMPLE_BITS"])
        endian = ">" if st.startswith("MSB") or "SUN" in st else "<"
        if "INTEGER" in st:
            kind = "u" if "UNSIGNED" in st else "i"
        elif "REAL" in st:
            kind = "f"
        else:
            raise PDS3Error(f"unsupported SAMPLE_TYPE {st}")
        return np.dtype(f"{endian}{kind}{bits // 8}")

    def summary(self) -> dict:
        return {"product_id": self.label.get("PRODUCT_ID"), "data_set_id": self.label.get("DATA_SET_ID"),
                "instrument": self.label.get("INSTRUMENT_NAME"), "lines": self.lines, "samples": self.samples,
                "pixels_per_degree": self.ppd, "lat_min": self.lat_min, "lat_max": self.lat_max,
                "lon_min": self.lon_min, "lon_max": self.lon_max, "unit": self.image.get("UNIT"),
                "sample_type": self.image.get("SAMPLE_TYPE"), "coordinate_system": self.projection.get("COORDINATE_SYSTEM_NAME"),
                "radius_m": self.radius_m, "projection": self.projection.get("MAP_PROJECTION_TYPE")}


def open_mola(label_path: str | Path) -> MolaProduct:
    lp = Path(label_path)
    label = parse_label(lp.read_text(errors="replace"))
    if label.get("PDS_VERSION_ID") != "PDS3":
        raise PDS3Error("not a PDS3 label")
    if "IMAGE" not in label or "IMAGE_MAP_PROJECTION" not in label:
        raise PDS3Error("label lacks IMAGE or IMAGE_MAP_PROJECTION object")
    for k in REQUIRED_IMAGE_KEYS:
        if k not in label["IMAGE"]:
            raise PDS3Error(f"IMAGE object lacks {k}")
    ptr = str(label.get("^IMAGE", "")).strip('"')
    candidates = [lp.with_name(ptr), lp.with_name(ptr.lower()), lp.with_name(ptr.upper()), lp.with_suffix(".img"),
                  lp.with_suffix(".IMG")]
    img = next((c for c in candidates if c.exists()), None)
    if img is None:
        raise PDS3Error(f"image file referenced by ^IMAGE ({ptr}) not found next to label")
    prod = MolaProduct(lp, img, label)
    expected = prod.lines * prod.samples * prod.dtype.itemsize
    actual = img.stat().st_size
    if actual != expected:
        raise PDS3Error(f"image size {actual} != expected {expected} from label")
    pid = str(label.get("PRODUCT_ID", "")).lower()
    if pid and Path(pid).stem != img.stem.lower():
        raise PDS3Error(f"label PRODUCT_ID {pid} does not match image {img.name}")
    return prod


def extract_subgrid(prod: MolaProduct, lat_min: float, lat_max: float, lon_min: float, lon_max: float,
                    nodata_values: tuple = ()) -> dict:
    """Read a lat/lon window via memmap (originals are opened read-only).
    Requested bounds outside the product are clipped; fully outside -> empty."""
    lat_min_c, lat_max_c = max(lat_min, prod.lat_min), min(lat_max, prod.lat_max)
    lon_min_c, lon_max_c = max(lon_min, prod.lon_min), min(lon_max, prod.lon_max)
    if lat_min_c >= lat_max_c or lon_min_c >= lon_max_c:
        return {"empty": True, "data": np.zeros((0, 0)), "reason": "requested bounds outside product coverage"}
    ppd = prod.ppd
    r0 = int(round((prod.lat_max - lat_max_c) * ppd))
    r1 = int(round((prod.lat_max - lat_min_c) * ppd))
    c0 = int(round((lon_min_c - prod.lon_min) * ppd))
    c1 = int(round((lon_max_c - prod.lon_min) * ppd))
    mm = np.memmap(prod.image_path, dtype=prod.dtype, mode="r", shape=(prod.lines, prod.samples))
    sub = np.array(mm[r0:r1, c0:c1], dtype=np.float32)
    del mm
    for nd in nodata_values:
        sub[sub == nd] = np.nan
    return {"empty": False, "data": sub, "lat_max": prod.lat_max - r0 / ppd, "lat_min": prod.lat_max - r1 / ppd,
            "lon_min": prod.lon_min + c0 / ppd, "lon_max": prod.lon_min + c1 / ppd, "pixels_per_degree": ppd,
            "rows": r1 - r0, "cols": c1 - c0, "window": {"r0": r0, "r1": r1, "c0": c0, "c1": c1},
            "clipped": (lat_min_c, lat_max_c, lon_min_c, lon_max_c) != (lat_min, lat_max, lon_min, lon_max)}

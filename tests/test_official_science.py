"""Verify the packaged science data through the API and terrain grid."""
import numpy as np

from conftest import needs_mola
from khipu.geodesy import GridGeometry


def test_science_catalog_and_read_only_destinations(client, engine):
    catalog = client.get("/api/science").json()
    ids = {p["id"] for p in catalog["points"]}
    assert len(ids) == len(catalog["points"]) == 117
    samples = [p for p in catalog["points"] if p["category"] == "rover_sample"]
    assert len(samples) == 33
    assert len([p for p in samples if p["sample_type"] == "witness_tube"]) == 3

    orbital = [p for p in catalog["points"] if p["category"] == "orbital"]
    assert len(orbital) == 84 and sum(len(p["record_ids"]) for p in orbital) == 133
    assert all(p["source_url"].startswith("https://trek.nasa.gov/") for p in orbital)

    sample = engine.find_entity("M2020-749-22")
    assert sample["name"] == "Melyn" and sample["locked"] and not sample["editable"]
    assert (sample["lat"], sample["lon"]) == (18.47021736, 77.38394465)
    assert "carbonatos" in sample["materials"] and "#page=" in sample["source_url"]
    assert sample in client.get("/api/scenario").json()["science_points"]
    assert client.patch("/api/assets/" + sample["id"], json={"name": "Edit"}).status_code == 409
    assert client.delete("/api/assets/" + sample["id"]).status_code == 409


@needs_mola
def test_official_geology_has_categorical_palette_and_missing_coverage(client, engine):
    layer = client.get("/api/layers/geology_usgs?include_grid=false").json()
    assert layer["available"] and layer["provenance"] == "official_usgs"
    assert 0 < layer["stats"]["coverage"] < 1
    classes = layer["layer"]["classes"]
    assert len(classes) == 14
    assert {row["code"] for row in classes} == set(range(1, 15))
    assert all(row["color"].startswith("#") and len(row["color"]) == 7 for row in classes)
    grid = GridGeometry(lat_max=20, lon_min=77, pixels_per_degree=128, rows=5, cols=5)
    assert not engine.science.covers(grid)
    assert np.isnan(engine.science.geology_grid(grid)).all()

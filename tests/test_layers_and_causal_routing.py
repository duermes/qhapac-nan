"""REF-185..188 — layer domain hierarchy, catalog, endpoints, causal routing."""
from conftest import BASE, DELTA, needs_mola
from khipu.domain import Field, Provenance
from khipu.layers import LayerDef, build_catalog


def test_poo_layer_domain_hierarchy():
    from khipu.domain import RealtimeField, StaticField
    assert issubclass(StaticField, Field) and issubclass(RealtimeField, Field)
    cat = build_catalog()
    assert all(isinstance(d, LayerDef) for d in cat.values())
    assert cat["elevation"].provenance == Provenance.OFFICIAL_NASA
    assert cat["slope"].provenance == Provenance.DERIVED_FROM_NASA
    assert cat["temperature"].temporal and not cat["elevation"].temporal


def test_layer_catalog_8_layers():
    cat = build_catalog()
    available = [d for d in cat.values() if d.available]
    assert len(available) >= 8
    for d in cat.values():
        desc = d.describe()
        assert desc["units"] and desc["provenance"] and desc["name"]
    assert not cat["isru"].available and cat["isru"].unavailable_reason


@needs_mola
def test_api_layers_endpoints(client):
    j = client.get("/api/layers").json()
    assert len(j["layers"]) >= 8 and "realtime" in j
    s = client.get("/api/layers/slope", params={"stride": 4}).json()
    assert s["available"] and s["grid"]["encoding"] == "uint8" and s["units"] == "°"
    assert client.get("/api/layers/nope").status_code == 404
    isru = client.get("/api/layers/isru").json()
    assert isru["available"] is False and isru["reason"]


@needs_mola
def test_causal_routing_and_euclidean(client):
    j = client.post("/api/route", json={"origin": BASE, "destination": DELTA, "profile": "rover"}).json()
    assert j["direct"]["distance_m"] > 0
    for v in j["variants"]:
        assert v["metrics"]["distance_m"] >= j["direct"]["distance_m"] * 0.98

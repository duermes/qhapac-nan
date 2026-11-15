from khipu.pnr import search_pnr
from khipu.router import RouteInfeasible


def test_no_pnr_requires_complete_declared_coverage():
    result = search_pnr(1000, lambda s: {"viable": True}, tolerance=25)
    assert result["analysis_status"] == "NO_PNR_VERIFIED"
    assert result["classification"] == "NO_PNR"
    assert result["distance_m"] is None
    assert result["verified_until_m"] == 1000
    assert not result["monotonicity_assumed"]


def test_nonmonotone_island_precedes_later_persistent_failure():
    def evaluator(s):
        return {"viable": not (200 <= s <= 240 or s >= 800)}
    result = search_pnr(1000, evaluator, tolerance=10, max_queries=256)
    assert result["classification"] == "PNR_FOUND"
    assert 200 <= result["distance_m"] <= 210


def test_insufficient_work_cannot_assert_no_pnr():
    result = search_pnr(100000, lambda s: {"viable": True}, tolerance=10, max_queries=8)
    assert result["classification"] == "INDETERMINATE"
    assert result["distance_m"] is None
    assert result["evaluations"] == 8
    assert result["verified_until_m"] < 100000


def test_certified_intervals_skip_costly_queries():
    result = search_pnr(100000, lambda s: {"viable": True}, tolerance=1,
                        certify=lambda a, b: True)
    assert result["analysis_status"] == "NO_PNR_VERIFIED"
    assert result["evaluations"] == 1


def test_a_failed_departure_return_has_a_real_zero_boundary():
    result = search_pnr(100, lambda s: {"viable": False})
    assert result["classification"] == "PNR_FOUND"
    assert result["distance_m"] == 0


def test_rejected_outbound_route_never_exports_a_pnr():
    result = RouteInfeasible("hazard", "Forbidden destination").to_dict()
    assert result["classification"] == "INVALID_ROUTE"
    assert result["pnr"] is None


def test_search_budget_failure_is_not_a_proof_of_invalid_route():
    result = RouteInfeasible("search_budget", "Work budget", classification="INDETERMINATE").to_dict()
    assert result["classification"] == "INDETERMINATE"
    assert result["pnr"] is None

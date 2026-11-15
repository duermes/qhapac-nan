"""Zero-order return search with explicit coverage and work limits.

No monotonicity is assumed. Intervals are visited from the origin and subdivided
until their arc length is at most the requested spatial resolution. A verified
result refers to this declared discretization, never to arbitrarily small
continuous hazards. A caller can certify whole intervals to avoid point queries.
"""
from __future__ import annotations

import time


def search_pnr(length, evaluate, tolerance=100.0, max_queries=128, certify=None, deadline=None, critical_points=()):
    if tolerance <= 0 or max_queries < 1 or length < 0:
        raise ValueError("Invalid PNR search limits")
    samples = {}
    verified_until = 0.0

    def query(distance):
        if distance not in samples:
            if len(samples) >= max_queries or (deadline is not None and time.monotonic() >= deadline):
                raise TimeoutError
            samples[distance] = evaluate(distance)
        return samples[distance]

    def result(status, distance=None):
        return {"analysis_status": status, "classification": "NO_PNR" if status == "NO_PNR_VERIFIED" else status,
                "distance_m": distance, "evaluations": len(samples), "tolerance_m": tolerance,
                "verified_until_m": verified_until, "coverage_model": "arc_length_discretization",
                "monotonicity_assumed": False, "sample": samples.get(distance)}

    try:
        if not query(0.0)["viable"]:
            return result("PNR_FOUND", 0.0)
        boundaries = sorted({0.0, float(length), *(float(p) for p in critical_points if 0 <= p <= length)})
        stack = list(reversed(list(zip(boundaries, boundaries[1:]))))
        while stack:
            left, right = stack.pop()
            if certify is not None and certify(left, right) is True:
                verified_until = right
                continue
            if right - left > tolerance:
                mid = (left + right) / 2
                stack.extend([(mid, right), (left, mid)])
                continue
            if not query(right)["viable"]:
                return result("PNR_FOUND", right)
            verified_until = right
        return result("NO_PNR_VERIFIED")
    except TimeoutError:
        return result("INDETERMINATE")

"""REF-023..025 — mission FSM, redundancy, demo harness."""
from khipu.operations import ABORT, CAUTION, GO, DemoHarness, MissionFSM, PeerSwarm


def test_fsm_state_transitions():
    f = MissionFSM()
    assert f.evaluate({"battery_pct": 90, "o2_pct": 90, "link_margin_db": 10}) == GO
    assert f.evaluate({"battery_pct": 30}) == CAUTION
    assert f.evaluate({"battery_pct": 10}) == ABORT
    assert f.evaluate({"battery_pct": 90}) == ABORT  # latched
    assert f.evaluate({"battery_pct": 90, "reset": True}) == GO
    assert f.evaluate({"pnr_exceeded": True}) == ABORT
    assert len(f.history) >= 4


def test_redundancy_peer_discovery_and_failover():
    s = PeerSwarm(timeout_s=5, degraded_s=2)
    s.register("a", "console", 1, now=0)
    s.register("b", "rover", 2, now=0)
    assert s.leader_id == "a"
    s.heartbeat("b", now=4)
    assert s.health("a", now=3) == "degraded" and s.health("a", now=6) == "lost"
    res = s.failover(now=6)
    assert res["new_leader"] == "b" and res["changed"]
    v = s.broadcast_costmap(now=6)
    st = s.status(now=6)
    assert st["costmap_version"] == v
    assert any(p["peer_id"] == "b" and p["in_sync"] for p in st["peers"])


def test_demo_simulation_harness_injection():
    h = DemoHarness()
    prod = {"tau": 0.5, "link_margin_db": 12.0, "battery_pct": 80.0, "slip": 0.05}
    h.inject("dust_storm")
    h.inject("comms_blackout")
    ov = h.apply(prod)
    assert ov["simulation"] is True and ov["tau"] > prod["tau"] and ov["link_margin_db"] < 0
    assert prod == {"tau": 0.5, "link_margin_db": 12.0, "battery_pct": 80.0, "slip": 0.05}  # untouched
    h.clear()
    assert h.apply(prod)["simulation"] is False

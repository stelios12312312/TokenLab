"""Capture which Z1 parity epochs diverge from the golden fixture (local numpy drift audit)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, "src")
sys.path.insert(0, ".")

from tests.test_z1_shared_core_parity import (
    FIXTURE_PATH,
    _capture,
    _run_m1,
    _run_m2,
    _run_m3,
)

fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

report = {}
for name, run in [("m1", _run_m1), ("m2", _run_m2), ("m3", _run_m3)]:
    captured = _capture(run)
    golden = fixture["milestones"][name]
    divergent = [
        i
        for i, (a, b) in enumerate(
            zip(captured["epoch_hashes"], golden["epoch_hashes"])
        )
        if a != b
    ]
    report[name] = {
        "divergent_epochs": divergent,
        "final_state_match": captured["final_state"] == golden["final_state"],
        "columns_match": captured["columns"] == golden["columns"],
    }

Path("scratch/parity_baseline.json").write_text(json.dumps(report, indent=2))
print(json.dumps({
    k: {"n": len(v["divergent_epochs"]), "epochs": v["divergent_epochs"],
        "final": v["final_state_match"]}
    for k, v in report.items()
}, indent=1))

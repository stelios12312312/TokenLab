"""DM-001 sanitization source audit for the demand-model migration.

# @planner:story = US-PM-AUTO-H29A44FC56887127A

Scans the package, examples, fixtures, the public demo guide, and a freshly
generated test-tier artifact bundle for any client material: the client
identifier (case-insensitive), the client token symbol, and any distinctive
value of the historical client volume series as a string.

The forbidden values are derived at runtime from the historical project
file — they are never written into this test, any package file, fixture,
doc, or generated artifact. The client directory and variable names are
assembled from fragments for the same reason.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
import re

from TokenLab.agentic.runner import MonteCarloRunner
from TokenLab.agentic.schema import load_scenario

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "src" / "TokenLab" / "agentic" / "data"
SCENARIO_PATH = DATA_DIR / "public_demand_history_v2.yaml"
PROFILE_PATH = DATA_DIR / "public_demand_history_v2_profile.json"
CONTROL_SCENARIO_PATH = DATA_DIR / "public_demand_constant_v1.yaml"
CONTROL_PROFILE_PATH = DATA_DIR / "public_demand_constant_v1_profile.json"
REGISTRY_PATH = DATA_DIR / "demo_registry.json"

CLIENT_NAME = "hem" + "ergy"
CLIENT_SYMBOL = "M" + "RG"
# Distinctive plateau-scale client figures; smaller magnitudes could collide
# with legitimate round illustrative constants, timestamps, or hashes.
DISTINCTIVE_VALUE_FLOOR = 100_000

TEXT_SUFFIXES = {
    ".py",
    ".json",
    ".yaml",
    ".yml",
    ".md",
    ".txt",
    ".csv",
    ".html",
    ".js",
    ".ipynb",
    ".toml",
    ".cfg",
    ".ini",
}

SCAN_ROOTS = (
    ROOT / "src" / "TokenLab",
    ROOT / "examples",
    ROOT / "tests" / "fixtures",
)


def _client_trans_values():
    path = ROOT / "projects" / CLIENT_NAME / f"{CLIENT_NAME}.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    target_name = "TR" + "ANS"
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == target_name:
                    return list(ast.literal_eval(node.value))
    raise AssertionError("client series assignment not found")


def _text_files(root: Path):
    if root.is_file():
        return [root]
    if not root.exists():
        return []
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and path.suffix.lower() in TEXT_SUFFIXES
        and "__pycache__" not in path.parts
    )


def _forbidden_patterns():
    distinctive = {
        value
        for value in _client_trans_values()
        if isinstance(value, int) and value >= DISTINCTIVE_VALUE_FLOOR
    }
    patterns = [
        ("client identifier", re.compile(re.escape(CLIENT_NAME), re.IGNORECASE)),
        ("client token symbol", re.compile(rf"\b{re.escape(CLIENT_SYMBOL)}\b")),
    ]
    patterns.extend(
        (
            f"client series value {value}",
            re.compile(rf"(?<!\d){value}(?!\d)"),
        )
        for value in sorted(distinctive)
    )
    return patterns


def _scan(paths, patterns):
    hits = []
    for path in paths:
        text = path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in patterns:
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                hits.append(f"{path.relative_to(ROOT)}:{line}: {label}")
    return hits


def test_no_client_material_in_package_or_artifacts(tmp_path):
    patterns = _forbidden_patterns()
    # Sanity: the audit is armed with the real client fingerprints.
    assert any(label == "client identifier" for label, _ in patterns)
    assert any(label == "client token symbol" for label, _ in patterns)
    assert sum(1 for label, _ in patterns if label.startswith("client series value")) >= 10

    paths = []
    for root in SCAN_ROOTS:
        paths.extend(_text_files(root))
    paths.append(ROOT / "docs" / "public-demo.md")

    # A freshly generated test-tier bundle of the new demo is in scope too.
    config = load_scenario(SCENARIO_PATH)
    profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
    artifacts = MonteCarloRunner().run(
        config,
        tmp_path / "runs",
        run_id="sanitization-audit",
        run_tier="test",
        artifact_profile=profile,
    )
    paths.extend(_text_files(artifacts.bundle_dir))

    hits = _scan(paths, patterns)
    assert not hits, "client material detected:\n" + "\n".join(hits)

    # The demo resources carry the required provenance labels and the
    # sanitized token symbol — and never the client symbol.
    for resource in (
        SCENARIO_PATH,
        PROFILE_PATH,
        CONTROL_SCENARIO_PATH,
        CONTROL_PROFILE_PATH,
        REGISTRY_PATH,
    ):
        text = resource.read_text(encoding="utf-8")
        lowered = text.lower()
        assert "illustrative" in lowered, resource.name
        assert "uncalibrated" in lowered, resource.name
    for resource in (SCENARIO_PATH, PROFILE_PATH):
        text = resource.read_text(encoding="utf-8")
        assert "DTLB" in text
        assert not re.search(rf"\b{re.escape(CLIENT_SYMBOL)}\b", text)

    # Every demand-demo prior is explicitly illustrative and uncalibrated in
    # provenance, and the profile declares the synthetic demand lineage.
    scenario_text = SCENARIO_PATH.read_text(encoding="utf-8").lower()
    assert scenario_text.count("calibration: illustrative") == 3
    assert "library default bracket" in scenario_text
    profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
    coverage = profile["tokenomics_coverage"]
    assert coverage["priors"]["status"] == "illustrative_uncalibrated"
    assert coverage["demand_series"]["status"] == "synthetic_illustrative"
    assert coverage["supply"]["status"] == "fixed"
    absent = {
        "emissions",
        "vesting_unlocks",
        "liquidity",
        "treasury",
        "governance",
        "staking_reward_source",
        "fdv",
        "apy",
    }
    assert {key for key, record in coverage.items() if record["status"] == "absent"} == absent
    assert "not" in profile["interpretation_boundary"].lower()

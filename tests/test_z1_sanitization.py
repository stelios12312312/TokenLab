"""Z-002 sanitization audit for the Z1 core-solvency adapter (T-INTAKE-32F3E825).

# @planner:story = US-PM-AUTO-HD831D2BD43331EFE

Scans the published adapter artifacts — the committed gallery bundles, the
gallery index, the profile, the demo registry, the public demo guide, and a
freshly generated bundle — for client material: the client identifiers
(case-insensitive, fragment-assembled), audience-scale figures derived at
runtime from the Z1 empirical/reporting/config sources, the client scale
factor as a client reference, and client token symbols. Also proves the
neutral-name mapping is total: every published metric name maps 1:1 to a Z1
emitted column and carries no client token.

The forbidden values are derived at runtime from the Z1 project files — they
are never written into this test or any published artifact. Z1's own project
files legitimately keep internal names; neutralization is publish-time only.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
import re

import pandas as pd
import yaml

from projects.z1.core_solvency import adapter
from projects.z1.core_solvency.run import run_simulation
from projects.z1.core_solvency.scenarios import get_scenario_config

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "src" / "TokenLab" / "agentic" / "data"
GALLERY_BUNDLES_DIR = DATA_DIR / "z1_solvency_gallery"
INDEX_PATH = DATA_DIR / "z1_solvency_index.json"
PROFILE_PATH = DATA_DIR / "z1_solvency_profile.json"
REGISTRY_PATH = DATA_DIR / "demo_registry.json"
GUIDE_PATH = ROOT / "docs" / "public-demo.md"

CLIENT_NAMES = ("Z" + "ee", "ZEE" + "5")
# Client token symbol surfaces assembled from fragments; the Z1 internal
# codename columns (referenced only inside the declarative mapping) are not
# client symbols.
CLIENT_SYMBOLS = ("$" + "Z" + "EE", CLIENT_NAMES[1] + " token", CLIENT_NAMES[0] + "Token")
# Audience-scale fingerprint floor: distinctive client audience figures are
# all >= 10M; smaller magnitudes could collide with legitimate scaled
# constants, hashes, or computed outputs.
AUDIENCE_VALUE_FLOOR = 10_000_000

FINGERPRINT_SOURCES_PY = (
    ROOT / "projects" / "z1" / "empirical_calibrated_simulation" / "model.py",
    ROOT / "projects" / "z1" / "reporting" / "full_token_lifecycle_data.py",
)
FINGERPRINT_SOURCES_YAML = (
    ROOT / "projects" / "z1" / "core_solvency" / "configs" / "z1_m1_numbers.yaml",
    ROOT / "projects" / "z1" / "core_solvency" / "configs" / "z1_m1_scenarios.yaml",
)

TEXT_SUFFIXES = {".py", ".json", ".yaml", ".yml", ".md", ".txt", ".csv", ".log", ".html"}


def _audience_scale_values():
    values = set()
    for path in FINGERPRINT_SOURCES_PY:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
                values.add(float(node.value))
    for path in FINGERPRINT_SOURCES_YAML:
        payload = yaml.safe_load(path.read_text(encoding="utf-8"))
        stack = [payload]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
            elif isinstance(node, (int, float)) and not isinstance(node, bool):
                values.add(float(node))
    return {value for value in values if value >= AUDIENCE_VALUE_FLOOR}


def _value_text(value):
    if float(value).is_integer():
        return str(int(value))
    return repr(value)


def _forbidden_patterns():
    patterns = [
        (
            f"client identifier {name}",
            re.compile(rf"\b{re.escape(name)}\b", re.IGNORECASE),
        )
        for name in CLIENT_NAMES
    ]
    patterns.extend(
        ("client token symbol", re.compile(re.escape(symbol), re.IGNORECASE))
        for symbol in CLIENT_SYMBOLS
    )
    patterns.append(
        (
            "client scale-factor reference",
            re.compile(
                r"(?i)(?:30_?000[^\n]{0,40}scale|scale[^\n]{0,40}30_?000)"
            ),
        )
    )
    patterns.extend(
        (
            f"client audience-scale value {_value_text(value)}",
            re.compile(rf"(?<![\d.]){re.escape(_value_text(value))}(?![\d])"),
        )
        for value in sorted(_audience_scale_values())
    )
    return patterns


def _text_files(root: Path):
    if root.is_file():
        return [root]
    if not root.exists():
        return []
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES
    )


def _scan(paths, patterns):
    hits = []
    for path in paths:
        text = path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in patterns:
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                hits.append(f"{path.relative_to(ROOT)}:{line}: {label}")
    return hits


def test_no_client_material_in_published_artifacts(tmp_path):
    patterns = _forbidden_patterns()
    # Sanity: the audit is armed with the real runtime-derived fingerprints.
    assert sum(1 for label, _ in patterns if label.startswith("client identifier")) == 2
    assert sum(1 for label, _ in patterns if label == "client token symbol") == len(CLIENT_SYMBOLS)
    assert any(label == "client scale-factor reference" for label, _ in patterns)
    assert sum(1 for label, _ in patterns if label.startswith("client audience-scale value")) >= 8

    paths = []
    for candidate in (GALLERY_BUNDLES_DIR, INDEX_PATH, PROFILE_PATH, REGISTRY_PATH, GUIDE_PATH):
        paths.extend(_text_files(candidate))
    assert paths, "published adapter artifacts are missing"

    # A freshly generated bundle of the adapter is in scope too.
    profile_template = adapter.load_profile_template()
    entry = adapter.publish_scenario(
        "baseline", out_dir=tmp_path / "runs", profile_template=profile_template
    )
    assert entry["status"] == "published"
    paths.extend(_text_files(Path(entry["bundle_dir"])))

    hits = _scan(paths, patterns)
    assert not hits, "client material detected:\n" + "\n".join(hits)


def test_neutral_name_mapping_is_total_and_client_free(tmp_path):
    profile = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
    mapping = profile["neutral_name_mapping"]

    # 1:1 bijection between published names and Z1 emitted columns.
    assert len(set(mapping.keys())) == len(mapping)
    assert len(set(mapping.values())) == len(mapping)

    # The mapping covers exactly the Z1 emitted columns of a fixed-seed run.
    direct = pd.DataFrame(run_simulation(get_scenario_config("baseline")))
    assert set(mapping.values()) == set(direct.columns)

    # Every published results column is a declared published name, and every
    # profile metric resolves to a published (neutral) name.
    entry = adapter.publish_scenario(
        "stable_case",
        out_dir=tmp_path / "runs",
        profile_template=adapter.load_profile_template(),
    )
    published_columns = set(pd.read_csv(Path(entry["bundle_dir"]) / "results.csv").columns)
    data_columns = published_columns - set(adapter.LINEAGE_COLUMNS)
    assert data_columns == set(mapping.keys())
    for metric in profile["metrics"]:
        assert metric["source"]["column"] in mapping

    # No published name carries a client identifier or client token.
    forbidden_fragments = (CLIENT_NAMES[0].lower(), CLIENT_NAMES[1].lower(), "z1u", "acr")
    for published_name in mapping:
        lowered = published_name.lower()
        assert not any(fragment in lowered for fragment in forbidden_fragments), published_name

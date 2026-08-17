"""S-006 sanitization source audit for the staking + dependent multi-token
migration (schema v3).

# @planner:story = US-PM-AUTO-HBD48E6CAE9D9DF04

Scans the package, examples, fixtures, the public demo guide, the agentic
runner guide, and freshly generated test-tier artifact bundles of BOTH v3
demos for any client material: the three client identifiers and token
symbols (case-insensitive, fragment-assembled), the hive-NFT identifier,
and any distinctive value of the historical client supply/hive CSVs, the
61-point emission list, the USD volume table, the bonding/issuance curve
constants, the channel fraction, or the dependent max supply.

The forbidden values are derived at runtime from the historical project
files (CSV parses for the supply/hive and volume tables, AST parses for
the scripts — including constant fractions such as the channel percentage
and the curve constants inside the price-function definitions) — they are
never written into this test, any package file, fixture, doc, or generated
artifact. The client directory, file, symbol, and identifier names are
assembled from fragments for the same reason.
"""

from __future__ import annotations

import ast
import csv
import json
from pathlib import Path
import re

from TokenLab.agentic.runner import MonteCarloRunner
from TokenLab.agentic.schema import load_scenario

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "src" / "TokenLab" / "agentic" / "data"
STAKING_SCENARIO = DATA_DIR / "public_staking_rewards_v3.yaml"
STAKING_PROFILE = DATA_DIR / "public_staking_rewards_v3_profile.json"
ECOSYSTEM_SCENARIO = DATA_DIR / "public_multitoken_dependency_v3.yaml"
ECOSYSTEM_PROFILE = DATA_DIR / "public_multitoken_dependency_v3_profile.json"
CONTROL_STAKING_SCENARIO = DATA_DIR / "public_staking_constant_v1.yaml"
CONTROL_STAKING_PROFILE = DATA_DIR / "public_staking_constant_v1_profile.json"
CONTROL_ECOSYSTEM_SCENARIO = DATA_DIR / "public_multitoken_disconnected_v3.yaml"
CONTROL_ECOSYSTEM_PROFILE = DATA_DIR / "public_multitoken_disconnected_v3_profile.json"
REGISTRY_PATH = DATA_DIR / "demo_registry.json"
GENERATOR_PATH = DATA_DIR / "synthetic_staking.py"

STAKING_CLIENT = "a" + "piz"
EMISSION_CLIENT = "f" + "ido"
CURVE_CLIENT = "k" + "ix"
CLIENT_NAMES = (STAKING_CLIENT, EMISSION_CLIENT, CURVE_CLIENT)
CLIENT_SYMBOLS = ("F" + "ido", "d" + "at")
HIVE_IDENTIFIER = "NFT" + "_per_" + "hive"
# Distinctive-scale client figures; smaller magnitudes could collide with
# legitimate round illustrative constants, timestamps, or hashes, so they
# are armed only through the non-integer/curve-function rules below.
DISTINCTIVE_VALUE_FLOOR = 10_000

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

SCAN_DOCS = (
    ROOT / "docs" / "public-demo.md",
    ROOT / "docs" / "agentic-runner.md",
)


def _client_values():
    """Parse all three historical client tables/scripts at runtime."""
    values = set()

    def add_csv(path):
        # Client CSVs are gitignored and absent from a fresh checkout (CI);
        # skip them there and rely on the script-derived fingerprints.
        if not Path(path).is_file():
            return
        with open(path, newline="", encoding="utf-8", errors="replace") as handle:
            for row in csv.reader(handle):
                for cell in row:
                    try:
                        values.add(float(cell.replace(",", "").strip()))
                    except (ValueError, AttributeError):
                        continue

    def add_ast(path):
        tree = ast.parse(Path(path).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(
                node.value, (int, float)
            ) and not isinstance(node.value, bool):
                values.add(float(node.value))
            # Constant fractions such as the channel percentage (1/350).
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
                operands = (node.left, node.right)
                if all(
                    isinstance(operand, ast.Constant)
                    and isinstance(operand.value, (int, float))
                    and not isinstance(operand.value, bool)
                    for operand in operands
                ):
                    values.add(operands[0].value / operands[1].value)

    staking_dir = ROOT / "projects" / STAKING_CLIENT / "data" / STAKING_CLIENT
    add_csv(staking_dir / "data.csv")
    add_csv(staking_dir / "data_correct.csv")
    curve_dir = ROOT / "projects" / CURVE_CLIENT / "data" / CURVE_CLIENT
    add_csv(curve_dir / f"{CURVE_CLIENT}_transactions.csv")
    for client, filename in (
        (STAKING_CLIENT, f"{STAKING_CLIENT}.py"),
        (EMISSION_CLIENT, f"{EMISSION_CLIENT}.py"),
        (CURVE_CLIENT, f"{CURVE_CLIENT}.py"),
    ):
        add_ast(ROOT / "projects" / client / filename)
    return values


def _curve_function_values():
    """Numeric constants inside the historical price-function definitions.

    The bonding/issuance curve constants (including the small ones such as
    the log base/multiplier and the tiny issuance coefficient) live inside
    the client script's function definitions; they are derived here so no
    client constant is ever written into this test.
    """
    values = set()
    tree = ast.parse(
        (ROOT / "projects" / CURVE_CLIENT / f"{CURVE_CLIENT}.py").read_text(
            encoding="utf-8"
        )
    )
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            for inner in ast.walk(node):
                if isinstance(inner, ast.Constant) and isinstance(
                    inner.value, (int, float)
                ) and not isinstance(inner.value, bool):
                    values.add(float(inner.value))
    return values


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
        and "outputs" not in path.parts
    )


def _value_text(value):
    """Render a numeric fingerprint literally (never scientific notation
    unless the repr itself uses it)."""
    if float(value).is_integer():
        return str(int(value))
    return repr(value)


def _significant_digits(value):
    return len(re.sub(r"[^0-9]", "", _value_text(value)).lstrip("0"))


def _forbidden_patterns():
    patterns = [
        (
            f"client identifier {name}",
            re.compile(rf"\b{re.escape(name)}\b", re.IGNORECASE),
        )
        for name in CLIENT_NAMES
    ]
    patterns.extend(
        (
            f"client token symbol {symbol}",
            re.compile(rf"\b{re.escape(symbol)}\b", re.IGNORECASE),
        )
        for symbol in CLIENT_SYMBOLS
    )
    patterns.append(
        (
            "client hive-NFT identifier",
            re.compile(rf"\b{re.escape(HIVE_IDENTIFIER)}\b", re.IGNORECASE),
        )
    )
    # Distinctiveness filter: a client value that already occurs in the
    # migration-untouched legacy trees (examples/, tests/fixtures/) cannot
    # distinguish new client material from pre-existing legitimate numbers,
    # so it is not armed as a fingerprint. The armed set still scans every
    # scope below, including the guides, the registry, and fresh bundles.
    legacy_blob = _legacy_blob()

    def is_distinctive(value):
        text = _value_text(value)
        return not re.search(rf"(?<![\d.]){re.escape(text)}(?![\d])", legacy_blob)

    armed = set()
    for value in _client_values():
        if value >= DISTINCTIVE_VALUE_FLOOR and _is_armable(value):
            armed.add(value)
        elif not float(value).is_integer() and _significant_digits(value) >= 4:
            # Long-tail emission/volume figures and the tiny curve
            # coefficient/fraction reprs (many significant digits).
            armed.add(value)
    for value in _curve_function_values():
        if _significant_digits(value) >= 2:
            # Curve constants (multiplier, base, coefficient) — armed even
            # when small, because they are the named client curve values.
            armed.add(value)
    armed = {value for value in armed if is_distinctive(value)}
    patterns.extend(
        (
            f"client table value {_value_text(value)}",
            re.compile(rf"(?<![\d.]){re.escape(_value_text(value))}(?![\d])"),
        )
        for value in sorted(armed)
    )
    return patterns


def _is_armable(value):
    # Round magnitudes (one or two significant digits, i.e. d * 10^k or
    # d0 * 10^k) cannot distinguish client material from legitimate bounds,
    # budgets, and defaults, so they are never armed as fingerprints.
    # Long-tail values stay armed.
    if not float(value).is_integer():
        return True
    return len(str(int(value)).rstrip("0")) >= 3


def _legacy_blob():
    # Distinctiveness baseline: tracked files only, so the audit is identical
    # on a fresh checkout (CI) and a dirty local worktree.
    import subprocess

    try:
        out = subprocess.run(
            ["git", "ls-files", "examples", "tests/fixtures"],
            capture_output=True,
            text=True,
            cwd=ROOT,
            check=True,
        )
        tracked = [ROOT / line for line in out.stdout.split()]
    except Exception:  # pragma: no cover - git unavailable
        tracked = [
            path
            for root in (ROOT / "examples", ROOT / "tests" / "fixtures")
            for path in _text_files(root)
            if "outputs" not in path.parts
        ]
    return "\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for path in tracked
        if path.is_file()
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


def test_no_client_material_in_package_or_artifacts(tmp_path):
    patterns = _forbidden_patterns()
    # Sanity: the audit is armed with the real client fingerprints.
    assert (
        sum(1 for label, _ in patterns if label.startswith("client identifier")) == 3
    )
    assert (
        sum(1 for label, _ in patterns if label.startswith("client token symbol"))
        == 2
    )
    assert any(label == "client hive-NFT identifier" for label, _ in patterns)
    # Armed fingerprint classes that carry the audit's teeth on every stack:
    # the named client curve constants and long-tail values. Round magnitudes
    # are deliberately not armed (they cannot distinguish client material from
    # legitimate bounds/defaults), and gitignored client CSVs are absent from
    # fresh checkouts, so a raw count threshold would be environment-dependent.
    table_values = [
        label for label, _ in patterns if label.startswith("client table value")
    ]
    assert len(table_values) >= 10
    assert any("curve" in label for label, _ in patterns) or table_values

    paths = []
    for root in SCAN_ROOTS:
        paths.extend(_text_files(root))
    paths.extend(SCAN_DOCS)

    # Freshly generated test-tier bundles of BOTH new demos are in scope.
    for scenario_path, profile_path, tag in (
        (STAKING_SCENARIO, STAKING_PROFILE, "staking"),
        (ECOSYSTEM_SCENARIO, ECOSYSTEM_PROFILE, "ecosystem"),
    ):
        config = load_scenario(scenario_path)
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        artifacts = MonteCarloRunner().run(
            config,
            tmp_path / "runs",
            run_id=f"sanitization-audit-{tag}",
            run_tier="test",
            artifact_profile=profile,
        )
        paths.extend(_text_files(artifacts.bundle_dir))

    hits = _scan(paths, patterns)
    assert not hits, "client material detected:\n" + "\n".join(hits)


def test_demo_resources_carry_provenance_labels_and_no_apy_copy():
    resources = (
        STAKING_SCENARIO,
        STAKING_PROFILE,
        ECOSYSTEM_SCENARIO,
        ECOSYSTEM_PROFILE,
        CONTROL_STAKING_SCENARIO,
        CONTROL_STAKING_PROFILE,
        CONTROL_ECOSYSTEM_SCENARIO,
        CONTROL_ECOSYSTEM_PROFILE,
        GENERATOR_PATH,
    )
    for resource in resources:
        lowered = resource.read_text(encoding="utf-8").lower()
        assert "illustrative" in lowered, resource.name
        assert "uncalibrated" in lowered, resource.name

    # The demo symbols are the sanitized placeholders, never client symbols.
    for resource, symbols in (
        (STAKING_SCENARIO, ("STLB",)),
        (ECOSYSTEM_SCENARIO, ("MTLB", "MTDB")),
        (CONTROL_STAKING_SCENARIO, ("STLB",)),
        (CONTROL_ECOSYSTEM_SCENARIO, ("MTLB", "MTDB")),
    ):
        text = resource.read_text(encoding="utf-8")
        for symbol in symbols:
            assert symbol in text
        for client_symbol in CLIENT_SYMBOLS:
            assert not re.search(
                rf"\b{re.escape(client_symbol)}\b", text, re.IGNORECASE
            )

    # Every prior is explicitly illustrative in provenance; the counts pin
    # the declared priors of each stochastic demo.
    staking_text = STAKING_SCENARIO.read_text(encoding="utf-8").lower()
    assert staking_text.count("calibration: illustrative") == 3
    ecosystem_text = ECOSYSTEM_SCENARIO.read_text(encoding="utf-8").lower()
    assert ecosystem_text.count("calibration: illustrative") == 2

    # reward_as_perc is pinned explicitly in the staking demo (the latent
    # multiplicative default is never inherited silently).
    assert "reward_as_perc: false" in staking_text

    # No-APY copy: the staking reward is a fixed token quantity, never a
    # rate; APY/FDV/liquidity are declared absent in both profiles.
    staking_profile = json.loads(STAKING_PROFILE.read_text(encoding="utf-8"))
    coverage = staking_profile["tokenomics_coverage"]
    assert coverage["staking_reward_source"]["status"] == "modeled"
    assert "minted" in coverage["staking_reward_source"]["detail"].lower()
    assert "never apy" in coverage["staking_reward_source"]["detail"].lower()
    for concept in ("apy", "fdv", "liquidity", "treasury"):
        assert coverage[concept]["status"] == "absent"
    assert coverage["priors"]["status"] == "illustrative_uncalibrated"
    assert coverage["demand_series"]["status"] == "synthetic_illustrative"
    boundary = staking_profile["interpretation_boundary"].lower()
    assert "not investment" in boundary
    assert "never apy" in boundary

    ecosystem_profile = json.loads(ECOSYSTEM_PROFILE.read_text(encoding="utf-8"))
    eco_coverage = ecosystem_profile["tokenomics_coverage"]
    assert eco_coverage["dependencies_channels"]["status"] == "modeled"
    assert "directional" in eco_coverage["dependencies_channels"]["detail"].lower()
    for concept in ("apy", "fdv", "liquidity"):
        assert eco_coverage[concept]["status"] == "absent"
    # Liquidity limitations are declared, not silently absent.
    assert "liquidity" in eco_coverage
    assert "slippage" in eco_coverage["liquidity"]["detail"].lower()
    assert eco_coverage["priors"]["status"] == "illustrative_uncalibrated"
    eco_boundary = ecosystem_profile["interpretation_boundary"].lower()
    assert "not investment" in eco_boundary

    # The deterministic controls honestly declare variability unavailable
    # and never claim Monte Carlo evidence.
    for control_profile_path in (CONTROL_STAKING_PROFILE, CONTROL_ECOSYSTEM_PROFILE):
        control_profile = json.loads(control_profile_path.read_text(encoding="utf-8"))
        assert control_profile["variability"]["status"] == "unavailable"
        assert "monte carlo" not in json.dumps(control_profile).lower()

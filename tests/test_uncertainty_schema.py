"""Schema-v2 uncertainty model: validation contract and seeded sampler tests.

# @planner:story = US-PM-AUTO-H2A2D347E9E110A84

Covers the frozen Phase 2 contract in ``TokenLab.agentic.uncertainty``:

- every supported distribution family validates, and malformed entries are
  rejected with structured ``{"id", "reason"}`` errors;
- dependence-group and approval rules (PSD copula matrices, continuous-only
  membership, executable == all approved);
- v1 scenarios parse byte-identically (config hash and determinism adapter);
- v2 round-trips through ``to_dict`` with a stable, v1-distinct hash;
- the seeded sampler is reproducible per (specs, master_seed, path_index),
  prefix-stable across budgets, and matches analytic distribution moments
  and copula correlation within predeclared tolerances.
"""

from __future__ import annotations

import json
import math
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
import yaml

from TokenLab.agentic import uncertainty as uncertainty_module
from TokenLab.agentic.rng import SAMPLER_VERSION
from TokenLab.agentic.schema import (
    ScenarioError,
    load_scenario,
    scenario_from_dict,
)
from TokenLab.agentic.uncertainty import (
    DistributionSpec,
    UncertaintyError,
    parse_uncertainty,
    sample_parameters,
    validate_v2_scenario,
)

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DEMO = ROOT / "src" / "TokenLab" / "agentic" / "data" / "public_demo.yaml"
V2_FIXTURE = (
    ROOT / "tests" / "fixtures" / "uncertainty" / "v2_triangular_users.yaml"
)

# Frozen v1 hash of public_demo.yaml, captured before the v2 schema extension.
V1_PUBLIC_DEMO_HASH = "30c98082f0ef79e2879e6f71dd66bdafe082d694ed54c490db96171585c5fcaf"

MASTER_SEED = 20260816


def _economy_dict() -> dict:
    return {
        "type": "TokenEconomy_Basic",
        "parameters": {
            "initial_price": 0.05,
            "fiat": "$",
            "token": "TLAB",
            "active": True,
        },
        "holding_time": {
            "type": "HoldingTime_Constant",
            "parameters": {"holding_time": 1.5},
        },
        "supply": {
            "type": "SupplyController_Constant",
            "parameters": {"supply": 10**8},
        },
        "price": {"type": "PriceFunction_EOE", "parameters": {}},
        "supply_pools": [],
        "agent_pools": [
            {
                "id": "users",
                "type": "AgentPool_Basic",
                "parameters": {"currency": "$", "name": "users"},
                "users": {
                    "type": "UserGrowth_Spaced",
                    "parameters": {
                        "initial_users": 2500,
                        "max_users": 20000,
                        "num_steps": 24,
                    },
                },
                "transactions": {
                    "type": "TransactionManagement_Constant",
                    "parameters": {"avg_transactions": 10},
                },
            }
        ],
    }


def _economy_spec():
    return scenario_from_dict(
        {
            "schema_version": 1,
            "scenario_id": "uncertainty-tests",
            "economy": _economy_dict(),
            "monte_carlo": {
                "simulator": "TokenMetaSimulator",
                "iterations": 3,
                "repetitions": 1,
                "seed": 1,
            },
            "artifacts": {"format": "csv"},
        }
    ).economy


def _entry(
    ident: str,
    path: str,
    value_type: str,
    distribution: dict,
    bounds: dict | None,
    *,
    unit: str = "units",
    rounding: str | None = None,
    layer: str = "parameter",
    cadence: str = "per_path",
    calibration: str = "illustrative",
    approval: str = "approved",
    dependence="independent",
) -> dict:
    entry = {
        "id": ident,
        "path": path,
        "value_type": value_type,
        "unit": unit,
        "layer": layer,
        "cadence": cadence,
        "distribution": distribution,
        "provenance": "Derived from reviewed public downside/baseline/upside presets.",
        "rationale": "Brackets the uncertain quantity.",
        "calibration": calibration,
        "approval": approval,
        "dependence": dependence,
    }
    if value_type == "integer":
        entry["rounding"] = rounding or "nearest_integer"
    if bounds is not None:
        entry["bounds"] = bounds
    return entry


def _triangular_entry(**overrides) -> dict:
    entry = _entry(
        "max_users",
        "economy.agent_pools[0].users.parameters.max_users",
        "integer",
        {"family": "triangular", "minimum": 12000, "mode": 20000, "maximum": 32000},
        {"minimum": 12000, "maximum": 32000},
        unit="users",
    )
    entry.update(overrides)
    return entry


def _uniform_entry(ident: str = "price", **overrides) -> dict:
    entry = _entry(
        ident,
        "economy.parameters.initial_price",
        "number",
        {"family": "uniform", "minimum": 0.03, "maximum": 0.08},
        {"minimum": 0.03, "maximum": 0.08},
        unit="usd",
    )
    entry.update(overrides)
    return entry


def _validate(entries, groups=None):
    block = {"parameters": entries, "dependence_groups": groups or []}
    return parse_uncertainty(block, _economy_spec())


def _family_fixtures() -> list:
    """One positive fixture per supported distribution family."""
    return [
        _triangular_entry(),
        _uniform_entry(),
        _entry(
            "fixed_users",
            "economy.agent_pools[0].users.parameters.max_users",
            "integer",
            {"family": "fixed", "value": 15000},
            {"minimum": 12000, "maximum": 32000},
            unit="users",
        ),
        _entry(
            "holding",
            "economy.holding_time.parameters.holding_time",
            "number",
            {
                "family": "truncated_normal",
                "mean": 1.5,
                "standard_deviation": 0.25,
                "minimum": 0.5,
                "maximum": 3.0,
            },
            {"minimum": 0.5, "maximum": 3.0},
            unit="days",
        ),
        _entry(
            "growth",
            "economy.parameters.initial_price",
            "number",
            {
                "family": "truncated_lognormal",
                "mean": -3.0,
                "standard_deviation": 0.4,
                "minimum": 0.01,
                "maximum": 0.2,
            },
            {"minimum": 0.01, "maximum": 0.2},
            unit="usd",
        ),
        _entry(
            "retention",
            "economy.parameters.initial_price",
            "number",
            {"family": "beta", "alpha": 2.0, "beta": 5.0},
            {"minimum": 0, "maximum": 1},
            unit="share",
        ),
        _entry(
            "active",
            "economy.parameters.active",
            "boolean",
            {"family": "bernoulli", "probability": 0.7},
            None,
            unit="flag",
        ),
        _entry(
            "currency",
            "economy.parameters.fiat",
            "string",
            {
                "family": "categorical",
                "categories": ["$", "EUR"],
                "probabilities": [0.6, 0.4],
            },
            None,
            unit="currency",
        ),
    ]


def test_supported_distribution_families_validate():
    # Positive: one fixture per family validates and is executable.
    for entry in _family_fixtures():
        validation = _validate([entry])
        assert validation.errors == [], (entry["distribution"]["family"], validation.errors)
        assert validation.executable
        assert len(validation.specs) == 1

    negative_cases = [
        # unknown family
        _triangular_entry(distribution={"family": "normal", "mean": 1, "sd": 1}),
        # missing required distribution parameter
        _triangular_entry(distribution={"family": "uniform", "minimum": 0.03}),
        # extra distribution parameter
        _triangular_entry(
            distribution={
                "family": "uniform",
                "minimum": 0.03,
                "maximum": 0.08,
                "mode": 0.05,
            }
        ),
        # non-finite distribution parameter
        _triangular_entry(
            distribution={"family": "uniform", "minimum": float("-inf"), "maximum": 1}
        ),
        # impossible support: uniform minimum >= maximum
        _triangular_entry(distribution={"family": "uniform", "minimum": 2, "maximum": 1}),
        # impossible support: triangular mode outside [minimum, maximum]
        _triangular_entry(
            distribution={
                "family": "triangular",
                "minimum": 12000,
                "mode": 40000,
                "maximum": 32000,
            }
        ),
        # truncated_normal with non-positive standard deviation
        _triangular_entry(
            distribution={
                "family": "truncated_normal",
                "mean": 1.0,
                "standard_deviation": 0.0,
                "minimum": 0.0,
                "maximum": 2.0,
            }
        ),
        # truncated_lognormal with negative minimum
        _triangular_entry(
            distribution={
                "family": "truncated_lognormal",
                "mean": 1.0,
                "standard_deviation": 0.5,
                "minimum": -1.0,
                "maximum": 2.0,
            }
        ),
        # beta with non-positive shape
        _triangular_entry(distribution={"family": "beta", "alpha": 0.0, "beta": 2.0}),
        # bernoulli probability outside [0, 1]
        _entry(
            "flag",
            "economy.parameters.active",
            "boolean",
            {"family": "bernoulli", "probability": 1.5},
            None,
        ),
        # categorical probabilities not summing to 1
        _entry(
            "cur",
            "economy.parameters.fiat",
            "string",
            {
                "family": "categorical",
                "categories": ["$", "EUR"],
                "probabilities": [0.6, 0.3],
            },
            None,
        ),
        # categorical with empty categories
        _entry(
            "cur",
            "economy.parameters.fiat",
            "string",
            {"family": "categorical", "categories": [], "probabilities": []},
            None,
        ),
        # categorical categories must be strings for value_type string
        _entry(
            "cur",
            "economy.parameters.fiat",
            "string",
            {
                "family": "categorical",
                "categories": [1, 2],
                "probabilities": [0.5, 0.5],
            },
            None,
        ),
        # bad rounding rule
        _triangular_entry(rounding="bankers"),
        # rounding present for non-integer value_type
        dict(_uniform_entry(), rounding="floor"),
        # empty unit
        _triangular_entry(unit="  "),
        # layer=parameter requires cadence=per_path
        _triangular_entry(cadence="per_iteration"),
        # unknown cadence
        _triangular_entry(cadence="hourly"),
        # unknown layer
        _triangular_entry(layer="magic"),
        # bounds missing for numeric value_type
        {k: v for k, v in _triangular_entry().items() if k != "bounds"},
        # truncated families: bounds must equal the truncation limits
        _entry(
            "holding",
            "economy.holding_time.parameters.holding_time",
            "number",
            {
                "family": "truncated_normal",
                "mean": 1.5,
                "standard_deviation": 0.25,
                "minimum": 0.5,
                "maximum": 3.0,
            },
            {"minimum": 0.4, "maximum": 3.0},
        ),
        # triangular: bounds must bracket the support
        _triangular_entry(bounds={"minimum": 13000, "maximum": 32000}),
        # fixed value must match the declared value_type
        _triangular_entry(distribution={"family": "fixed", "value": "a lot"}),
        # fixed numeric value must lie inside bounds
        _triangular_entry(distribution={"family": "fixed", "value": 40000}),
        # unknown entry field
        dict(_triangular_entry(), confidence="high"),
        # missing required entry field
        {k: v for k, v in _triangular_entry().items() if k != "rationale"},
        # path does not resolve against the economy spec tree
        _triangular_entry(path="economy.agent_pools[9].users.parameters.max_users"),
        # path resolves to a non-scalar node
        _triangular_entry(path="economy.agent_pools[0].users.parameters"),
        # path outside the economy tree
        _triangular_entry(path="monte_carlo.seed"),
        # boolean value_type rejects continuous families
        _entry(
            "flag",
            "economy.parameters.active",
            "boolean",
            {"family": "uniform", "minimum": 0.0, "maximum": 1.0},
            None,
        ),
        # string value_type requires categorical (or fixed)
        _entry(
            "cur",
            "economy.parameters.fiat",
            "string",
            {"family": "bernoulli", "probability": 0.5},
            None,
        ),
        # bounds forbidden for non-numeric value types
        _entry(
            "flag",
            "economy.parameters.active",
            "boolean",
            {"family": "bernoulli", "probability": 0.5},
            {"minimum": 0, "maximum": 1},
        ),
        # unknown calibration / approval states
        _triangular_entry(calibration="guessed"),
        _triangular_entry(approval="signed_off"),
    ]
    for entry in negative_cases:
        validation = _validate([entry])
        assert validation.errors, entry
        assert not validation.executable
        assert all(set(error) == {"id", "reason"} for error in validation.errors)

    # Duplicate ids and duplicate paths are rejected with structured errors.
    duplicate_ids = _validate([_triangular_entry(), _triangular_entry()])
    assert any("duplicate" in error["reason"] for error in duplicate_ids.errors)
    duplicate_paths = _validate(
        [_triangular_entry(), _triangular_entry(id="other")]
    )
    assert any("more than one entry" in e["reason"] for e in duplicate_paths.errors)


def test_invalid_dependence_and_draft_priors_are_rejected():
    member_a = _uniform_entry("param_a")
    member_b = _uniform_entry("param_b", path="economy.holding_time.parameters.holding_time")
    group = {
        "id": "growth_corr",
        "members": ["param_a", "param_b"],
        "correlation": [[1.0, 0.5], [0.5, 1.0]],
    }

    # A valid copula group validates and is executable.
    valid = _validate(
        [
            dict(member_a, dependence={"group": "growth_corr"}),
            dict(member_b, dependence={"group": "growth_corr"}),
        ],
        [group],
    )
    assert valid.errors == []
    assert valid.executable

    bad_matrices = [
        [[1.0, 1.5], [1.5, 1.0]],  # symmetric, unit diagonal, not PSD
        [[1.0, 0.8], [0.5, 1.0]],  # asymmetric
        [[1.0, 0.5, 0.1], [0.5, 1.0, 0.2], [0.1, 0.2, 1.0]],  # wrong dimension
        [[1.0, 0.5], [0.5, 0.9]],  # non-unit diagonal
    ]
    for matrix in bad_matrices:
        validation = _validate(
            [
                dict(member_a, dependence={"group": "growth_corr"}),
                dict(member_b, dependence={"group": "growth_corr"}),
            ],
            [dict(group, correlation=matrix)],
        )
        assert validation.errors, matrix
        assert not validation.executable

    # Discrete families cannot join a copula group.
    categorical = _entry(
        "currency",
        "economy.parameters.fiat",
        "string",
        {
            "family": "categorical",
            "categories": ["$", "EUR"],
            "probabilities": [0.6, 0.4],
        },
        None,
        dependence={"group": "growth_corr"},
    )
    bernoulli = _entry(
        "active",
        "economy.parameters.active",
        "boolean",
        {"family": "bernoulli", "probability": 0.7},
        None,
        dependence={"group": "growth_corr"},
    )
    for discrete in (categorical, bernoulli):
        validation = _validate(
            [discrete, dict(member_b, dependence={"group": "growth_corr"})],
            [dict(group, members=[discrete["id"], "param_b"])],
        )
        assert validation.errors
        assert not validation.executable

    # Unknown group id.
    unknown_group = _validate([dict(member_a, dependence={"group": "nope"}), member_b])
    assert any("unknown dependence group" in e["reason"] for e in unknown_group.errors)

    # Both independence and group membership at once.
    both = _validate(
        [dict(member_a, dependence={"group": "growth_corr", "independent": True})]
    )
    assert both.errors

    # Group claims a member whose own dependence says independent.
    mismatch = _validate(
        [member_a, dict(member_b, dependence={"group": "growth_corr"})], [group]
    )
    assert mismatch.errors

    # Group references an undeclared parameter id.
    dangling = _validate(
        [dict(member_a, dependence={"group": "growth_corr"})],
        [dict(group, members=["param_a", "ghost"])],
    )
    assert dangling.errors

    # Draft and needs_evidence priors parse but are non-executable.
    for state in ("draft", "needs_evidence"):
        validation = _validate([_triangular_entry(approval=state)])
        assert validation.errors == []
        assert not validation.executable
        assert validation.warnings
        with pytest.raises(UncertaintyError, match="not executable"):
            sample_parameters(validation, MASTER_SEED, 0)

    # Uncalibrated priors raise an evidence question but stay executable.
    validation = _validate([_triangular_entry(calibration="uncalibrated")])
    assert validation.executable
    assert validation.questions


def test_v1_scenarios_parse_unchanged_and_stay_deterministic():
    config = load_scenario(PUBLIC_DEMO)
    assert config.schema_version == 1
    assert config.uncertainty is None
    assert config.is_stochastic is False
    assert config.config_hash == V1_PUBLIC_DEMO_HASH
    assert "uncertainty" not in config.to_dict()

    # The v1 adapter: an empty, executable, deterministic validation.
    validation = validate_v2_scenario(config)
    assert validation.errors == []
    assert validation.executable
    assert validation.specs == []

    # v1 documents must not carry an uncertainty block.
    document = yaml.safe_load(PUBLIC_DEMO.read_text(encoding="utf-8"))
    document["uncertainty"] = {"parameters": []}
    with pytest.raises(ScenarioError, match="uncertainty"):
        scenario_from_dict(document)

    # v2 documents require the uncertainty block.
    document = yaml.safe_load(PUBLIC_DEMO.read_text(encoding="utf-8"))
    document["schema_version"] = 2
    with pytest.raises(ScenarioError, match="uncertainty"):
        scenario_from_dict(document)


def test_v2_parsing_round_trip_and_hash():
    config = load_scenario(V2_FIXTURE)
    assert config.schema_version == 2
    assert config.uncertainty is not None
    assert config.is_stochastic is True

    # Round-trip: to_dict -> parse -> identical structured block and hash.
    reparsed = scenario_from_dict(config.to_dict())
    assert reparsed == config
    assert reparsed.config_hash == config.config_hash
    assert len(config.config_hash) == 64

    # Same economy with an uncertainty block hashes differently from v1.
    v1_document = yaml.safe_load(PUBLIC_DEMO.read_text(encoding="utf-8"))
    v2_document = dict(v1_document)
    v2_document["schema_version"] = 2
    v2_document["uncertainty"] = config.uncertainty.to_dict()
    v2_config = scenario_from_dict(v2_document)
    assert v2_config.config_hash != scenario_from_dict(v1_document).config_hash

    # to_dict carries the block back in its frozen shape.
    block = config.to_dict()["uncertainty"]
    assert block["parameters"][0]["distribution"]["family"] == "triangular"
    assert block["parameters"][0]["dependence"] == "independent"
    assert block["dependence_groups"] == []

    # validate_v2_scenario agrees with the parsed block.
    validation = validate_v2_scenario(config)
    assert validation.errors == []
    assert validation.executable
    assert [spec.id for spec in validation.specs] == ["max_users", "initial_price"]

    # Structurally invalid blocks raise UncertaintyError through the schema.
    broken = config.to_dict()
    broken["uncertainty"]["parameters"][0]["distribution"] = {
        "family": "triangular",
        "minimum": 10,
        "mode": 5,
        "maximum": 1,
    }
    with pytest.raises(UncertaintyError, match="triangular"):
        scenario_from_dict(broken)

    # A v2 block of only fixed/draft entries is not stochastic / not executable.
    only_fixed = config.to_dict()
    only_fixed["uncertainty"]["parameters"] = [
        dict(
            config.uncertainty.to_dict()["parameters"][0],
            distribution={"family": "fixed", "value": 20000},
        )
    ]
    fixed_config = scenario_from_dict(only_fixed)
    assert fixed_config.is_stochastic is False
    assert validate_v2_scenario(fixed_config).executable
    draft = config.to_dict()
    draft["uncertainty"]["parameters"][0]["approval"] = "draft"
    draft_config = scenario_from_dict(draft)
    assert not validate_v2_scenario(draft_config).executable


def _triangular_validation():
    return _validate([_triangular_entry()])


def test_sampler_is_deterministic_and_seed_dependent():
    validation = _triangular_validation()

    first = sample_parameters(validation, MASTER_SEED, 0)
    second = sample_parameters(validation, MASTER_SEED, 0)
    assert first.to_dict() == second.to_dict()
    assert first.values() == second.values()
    # Records stay JSON-safe.
    assert json.loads(json.dumps(first.to_dict())) == first.to_dict()

    other_seed = sample_parameters(validation, MASTER_SEED + 1, 0)
    assert other_seed.values() != first.values()
    other_path = sample_parameters(validation, MASTER_SEED, 1)
    assert other_path.values() != first.values()

    # Prefix stability: paths 0..31 drawn in a 64-path session equal those
    # drawn in a 32-path session (no budget enters the derivation).
    wide = [sample_parameters(validation, MASTER_SEED, p).values() for p in range(64)]
    narrow = [sample_parameters(validation, MASTER_SEED, p).values() for p in range(32)]
    assert wide[:32] == narrow

    # Integer rounding rule is applied to draws.
    assert all(isinstance(sample["max_users"], int) for sample in narrow)

    # Lineage pins the frozen derivation contract.
    sample = first.samples[0]
    assert sample.sampled is True
    assert sample.dependence == "independent"
    assert sample.lineage["namespace"] == "parameters:max_users"
    assert sample.lineage["master_seed"] == MASTER_SEED
    assert sample.lineage["path_index"] == 0
    assert sample.lineage["sampler_version"] == SAMPLER_VERSION


def test_sampler_records_fixed_entries_without_sampling():
    entries = _family_fixtures()
    fixed = next(e for e in entries if e["distribution"]["family"] == "fixed")
    validation = _validate([fixed])
    sample_set = sample_parameters(validation, MASTER_SEED, 3)
    (sample,) = sample_set.samples
    assert sample.value == 15000
    assert sample.sampled is False
    assert sample.lineage is None
    assert sample.family == "fixed"


def test_sampler_matches_triangular_moments():
    validation = _triangular_validation()
    draws = np.array(
        [
            sample_parameters(validation, MASTER_SEED, path).values()["max_users"]
            for path in range(20000)
        ],
        dtype=float,
    )
    analytic_mean = (12000 + 20000 + 32000) / 3.0
    # Predeclared tolerance: sample mean within 0.5% of the analytic mean.
    assert abs(draws.mean() - analytic_mean) <= 0.005 * analytic_mean
    assert draws.min() >= 12000
    assert draws.max() <= 32000


def test_sampler_copula_induces_declared_correlation():
    member_a = _uniform_entry("param_a")
    member_b = _uniform_entry("param_b", path="economy.holding_time.parameters.holding_time")
    group = {
        "id": "growth_corr",
        "members": ["param_a", "param_b"],
        "correlation": [[1.0, 0.8], [0.8, 1.0]],
    }
    validation = _validate(
        [
            dict(member_a, dependence={"group": "growth_corr"}),
            dict(member_b, dependence={"group": "growth_corr"}),
        ],
        [group],
    )
    assert validation.executable

    pairs = np.array(
        [
            tuple(
                sample_parameters(validation, MASTER_SEED, path).values()[key]
                for key in ("param_a", "param_b")
            )
            for path in range(20000)
        ]
    )
    pearson = np.corrcoef(pairs[:, 0], pairs[:, 1])[0, 1]
    # Predeclared tolerance: rho = 0.8 Gaussian copula must show a clearly
    # positive induced correlation (> 0.5; theoretical Pearson ~= 0.77).
    assert pearson > 0.5

    # Group draws share one lineage namespace per path.
    sample_set = sample_parameters(validation, MASTER_SEED, 0)
    namespaces = {sample.lineage["namespace"] for sample in sample_set.samples}
    assert namespaces == {"dependence:growth_corr"}
    assert {sample.dependence for sample in sample_set.samples} == {"growth_corr"}

    # Independent parameters show no material correlation.
    independent = _validate(
        [member_a, dict(member_b, id="param_c", path=member_b["path"])]
    )
    pairs = np.array(
        [
            tuple(
                sample_parameters(independent, MASTER_SEED, path).values()[key]
                for key in ("param_a", "param_c")
            )
            for path in range(20000)
        ]
    )
    assert abs(np.corrcoef(pairs[:, 0], pairs[:, 1])[0, 1]) < 0.05


def test_sampler_respects_uniform_bounds():
    validation = _validate([_uniform_entry()])
    draws = np.array(
        [
            sample_parameters(validation, MASTER_SEED, path).values()["price"]
            for path in range(10000)
        ]
    )
    assert draws.min() >= 0.03
    assert draws.max() <= 0.08
    # The stream actually explores the interval.
    assert draws.min() < 0.031
    assert draws.max() > 0.079


def test_sample_parameters_accepts_plain_specs_and_refuses_drafts():
    validation = _triangular_validation()
    from_specs = sample_parameters(validation.specs, MASTER_SEED, 0)
    from_validation = sample_parameters(validation, MASTER_SEED, 0)
    assert from_specs.to_dict() == from_validation.to_dict()

    drafts = [replace(validation.specs[0], approval="draft")]
    with pytest.raises(UncertaintyError, match="approval"):
        sample_parameters(drafts, MASTER_SEED, 0)


def test_inverse_cdf_clamps_boundary_uniforms():
    # u = 0/1 reach ppf unclamped as -inf/+inf for unbounded families; the
    # sampler clamps to [1e-12, 1 - 1e-12] so every draw stays finite and
    # inside the declared support.
    families = (
        DistributionSpec(
            "truncated_normal",
            {
                "minimum": 0.0,
                "maximum": 10.0,
                "mean": 5.0,
                "standard_deviation": 2.0,
            },
        ),
        DistributionSpec(
            "truncated_lognormal",
            {
                "minimum": 0.5,
                "maximum": 100.0,
                "mean": 3.0,
                "standard_deviation": 0.5,
            },
        ),
    )
    for distribution in families:
        low = uncertainty_module._inverse_cdf(distribution, 0.0)
        high = uncertainty_module._inverse_cdf(distribution, 1.0)
        assert math.isfinite(low)
        assert math.isfinite(high)
        assert distribution.parameters["minimum"] <= low
        assert high <= distribution.parameters["maximum"]


def test_copula_boundary_draws_stay_finite(monkeypatch):
    # norm.cdf rounds extreme correlated draws to exactly 0.0/1.0; the copula
    # path clamps before the inverse CDF so no marginal goes non-finite.
    member_a = _entry(
        "param_a",
        "economy.parameters.initial_price",
        "number",
        {
            "family": "truncated_normal",
            "minimum": 0.0,
            "maximum": 10.0,
            "mean": 5.0,
            "standard_deviation": 2.0,
        },
        {"minimum": 0.0, "maximum": 10.0},
        dependence={"group": "growth_corr"},
    )
    member_b = _entry(
        "param_b",
        "economy.holding_time.parameters.holding_time",
        "number",
        {
            "family": "truncated_lognormal",
            "minimum": 0.5,
            "maximum": 100.0,
            "mean": 3.0,
            "standard_deviation": 0.5,
        },
        {"minimum": 0.5, "maximum": 100.0},
        dependence={"group": "growth_corr"},
    )
    group = {
        "id": "growth_corr",
        "members": ["param_a", "param_b"],
        "correlation": [[1.0, 0.5], [0.5, 1.0]],
    }
    validation = _validate([member_a, member_b], [group])
    assert validation.executable

    class ExtremeGenerator:
        def standard_normal(self, size):
            return np.full(size, 1e9)

    monkeypatch.setattr(
        uncertainty_module, "derive_generator", lambda *args: ExtremeGenerator()
    )
    values = sample_parameters(validation, MASTER_SEED, 0).values()
    assert math.isfinite(values["param_a"])
    assert math.isfinite(values["param_b"])

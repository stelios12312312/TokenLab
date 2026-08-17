"""Statistical-artifact contract tests for the Phase 3 Monte Carlo pipeline.

# @planner:story = US-PM-AUTO-H2A2D347E9E110A84

Every test is seeded with predeclared tolerances — no coverage simulations,
no flaky thresholds. Covers ``TokenLab.agentic.statistics`` and the v2
bundle artifacts produced by ``MonteCarloRunner``:

- controlled analytic distributions through the real sampler + statistics
  pipeline match predeclared tolerances;
- modeled outcome intervals are never labeled confidence intervals;
- sensitivity statuses never fabricate ranks for constant or thin data;
- convergence checkpoint statuses and the near-zero absolute-tolerance
  guard;
- bootstrap determinism given a frozen generator;
- failed paths are excluded from statistics but included in denominators.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import yaml

from TokenLab.agentic.factory import ScenarioFactory
from TokenLab.agentic.rng import derive_generator
from TokenLab.agentic.runner import MonteCarloRunner
from TokenLab.agentic.statistics import (
    OUTCOME_INTERVAL_LABEL,
    IntervalLabelError,
    bootstrap_ci,
    convergence_checkpoints,
    quantile_summary,
    spearman_sensitivity,
    validate_interval_labels,
    wilson_interval,
)
from TokenLab.agentic.uncertainty import (
    Bounds,
    DistributionSpec,
    UncertaintySpec,
    sample_parameters,

)

ROOT = Path(__file__).resolve().parents[1]
V2_FIXTURE = ROOT / "tests" / "fixtures" / "uncertainty" / "v2_triangular_users.yaml"

MASTER_SEED = 20260816
DRAWS = 20000


def _spec(param_id: str, distribution: DistributionSpec) -> UncertaintySpec:
    support = distribution.support()
    return UncertaintySpec(
        id=param_id,
        path=f"economy.parameters.{param_id}",
        value_type="number",
        unit="unit",
        rounding=None,
        layer="parameter",
        cadence="per_path",
        distribution=distribution,
        bounds=Bounds(*support) if support is not None else None,
        provenance="Analytic test fixture.",
        rationale="Controlled distribution check.",
        calibration="calibrated",
        approval="approved",
    )


def _draw(spec: UncertaintySpec, count: int, seed: int = MASTER_SEED) -> np.ndarray:
    return np.array(
        [sample_parameters([spec], seed, path).values()[spec.id] for path in range(count)]
    )


def test_controlled_distributions_match_predeclared_tolerances():
    # Uniform(80, 180) through the real sampler + statistics pipeline.
    uniform = _draw(_spec("u", DistributionSpec("uniform", {"minimum": 80.0, "maximum": 180.0})), DRAWS)
    summary = quantile_summary(uniform)
    assert summary["n"] == DRAWS
    assert summary["quantile_method"] == "linear"
    assert abs(summary["mean"] - 130.0) <= 1.0
    assert abs(summary["p10"] - 90.0) <= 2.0
    assert abs(summary["p90"] - 170.0) <= 2.0
    assert summary["min"] >= 80.0 and summary["max"] <= 180.0

    # Triangular(12000, 20000, 32000): analytic mean/std/median.
    triangular = _draw(
        _spec(
            "t",
            DistributionSpec(
                "triangular",
                {"minimum": 12000.0, "mode": 20000.0, "maximum": 32000.0},
            ),
        ),
        DRAWS,
    )
    tri_summary = quantile_summary(triangular)
    assert abs(tri_summary["mean"] - 21333.333333333332) <= 0.005 * 21333.333333333332
    assert abs(tri_summary["std"] - 4109.609335312651) <= 0.01 * 4109.609335312651
    assert abs(tri_summary["p50"] - 21045.548849896677) <= 0.005 * 21045.548849896677

    # Bootstrap CI on the mean of a known normal fixture contains the true
    # mean (single fixed seed, predeclared — not a coverage simulation).
    fixture = np.random.default_rng(20260816).normal(50.0, 2.0, 2000)
    ci = bootstrap_ci(fixture, "mean", 1000, derive_generator(777, "bootstrap:test", 0))
    assert ci["ci_low"] <= 50.0 <= ci["ci_high"]
    assert ci["method"] == "percentile_bootstrap"
    assert ci["estimator"] == "mean"
    assert ci["level"] == 0.95
    assert ci["resamples"] == 1000
    assert ci["label"] == "95% percentile-bootstrap confidence interval for the mean"

    # Wilson interval matches hand-computed bounds.
    wilson = wilson_interval(3, 10)
    assert wilson["estimate"] == 0.3
    assert wilson["ci_low"] == pytest.approx(0.10779126740630099, rel=1e-12)
    assert wilson["ci_high"] == pytest.approx(0.6032218525388546, rel=1e-12)
    assert wilson["method"] == "wilson_score"
    assert wilson["successes"] == 3 and wilson["n"] == 10
    edge = wilson_interval(0, 10)
    assert edge["ci_low"] == 0.0
    assert edge["ci_high"] == pytest.approx(0.2775327998628892, rel=1e-12)


def test_outcome_intervals_are_not_labeled_confidence_intervals(tmp_path):
    artifacts = MonteCarloRunner().run(
        V2_FIXTURE, tmp_path / "runs", run_id="labels", paths=4
    )
    documents = {}
    for name in (
        "terminal_summary",
        "sensitivity",
        "convergence",
        "path_failures",
        "manifest",
    ):
        documents[name] = json.loads(
            (artifacts.bundle_dir / f"{name}.json").read_text(encoding="utf-8")
        )
    # Every published JSON artifact passes the label validator.
    for name, payload in documents.items():
        assert validate_interval_labels(payload) is True, name

    # Outcome intervals carry the frozen label; estimator CIs name the
    # estimator, method and level.
    for entry in documents["terminal_summary"]["metrics"]:
        assert entry["outcome_interval"]["label"] == OUTCOME_INTERVAL_LABEL
        for interval in entry["confidence_intervals"]:
            assert "confidence interval" in interval["label"]
            assert interval["estimator"] in ("mean", "median")
            assert interval["method"] == "percentile_bootstrap"
            assert interval["level"] == 0.95

    # No artifact attaches the phrase "confidence interval" to raw outcome
    # percentiles, anywhere in the nested payload.
    def check(node):
        if isinstance(node, dict):
            if "p10" in node and "p90" in node:
                for value in node.values():
                    if isinstance(value, str):
                        assert "confidence interval" not in value.lower()
            for value in node.values():
                check(value)
        elif isinstance(node, list):
            for value in node:
                check(value)

    for payload in documents.values():
        check(payload)

    # The validator rejects mislabeled payloads.
    with pytest.raises(IntervalLabelError, match="modeled outcome"):
        validate_interval_labels(
            {"label": "95% confidence interval", "p10": 1.0, "p90": 2.0}
        )
    with pytest.raises(IntervalLabelError, match="missing level"):
        validate_interval_labels(
            {
                "ci_low": 1.0,
                "ci_high": 2.0,
                "estimator": "mean",
                "method": "percentile_bootstrap",
            }
        )
    assert (
        validate_interval_labels(
            {
                "outcome_interval": {
                    "label": OUTCOME_INTERVAL_LABEL,
                    "p10": 1.0,
                    "p90": 2.0,
                },
                "confidence_intervals": [
                    {
                        "ci_low": 1.1,
                        "ci_high": 1.9,
                        "estimator": "mean",
                        "method": "percentile_bootstrap",
                        "level": 0.95,
                    }
                ],
            }
        )
        is True
    )


def test_sensitivity_statuses():
    rng = np.random.default_rng(99)
    x = rng.standard_normal(300)

    # ok: a monotone relationship recovers its sign and magnitude band.
    records = spearman_sensitivity(
        {"p": x},
        {"m": 2.0 * x},
        min_n=100,
        bootstrap_resamples=200,
        rng=np.random.default_rng(7),
    )
    (record,) = records
    assert record["status"] == "ok"
    assert record["rho"] == pytest.approx(1.0)
    assert record["direction"] == "positive"
    assert record["magnitude"] == "strong"
    assert record["ci_low"] <= record["rho"] <= record["ci_high"]
    assert record["n"] == 300
    assert record["method"] == "spearman_rank"
    assert record["interpretation"] == "association is not causal"
    # ok records are valid CI-bearing artifacts under the label contract.
    assert validate_interval_labels(records) is True

    (negative,) = spearman_sensitivity(
        {"p": x},
        {"m": -3.0 * x},
        min_n=100,
        bootstrap_resamples=200,
        rng=np.random.default_rng(7),
    )
    assert negative["status"] == "ok"
    assert negative["direction"] == "negative"
    assert negative["magnitude"] == "strong"

    # insufficient_paths below 100 completed paths: no rank is produced.
    (thin,) = spearman_sensitivity(
        {"p": x[:32]},
        {"m": x[:32]},
        min_n=100,
        bootstrap_resamples=200,
        rng=np.random.default_rng(7),
    )
    assert thin["status"] == "insufficient_paths"
    assert thin["n"] == 32
    assert "rho" not in thin

    # Constant data never fabricates a rank.
    (const_out,) = spearman_sensitivity(
        {"p": x},
        {"m": np.ones(300)},
        min_n=100,
        bootstrap_resamples=200,
        rng=np.random.default_rng(7),
    )
    assert const_out["status"] == "constant_output"
    assert "rho" not in const_out

    (const_in,) = spearman_sensitivity(
        {"p": np.full(300, 7.0)},
        {"m": x},
        min_n=100,
        bootstrap_resamples=200,
        rng=np.random.default_rng(7),
    )
    assert const_in["status"] == "constant_input"
    assert "rho" not in const_in


def test_convergence_statuses():
    # Fewer than two checkpoints: drift is not computed, MC standard error is.
    thin = convergence_checkpoints({100: np.arange(100.0)})
    assert thin["status"] == "insufficient_checkpoints"
    (checkpoint,) = thin["checkpoints"]
    assert checkpoint["n"] == 100
    expected_se = float(np.std(np.arange(100.0), ddof=1)) / np.sqrt(100)
    assert checkpoint["mc_standard_error"] == pytest.approx(expected_se)

    # iid fixture with identical empirical distributions: converged, no drift.
    base = np.arange(100.0)
    converged = convergence_checkpoints({100: base, 200: np.concatenate([base, base])})
    assert converged["status"] == "converged"
    assert converged["reference_checkpoint"] == 100
    assert converged["final_checkpoint"] == 200
    for quantile in ("p10", "p50", "p90"):
        assert converged["drift"][quantile]["relative_drift"] == pytest.approx(
            0.0, abs=1e-12
        )

    # Drifted fixture anchored at zero: the declared absolute tolerance guards
    # the division (no bare epsilon) and the drift is truthfully huge.
    drifted = convergence_checkpoints(
        {100: np.zeros(100), 250: np.concatenate([np.zeros(100), np.ones(150)])}
    )
    assert drifted["status"] == "not_converged"
    assert np.isfinite(drifted["drift"]["p50"]["relative_drift"])
    assert drifted["drift"]["p50"]["relative_drift"] > 1.0
    assert drifted["tolerances"] == {"relative_drift": 0.05, "absolute": 1e-9}


def test_bootstrap_is_deterministic_given_the_seed():
    values = np.random.default_rng(5).standard_normal(500)
    first = bootstrap_ci(values, "median", 500, derive_generator(11, "ns", 0))
    second = bootstrap_ci(values, "median", 500, derive_generator(11, "ns", 0))
    assert first == second
    other = bootstrap_ci(values, "median", 500, derive_generator(12, "ns", 0))
    assert (other["ci_low"], other["ci_high"]) != (first["ci_low"], first["ci_high"])


def test_path_failures_are_excluded_from_statistics_but_counted(
    tmp_path, monkeypatch
):
    failing = {1, 6}
    calls = {"count": 0}
    original_build = ScenarioFactory.build

    def flaky_build(self, config, rng_plan=None):
        index = calls["count"]
        calls["count"] += 1
        if index in failing:
            raise RuntimeError("injected component failure")
        return original_build(self, config, rng_plan=rng_plan)

    monkeypatch.setattr(ScenarioFactory, "build", flaky_build)
    artifacts = MonteCarloRunner().run(
        V2_FIXTURE, tmp_path / "runs", run_id="denominators", paths=8
    )

    # Denominators: requested = completed + failed, everywhere.
    assert artifacts.path_failures == {
        "requested": 8,
        "completed": 6,
        "failed": 2,
        "failures": artifacts.path_failures["failures"],
    }
    assert [r["path_index"] for r in artifacts.path_failures["failures"]] == [1, 6]

    # Statistics aggregate completed paths only.
    for entry in artifacts.terminal_summary["metrics"]:
        assert entry["n"] == 6
    for column in artifacts.iteration_summary.columns:
        if column.endswith("_n"):
            assert artifacts.iteration_summary[column].eq(6).all()
    assert artifacts.sensitivity["completed_paths"] == 6
    assert {r["status"] for r in artifacts.sensitivity["results"]} == {
        "insufficient_paths"
    }

    # Samples are still published for the failed paths (denominator evidence).
    assert set(artifacts.parameter_samples["path_index"]) == set(range(8))
    assert set(artifacts.results["path_index"]) == {0, 2, 3, 4, 5, 7}

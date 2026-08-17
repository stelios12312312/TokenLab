"""Assumption-aware agent operation contract tests (Phase 4).

# @planner:story = US-PM-AUTO-H5C4D76290B437A5B
# @planner:proves = crit:CRIT-004

Covers the frozen operation envelopes of ``TokenLab.agentic.assumptions``:

- draft/needs_evidence priors make validation non-executable and turn
  propose/run into structured refusals that create no bundle; missing
  range/provenance/unit/dependence items surface as structured questions;
- the full inspect -> validate -> propose -> run -> summarize chain on the
  approved fixture is status ok end-to-end, and every numeric claim in the
  summary cites an existing bundle artifact field with an equal value;
- scenario path and output dir allowlists refuse traversal, absolute system
  paths, and non-scenario extensions;
- v1 scenarios route to the deterministic HeadlessRunner path with Monte
  Carlo claims forbidden;
- the seed contract: embedded seeds are used, explicit seeds override, and
  generated seeds are persisted in the bundle and shown before any claim;
- CLI subcommands print parseable JSON and exit non-zero on refusal.
"""

from __future__ import annotations

from dataclasses import replace
import hashlib
import json
from pathlib import Path

import pytest
import yaml

from TokenLab import cli
from TokenLab.agentic import assumptions
from TokenLab.agentic.runner import RUN_TIERS
from TokenLab.agentic.schema import load_scenario
from TokenLab.agentic.statistics import OUTCOME_INTERVAL_LABEL

ROOT = Path(__file__).resolve().parents[1]
V2_FIXTURE = ROOT / "tests" / "fixtures" / "uncertainty" / "v2_triangular_users.yaml"
V1_DEMO = ROOT / "src" / "TokenLab" / "agentic" / "data" / "public_demo.yaml"


def _fixture_dict() -> dict:
    return yaml.safe_load(V2_FIXTURE.read_text(encoding="utf-8"))


def _write_yaml(path: Path, data: dict) -> Path:
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return path


def _resolve_field(document, field: str):
    node = document
    for part in field.split("."):
        node = node[int(part)] if isinstance(node, list) else node[part]
    return node


def test_agent_refuses_unapproved_or_incomplete_priors(tmp_path):
    # A draft prior: parses, but is non-executable end to end.
    draft = _fixture_dict()
    draft["uncertainty"]["parameters"][0]["approval"] = "draft"
    draft_path = _write_yaml(tmp_path / "draft.yaml", draft)

    validation = assumptions.validate_uncertainty(draft_path, allowed_roots=[tmp_path])
    assert validation["status"] == "ok"
    assert validation["executable"] is False
    assert any(
        question["subject"] == "approval" and question["id"] == "max_users"
        for question in validation["questions"]
    )
    assert validation["supported_families"] == [
        "fixed",
        "uniform",
        "triangular",
        "truncated_normal",
        "truncated_lognormal",
        "beta",
        "bernoulli",
        "categorical",
    ]

    proposal = assumptions.propose_run(draft_path, "analysis", allowed_roots=[tmp_path])
    assert proposal["status"] == "refused"
    assert proposal["reasons"]
    assert proposal["questions"]

    output_dir = tmp_path / "runs"
    result = assumptions.run_simulation(
        draft_path,
        run_tier="test",
        output_dir=output_dir,
        allowed_roots=[tmp_path],
        allowed_output_roots=[tmp_path],
    )
    assert result["status"] == "refused"
    assert result["reasons"]
    assert not output_dir.exists() or not any(output_dir.iterdir())

    # Missing provenance/unit/range/dependence each yield the right question.
    for field, subject in [
        ("provenance", "provenance"),
        ("unit", "unit"),
        ("bounds", "range"),
        ("dependence", "dependence"),
    ]:
        variant = _fixture_dict()
        del variant["uncertainty"]["parameters"][0][field]
        variant_path = _write_yaml(tmp_path / f"missing_{field}.yaml", variant)
        outcome = assumptions.validate_uncertainty(
            variant_path, allowed_roots=[tmp_path]
        )
        assert outcome["status"] == "ok"
        assert outcome["executable"] is False
        assert any(
            question["subject"] == subject for question in outcome["questions"]
        ), subject

    # A v1 scenario validates as deterministic and runs via HeadlessRunner.
    v1_validation = assumptions.validate_uncertainty(V1_DEMO)
    assert v1_validation["status"] == "ok"
    assert v1_validation["executable"] is True
    assert "no uncertainty is modeled" in v1_validation["note"]

    v1_result = assumptions.run_simulation(
        V1_DEMO,
        output_dir=tmp_path / "v1runs",
        allowed_output_roots=[tmp_path],
    )
    assert v1_result["status"] == "ok"
    assert v1_result["claim"] == "deterministic"
    assert "Monte Carlo claims are forbidden" in v1_result["note"]
    assert v1_result["claim_eligibility"]["eligible"] is False
    assert Path(v1_result["manifest_path"]).is_file()


def test_agent_refuses_needs_evidence_dependence_group(tmp_path):
    data = _fixture_dict()
    parameters = data["uncertainty"]["parameters"]
    parameters[0]["approval"] = "needs_evidence"
    parameters[0]["dependence"] = {"group": "adoption"}
    parameters[1]["dependence"] = {"group": "adoption"}
    data["uncertainty"]["dependence_groups"] = [
        {
            "id": "adoption",
            "members": ["max_users", "initial_price"],
            "correlation": [[1.0, 0.3], [0.3, 1.0]],
        }
    ]
    path = _write_yaml(tmp_path / "needs_evidence.yaml", data)

    validation = assumptions.validate_uncertainty(path, allowed_roots=[tmp_path])
    assert validation["executable"] is False

    result = assumptions.run_simulation(
        path,
        run_tier="test",
        output_dir=tmp_path / "runs",
        allowed_roots=[tmp_path],
        allowed_output_roots=[tmp_path],
    )
    assert result["status"] == "refused"
    assert not (tmp_path / "runs").exists() or not any((tmp_path / "runs").iterdir())


def test_agent_summary_cites_exact_artifacts(tmp_path):
    inspected = assumptions.inspect_assumptions(V2_FIXTURE)
    assert inspected["status"] == "ok"
    assert inspected["is_stochastic"] is True
    assert inspected["schema_version"] == 2
    by_id = {entry["id"]: entry for entry in inspected["assumptions"]}
    assert by_id["max_users"]["classification"] == "uncertain"
    assert by_id["initial_price"]["classification"] == "uncertain"
    assert by_id["max_users"]["calibration"] == "illustrative"
    assert by_id["max_users"]["approval"] == "approved"
    assert by_id["process:economy"]["classification"] == "process"
    assert by_id["process:monte_carlo.simulator"]["layer"] == "process"

    validation = assumptions.validate_uncertainty(V2_FIXTURE)
    assert validation["status"] == "ok"
    assert validation["executable"] is True

    proposal = assumptions.propose_run(V2_FIXTURE, "analysis")
    assert proposal["status"] == "ok"
    assert proposal["run_tier"] == "standard"
    assert proposal["paths"] == RUN_TIERS["standard"]["paths"]
    assert "convergence diagnostics required" in proposal["expected_precision"]
    assert proposal["estimated_cost"]["reference_machine"] is True
    assert "not a forecast" in proposal["boundary"]

    run = assumptions.run_simulation(
        V2_FIXTURE,
        run_tier="test",
        output_dir=tmp_path / "runs",
        allowed_output_roots=[tmp_path],
    )
    assert run["status"] == "ok"
    assert run["claim"] == "monte_carlo"
    assert run["requested_paths"] == RUN_TIERS["test"]["paths"]
    assert run["completed_paths"] == RUN_TIERS["test"]["paths"]
    assert run["failed_paths"] == 0
    bundle = Path(run["bundle_dir"])
    assert bundle.is_dir()

    # summarize accepts both the run result dict and the bundle path.
    summary = assumptions.summarize_evidence(run)
    assert summary["status"] == "ok"
    from_path = assumptions.summarize_evidence(bundle)
    assert from_path["status"] == "ok"

    # Every citation points at an existing artifact, and every JSON citation
    # value equals the artifact content at the cited field.
    documents = {}
    for citation in summary["citations"]:
        artifact = bundle / citation["artifact"]
        assert artifact.is_file(), citation
        if citation["artifact"].endswith(".json"):
            if citation["artifact"] not in documents:
                documents[citation["artifact"]] = json.loads(
                    artifact.read_text(encoding="utf-8")
                )
            resolved = _resolve_field(documents[citation["artifact"]], citation["field"])
            assert resolved == citation["value"], citation

    # Interval labels: outcome bands carry the frozen label; estimator CIs
    # name estimator, method, and level.
    assert summary["outcome_bands"], "expected at least one terminal metric"
    for band in summary["outcome_bands"]:
        assert band["label"] == OUTCOME_INTERVAL_LABEL
        assert "confidence interval" not in band["label"]
    assert summary["estimator_intervals"], "expected estimator CIs"
    for interval in summary["estimator_intervals"]:
        assert "confidence interval" in interval["label"]
        assert interval["estimator"] in {"mean", "median"}
        assert interval["method"] == "percentile_bootstrap"
        assert interval["level"] == 0.95

    # Every numeric claim in the bands/intervals/failures sections is cited.
    cited = {citation["statistic_id"] for citation in summary["citations"]}
    for band in summary["outcome_bands"]:
        for key in ("p10", "p90", "mean", "median", "n"):
            assert f"terminal:{band['id']}:{key}" in cited
    for interval in summary["estimator_intervals"]:
        for key in ("estimate", "ci_low", "ci_high"):
            assert (
                f"terminal:{interval['metric']}:ci:{interval['estimator']}.{key}"
                in cited
            )
    for key in ("requested", "completed", "failed"):
        assert f"path_failures:{key}" in cited

    # Interpretation boundary and read-only calibration echo.
    boundary = summary["interpretation_boundary"]
    assert "not confidence intervals" in boundary
    assert "forecast" in boundary
    states = summary["calibration_states"]["states"]
    assert states["max_users"]["calibration"] == ["illustrative"]
    assert states["max_users"]["approval"] == ["approved"]

    # Sensitivity/convergence/failure sections are truthful for 32 paths:
    # below the 100-path sensitivity minimum and the first checkpoint.
    assert summary["sensitivity"]["interpretation"] == "association is not causal"
    assert summary["sensitivity"]["highlights"]
    assert all(
        highlight["status"] == "insufficient_paths"
        for highlight in summary["sensitivity"]["highlights"]
    )
    assert summary["convergence"]["checkpoints_used"] == []
    assert all(
        metric["status"] == "insufficient_checkpoints"
        for metric in summary["convergence"]["metrics"].values()
    )
    assert summary["failures"] == {
        "requested": RUN_TIERS["test"]["paths"],
        "completed": RUN_TIERS["test"]["paths"],
        "failed": 0,
        "failures": [],
    }
    assert summary["claim_eligibility"]["eligible"] is True


def test_agent_refuses_path_traversal_and_non_scenario_files(tmp_path):
    # A valid scenario outside every allowlisted root is refused.
    outside = _write_yaml(tmp_path / "outside.yaml", _fixture_dict())
    result = assumptions.inspect_assumptions(outside)
    assert result["status"] == "refused"
    assert "allowlisted roots" in result["reasons"][0]

    # A .. escape that resolves outside the allowed roots is refused.
    traversal = assumptions.inspect_assumptions(
        str(tmp_path / "nested" / ".." / "outside.yaml"), allowed_roots=[tmp_path / "nested"]
    )
    assert traversal["status"] == "refused"

    # Absolute system paths are refused whether or not they exist.
    assert assumptions.inspect_assumptions("/etc/hosts")["status"] == "refused"
    assert assumptions.validate_uncertainty("/etc/passwd.yaml")["status"] == "refused"

    # A non-scenario extension inside an allowed root is refused.
    text_file = tmp_path / "scenario.txt"
    text_file.write_text("schema_version: 2", encoding="utf-8")
    refused = assumptions.inspect_assumptions(text_file, allowed_roots=[tmp_path])
    assert refused["status"] == "refused"

    # propose_run enforces the same allowlist.
    proposal = assumptions.propose_run(outside, "analysis")
    assert proposal["status"] == "refused"


def test_run_simulation_enforces_output_dir_allowlist(tmp_path):
    refused = assumptions.run_simulation(
        V2_FIXTURE, run_tier="test", output_dir=tmp_path / "runs"
    )
    assert refused["status"] == "refused"
    assert "allowlisted roots" in refused["reasons"][0]
    assert not (tmp_path / "runs").exists()


def test_agent_rejects_unknown_operation_fields(tmp_path):
    unknown_param_field = _fixture_dict()
    unknown_param_field["uncertainty"]["parameters"][0]["bogus_field"] = 1
    param_path = _write_yaml(tmp_path / "unknown_param.yaml", unknown_param_field)
    outcome = assumptions.validate_uncertainty(param_path, allowed_roots=[tmp_path])
    assert outcome["executable"] is False
    assert any("not allowed" in error["reason"] for error in outcome["errors"])

    unknown_top_level = _fixture_dict()
    unknown_top_level["surprise"] = True
    top_path = _write_yaml(tmp_path / "unknown_top.yaml", unknown_top_level)
    outcome = assumptions.validate_uncertainty(top_path, allowed_roots=[tmp_path])
    assert outcome["status"] == "error"

    proposal = assumptions.propose_run(V2_FIXTURE, "nonsense-purpose")
    assert proposal["status"] == "refused"
    assert "unknown purpose" in proposal["reasons"][0]


def test_tokenomics_coverage_ledger_on_fixture():
    inspected = assumptions.inspect_assumptions(V2_FIXTURE)
    coverage = inspected["tokenomics_coverage"]
    assert coverage["supply"]["status"] == "fixed"
    assert "250000000" in coverage["supply"]["basis"]
    assert "TLAB" in coverage["supply"]["basis"]
    for domain in (
        "emissions",
        "vesting_unlocks",
        "incentive_source",
        "liquidity",
        "treasury",
        "governance",
        "staking",
        "fdv",
        "apy",
    ):
        assert coverage[domain]["status"] == "absent", domain
        assert coverage[domain]["basis"]


def test_inspect_v1_marks_every_input_fixed():
    inspected = assumptions.inspect_assumptions(V1_DEMO)
    assert inspected["status"] == "ok"
    assert inspected["is_stochastic"] is False
    assert inspected["schema_version"] == 1
    by_path = {entry["path"]: entry for entry in inspected["assumptions"]}
    supply = by_path["economy.supply.parameters.supply"]
    assert supply["classification"] == "fixed"
    assert supply["value"] == 250000000
    assert supply["calibration"] == "not_tracked"
    parameter_entries = [
        entry
        for entry in inspected["assumptions"]
        if entry["layer"] == "parameter"
    ]
    assert all(entry["classification"] == "fixed" for entry in parameter_entries)


def test_run_simulation_seed_contract(tmp_path):
    # Embedded scenario seed: used, shown, and persisted in the manifest.
    embedded = assumptions.run_simulation(
        V2_FIXTURE,
        run_tier="test",
        output_dir=tmp_path / "embedded",
        allowed_output_roots=[tmp_path],
    )
    assert embedded["status"] == "ok"
    assert embedded["seed"] == 20260812
    assert embedded["seed_source"] == "scenario"
    manifest = json.loads(Path(embedded["manifest_path"]).read_text(encoding="utf-8"))
    assert manifest["master_seed"] == 20260812

    # Explicit seed: overrides, shown, and persisted before any claim.
    explicit = assumptions.run_simulation(
        V2_FIXTURE,
        run_tier="test",
        seed=7,
        output_dir=tmp_path / "explicit",
        allowed_output_roots=[tmp_path],
    )
    assert explicit["status"] == "ok"
    assert explicit["seed"] == 7
    assert explicit["seed_source"] == "explicit"
    manifest = json.loads(Path(explicit["manifest_path"]).read_text(encoding="utf-8"))
    assert manifest["master_seed"] == 7

    # No embedded seed: a seed is generated, persisted, and shown.
    config = load_scenario(V2_FIXTURE)
    seedless = replace(config, monte_carlo=replace(config.monte_carlo, seed=None))
    generated = assumptions.run_simulation(
        seedless,
        run_tier="test",
        output_dir=tmp_path / "generated",
        allowed_output_roots=[tmp_path],
    )
    assert generated["status"] == "ok"
    assert generated["seed_source"] == "generated"
    assert isinstance(generated["seed"], int)
    manifest = json.loads(Path(generated["manifest_path"]).read_text(encoding="utf-8"))
    assert manifest["master_seed"] == generated["seed"]

    # The caller's config is never mutated by seed resolution.
    assert config.monte_carlo.seed == 20260812
    assert seedless.monte_carlo.seed is None

    # Invalid seeds are refused.
    for bad_seed in (-1, True, 2**32):
        refused = assumptions.run_simulation(
            V2_FIXTURE,
            run_tier="test",
            seed=bad_seed,
            output_dir=tmp_path / "bad",
            allowed_output_roots=[tmp_path],
        )
        assert refused["status"] == "refused", bad_seed


def test_run_simulation_budget_gates(tmp_path):
    base = dict(output_dir=tmp_path / "runs", allowed_output_roots=[tmp_path])
    both = assumptions.run_simulation(
        V2_FIXTURE, run_tier="test", paths=10, **base
    )
    assert both["status"] == "refused"
    neither = assumptions.run_simulation(V2_FIXTURE, **base)
    assert neither["status"] == "refused"
    too_many = assumptions.run_simulation(V2_FIXTURE, paths=10001, **base)
    assert too_many["status"] == "refused"
    zero = assumptions.run_simulation(V2_FIXTURE, paths=0, **base)
    assert zero["status"] == "refused"
    unknown = assumptions.run_simulation(V2_FIXTURE, run_tier="bogus", **base)
    assert unknown["status"] == "refused"
    assert not (tmp_path / "runs").exists()


def test_summarize_evidence_rejects_broken_bundles(tmp_path):
    run = assumptions.run_simulation(
        V2_FIXTURE,
        run_tier="test",
        output_dir=tmp_path / "runs",
        allowed_output_roots=[tmp_path],
    )
    assert run["status"] == "ok"
    bundle = Path(run["bundle_dir"])

    # Missing artifact: refused to paper over.
    (bundle / "sensitivity.json").unlink()
    broken = assumptions.summarize_evidence(bundle)
    assert broken["status"] == "error"
    assert any("missing" in reason for reason in broken["reasons"])

    # No manifest at all.
    missing = assumptions.summarize_evidence(tmp_path / "no-such-bundle")
    assert missing["status"] == "error"

    # Unsupported manifest version.
    fake = tmp_path / "fake"
    fake.mkdir()
    (fake / "manifest.json").write_text(
        json.dumps({"manifest_version": 99}), encoding="utf-8"
    )
    unsupported = assumptions.summarize_evidence(fake)
    assert unsupported["status"] == "error"
    assert "manifest_version" in unsupported["reasons"][0]


def _real_v2_bundle(tmp_path) -> Path:
    run = assumptions.run_simulation(
        V2_FIXTURE,
        run_tier="test",
        output_dir=tmp_path / "runs",
        allowed_output_roots=[tmp_path],
    )
    assert run["status"] == "ok"
    return Path(run["bundle_dir"])


def _rewrite_json(path: Path, document) -> str:
    path.write_text(
        json.dumps(document, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_summarize_evidence_refuses_manifest_path_traversal(tmp_path):
    bundle = _real_v2_bundle(tmp_path)
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # A manifest entry pointing outside the bundle must be refused, not read.
    manifest["outputs"]["results"]["path"] = "../outside.csv"
    _rewrite_json(manifest_path, manifest)
    traversal = assumptions.summarize_evidence(bundle)
    assert traversal["status"] == "error"
    assert any("escapes the bundle" in reason for reason in traversal["reasons"])

    # Absolute paths are refused the same way.
    manifest["outputs"]["results"]["path"] = str(tmp_path / "outside.csv")
    _rewrite_json(manifest_path, manifest)
    absolute = assumptions.summarize_evidence(bundle)
    assert absolute["status"] == "error"
    assert any("escapes the bundle" in reason for reason in absolute["reasons"])


def test_summarize_evidence_rehashes_every_manifest_output(tmp_path):
    bundle = _real_v2_bundle(tmp_path)

    # Tamper with one artifact without updating the manifest hash.
    sensitivity_path = bundle / "sensitivity.json"
    document = json.loads(sensitivity_path.read_text(encoding="utf-8"))
    document["min_paths"] = 1
    _rewrite_json(sensitivity_path, document)
    tampered = assumptions.summarize_evidence(bundle)
    assert tampered["status"] == "error"
    assert any("hash check" in reason for reason in tampered["reasons"])


def test_summarize_evidence_recomputes_claim_eligibility(tmp_path):
    bundle = _real_v2_bundle(tmp_path)
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # A hand-crafted bundle that lies about eligibility: every artifact stays
    # hash-consistent, one metric is doctored to not_converged (with its hash
    # updated), and the manifest still claims eligible=true.
    convergence_path = bundle / "convergence.json"
    convergence = json.loads(convergence_path.read_text(encoding="utf-8"))
    metric_id = sorted(convergence["metrics"])[0]
    convergence["metrics"][metric_id] = {
        "status": "not_converged",
        "reference_checkpoint": 100,
        "final_checkpoint": 200,
        "drift": {
            quantile: {"relative_drift": 0.5} for quantile in ("p10", "p50", "p90")
        },
    }
    manifest["outputs"]["convergence"]["sha256"] = _rewrite_json(
        convergence_path, convergence
    )
    manifest["claim_eligibility"] = {"eligible": True, "reasons": []}
    _rewrite_json(manifest_path, manifest)

    summary = assumptions.summarize_evidence(bundle)
    assert summary["status"] == "ok"
    # The summary's own eligibility is recomputed from the verified inputs...
    verified = summary["claim_eligibility"]
    assert verified["eligible"] is False
    assert any("not_converged" in reason for reason in verified["reasons"])
    # ...the manifest's claim is reported alongside, never echoed...
    assert summary["manifest_claim_eligibility"] == {
        "eligible": True,
        "reasons": [],
    }
    # ...and the disagreement is flagged.
    assert "manifest_disagreement" in verified


def test_cli_agentic_subcommands(tmp_path, capsys):
    assert cli.main(["inspect-assumptions", str(V2_FIXTURE)]) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["operation"] == "inspect_assumptions"
    assert output["status"] == "ok"

    assert cli.main(["validate-uncertainty", str(V2_FIXTURE)]) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["executable"] is True

    assert cli.main(["propose-run", str(V2_FIXTURE), "--purpose", "exploration"]) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["run_tier"] == "fast"

    assert (
        cli.main(
            [
                "run-simulation",
                str(V2_FIXTURE),
                "--run-tier",
                "test",
                "--output-dir",
                str(tmp_path / "cli-runs"),
                "--allowed-output-root",
                str(tmp_path),
            ]
        )
        == 0
    )
    run = json.loads(capsys.readouterr().out)
    assert run["status"] == "ok"
    assert run["claim"] == "monte_carlo"

    assert cli.main(["summarize-evidence", run["bundle_dir"]]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["status"] == "ok"
    assert summary["citations"]

    # Refusals exit non-zero with a parseable JSON envelope.
    draft = _fixture_dict()
    draft["uncertainty"]["parameters"][0]["approval"] = "draft"
    draft_path = _write_yaml(tmp_path / "draft.yaml", draft)
    assert (
        cli.main(
            [
                "propose-run",
                str(draft_path),
                "--purpose",
                "analysis",
                "--allowed-root",
                str(tmp_path),
            ]
        )
        == 2
    )
    refused = json.loads(capsys.readouterr().out)
    assert refused["status"] == "refused"

    # Non-allowlisted scenario path exits non-zero.
    assert cli.main(["inspect-assumptions", "/etc/hosts"]) == 2
    refused = json.loads(capsys.readouterr().out)
    assert refused["status"] == "refused"

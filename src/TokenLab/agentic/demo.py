"""One-command, public-safe TokenLab demonstration."""

# @planner:story = US-PM-AUTO-HFC7DB1681D268A66
# @planner:proves = crit:CRIT-001,crit:CRIT-002,crit:CRIT-003,crit:CRIT-004

from __future__ import annotations

import argparse
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from importlib import resources
import io
import json
from pathlib import Path
import sys
from typing import Any, Dict, Iterator, Sequence, Tuple

from .artifact_profile import ArtifactProfileError, validate_bundle
from .runner import (
    ArtifactError,
    HeadlessRunner,
    MonteCarloRunArtifacts,
    MonteCarloRunner,
    RUN_TIERS,
    RunArtifacts,
)
from .schema import load_scenario


_DATA_ROOT = resources.files("TokenLab.agentic").joinpath("data")
_SCENARIO_RESOURCE = _DATA_ROOT.joinpath("public_demo.yaml")
_PROFILE_RESOURCE = _DATA_ROOT.joinpath("public_demo_profile.json")
_V2_SCENARIO_RESOURCE = _DATA_ROOT.joinpath("public_growth_uncertainty_v2.yaml")
_V2_PROFILE_RESOURCE = _DATA_ROOT.joinpath("public_growth_uncertainty_v2_profile.json")
_DEMAND_V2_SCENARIO_RESOURCE = _DATA_ROOT.joinpath("public_demand_history_v2.yaml")
_DEMAND_V2_PROFILE_RESOURCE = _DATA_ROOT.joinpath(
    "public_demand_history_v2_profile.json"
)
_VESTING_CONCENTRATED_V2_SCENARIO_RESOURCE = _DATA_ROOT.joinpath(
    "public_vesting_concentrated_v2.yaml"
)
_VESTING_CONCENTRATED_V2_PROFILE_RESOURCE = _DATA_ROOT.joinpath(
    "public_vesting_concentrated_v2_profile.json"
)
_VESTING_SMOOTHED_V2_SCENARIO_RESOURCE = _DATA_ROOT.joinpath(
    "public_vesting_smoothed_v2.yaml"
)
_VESTING_SMOOTHED_V2_PROFILE_RESOURCE = _DATA_ROOT.joinpath(
    "public_vesting_smoothed_v2_profile.json"
)
_STAKING_V3_SCENARIO_RESOURCE = _DATA_ROOT.joinpath(
    "public_staking_rewards_v3.yaml"
)
_STAKING_V3_PROFILE_RESOURCE = _DATA_ROOT.joinpath(
    "public_staking_rewards_v3_profile.json"
)
_MULTITOKEN_V3_SCENARIO_RESOURCE = _DATA_ROOT.joinpath(
    "public_multitoken_dependency_v3.yaml"
)
_MULTITOKEN_V3_PROFILE_RESOURCE = _DATA_ROOT.joinpath(
    "public_multitoken_dependency_v3_profile.json"
)

DEMO_SCENARIO_V1 = "public-growth-path-v1"
DEMO_SCENARIO_V2 = "public-growth-uncertainty-v2"
DEMO_SCENARIO_DEMAND_V2 = "public-demand-history-v2"
DEMO_SCENARIO_VESTING_CONCENTRATED_V2 = "public-vesting-concentrated-v2"
DEMO_SCENARIO_VESTING_SMOOTHED_V2 = "public-vesting-smoothed-v2"
DEMO_SCENARIO_STAKING_V3 = "public-staking-rewards-v3"
DEMO_SCENARIO_MULTITOKEN_V3 = "public-multitoken-dependency-v3"
DEMO_SCENARIOS = (
    DEMO_SCENARIO_V1,
    DEMO_SCENARIO_V2,
    DEMO_SCENARIO_DEMAND_V2,
    DEMO_SCENARIO_VESTING_CONCENTRATED_V2,
    DEMO_SCENARIO_VESTING_SMOOTHED_V2,
    DEMO_SCENARIO_STAKING_V3,
    DEMO_SCENARIO_MULTITOKEN_V3,
)
_V2_RESOURCES = {
    DEMO_SCENARIO_V2: (_V2_SCENARIO_RESOURCE, _V2_PROFILE_RESOURCE),
    DEMO_SCENARIO_DEMAND_V2: (
        _DEMAND_V2_SCENARIO_RESOURCE,
        _DEMAND_V2_PROFILE_RESOURCE,
    ),
    DEMO_SCENARIO_VESTING_CONCENTRATED_V2: (
        _VESTING_CONCENTRATED_V2_SCENARIO_RESOURCE,
        _VESTING_CONCENTRATED_V2_PROFILE_RESOURCE,
    ),
    DEMO_SCENARIO_VESTING_SMOOTHED_V2: (
        _VESTING_SMOOTHED_V2_SCENARIO_RESOURCE,
        _VESTING_SMOOTHED_V2_PROFILE_RESOURCE,
    ),
    DEMO_SCENARIO_STAKING_V3: (
        _STAKING_V3_SCENARIO_RESOURCE,
        _STAKING_V3_PROFILE_RESOURCE,
    ),
    DEMO_SCENARIO_MULTITOKEN_V3: (
        _MULTITOKEN_V3_SCENARIO_RESOURCE,
        _MULTITOKEN_V3_PROFILE_RESOURCE,
    ),
}


def load_public_profile() -> Dict[str, Any]:
    """Load the immutable public demo metric contract from package data."""

    return json.loads(_PROFILE_RESOURCE.read_text(encoding="utf-8"))


@contextmanager
def public_scenario_path() -> Iterator[Path]:
    """Expose the package scenario as a filesystem path for the safe loader."""

    with resources.as_file(_SCENARIO_RESOURCE) as path:
        yield path


def run_public_demo(
    output_dir: str | Path = "outputs/demo",
    *,
    run_id: str | None = None,
    diagnostic_preamble: str | None = None,
) -> Tuple[RunArtifacts, Dict[str, Any]]:
    """Run and validate the reviewed public scenario."""

    profile = load_public_profile()
    with public_scenario_path() as scenario:
        artifacts = HeadlessRunner().run(
            scenario,
            output_dir,
            run_id=run_id,
            capture_diagnostics=True,
            artifact_profile=profile,
            diagnostic_preamble=diagnostic_preamble,
        )
    return artifacts, validate_bundle(artifacts.bundle_dir)


def load_public_v2_profile() -> Dict[str, Any]:
    """Load the immutable stochastic-demo metric contract from package data."""

    return json.loads(_V2_PROFILE_RESOURCE.read_text(encoding="utf-8"))


@contextmanager
def public_v2_scenario_path() -> Iterator[Path]:
    """Expose the packaged v2 scenario as a filesystem path."""

    with resources.as_file(_V2_SCENARIO_RESOURCE) as path:
        yield path


def run_public_demo_v2(
    output_dir: str | Path = "outputs/demo",
    *,
    run_id: str | None = None,
    run_tier: str = "fast",
    capture_stream: Any = None,
    scenario: str = DEMO_SCENARIO_V2,
) -> MonteCarloRunArtifacts:
    """Run a packaged stochastic demo through the real MonteCarloRunner.

    ``scenario`` selects one of the packaged stochastic demo ids (the growth
    flagship, the demand-history archetype, the two vesting/unlock
    archetypes, or the two schema v3 staking/multi-token archetypes).
    ``capture_stream`` optionally receives the numerical
    stack's per-path console output so presentation surfaces stay bounded.
    """

    try:
        scenario_resource, profile_resource = _V2_RESOURCES[scenario]
    except KeyError:
        raise ArtifactError(f"unknown stochastic demo scenario {scenario!r}") from None
    profile = json.loads(profile_resource.read_text(encoding="utf-8"))
    with resources.as_file(scenario_resource) as scenario_path:
        config = load_scenario(scenario_path)
    if capture_stream is None:
        return MonteCarloRunner().run(
            config,
            output_dir,
            run_id=run_id,
            run_tier=run_tier,
            artifact_profile=profile,
        )
    with redirect_stdout(capture_stream), redirect_stderr(capture_stream):
        return MonteCarloRunner().run(
            config,
            output_dir,
            run_id=run_id,
            run_tier=run_tier,
            artifact_profile=profile,
        )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run TokenLab's reviewed illustrative public scenario."
    )
    parser.add_argument(
        "scenario",
        nargs="?",
        default=DEMO_SCENARIO_V1,
        choices=DEMO_SCENARIOS,
        help=(
            "Packaged demo id: public-growth-path-v1 (deterministic control, "
            "default), public-growth-uncertainty-v2 (stochastic Monte Carlo), "
            "public-demand-history-v2 (stochastic demand-history archetype), "
            "public-vesting-concentrated-v2 / public-vesting-smoothed-v2 "
            "(stochastic vesting/unlock archetypes), or "
            "public-staking-rewards-v3 / public-multitoken-dependency-v3 "
            "(stochastic schema v3 staking/multi-token archetypes)"
        ),
    )
    parser.add_argument(
        "--output-dir",
        default="outputs/demo",
        help="Directory that will contain the non-overwriting demo bundle",
    )
    parser.add_argument("--run-id", help="Optional safe, unique bundle name")
    parser.add_argument(
        "--run-tier",
        choices=sorted(RUN_TIERS),
        default="fast",
        help=(
            "Monte Carlo run tier for the stochastic demos "
            "(default: fast = 100 paths); ignored for the v1 control"
        ),
    )
    return parser


def _main_v2(args: argparse.Namespace) -> int:
    capture = io.StringIO()
    try:
        artifacts = run_public_demo_v2(
            args.output_dir,
            run_id=args.run_id,
            run_tier=args.run_tier,
            capture_stream=capture,
            scenario=args.scenario,
        )
    except (ArtifactError, ArtifactProfileError, OSError, json.JSONDecodeError) as exc:
        print(f"TokenLab public demo: FAIL — {exc}", file=sys.stderr)
        return 1

    manifest = artifacts.manifest
    result_hash = manifest["outputs"]["results"][
        "reproducible_content_sha256"
    ][:12]
    claim = manifest["claim_eligibility"]
    eligibility = "eligible" if claim["eligible"] else "ineligible"
    print("TokenLab public demo: PASS")
    print(
        f"Scenario: {manifest['scenario_id']} | seed {manifest['seed']} | "
        f"{manifest['monte_carlo']['iterations']} steps x "
        f"{manifest['requested_paths']} Monte Carlo paths (tier "
        f"{manifest['run_tier']})"
    )
    print(
        f"Paths: {manifest['requested_paths']} requested / "
        f"{manifest['completed_paths']} completed / "
        f"{manifest['failed_paths']} failed | claim eligibility: {eligibility}"
    )
    print(f"Bundle: {artifacts.bundle_dir}")
    print(
        f"Evidence: {len(manifest['outputs'])} artifacts | content {result_hash}"
    )
    print(
        "Boundary: illustrative Monte Carlo over uncalibrated priors; modeled "
        "outcome intervals are not confidence intervals; not investment, "
        "launch, legal, financial, forecast, or decision-grade advice."
    )
    return 0


def main(
    argv: Sequence[str] | None = None,
    *,
    diagnostic_preamble: str | None = None,
) -> int:
    args = _parser().parse_args(argv)
    if args.scenario in _V2_RESOURCES:
        return _main_v2(args)
    try:
        artifacts, validation = run_public_demo(
            args.output_dir,
            run_id=args.run_id,
            diagnostic_preamble=diagnostic_preamble,
        )
    except (ArtifactError, ArtifactProfileError, OSError, json.JSONDecodeError) as exc:
        print(f"TokenLab public demo: FAIL — {exc}", file=sys.stderr)
        return 1

    manifest = artifacts.manifest
    result_hash = manifest["outputs"]["results"][
        "reproducible_content_sha256"
    ][:12]
    print("TokenLab public demo: PASS")
    print(
        f"Scenario: {manifest['scenario_id']} | seed {manifest['seed']} | "
        f"{manifest['monte_carlo']['iterations']} steps x "
        f"{manifest['monte_carlo']['repetitions']} deterministic paths"
    )
    print(f"Bundle: {artifacts.bundle_dir}")
    print(
        f"Evidence: {len(manifest['outputs'])} tables + "
        f"{len(manifest['attachments'])} attachments | content {result_hash}"
    )
    print(
        f"Profile: {validation['profile_id']} | "
        f"{validation['metric_count']} declared metrics"
    )
    print(
        "Boundary: illustrative simulation only; not investment, launch, legal, "
        "financial, forecast, or decision-grade advice."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

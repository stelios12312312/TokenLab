"""One-command, public-safe TokenLab demonstration."""

# @planner:story = US-PM-AUTO-HFC7DB1681D268A66
# @planner:proves = crit:CRIT-001,crit:CRIT-002,crit:CRIT-003,crit:CRIT-004

from __future__ import annotations

import argparse
from contextlib import contextmanager
from importlib import resources
import json
from pathlib import Path
import sys
from typing import Any, Dict, Iterator, Sequence, Tuple

from .artifact_profile import ArtifactProfileError, validate_bundle
from .runner import ArtifactError, HeadlessRunner, RunArtifacts


_DATA_ROOT = resources.files("TokenLab.agentic").joinpath("data")
_SCENARIO_RESOURCE = _DATA_ROOT.joinpath("public_demo.yaml")
_PROFILE_RESOURCE = _DATA_ROOT.joinpath("public_demo_profile.json")


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


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run TokenLab's reviewed illustrative public scenario."
    )
    parser.add_argument(
        "--output-dir",
        default="outputs/demo",
        help="Directory that will contain the non-overwriting demo bundle",
    )
    parser.add_argument("--run-id", help="Optional safe, unique bundle name")
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    diagnostic_preamble: str | None = None,
) -> int:
    args = _parser().parse_args(argv)
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

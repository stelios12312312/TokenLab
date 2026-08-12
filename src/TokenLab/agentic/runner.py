"""Headless scenario execution and atomic artifact-bundle publication."""

# @planner:story = US-PM-AUTO-H2A2D347E9E110A84
# @planner:proves = crit:CRIT-003,crit:CRIT-004,crit:CRIT-006

from __future__ import annotations

import argparse
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import random
import re
import shutil
import tempfile
from typing import Any, Dict, Iterator, Mapping, Sequence, Union
import uuid

import numpy as np
import pandas as pd
import scipy.stats

from .artifact_profile import (
    file_sha256,
    reproducible_table_hash,
    validate_artifact_profile,
)
from .factory import ScenarioFactory
from .schema import ScenarioConfig, load_scenario


_SAFE_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_LINEAGE_COLUMNS = ["run_id", "scenario_id", "config_hash", "seed"]


class ArtifactError(RuntimeError):
    """Raised when execution or bundle publication cannot complete safely."""


@dataclass(frozen=True)
class RunArtifacts:
    bundle_dir: Path
    manifest_path: Path
    manifest: Dict[str, Any]
    raw_data: pd.DataFrame
    summary_data: pd.DataFrame


@contextmanager
def _seeded_runtime(seed: int) -> Iterator[None]:
    python_state = random.getstate()
    numpy_state = np.random.get_state()
    scipy_owner = scipy.stats.rv_continuous
    had_scipy_state = hasattr(scipy_owner, "random_state")
    scipy_state = getattr(scipy_owner, "random_state", None)
    random.seed(seed)
    np.random.seed(seed)
    try:
        yield
    finally:
        random.setstate(python_state)
        np.random.set_state(numpy_state)
        if had_scipy_state:
            scipy_owner.random_state = scipy_state
        elif hasattr(scipy_owner, "random_state"):
            delattr(scipy_owner, "random_state")


class HeadlessRunner:
    """Execute one scenario and publish one complete, non-overwriting bundle."""

    def __init__(self, factory: ScenarioFactory | None = None) -> None:
        self.factory = factory or ScenarioFactory()

    @staticmethod
    def _run_id(config: ScenarioConfig, requested: str | None) -> str:
        if requested is None:
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            requested = f"{config.scenario_id}-{timestamp}-{uuid.uuid4().hex[:8]}"
        if not _SAFE_RUN_ID.fullmatch(requested):
            raise ArtifactError(
                "run_id must be 1-128 safe characters: letters, digits, '.', '_', or '-'"
            )
        return requested

    @staticmethod
    def _with_lineage(
        data: pd.DataFrame,
        *,
        run_id: str,
        config: ScenarioConfig,
    ) -> pd.DataFrame:
        result = data.copy()
        values = {
            "run_id": run_id,
            "scenario_id": config.scenario_id,
            "config_hash": config.config_hash,
            "seed": config.monte_carlo.seed,
        }
        for column in _LINEAGE_COLUMNS:
            result[column] = values[column]
        return result

    @staticmethod
    def _summary(data: pd.DataFrame) -> pd.DataFrame:
        if "iteration_time" not in data.columns:
            raise ArtifactError(
                "TokenMetaSimulator output is missing required iteration_time"
            )
        numeric = [
            column
            for column in data.select_dtypes(include=[np.number]).columns
            if column not in {"iteration_time", "repetition_run"}
        ]
        if not numeric:
            return data.loc[:, ["iteration_time"]].drop_duplicates().reset_index(drop=True)
        summary = data.groupby("iteration_time", sort=True)[numeric].agg(
            ["mean", "std", "min", "max"]
        )
        summary.columns = [
            f"{column}_{statistic}" for column, statistic in summary.columns
        ]
        return summary.reset_index()

    def _write_table(
        self, data: pd.DataFrame, path: Path, file_format: str
    ) -> None:
        if file_format == "csv":
            data.to_csv(path, index=False)
            return
        try:
            data.to_parquet(path, index=False)
        except ImportError as exc:
            raise ArtifactError(
                "Parquet output requires TokenLab's reporting extra; use CSV or install pyarrow"
            ) from exc

    def run(
        self,
        scenario: Union[str, Path, ScenarioConfig],
        output_dir: Union[str, Path] = "outputs/agentic",
        *,
        run_id: str | None = None,
        capture_diagnostics: bool = False,
        artifact_profile: Mapping[str, Any] | None = None,
        diagnostic_preamble: str | None = None,
    ) -> RunArtifacts:
        config = scenario if isinstance(scenario, ScenarioConfig) else load_scenario(scenario)
        resolved_run_id = self._run_id(config, run_id)
        output_root = Path(output_dir)
        output_root.mkdir(parents=True, exist_ok=True)
        bundle_dir = output_root / resolved_run_id
        if bundle_dir.exists():
            raise ArtifactError(f"run bundle already exists: {bundle_dir}")
        if diagnostic_preamble and not capture_diagnostics:
            raise ArtifactError(
                "diagnostic_preamble requires capture_diagnostics=True"
            )

        temporary_path: Path | None = None
        try:
            temporary_path = Path(
                tempfile.mkdtemp(prefix=f".{resolved_run_id}.", dir=output_root)
            )
            def execute_scenario() -> pd.DataFrame:
                with _seeded_runtime(config.monte_carlo.seed):
                    built = self.factory.build(config)
                    return built.simulator.execute(
                        iterations=config.monte_carlo.iterations,
                        repetitions=config.monte_carlo.repetitions,
                    )

            diagnostic_path: Path | None = None
            if capture_diagnostics:
                diagnostic_path = temporary_path / "diagnostics.log"
                with diagnostic_path.open("w", encoding="utf-8") as stream:
                    if diagnostic_preamble:
                        stream.write("[bootstrap diagnostics]\n")
                        stream.write(diagnostic_preamble.rstrip() + "\n")
                    stream.write("[simulation diagnostics]\n")
                    with redirect_stdout(stream), redirect_stderr(stream):
                        raw_result = execute_scenario()
            else:
                raw_result = execute_scenario()
            if not isinstance(raw_result, pd.DataFrame) or raw_result.empty:
                raise ArtifactError("simulation produced no output rows")

            summary_result = self._summary(raw_result)
            raw_data = self._with_lineage(
                raw_result, run_id=resolved_run_id, config=config
            )
            summary_data = self._with_lineage(
                summary_result, run_id=resolved_run_id, config=config
            )

            extension = "csv" if config.artifacts.format == "csv" else "parquet"
            tables = {
                "results": (raw_data, temporary_path / f"results.{extension}"),
                "iteration_summary": (
                    summary_data,
                    temporary_path / f"iteration_summary.{extension}",
                ),
            }
            output_metadata: Dict[str, Any] = {}
            for name, (table, path) in tables.items():
                self._write_table(table, path, config.artifacts.format)
                persisted_table = (
                    pd.read_csv(path)
                    if config.artifacts.format == "csv"
                    else pd.read_parquet(path)
                )
                output_metadata[name] = {
                    "path": path.name,
                    "format": config.artifacts.format,
                    "rows": int(len(table)),
                    "columns": list(table.columns),
                    "sha256": file_sha256(path),
                    "reproducible_content_sha256": reproducible_table_hash(
                        persisted_table
                    ),
                    "reproducibility_excludes": ["run_id"],
                }

            attachments: Dict[str, Any] = {}
            if diagnostic_path is not None:
                attachments["diagnostics"] = {
                    "path": diagnostic_path.name,
                    "media_type": "text/plain; charset=utf-8",
                    "bytes": diagnostic_path.stat().st_size,
                    "sha256": file_sha256(diagnostic_path),
                }
            if artifact_profile is not None:
                validated_profile = validate_artifact_profile(
                    artifact_profile,
                    {name: table for name, (table, _) in tables.items()},
                    scenario_id=config.scenario_id,
                )
                profile_path = temporary_path / "artifact_profile.json"
                profile_path.write_text(
                    json.dumps(validated_profile, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
                attachments["artifact_profile"] = {
                    "path": profile_path.name,
                    "media_type": "application/json",
                    "bytes": profile_path.stat().st_size,
                    "sha256": file_sha256(profile_path),
                    "profile_version": validated_profile["profile_version"],
                    "profile_id": validated_profile["profile_id"],
                }

            manifest = {
                "manifest_version": 1,
                "run_id": resolved_run_id,
                "scenario_id": config.scenario_id,
                "config_hash": config.config_hash,
                "seed": config.monte_carlo.seed,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "monte_carlo": {
                    "iterations": config.monte_carlo.iterations,
                    "repetitions": config.monte_carlo.repetitions,
                    "simulator": config.monte_carlo.simulator,
                },
                "outputs": output_metadata,
            }
            if attachments:
                manifest["attachments"] = attachments
            manifest_path = temporary_path / "manifest.json"
            manifest_path.write_text(
                json.dumps(manifest, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            temporary_path.rename(bundle_dir)
            temporary_path = None
            return RunArtifacts(
                bundle_dir=bundle_dir,
                manifest_path=bundle_dir / "manifest.json",
                manifest=manifest,
                raw_data=raw_data,
                summary_data=summary_data,
            )
        except ArtifactError:
            raise
        except Exception as exc:
            raise ArtifactError(f"scenario run failed: {exc}") from exc
        finally:
            if temporary_path is not None and temporary_path.exists():
                shutil.rmtree(temporary_path)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run an existing-class TokenLab simulation from YAML or JSON."
    )
    parser.add_argument("scenario", help="Path to a .yaml, .yml, or .json scenario")
    parser.add_argument(
        "--output-dir",
        default="outputs/agentic",
        help="Directory that will contain the run bundle",
    )
    parser.add_argument("--run-id", help="Safe, unique bundle name")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    artifacts = HeadlessRunner().run(
        args.scenario, args.output_dir, run_id=args.run_id
    )
    print(artifacts.bundle_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

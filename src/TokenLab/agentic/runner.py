"""Headless scenario execution and atomic artifact-bundle publication."""

# @planner:story = US-PM-AUTO-H2A2D347E9E110A84
# @planner:proves = crit:CRIT-003,crit:CRIT-004,crit:CRIT-006

from __future__ import annotations

import argparse
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import random
import re
import shutil
import sys
import tempfile
from typing import Any, Dict, Iterator, List, Mapping, Sequence, Union
import uuid

import numpy as np
import pandas as pd
import scipy.stats

from .artifact_profile import (
    file_sha256,
    reproducible_json_hash,
    reproducible_table_hash,
    validate_artifact_profile,
)
from .factory import ScenarioFactory
from .rng import RNG_ALGORITHM, SAMPLER_VERSION, derive_generator, seed_lineage
from .schema import ScenarioConfig, load_scenario, scenario_from_dict
from .statistics import (
    NON_CAUSAL_INTERPRETATION,
    OUTCOME_INTERVAL_LABEL,
    bootstrap_ci,
    convergence_checkpoints,
    quantile_summary,
    spearman_sensitivity,
    validate_interval_labels,
    wilson_interval,
)
from .uncertainty import UncertaintyError, sample_parameters, validate_v2_scenario


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


# ---------------------------------------------------------------------------
# Monte Carlo runner (schema v2). The v1 HeadlessRunner above is untouched;
# everything below this line is the additive v2 path.
# ---------------------------------------------------------------------------

# Frozen run tiers: (paths, bootstrap resamples). The requested path count is
# never silently reduced; explicit paths bypass tiers within [1, 10000].
RUN_TIERS: Dict[str, Dict[str, int]] = {
    "test": {"paths": 32, "bootstrap_resamples": 200},
    "fast": {"paths": 100, "bootstrap_resamples": 500},
    "standard": {"paths": 500, "bootstrap_resamples": 2000},
    "deep": {"paths": 2000, "bootstrap_resamples": 5000},
}
MAX_EXPLICIT_PATHS = 10000
# Explicit-path runs (no tier) default to the test tier's bootstrap budget and
# may override it within [1, MAX_EXPLICIT_BOOTSTRAP].
DEFAULT_EXPLICIT_BOOTSTRAP = RUN_TIERS["test"]["bootstrap_resamples"]
MAX_EXPLICIT_BOOTSTRAP = RUN_TIERS["deep"]["bootstrap_resamples"]

# Frozen convergence contract: nested checkpoints and predeclared tolerances.
CONVERGENCE_CHECKPOINTS = (100, 250, 500, 1000, 2000)
DEFAULT_RELATIVE_DRIFT = 0.05
DEFAULT_ABSOLUTE_TOLERANCE = 1e-9
SENSITIVITY_MIN_PATHS = 100

V2_LINEAGE_COLUMNS = ["run_id", "scenario_id", "config_hash", "seed", "path_index"]
_NON_OUTPUT_COLUMNS = {"iteration_time", "repetition_run", "path_index", "seed"}
_PATH_SEGMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)(?:\[([0-9]+)\])?$")

INTERVAL_DEFINITIONS = (
    "modeled outcome interval: P10–P90 cross-path modeled outcomes; "
    "confidence interval: 95% percentile-bootstrap on the named estimator"
)

# Tiers whose published numbers may support headline claims; they require
# evaluated convergence diagnostics (insufficient_checkpoints blocks them).
CLAIM_TIERS = frozenset({"standard", "deep"})

CLAIM_ELIGIBILITY_NOTE = (
    "eligible means every requested path completed with zero failures, no "
    "terminal metric reported not_converged, and — for the standard/deep "
    "claim tiers — convergence checkpoints were sufficient to evaluate "
    "drift. test/fast tiers and small explicit budgets may be eligible with "
    "entries under 'limitations'; they support smoke/illustrative claims "
    "only and must never be read as standard/deep-grade evidence."
)


def evaluate_claim_eligibility(
    *,
    executable: bool,
    requested: int,
    completed: int,
    failed: int,
    run_tier: str,
    convergence_statuses: Mapping[str, str],
) -> Dict[str, Any]:
    """Single source of truth for the claim_eligibility manifest field.

    ``convergence_statuses`` maps terminal-metric id to its convergence
    status (``converged`` / ``not_converged`` / ``insufficient_checkpoints``).
    Any ``not_converged`` headline metric blocks eligibility for every tier;
    ``insufficient_checkpoints`` blocks the standard/deep claim tiers and is
    a standing limitation note everywhere else.
    """
    reasons: List[str] = []
    limitations: List[str] = []
    if not executable:
        reasons.append("uncertainty validation is not executable")
    if completed != requested:
        reasons.append(f"completed paths {completed} < requested {requested}")
    if failed:
        reasons.append(f"{failed} path failure(s) recorded")
    not_converged = sorted(
        metric_id
        for metric_id, status in convergence_statuses.items()
        if status == "not_converged"
    )
    if not_converged:
        reasons.append(
            "terminal metric(s) not_converged: " + ", ".join(not_converged)
        )
    insufficient = sorted(
        metric_id
        for metric_id, status in convergence_statuses.items()
        if status == "insufficient_checkpoints"
    )
    if insufficient:
        if run_tier in CLAIM_TIERS:
            reasons.append(
                f"tier {run_tier!r} requires evaluated convergence diagnostics; "
                "insufficient_checkpoints for: " + ", ".join(insufficient)
            )
        else:
            limitations.append(
                "convergence not evaluated (insufficient_checkpoints) for: "
                + ", ".join(insufficient)
                + f"; tier {run_tier!r} evidence is smoke/illustrative only"
            )
    return {
        "eligible": not reasons,
        "reasons": reasons,
        "limitations": limitations,
        "note": CLAIM_ELIGIBILITY_NOTE,
    }


class MonteCarloError(ArtifactError):
    """Raised when a v2 Monte Carlo run cannot be planned or completed."""


class MonteCarloRunCancelled(ArtifactError):
    """Raised when a caller-supplied cancel event stops a v2 run mid-loop.

    Carries the truthful counts at the moment of cancellation; no bundle is
    ever published for a cancelled run.
    """

    def __init__(self, requested: int, completed: int, failed: int) -> None:
        super().__init__(
            f"monte carlo run cancelled: {completed} completed, {failed} failed "
            f"of {requested} requested paths; no bundle published"
        )
        self.requested = requested
        self.completed = completed
        self.failed = failed


@dataclass(frozen=True)
class MonteCarloRunArtifacts:
    bundle_dir: Path
    manifest_path: Path
    manifest: Dict[str, Any]
    results: pd.DataFrame
    parameter_samples: pd.DataFrame
    iteration_summary: pd.DataFrame
    terminal_summary: Dict[str, Any]
    sensitivity: Dict[str, Any]
    convergence: Dict[str, Any]
    path_failures: Dict[str, Any]


def _package_version() -> str:
    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            return version("TokenLab")
        except PackageNotFoundError:
            return "0.2.0"
    except Exception:
        return "0.2.0"


def _assign_path(tree: Any, path: str, value: Any) -> None:
    """Assign ``value`` at an ``economy.a.b[0].c`` path inside a config dict."""
    segments = path.split(".")
    node = tree
    for segment in segments[:-1]:
        match = _PATH_SEGMENT.match(segment)
        if match is None:
            raise MonteCarloError(f"cannot substitute at malformed path {path!r}")
        node = node[match.group(1)]
        if match.group(2) is not None:
            node = node[int(match.group(2))]
    last = _PATH_SEGMENT.match(segments[-1])
    if last is None:
        raise MonteCarloError(f"cannot substitute at malformed path {path!r}")
    if last.group(2) is not None:
        node[last.group(1)][int(last.group(2))] = value
    else:
        node[last.group(1)] = value


def _sanitize_message(exc: BaseException) -> str:
    """Exception type plus a short single-line message; no traceback state."""
    return " ".join(str(exc).split())[:200]


class MonteCarloRunner:
    """Execute a schema v2 scenario as seeded Monte Carlo paths.

    Each path re-samples approved uncertainty parameters, rebuilds the whole
    scenario object graph from a deep-copied config, and receives fresh
    per-context generators derived from ``(master_seed, namespace, path)`` —
    no state leaks across paths and path prefixes are budget-independent.
    """

    def __init__(self, factory: ScenarioFactory | None = None) -> None:
        self.factory = factory or ScenarioFactory()

    @staticmethod
    def _resolve_run_plan(
        run_tier: str | None,
        paths: int | None,
        bootstrap_resamples: int | None,
    ) -> Dict[str, Any]:
        if (run_tier is None) == (paths is None):
            raise MonteCarloError(
                "exactly one of run_tier or paths must be given; "
                "they are mutually exclusive"
            )
        if run_tier is not None:
            if run_tier not in RUN_TIERS:
                raise MonteCarloError(
                    f"unknown run_tier {run_tier!r}; allowed: {sorted(RUN_TIERS)}"
                )
            tier = RUN_TIERS[run_tier]
            budget = tier["bootstrap_resamples"]
            if bootstrap_resamples is None:
                resolved_bootstrap = budget
            elif (
                isinstance(bootstrap_resamples, bool)
                or not isinstance(bootstrap_resamples, int)
                or not 1 <= bootstrap_resamples <= budget
            ):
                raise MonteCarloError(
                    f"bootstrap_resamples override for tier {run_tier!r} must be "
                    f"an integer in [1, {budget}]"
                )
            else:
                resolved_bootstrap = bootstrap_resamples
            return {
                "run_tier": run_tier,
                "paths": tier["paths"],
                "bootstrap_resamples": resolved_bootstrap,
            }
        if (
            isinstance(paths, bool)
            or not isinstance(paths, int)
            or not 1 <= paths <= MAX_EXPLICIT_PATHS
        ):
            raise MonteCarloError(
                f"explicit paths must be an integer in [1, {MAX_EXPLICIT_PATHS}]; "
                "the requested count is never silently reduced"
            )
        if bootstrap_resamples is None:
            resolved_bootstrap = DEFAULT_EXPLICIT_BOOTSTRAP
        elif (
            isinstance(bootstrap_resamples, bool)
            or not isinstance(bootstrap_resamples, int)
            or not 1 <= bootstrap_resamples <= MAX_EXPLICIT_BOOTSTRAP
        ):
            raise MonteCarloError(
                "bootstrap_resamples override for explicit paths must be an "
                f"integer in [1, {MAX_EXPLICIT_BOOTSTRAP}]"
            )
        else:
            resolved_bootstrap = bootstrap_resamples
        return {
            "run_tier": "explicit",
            "paths": paths,
            "bootstrap_resamples": resolved_bootstrap,
        }

    @staticmethod
    def _build_contexts(config: ScenarioConfig) -> List[str]:
        """Every stochastic-capable build context of this scenario."""
        return [
            context
            for context, _, _ in ScenarioFactory._context_components(config)
        ]

    def _path_config(self, config: ScenarioConfig, sample_set: Any) -> ScenarioConfig:
        """A fresh uncertainty-free config with this path's values applied.

        v2 documents degrade to schema v1 (v2 is v1 plus uncertainty); v3
        documents keep version 3 because v1 cannot express the v3 blocks —
        the v3 parser accepts documents without an uncertainty block.
        """
        data = config.to_dict()
        data["schema_version"] = 1 if config.schema_version == 2 else 3
        data.pop("uncertainty", None)
        data["monte_carlo"]["repetitions"] = 1
        for sample in sample_set:
            _assign_path(data, sample.path, sample.value)
        return scenario_from_dict(data)

    _SAMPLE_COLUMNS = [
        "path_index",
        "id",
        "path",
        "value",
        "family",
        "layer",
        "cadence",
        "calibration",
        "approval",
        "dependence",
        "provenance",
        "sampled",
        "lineage_master_seed",
        "lineage_namespace",
        "lineage_namespace_sha256",
        "lineage_spawn_key",
        "lineage_rng_algorithm",
        "lineage_sampler_version",
    ]

    def _sample_rows(self, sample_set: Any) -> List[Dict[str, Any]]:
        rows = []
        for sample in sample_set:
            row = {
                "path_index": sample_set.path_index,
                "id": sample.id,
                "path": sample.path,
                "value": sample.value,
                "family": sample.family,
                "layer": sample.layer,
                "cadence": sample.cadence,
                "calibration": sample.calibration,
                "approval": sample.approval,
                "dependence": sample.dependence,
                "provenance": sample.provenance,
                "sampled": sample.sampled,
            }
            lineage = sample.lineage or {}
            for key in (
                "master_seed",
                "namespace",
                "namespace_sha256",
                "spawn_key",
                "rng_algorithm",
                "sampler_version",
            ):
                row[f"lineage_{key}"] = lineage.get(key)
            rows.append(row)
        return rows

    def _execute_all(
        self,
        config: ScenarioConfig,
        validation: Any,
        master_seed: int,
        requested: int,
        progress_callback: Any = None,
        cancel_event: Any = None,
    ) -> tuple:
        """Run paths sequentially in path-index order; failures are recorded.

        Parameter samples are recorded before build/execute, so a failed
        path still publishes its sampled values and its failure record.

        ``progress_callback`` (optional) is invoked after every settled path
        with keyword arguments ``requested``, ``completed`` and ``failed``.
        ``cancel_event`` (optional ``threading.Event``-like) stops the loop
        before the next path by raising :class:`MonteCarloRunCancelled`;
        cancellation publishes nothing and keeps exact counts.
        """
        frames: List[pd.DataFrame] = []
        sample_rows: List[Dict[str, Any]] = []
        failures: List[Dict[str, Any]] = []
        for path_index in range(requested):
            if cancel_event is not None and cancel_event.is_set():
                raise MonteCarloRunCancelled(
                    requested, path_index - len(failures), len(failures)
                )
            stage = "sample"
            try:
                sample_set = sample_parameters(validation, master_seed, path_index)
                sample_rows.extend(self._sample_rows(sample_set))
                stage = "build"
                path_config = self._path_config(config, sample_set)
                rng_plan = {
                    context: derive_generator(
                        master_seed, f"components:{context}", path_index
                    )
                    # Only contexts whose component accepts ``rng`` are
                    # planned; naming a non-rng context would now raise in
                    # the factory instead of being silently skipped.
                    for context in self.factory.rng_capable_contexts(path_config)
                }
                built = self.factory.build(path_config, rng_plan=rng_plan)
                stage = "execute"
                data = built.simulator.execute(
                    iterations=config.monte_carlo.iterations, repetitions=1
                )
                if not isinstance(data, pd.DataFrame) or data.empty:
                    raise MonteCarloError("simulation produced no output rows")
                frame = data.copy()
                frame["path_index"] = path_index
                frames.append(frame)
            except Exception as exc:
                failures.append(
                    {
                        "path_index": path_index,
                        "stage": stage,
                        "error_class": type(exc).__name__,
                        "message": _sanitize_message(exc),
                        "seed_lineage": {
                            "master_seed": master_seed,
                            "path_index": path_index,
                            "sampler_version": SAMPLER_VERSION,
                            "rng_algorithm": RNG_ALGORITHM,
                        },
                    }
                )
            if progress_callback is not None:
                try:
                    progress_callback(
                        requested=requested,
                        completed=path_index + 1 - len(failures),
                        failed=len(failures),
                    )
                except Exception:
                    # Progress reporting must never corrupt a scientific run.
                    pass
        results = (
            pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        )
        return (
            results,
            pd.DataFrame(sample_rows, columns=self._SAMPLE_COLUMNS),
            failures,
        )

    @staticmethod
    def _numeric_output_columns(frame: pd.DataFrame) -> List[str]:
        return [
            column
            for column in frame.select_dtypes(include=[np.number]).columns
            if column not in _NON_OUTPUT_COLUMNS
        ]

    def _iteration_summary(
        self, results: pd.DataFrame, numeric_columns: Sequence[str]
    ) -> pd.DataFrame:
        """Per-step cross-path quantile summary.

        Every ``<column>_n`` field is that column's non-null path count at
        that step — the honest per-column denominator. Columns with ragged
        (partially missing) data publish a smaller ``n`` instead of silently
        borrowing the completed-path count.
        """
        rows = []
        for iteration_time, group in results.groupby("iteration_time", sort=True):
            row: Dict[str, Any] = {"iteration_time": iteration_time}
            for column in numeric_columns:
                summary = quantile_summary(group[column].dropna().to_numpy())
                for key, value in summary.items():
                    if key == "quantile_method":
                        continue
                    row[f"{column}_{key}"] = value
            rows.append(row)
        return pd.DataFrame(rows)

    @staticmethod
    def _terminal_values(
        results: pd.DataFrame, numeric_columns: Sequence[str]
    ) -> pd.DataFrame:
        """Final-step values per completed path, ordered by path index."""
        terminal_rows = (
            results.sort_values("iteration_time")
            .groupby("path_index", sort=True)
            .tail(1)
            .sort_values("path_index")
        )
        return terminal_rows.loc[:, ["path_index", *numeric_columns]].reset_index(
            drop=True
        )

    def _terminal_metrics(
        self,
        numeric_columns: Sequence[str],
        artifact_profile: Mapping[str, Any] | None,
    ) -> List[Dict[str, Any]]:
        """Declared terminal metrics, else one per numeric output column."""
        profile = artifact_profile or {}
        units = profile.get("units", {}) if isinstance(profile, Mapping) else {}
        declared = profile.get("terminal_metrics") if isinstance(profile, Mapping) else None
        if declared:
            metrics = []
            for entry in declared:
                metrics.append(
                    {
                        "id": entry["id"],
                        "column": entry["column"],
                        "unit": entry.get("unit", units.get(entry["column"], "")),
                        "kind": entry.get("kind", "continuous"),
                        "absolute_tolerance": entry.get("absolute_tolerance"),
                    }
                )
            return metrics
        return [
            {
                "id": column,
                "column": column,
                "unit": units.get(column, ""),
                "kind": "continuous",
                "absolute_tolerance": None,
            }
            for column in numeric_columns
        ]

    def _terminal_summary(
        self,
        metrics: Sequence[Mapping[str, Any]],
        terminal: pd.DataFrame,
        master_seed: int,
        bootstrap_resamples: int,
    ) -> Dict[str, Any]:
        entries = []
        for metric in metrics:
            values = terminal[metric["column"]].to_numpy(dtype=float)
            entry: Dict[str, Any] = {
                "id": metric["id"],
                "column": metric["column"],
                "unit": metric["unit"],
                "kind": metric["kind"],
                "n": int(values.size),
            }
            if metric["kind"] == "binary":
                successes = int(np.sum(values))
                entry["successes"] = successes
                entry["probability"] = wilson_interval(successes, int(values.size))
            else:
                summary = quantile_summary(values)
                entry["estimates"] = {
                    "mean": summary["mean"],
                    "median": summary["p50"],
                }
                entry["outcome_interval"] = {
                    "label": OUTCOME_INTERVAL_LABEL,
                    "p10": summary["p10"],
                    "p90": summary["p90"],
                    "quantile_method": summary["quantile_method"],
                }
                intervals = []
                for estimator in ("mean", "median"):
                    namespace = f"bootstrap:terminal:{metric['id']}:{estimator}"
                    intervals.append(
                        bootstrap_ci(
                            values,
                            estimator,
                            bootstrap_resamples,
                            derive_generator(master_seed, namespace, 0),
                            lineage=seed_lineage(master_seed, namespace, 0),
                        )
                    )
                entry["confidence_intervals"] = intervals
            entries.append(entry)
        payload = {
            "interval_definitions": INTERVAL_DEFINITIONS,
            "outcome_interval_label": OUTCOME_INTERVAL_LABEL,
            "metrics": entries,
        }
        validate_interval_labels(payload)
        return payload

    def _sensitivity(
        self,
        config: ScenarioConfig,
        parameter_samples: pd.DataFrame,
        terminal: pd.DataFrame,
        metrics: Sequence[Mapping[str, Any]],
        completed: int,
        master_seed: int,
        bootstrap_resamples: int,
    ) -> Dict[str, Any]:
        sampled_ids = [
            spec.id
            for spec in config.uncertainty.parameters
            if spec.distribution.family != "fixed"
            and spec.value_type in ("integer", "number")
        ]
        completed_rows = parameter_samples[
            parameter_samples["path_index"].isin(terminal["path_index"])
        ]
        samples_map = {
            param_id: completed_rows.loc[
                completed_rows["id"] == param_id, "value"
            ].to_numpy(dtype=float)
            for param_id in sampled_ids
        }
        outputs_map = {
            metric["id"]: terminal[metric["column"]].to_numpy(dtype=float)
            for metric in metrics
        }
        namespace = "bootstrap:sensitivity"
        records = spearman_sensitivity(
            samples_map,
            outputs_map,
            min_n=SENSITIVITY_MIN_PATHS,
            bootstrap_resamples=bootstrap_resamples,
            rng=derive_generator(master_seed, namespace, 0),
        )
        return {
            "method": "spearman_rank",
            "min_paths": SENSITIVITY_MIN_PATHS,
            "completed_paths": completed,
            "bootstrap_resamples": bootstrap_resamples,
            "interpretation": NON_CAUSAL_INTERPRETATION,
            "lineage": seed_lineage(master_seed, namespace, 0),
            "results": records,
        }

    def _convergence(
        self,
        metrics: Sequence[Mapping[str, Any]],
        terminal: pd.DataFrame,
        completed: int,
        artifact_profile: Mapping[str, Any] | None,
    ) -> Dict[str, Any]:
        profile = artifact_profile if isinstance(artifact_profile, Mapping) else {}
        profile_tolerances = (
            profile.get("convergence", {}) if isinstance(profile, Mapping) else {}
        )
        relative = float(
            profile_tolerances.get("relative_drift", DEFAULT_RELATIVE_DRIFT)
        )
        absolute_overrides = profile_tolerances.get("absolute_tolerance", {})
        checkpoints = [
            checkpoint
            for checkpoint in CONVERGENCE_CHECKPOINTS
            if checkpoint <= completed
        ]
        per_metric: Dict[str, Any] = {}
        for metric in metrics:
            values = terminal[metric["column"]].to_numpy(dtype=float)
            absolute = DEFAULT_ABSOLUTE_TOLERANCE
            if metric.get("absolute_tolerance") is not None:
                absolute = float(metric["absolute_tolerance"])
            elif metric["column"] in absolute_overrides:
                absolute = float(absolute_overrides[metric["column"]])
            per_metric[metric["id"]] = convergence_checkpoints(
                {
                    checkpoint: values[:checkpoint]
                    for checkpoint in checkpoints
                },
                {"relative_drift": relative, "absolute": absolute},
            )
        return {
            "checkpoints_requested": list(CONVERGENCE_CHECKPOINTS),
            "checkpoints_used": checkpoints,
            "tolerance_defaults": {
                "relative_drift": DEFAULT_RELATIVE_DRIFT,
                "absolute": DEFAULT_ABSOLUTE_TOLERANCE,
                "note": (
                    "drift = |final - reference| / max(|reference|, absolute); "
                    "the declared per-metric absolute tolerance guards near-zero "
                    "references (no division by a bare epsilon)"
                ),
            },
            "metrics": per_metric,
        }

    @staticmethod
    def _write_table(data: pd.DataFrame, path: Path, file_format: str) -> None:
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
        run_tier: str | None = None,
        paths: int | None = None,
        bootstrap_resamples: int | None = None,
        artifact_profile: Mapping[str, Any] | None = None,
        progress_callback: Any = None,
        cancel_event: Any = None,
    ) -> MonteCarloRunArtifacts:
        config = scenario if isinstance(scenario, ScenarioConfig) else load_scenario(scenario)
        if config.schema_version not in (2, 3) or config.uncertainty is None:
            raise MonteCarloError(
                "MonteCarloRunner requires a schema v2 or v3 scenario with an "
                "uncertainty block"
            )
        plan = self._resolve_run_plan(run_tier, paths, bootstrap_resamples)
        validation = validate_v2_scenario(config)
        if validation.errors or not validation.executable:
            problems = [
                f"{error['id'] or 'uncertainty'}: {error['reason']}"
                for error in validation.errors
            ] + [
                f"{warning['id']}: {warning['reason']}"
                for warning in validation.warnings
            ]
            raise MonteCarloError(
                "refusing to execute: uncertainty validation is not executable "
                "(draft/needs_evidence/errors): " + "; ".join(problems)
            )

        master_seed = config.monte_carlo.seed
        requested = plan["paths"]
        resolved_run_id = HeadlessRunner._run_id(config, run_id)
        output_root = Path(output_dir)
        output_root.mkdir(parents=True, exist_ok=True)
        bundle_dir = output_root / resolved_run_id
        if bundle_dir.exists():
            raise ArtifactError(f"run bundle already exists: {bundle_dir}")

        temporary_path: Path | None = None
        try:
            temporary_path = Path(
                tempfile.mkdtemp(prefix=f".{resolved_run_id}.", dir=output_root)
            )

            raw_results, sample_frame, failures = self._execute_all(
                config, validation, master_seed, requested,
                progress_callback=progress_callback,
                cancel_event=cancel_event,
            )
            completed = requested - len(failures)
            if raw_results.empty:
                raise MonteCarloError(
                    f"all {requested} paths failed; no bundle is published"
                )

            numeric_columns = self._numeric_output_columns(raw_results)
            results = raw_results.copy()
            lineage_values = {
                "run_id": resolved_run_id,
                "scenario_id": config.scenario_id,
                "config_hash": config.config_hash,
                "seed": master_seed,
            }
            for column in V2_LINEAGE_COLUMNS:
                if column != "path_index":
                    results[column] = lineage_values[column]
            results = results.loc[
                :,
                [
                    *V2_LINEAGE_COLUMNS,
                    *[c for c in results.columns if c not in V2_LINEAGE_COLUMNS],
                ],
            ]

            iteration_summary = self._iteration_summary(results, numeric_columns)
            terminal = self._terminal_values(results, numeric_columns)
            metrics = self._terminal_metrics(numeric_columns, artifact_profile)
            terminal_summary = self._terminal_summary(
                metrics, terminal, master_seed, plan["bootstrap_resamples"]
            )
            sensitivity = self._sensitivity(
                config,
                sample_frame,
                terminal,
                metrics,
                completed,
                master_seed,
                plan["bootstrap_resamples"],
            )
            convergence = self._convergence(
                metrics, terminal, completed, artifact_profile
            )
            path_failures = {
                "requested": requested,
                "completed": completed,
                "failed": len(failures),
                "failures": failures,
            }

            extension = "csv" if config.artifacts.format == "csv" else "parquet"
            tables = {
                "results": (results, temporary_path / f"results.{extension}"),
                "parameter_samples": (
                    sample_frame,
                    temporary_path / f"parameter_samples.{extension}",
                ),
                "iteration_summary": (
                    iteration_summary,
                    temporary_path / f"iteration_summary.{extension}",
                ),
            }
            documents = {
                "terminal_summary": terminal_summary,
                "sensitivity": sensitivity,
                "convergence": convergence,
                "path_failures": path_failures,
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
            for name, document in documents.items():
                validate_interval_labels(document)
                path = temporary_path / f"{name}.json"
                path.write_text(
                    json.dumps(document, indent=2, sort_keys=True, allow_nan=False)
                    + "\n",
                    encoding="utf-8",
                )
                output_metadata[name] = {
                    "path": path.name,
                    "format": "json",
                    "sha256": file_sha256(path),
                    "reproducible_content_sha256": reproducible_json_hash(document),
                    "reproducibility_excludes": ["run_id"],
                }

            claim_eligibility = evaluate_claim_eligibility(
                executable=validation.executable,
                requested=requested,
                completed=completed,
                failed=len(failures),
                run_tier=plan["run_tier"],
                convergence_statuses={
                    metric_id: result["status"]
                    for metric_id, result in convergence["metrics"].items()
                },
            )
            uncertainty_spec_hash = hashlib.sha256(
                json.dumps(
                    config.uncertainty.to_dict(),
                    sort_keys=True,
                    separators=(",", ":"),
                    ensure_ascii=False,
                    allow_nan=False,
                ).encode("utf-8")
            ).hexdigest()

            manifest = {
                "manifest_version": 2,
                "run_id": resolved_run_id,
                "scenario_id": config.scenario_id,
                "config_hash": config.config_hash,
                "seed": master_seed,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "monte_carlo": {
                    "iterations": config.monte_carlo.iterations,
                    "repetitions": 1,
                    "simulator": config.monte_carlo.simulator,
                    "paths": requested,
                },
                "run_tier": plan["run_tier"],
                "requested_paths": requested,
                "completed_paths": completed,
                "failed_paths": len(failures),
                "bootstrap_resamples": plan["bootstrap_resamples"],
                "sampler_version": SAMPLER_VERSION,
                "rng_algorithm": RNG_ALGORITHM,
                "master_seed": master_seed,
                "seed_lineage": {
                    "master_seed": master_seed,
                    "sampler_version": SAMPLER_VERSION,
                    "rng_algorithm": RNG_ALGORITHM,
                    "namespaces": {
                        "parameters": "parameters:<parameter_id>",
                        "dependence": "dependence:<group_id>",
                        "components": "components:<build_context>",
                        "bootstrap": "bootstrap:<artifact>:<id>",
                    },
                    "path_spawn": "SeedSequence spawn_key=(path_index,)",
                },
                "uncertainty_spec_hash": uncertainty_spec_hash,
                "interval_definitions": INTERVAL_DEFINITIONS,
                "interval_labels": {"outcome_interval": OUTCOME_INTERVAL_LABEL},
                "claim_eligibility": claim_eligibility,
                "code": {"package": "TokenLab", "version": _package_version()},
                "outputs": output_metadata,
            }
            manifest_path = temporary_path / "manifest.json"
            manifest_path.write_text(
                json.dumps(manifest, indent=2, sort_keys=True, allow_nan=False) + "\n",
                encoding="utf-8",
            )
            temporary_path.rename(bundle_dir)
            temporary_path = None
            return MonteCarloRunArtifacts(
                bundle_dir=bundle_dir,
                manifest_path=bundle_dir / "manifest.json",
                manifest=manifest,
                results=results,
                parameter_samples=sample_frame,
                iteration_summary=iteration_summary,
                terminal_summary=terminal_summary,
                sensitivity=sensitivity,
                convergence=convergence,
                path_failures=path_failures,
            )
        except ArtifactError:
            raise
        except Exception as exc:
            raise ArtifactError(f"monte carlo run failed: {exc}") from exc
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
    parser.add_argument(
        "--run-tier",
        choices=sorted(RUN_TIERS),
        help="Schema v2 Monte Carlo tier (mutually exclusive with --paths)",
    )
    parser.add_argument(
        "--paths",
        type=int,
        help="Schema v2 explicit path count in [1, 10000] (mutually exclusive "
        "with --run-tier)",
    )
    parser.add_argument(
        "--bootstrap-resamples",
        type=int,
        help="Schema v2 bootstrap resample override, bounded per tier",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    config = load_scenario(args.scenario)
    mc_requested = (
        config.schema_version in (2, 3)
        or args.run_tier is not None
        or args.paths is not None
    )
    if not mc_requested:
        artifacts = HeadlessRunner().run(
            args.scenario, args.output_dir, run_id=args.run_id
        )
        print(artifacts.bundle_dir)
        return 0
    if config.schema_version not in (2, 3):
        print(
            json.dumps(
                {
                    "status": "error",
                    "error_class": "MonteCarloError",
                    "message": "--run-tier/--paths require a schema v2 or v3 scenario",
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2
    run_tier = args.run_tier
    if run_tier is None and args.paths is None:
        run_tier = "test"
    try:
        artifacts = MonteCarloRunner().run(
            config,
            args.output_dir,
            run_id=args.run_id,
            run_tier=run_tier,
            paths=args.paths,
            bootstrap_resamples=args.bootstrap_resamples,
        )
    except (ArtifactError, UncertaintyError) as exc:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error_class": type(exc).__name__,
                    "message": str(exc),
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2
    print(artifacts.bundle_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

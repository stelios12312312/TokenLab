"""Z1 core-solvency canonical bundle adapter.

Read-only over Z1: this module composes the maintained public entry points
(``get_scenario_config`` + ``run_simulation`` + ``summarize_run``) unchanged at
repetitions=1, verifies the shared-core invariants per run with the read-only
``check_invariants`` surface, and translates the outputs into canonical v1
artifact bundles (manifest_version 1, lineage columns, sha256 + reproducible
content hashes, diagnostics attachment, validated artifact profile) plus a
gallery-facing index JSON. Any validation or invariant error blocks publication
of that scenario's bundle with a visible, recorded failure — a blocked
publication is evidence, never a fabricated bundle.

CLI:
    python -m projects.z1.core_solvency.adapter \
        --scenarios baseline,stable_case,collapse_case --out outputs/z1_gallery [--grid]
"""

# @planner:module = z1_solvency_adapter
# @planner:story = US-PM-AUTO-HD831D2BD43331EFE

from __future__ import annotations

import argparse
import copy
import dataclasses
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple

import pandas as pd
from importlib import resources

from TokenLab.agentic.artifact_profile import (
    file_sha256,
    reproducible_table_hash,
    validate_artifact_profile,
)

from .config import COHORT_NAMES, SolvencyConfig
from .economy import TokenEconomy_Z1
from .invariants import check_invariants
from .metrics import summarize_run
from .pools import AgentPool_Z1
from .run import run_simulation
from .scenarios import generate_stress_grid, get_scenario_config


ADAPTER_ID = "z1-core-solvency-adapter"
INDEX_VERSION = 1
PROFILE_RESOURCE = "z1_solvency_profile.json"

DEFAULT_SCENARIOS = ("baseline", "stable_case", "collapse_case")
NEUTRAL_SCENARIO_NAMES = {
    "baseline": "baseline",
    "stable_case": "stable",
    "collapse_case": "collapse",
}
LINEAGE_COLUMNS = ["run_id", "scenario_id", "config_hash", "seed"]
# The six declared terminal metrics: neutral name -> Z1 summary key.
TERMINAL_METRIC_KEYS = {
    "final_reserve_ratio": "final_ar_ratio",
    "final_treasury": "final_treasury",
    "max_settlement_queue": "max_settlement_queue_z1u",
    "throttle_epochs": "throttle_epochs",
    "total_burns": "total_burn",
    "classification": "classification",
}


class AdapterError(RuntimeError):
    """Raised when the adapter itself cannot complete publication safely."""


def load_profile_template() -> Dict[str, Any]:
    """Load the declarative neutral-name profile from the platform package."""
    resource = resources.files("TokenLab.agentic").joinpath(
        f"data/{PROFILE_RESOURCE}"
    )
    try:
        return json.loads(resource.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError) as exc:
        raise AdapterError(f"adapter profile resource is missing or invalid: {exc}") from exc


def neutral_name_mapping(profile: Mapping[str, Any]) -> Dict[str, str]:
    """The declarative published-name -> Z1-column mapping from the profile."""
    mapping = profile.get("neutral_name_mapping")
    if not isinstance(mapping, Mapping) or not mapping:
        raise AdapterError("profile is missing its neutral_name_mapping")
    return {str(published): str(z1) for published, z1 in mapping.items()}


def config_hash(config: SolvencyConfig) -> str:
    """Canonical-content hash of the exact scenario configuration."""
    payload = json.dumps(
        dataclasses.asdict(config),
        sort_keys=True,
        separators=(",", ":"),
        default=str,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def verify_invariants(config: SolvencyConfig) -> Dict[str, Any]:
    """Read-only per-epoch invariant verification of one deterministic run.

    Replays the public Z1 economy objects (never modifying them) and calls the
    read-only shared-core ``check_invariants`` after every epoch, recording all
    outcomes. The economy's own per-epoch assertion still fires first; an
    invariant breach is recorded (not hidden) and marks the report failed.
    """
    report: Dict[str, Any] = {"status": "pass", "epochs_checked": 0, "errors": []}
    economy = TokenEconomy_Z1(config)
    for name in COHORT_NAMES:
        economy.add_agent_pool(AgentPool_Z1(name, config))

    def checkpoint() -> None:
        errors = check_invariants(economy)
        report["epochs_checked"] += 1
        for message in errors:
            report["errors"].append({"epoch": int(economy.epoch), "message": message})

    checkpoint()  # epoch-0 baseline state
    for _ in range(config.n_epochs):
        try:
            economy.execute()
        except AssertionError as exc:
            report["errors"].append(
                {
                    "epoch": int(economy.epoch),
                    "message": " ".join(str(exc).split()),
                }
            )
            break
        checkpoint()
    if report["errors"]:
        report["status"] = "fail"
    return report


def run_scenario(scenario_name: str) -> Tuple[SolvencyConfig, pd.DataFrame, Dict[str, Any]]:
    """Run one named Z1 scenario unchanged at repetitions=1."""
    config = get_scenario_config(scenario_name)
    if config.repetitions != 1:
        raise AdapterError(
            f"canonical bundles pin repetitions=1; scenario {scenario_name!r} "
            f"declares repetitions={config.repetitions}"
        )
    records = run_simulation(config)
    frame = pd.DataFrame(records)
    summary = summarize_run(frame)
    return config, frame, summary


def _with_lineage(
    data: pd.DataFrame,
    *,
    run_id: str,
    scenario_id: str,
    config_digest: str,
    seed: int,
) -> pd.DataFrame:
    result = data.copy()
    values = {
        "run_id": run_id,
        "scenario_id": scenario_id,
        "config_hash": config_digest,
        "seed": seed,
    }
    for column in LINEAGE_COLUMNS:
        result[column] = values[column]
    return result


def _iteration_summary(data: pd.DataFrame) -> pd.DataFrame:
    """Per-epoch descriptive summary, mirroring the canonical v1 shape."""
    numeric = [
        column
        for column in data.select_dtypes(include="number").columns
        if column not in {"iteration_time", "repetition_run"}
    ]
    if not numeric:
        return data.loc[:, ["iteration_time"]].drop_duplicates().reset_index(drop=True)
    summary = data.groupby("iteration_time", sort=True)[numeric].agg(
        ["mean", "std", "min", "max"]
    )
    summary.columns = [f"{column}_{stat}" for column, stat in summary.columns]
    return summary.reset_index()


def _neutralize(
    frame: pd.DataFrame, mapping: Mapping[str, str]
) -> pd.DataFrame:
    """Rename Z1 emitted columns to their published neutral names (1:1)."""
    z1_to_published = {z1: published for published, z1 in mapping.items()}
    emitted = set(frame.columns)
    declared = set(mapping.values())
    if emitted != declared:
        raise AdapterError(
            "neutral-name mapping is not total over the emitted Z1 columns: "
            f"unmapped emitted={sorted(emitted - declared)}, "
            f"declared but absent={sorted(declared - emitted)}"
        )
    return frame.rename(columns=z1_to_published)


def _diagnostics_text(
    *,
    source_scenario: str,
    published_name: str,
    config: SolvencyConfig,
    summary: Mapping[str, Any],
    invariant_report: Mapping[str, Any],
) -> str:
    """Deterministic diagnostics attachment content (no timestamps)."""
    lines = [
        "[z1 solvency adapter diagnostics]",
        f"source_scenario: {source_scenario}",
        f"published_as: {published_name}",
        f"seed: {config.random_seed}",
        f"epochs: {config.n_epochs}",
        "repetitions: 1",
        f"classification: {summary['classification']}",
        "terminal_metrics:",
    ]
    for neutral, key in TERMINAL_METRIC_KEYS.items():
        lines.append(f"  {neutral}: {summary[key]}")
    lines.append("")
    lines.append("[invariant verification]")
    lines.append(f"status: {invariant_report['status']}")
    lines.append(f"epochs_checked: {invariant_report['epochs_checked']}")
    if invariant_report["errors"]:
        for error in invariant_report["errors"]:
            lines.append(f"error epoch {error['epoch']}: {error['message']}")
    else:
        lines.append("errors: none")
    lines.append("")
    lines.append("[solvency locks]")
    for lock in config.check_solvency_locks():
        lines.append(
            f"{lock['lock']} ({lock['severity']}) {lock['status']}: {lock['message']}"
        )
    return "\n".join(lines) + "\n"


def publish_bundle(
    config: SolvencyConfig,
    frame: pd.DataFrame,
    summary: Mapping[str, Any],
    invariant_report: Mapping[str, Any],
    *,
    published_name: str,
    source_scenario: str,
    run_id: str,
    out_dir: Path,
    profile_template: Mapping[str, Any],
) -> Dict[str, Any]:
    """Publish one canonical v1 bundle; never overwrites an existing bundle."""
    out_dir.mkdir(parents=True, exist_ok=True)
    bundle_dir = out_dir / run_id
    if bundle_dir.exists():
        raise AdapterError(f"run bundle already exists: {bundle_dir}")

    scenario_id = run_id
    digest = config_hash(config)
    mapping = neutral_name_mapping(profile_template)
    neutral_frame = _neutralize(frame, mapping)
    results = _with_lineage(
        neutral_frame,
        run_id=run_id,
        scenario_id=scenario_id,
        config_digest=digest,
        seed=config.random_seed,
    )
    iteration_summary = _with_lineage(
        _iteration_summary(neutral_frame),
        run_id=run_id,
        scenario_id=scenario_id,
        config_digest=digest,
        seed=config.random_seed,
    )
    tables = {"results": results, "iteration_summary": iteration_summary}

    profile = copy.deepcopy(dict(profile_template))
    profile["scenario_id"] = scenario_id
    validated_profile = validate_artifact_profile(
        profile, tables, scenario_id=scenario_id
    )

    temporary_path = Path(tempfile.mkdtemp(prefix=f".{run_id}.", dir=out_dir))
    try:
        output_metadata: Dict[str, Any] = {}
        for name, table in tables.items():
            path = temporary_path / f"{name}.csv"
            table.to_csv(path, index=False)
            persisted = pd.read_csv(path)
            output_metadata[name] = {
                "path": path.name,
                "format": "csv",
                "rows": int(len(table)),
                "columns": list(table.columns),
                "sha256": file_sha256(path),
                "reproducible_content_sha256": reproducible_table_hash(persisted),
                "reproducibility_excludes": ["run_id"],
            }

        diagnostics_path = temporary_path / "diagnostics.log"
        diagnostics_path.write_text(
            _diagnostics_text(
                source_scenario=source_scenario,
                published_name=published_name,
                config=config,
                summary=summary,
                invariant_report=invariant_report,
            ),
            encoding="utf-8",
        )
        profile_path = temporary_path / "artifact_profile.json"
        profile_path.write_text(
            json.dumps(validated_profile, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        attachments = {
            "diagnostics": {
                "path": diagnostics_path.name,
                "media_type": "text/plain; charset=utf-8",
                "bytes": diagnostics_path.stat().st_size,
                "sha256": file_sha256(diagnostics_path),
            },
            "artifact_profile": {
                "path": profile_path.name,
                "media_type": "application/json",
                "bytes": profile_path.stat().st_size,
                "sha256": file_sha256(profile_path),
                "profile_version": validated_profile["profile_version"],
                "profile_id": validated_profile["profile_id"],
            },
        }
        manifest = {
            "manifest_version": 1,
            "run_id": run_id,
            "scenario_id": scenario_id,
            "config_hash": digest,
            "seed": config.random_seed,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "monte_carlo": {
                "iterations": config.n_epochs,
                "repetitions": 1,
                "simulator": "TokenMetaSimulator",
            },
            "outputs": output_metadata,
            "attachments": attachments,
        }
        manifest_path = temporary_path / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        temporary_path.rename(bundle_dir)
        temporary_path = None
    finally:
        if temporary_path is not None and temporary_path.exists():
            shutil.rmtree(temporary_path)

    return {
        "scenario_id": scenario_id,
        "config_hash": digest,
        "seed": config.random_seed,
        "epochs": config.n_epochs,
        "profile_id": validated_profile["profile_id"],
        "content_hashes": {
            name: metadata["reproducible_content_sha256"]
            for name, metadata in output_metadata.items()
        },
        "bundle_dir": str(bundle_dir),
    }


def publish_config(
    config: SolvencyConfig,
    *,
    published_name: str,
    source_scenario: str,
    run_id: str,
    out_dir: Path,
    profile_template: Mapping[str, Any],
) -> Dict[str, Any]:
    """Run one config unchanged and publish, or record a blocked publication.

    A blocked entry carries the exact upstream reason (validation or invariant
    failure) and publishes nothing — visible negative-control evidence.
    """
    entry: Dict[str, Any] = {
        "preset": published_name,
        "source_scenario": source_scenario,
    }
    try:
        if config.repetitions != 1:
            raise AdapterError(
                f"canonical bundles pin repetitions=1; got repetitions={config.repetitions}"
            )
        records = run_simulation(config)
        frame = pd.DataFrame(records)
        summary = summarize_run(frame)
        invariant_report = verify_invariants(config)
        if invariant_report["status"] != "pass":
            first = invariant_report["errors"][0]
            raise AdapterError(
                f"invariant verification failed at epoch {first['epoch']}: "
                f"{first['message']} ({len(invariant_report['errors'])} error(s))"
            )
        published = publish_bundle(
            config,
            frame,
            summary,
            invariant_report,
            published_name=published_name,
            source_scenario=source_scenario,
            run_id=run_id,
            out_dir=out_dir,
            profile_template=profile_template,
        )
        entry.update(
            {
                "status": "published",
                "classification": summary["classification"],
                "metrics": {
                    neutral: summary[key]
                    for neutral, key in TERMINAL_METRIC_KEYS.items()
                },
                "scenario_id": published["scenario_id"],
                "config_hash": published["config_hash"],
                "seed": published["seed"],
                "epochs": published["epochs"],
                "profile_id": published["profile_id"],
                "content_hashes": published["content_hashes"],
                "bundle_dir": published["bundle_dir"],
            }
        )
    except Exception as exc:  # blocked publication: visible, recorded, nothing emitted
        entry.update(
            {
                "status": "blocked",
                "error_class": type(exc).__name__,
                "reason": " ".join(str(exc).split())[:400],
                "bundle_dir": None,
            }
        )
    return entry


def publish_scenario(
    scenario_name: str,
    *,
    out_dir: Path,
    profile_template: Mapping[str, Any],
) -> Dict[str, Any]:
    """Publish one named Z1 scenario under its neutral publish-time name."""
    published_name = NEUTRAL_SCENARIO_NAMES.get(scenario_name, scenario_name)
    config = get_scenario_config(scenario_name)
    return publish_config(
        config,
        published_name=published_name,
        source_scenario=scenario_name,
        run_id=f"z1-solvency-{published_name}-v1",
        out_dir=out_dir,
        profile_template=profile_template,
    )


def publish(
    scenarios: List[str],
    out_dir: Path,
    *,
    index_path: Optional[Path] = None,
    grid: bool = False,
) -> Dict[str, Any]:
    """Publish all requested scenarios plus the gallery-facing index JSON."""
    out_dir = Path(out_dir)
    profile_template = load_profile_template()
    entries = [
        publish_scenario(name, out_dir=out_dir, profile_template=profile_template)
        for name in scenarios
    ]

    grid_section: Dict[str, Any] = {
        "completed": 0,
        "total": 27,
        "label": "not_run",
        "cases": [],
    }
    if grid:
        grid_entries = []
        for case_name, case_config in generate_stress_grid():
            grid_entries.append(
                publish_config(
                    case_config,
                    published_name=case_name,
                    source_scenario=case_name,
                    run_id=f"z1-solvency-grid-{case_name}",
                    out_dir=out_dir,
                    profile_template=profile_template,
                )
            )
        completed = sum(1 for entry in grid_entries if entry["status"] == "published")
        grid_section = {
            "completed": completed,
            "total": len(grid_entries),
            "label": (
                "cli_only_evidence" if completed == len(grid_entries) else "wiring_proof"
            ),
            "cases": grid_entries,
        }

    if index_path is None:
        index_path = out_dir / "index.json"
    index_path = Path(index_path)
    index_path.parent.mkdir(parents=True, exist_ok=True)

    def relative_bundle(entry: Mapping[str, Any]) -> Optional[str]:
        bundle_dir = entry.get("bundle_dir")
        if not bundle_dir:
            return None
        return os.path.relpath(bundle_dir, index_path.parent)

    index = {
        "index_version": INDEX_VERSION,
        "adapter": ADAPTER_ID,
        "generated_by": "projects.z1.core_solvency.adapter",
        "profile_id": profile_template["profile_id"],
        "profile_resource": PROFILE_RESOURCE,
        "repetitions": 1,
        "scenarios": [
            {
                key: value
                for key, value in {**entry, "bundle_path": relative_bundle(entry)}.items()
                if key != "bundle_dir"
            }
            for entry in entries
        ],
        "grid": {
            key: (
                [
                    {
                        k: v
                        for k, v in {
                            **case,
                            "bundle_path": relative_bundle(case),
                        }.items()
                        if k != "bundle_dir"
                    }
                    for case in value
                ]
                if key == "cases"
                else value
            )
            for key, value in grid_section.items()
        },
        "tested_region": profile_template["tested_region"],
        "interpretation_boundary": profile_template["interpretation_boundary"],
    }
    index_path.write_text(
        json.dumps(index, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    for entry in entries:
        if entry["status"] == "published":
            print(
                f"PUBLISHED {entry['source_scenario']} as {entry['preset']!r} "
                f"(classification: {entry['classification']})"
            )
        else:
            print(
                f"BLOCKED {entry['source_scenario']} (preset {entry['preset']!r}): "
                f"{entry['error_class']}: {entry['reason']}",
                file=sys.stderr,
            )
    published_count = sum(1 for entry in entries if entry["status"] == "published")
    blocked_count = len(entries) - published_count
    print(
        f"adapter complete: {published_count} published, {blocked_count} blocked; "
        f"index: {index_path}"
    )
    if grid:
        print(
            f"grid: {grid_section['completed']}/{grid_section['total']} cases "
            f"published ({grid_section['label']})"
        )
    return index


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Publish canonical v1 bundles for the Z1 core-solvency scenarios."
    )
    parser.add_argument(
        "--scenarios",
        type=str,
        default=",".join(DEFAULT_SCENARIOS),
        help="Comma-separated Z1 scenario names (default: baseline,stable_case,collapse_case)",
    )
    parser.add_argument(
        "--out",
        type=str,
        default=os.path.join("outputs", "z1_gallery"),
        help="Output directory for the published bundles",
    )
    parser.add_argument(
        "--index",
        type=str,
        default=None,
        help="Gallery-facing index JSON path (default: <out>/index.json)",
    )
    parser.add_argument(
        "--grid",
        action="store_true",
        help="Also publish the 27-case stress grid as CLI-only evidence with exact counts",
    )
    args = parser.parse_args(argv)

    scenarios = [name.strip() for name in args.scenarios.split(",") if name.strip()]
    if not scenarios:
        print("no scenarios requested", file=sys.stderr)
        return 2
    index = publish(
        scenarios,
        Path(args.out),
        index_path=Path(args.index) if args.index else None,
        grid=args.grid,
    )
    return 0 if index["scenarios"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

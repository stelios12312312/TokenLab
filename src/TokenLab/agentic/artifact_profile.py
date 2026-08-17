"""Validation helpers for versioned TokenLab artifact profiles and bundles."""

# @planner:story = US-PM-AUTO-HFC7DB1681D268A66
# @planner:proves = crit:CRIT-002,crit:CRIT-003,crit:CRIT-004

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, Mapping

import pandas as pd
import numpy as np


PROFILE_VERSION = 1
_REQUIRED_PROFILE_FIELDS = {
    "profile_version",
    "profile_id",
    "scenario_id",
    "source_artifacts",
    "time_axis",
    "metrics",
    "unavailable_concepts",
    "repeatability",
    "variability",
    "interpretation_boundary",
}


class ArtifactProfileError(ValueError):
    """Raised when a profile or completed artifact bundle is invalid."""


def file_sha256(path: Path) -> str:
    """Return the exact SHA-256 of one on-disk artifact."""

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_cell(value: Any) -> str:
    """Stack-stable canonical rendering of one table cell.

    pandas' ``to_csv`` float formatting varies across pandas versions, which
    made persisted content hashes stack-dependent (a bundle published under
    one pandas/pandas-reader stack failed validation under another). Python's
    ``repr`` of a ``float``/``int`` is identical across the supported
    dependency set, and correctly-rounded CSV float parsing yields the same
    doubles on both stacks, so this canonical form is stable everywhere.
    """
    if value is None or (isinstance(value, float) and value != value):
        return ""
    try:
        if bool(pd.isna(value)):
            return ""
    except (TypeError, ValueError):
        pass
    if isinstance(value, (bool, np.bool_)):
        return str(bool(value))
    if isinstance(value, (int, np.integer)):
        return str(int(value))
    if isinstance(value, (float, np.floating)):
        return repr(float(value))
    return str(value)


def reproducible_csv_text_hash(path: str | Path) -> str:
    """Hash persisted CSV text with the ``run_id`` column removed.

    Unlike the frame-based hash, this never parses floats, so it is identical
    on every supported stack: pandas' CSV float *parser* (not just its
    writer) can differ by one ulp across pandas versions, which made
    frame-based hashes of committed precomputed bundles stack-dependent.
    Hashing the persisted representation directly removes that dependency.
    """
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    if not lines:
        raise ArtifactProfileError(f"cannot hash empty CSV: {path}")
    header = lines[0].split(",")
    if "run_id" in header:
        drop = header.index("run_id")
        lines = [
            ",".join(
                field for index, field in enumerate(line.split(",")) if index != drop
            )
            for line in lines
        ]
    payload = ("\n".join(lines) + "\n").encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def reproducible_table_hash(data: pd.DataFrame) -> str:
    """Hash canonical table content while excluding unique bundle identity."""

    canonical = data.drop(columns=["run_id"], errors="ignore")
    lines = [",".join(str(column) for column in canonical.columns)]
    for row in canonical.itertuples(index=False, name=None):
        lines.append(",".join(_canonical_cell(value) for value in row))
    payload = ("\n".join(lines) + "\n").encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def reproducible_json_hash(payload: Any) -> str:
    """Hash canonical JSON content while excluding unique bundle identity.

    ``run_id`` keys are stripped recursively before hashing, matching the
    table-hash exclusion discipline; serialization is canonical
    (sorted keys, tight separators, no NaN).
    """

    def strip(node: Any) -> Any:
        if isinstance(node, Mapping):
            return {
                key: strip(value)
                for key, value in node.items()
                if key != "run_id"
            }
        if isinstance(node, list):
            return [strip(value) for value in node]
        return node

    canonical = json.dumps(
        strip(payload),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _require_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ArtifactProfileError(f"{field} must be a non-empty string")
    return value.strip()


def _validate_source(
    source: Any,
    *,
    field: str,
    tables: Mapping[str, pd.DataFrame],
) -> None:
    if not isinstance(source, Mapping):
        raise ArtifactProfileError(f"{field} must be an object")
    artifact = _require_text(source.get("artifact"), f"{field}.artifact")
    column = _require_text(source.get("column"), f"{field}.column")
    if artifact not in tables:
        raise ArtifactProfileError(
            f"{field}.artifact references unknown table {artifact!r}"
        )
    if column not in tables[artifact].columns:
        raise ArtifactProfileError(
            f"{field}.column {column!r} is absent from {artifact!r}"
        )


def validate_artifact_profile(
    profile: Mapping[str, Any],
    tables: Mapping[str, pd.DataFrame],
    *,
    scenario_id: str | None = None,
) -> Dict[str, Any]:
    """Validate a profile against the exact tables it declares."""

    if not isinstance(profile, Mapping):
        raise ArtifactProfileError("artifact profile must be an object")
    missing = sorted(_REQUIRED_PROFILE_FIELDS - set(profile))
    if missing:
        raise ArtifactProfileError(
            "artifact profile is missing required field(s): " + ", ".join(missing)
        )
    if profile.get("profile_version") != PROFILE_VERSION:
        raise ArtifactProfileError(
            f"unsupported profile_version {profile.get('profile_version')!r}; "
            f"expected {PROFILE_VERSION}"
        )

    _require_text(profile.get("profile_id"), "profile_id")
    declared_scenario = _require_text(profile.get("scenario_id"), "scenario_id")
    if scenario_id is not None and declared_scenario != scenario_id:
        raise ArtifactProfileError(
            f"profile scenario_id {declared_scenario!r} does not match "
            f"run scenario_id {scenario_id!r}"
        )

    source_artifacts = profile.get("source_artifacts")
    if not isinstance(source_artifacts, Mapping) or not source_artifacts:
        raise ArtifactProfileError("source_artifacts must be a non-empty object")
    for name, declaration in source_artifacts.items():
        if name not in tables:
            raise ArtifactProfileError(
                f"source_artifacts references unknown table {name!r}"
            )
        if not isinstance(declaration, Mapping):
            raise ArtifactProfileError(f"source_artifacts.{name} must be an object")
        manifest_output = _require_text(
            declaration.get("manifest_output"),
            f"source_artifacts.{name}.manifest_output",
        )
        if manifest_output != name:
            raise ArtifactProfileError(
                f"source_artifacts.{name}.manifest_output must equal {name!r}"
            )
        _require_text(declaration.get("role"), f"source_artifacts.{name}.role")

    _validate_source(profile.get("time_axis"), field="time_axis", tables=tables)
    _require_text(profile["time_axis"].get("label"), "time_axis.label")
    _require_text(profile["time_axis"].get("unit"), "time_axis.unit")

    metrics = profile.get("metrics")
    if not isinstance(metrics, list) or not metrics:
        raise ArtifactProfileError("metrics must be a non-empty array")
    metric_ids = set()
    for index, metric in enumerate(metrics):
        field = f"metrics[{index}]"
        if not isinstance(metric, Mapping):
            raise ArtifactProfileError(f"{field} must be an object")
        metric_id = _require_text(metric.get("id"), f"{field}.id")
        if metric_id in metric_ids:
            raise ArtifactProfileError(f"duplicate metric id {metric_id!r}")
        metric_ids.add(metric_id)
        for key in ("label", "unit", "aggregation", "description"):
            _require_text(metric.get(key), f"{field}.{key}")
        _validate_source(metric.get("source"), field=f"{field}.source", tables=tables)

    unavailable = profile.get("unavailable_concepts")
    if not isinstance(unavailable, list) or not unavailable:
        raise ArtifactProfileError("unavailable_concepts must be a non-empty array")
    unavailable_ids = set()
    for index, concept in enumerate(unavailable):
        field = f"unavailable_concepts[{index}]"
        if not isinstance(concept, Mapping):
            raise ArtifactProfileError(f"{field} must be an object")
        concept_id = _require_text(concept.get("id"), f"{field}.id")
        if concept_id in unavailable_ids:
            raise ArtifactProfileError(
                f"duplicate unavailable concept id {concept_id!r}"
            )
        unavailable_ids.add(concept_id)
        _require_text(concept.get("reason"), f"{field}.reason")

    for section in ("repeatability", "variability"):
        value = profile.get(section)
        if not isinstance(value, Mapping):
            raise ArtifactProfileError(f"{section} must be an object")
        _require_text(value.get("status"), f"{section}.status")
        _require_text(value.get("explanation"), f"{section}.explanation")
    _require_text(profile.get("interpretation_boundary"), "interpretation_boundary")

    try:
        return json.loads(json.dumps(profile))
    except (TypeError, ValueError) as exc:
        raise ArtifactProfileError(
            f"artifact profile must contain JSON-compatible values: {exc}"
        ) from exc


def _safe_artifact_path(bundle_dir: Path, relative: Any, field: str) -> Path:
    value = _require_text(relative, field)
    relative_path = Path(value)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise ArtifactProfileError(f"{field} must be a safe relative path")
    resolved_root = bundle_dir.resolve()
    resolved = (bundle_dir / relative_path).resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise ArtifactProfileError(f"{field} escapes the bundle directory")
    return resolved


def _read_table(path: Path, file_format: str) -> pd.DataFrame:
    if file_format == "csv":
        return pd.read_csv(path)
    if file_format == "parquet":
        return pd.read_parquet(path)
    raise ArtifactProfileError(f"unsupported table format {file_format!r}")


def validate_bundle(bundle_dir: str | Path) -> Dict[str, Any]:
    """Validate a completed bundle without executing any content from it."""

    root = Path(bundle_dir)
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise ArtifactProfileError(f"bundle manifest is missing: {manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ArtifactProfileError(f"bundle manifest is invalid: {exc}") from exc
    if manifest.get("manifest_version") != 1:
        raise ArtifactProfileError("unsupported or missing manifest_version")

    outputs = manifest.get("outputs")
    if not isinstance(outputs, Mapping):
        raise ArtifactProfileError("manifest.outputs must be an object")
    required_outputs = {"results", "iteration_summary"}
    missing_outputs = sorted(required_outputs - set(outputs))
    if missing_outputs:
        raise ArtifactProfileError(
            "manifest.outputs is missing: " + ", ".join(missing_outputs)
        )

    tables: Dict[str, pd.DataFrame] = {}
    for name, metadata in outputs.items():
        if not isinstance(metadata, Mapping):
            raise ArtifactProfileError(f"manifest.outputs.{name} must be an object")
        path = _safe_artifact_path(root, metadata.get("path"), f"outputs.{name}.path")
        if not path.is_file():
            raise ArtifactProfileError(f"declared output is missing: {path.name}")
        if file_sha256(path) != metadata.get("sha256"):
            raise ArtifactProfileError(f"SHA-256 mismatch for output {name!r}")
        table = _read_table(path, metadata.get("format"))
        if int(metadata.get("rows", -1)) != len(table):
            raise ArtifactProfileError(f"row-count mismatch for output {name!r}")
        if list(metadata.get("columns", [])) != list(table.columns):
            raise ArtifactProfileError(f"column mismatch for output {name!r}")
        expected_content_hash = metadata.get("reproducible_content_sha256")
        recomputed_hash = (
            reproducible_csv_text_hash(path)
            if metadata.get("format") == "csv"
            else reproducible_table_hash(table)
        )
        if expected_content_hash != recomputed_hash:
            raise ArtifactProfileError(
                f"reproducible content hash mismatch for output {name!r}"
            )
        if metadata.get("reproducibility_excludes") != ["run_id"]:
            raise ArtifactProfileError(
                f"output {name!r} must declare run_id as its only hash exclusion"
            )
        tables[name] = table

    attachments = manifest.get("attachments")
    if not isinstance(attachments, Mapping):
        raise ArtifactProfileError("manifest.attachments must be an object")
    for required in ("diagnostics", "artifact_profile"):
        if required not in attachments:
            raise ArtifactProfileError(f"manifest.attachments.{required} is missing")

    attachment_paths: Dict[str, Path] = {}
    for name, metadata in attachments.items():
        if not isinstance(metadata, Mapping):
            raise ArtifactProfileError(
                f"manifest.attachments.{name} must be an object"
            )
        path = _safe_artifact_path(
            root, metadata.get("path"), f"attachments.{name}.path"
        )
        if not path.is_file():
            raise ArtifactProfileError(f"declared attachment is missing: {path.name}")
        if file_sha256(path) != metadata.get("sha256"):
            raise ArtifactProfileError(f"SHA-256 mismatch for attachment {name!r}")
        if int(metadata.get("bytes", -1)) != path.stat().st_size:
            raise ArtifactProfileError(f"byte-count mismatch for attachment {name!r}")
        attachment_paths[name] = path

    try:
        profile = json.loads(
            attachment_paths["artifact_profile"].read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError) as exc:
        raise ArtifactProfileError(f"artifact profile is invalid JSON: {exc}") from exc
    validated_profile = validate_artifact_profile(
        profile,
        tables,
        scenario_id=_require_text(manifest.get("scenario_id"), "scenario_id"),
    )

    return {
        "status": "pass",
        "bundle_dir": str(root),
        "run_id": manifest.get("run_id"),
        "scenario_id": manifest.get("scenario_id"),
        "validated_outputs": sorted(tables),
        "validated_attachments": sorted(attachment_paths),
        "metric_count": len(validated_profile["metrics"]),
        "profile_id": validated_profile["profile_id"],
    }

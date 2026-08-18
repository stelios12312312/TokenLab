"""Local, read-only dashboard for validated TokenLab artifact bundles."""

# @planner:story = US-002
# @planner:proves = crit:CRIT-001,crit:CRIT-002,crit:CRIT-003,crit:CRIT-004
# @planner:story = US-PM-AUTO-HCE13E9273E2C5559
# @planner:proves = crit:CRIT-002,crit:CRIT-003,crit:CRIT-004,crit:CRIT-005

from __future__ import annotations

import argparse
from copy import deepcopy
from dataclasses import dataclass, field
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
import json
import math
import numbers
import os
from pathlib import Path
import re
import socket
import sys
import tempfile
import threading
from typing import Any, Dict, Mapping, Sequence, Tuple
from urllib.parse import quote, unquote, urlsplit


DASHBOARD_VERSION = 1
MAX_MANIFEST_BYTES = 256 * 1024
MAX_DECLARED_FILE_BYTES = 5 * 1024 * 1024
MAX_BUNDLE_BYTES = 20 * 1024 * 1024
MAX_GALLERY_REQUEST_BYTES = 32 * 1024
MAX_GALLERY_RUNS = 100
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_HTML_RESOURCE = resources.files("TokenLab").joinpath("dashboard_static/index.html")
_GALLERY_HTML_RESOURCE = resources.files("TokenLab").joinpath(
    "dashboard_static/gallery.html"
)
_SAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")
_GALLERY_RUN_LOCK = threading.Lock()


class DashboardError(ValueError):
    """Raised when a bundle cannot be safely presented by the dashboard."""


@dataclass(frozen=True)
class DashboardApplication:
    """Validated browser payload plus its exact download allowlist."""

    payload: Dict[str, Any]
    downloads: Dict[str, Tuple[str, bytes]]


class GalleryBusyError(RuntimeError):
    """Raised when a second run arrives while the process-global RNG is in use."""


class GalleryCapacityError(RuntimeError):
    """Raised when a gallery process reaches its bounded completed-run limit."""


@dataclass
class GalleryApplication:
    """Validated registry runner plus completed immutable download snapshots."""

    gallery: Any
    catalog: Dict[str, Any]
    runs: Dict[str, DashboardApplication] = field(default_factory=dict)
    run_lock: threading.Lock = field(default_factory=lambda: _GALLERY_RUN_LOCK)
    jobs: Any = None

    def execute(self, request: Any) -> Dict[str, Any]:
        if not self.run_lock.acquire(blocking=False):
            raise GalleryBusyError("another simulation is already running")
        try:
            if len(self.runs) >= MAX_GALLERY_RUNS:
                raise GalleryCapacityError(
                    "gallery run limit reached; restart with a fresh output directory"
                )
            completed = self.gallery.run_request(request)
            dashboard = deepcopy(completed.application.payload)
            run_id = dashboard.get("run", {}).get("run_id")
            if not isinstance(run_id, str) or not run_id:
                raise DashboardError("completed gallery run has no safe run id")
            for item in dashboard.get("downloads", []):
                artifact_id = item.get("id")
                item["url"] = (
                    f"/api/runs/{quote(run_id, safe='')}/download/"
                    f"{quote(str(artifact_id), safe='')}"
                )
            self.runs[run_id] = completed.application
            return {
                "status": "success",
                "demo_id": completed.demo_id,
                "preset_id": completed.preset_id,
                "run_id": run_id,
                "resolved_parameters": dict(completed.resolved_parameters),
                "dashboard": dashboard,
            }
        finally:
            self.run_lock.release()


def validate_host(host: str) -> str:
    """Return a supported loopback host or fail before binding."""

    if host not in LOOPBACK_HOSTS:
        raise DashboardError(
            "dashboard host must be loopback: 127.0.0.1, localhost, or ::1"
        )
    return host


def _safe_declared_path(root: Path, relative: Any, field: str) -> Path:
    if not isinstance(relative, str) or not relative.strip():
        raise DashboardError(f"{field} must be a non-empty safe relative path")
    relative_path = Path(relative.strip())
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise DashboardError(f"{field} must be a safe relative path")

    candidate = root / relative_path
    if candidate.is_symlink():
        raise DashboardError(f"{field} must not be a symlink")
    try:
        resolved_root = root.resolve(strict=True)
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise DashboardError(f"{field} references a missing declared file") from exc
    if resolved == resolved_root or resolved_root not in resolved.parents:
        raise DashboardError(f"{field} escapes the bundle directory")
    if not resolved.is_file():
        raise DashboardError(f"{field} must reference a regular file")
    return resolved


def preflight_bundle(
    bundle_dir: str | Path,
) -> Tuple[Dict[str, Any], Dict[Tuple[str, str], Path]]:
    """Bound manifest-declared content before the canonical validator parses it."""

    root = Path(bundle_dir)
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise DashboardError("bundle manifest is missing or unreadable")
    manifest_bytes = manifest_path.stat().st_size
    if manifest_bytes > MAX_MANIFEST_BYTES:
        raise DashboardError("bundle manifest exceeds the dashboard byte limit")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DashboardError("bundle manifest is invalid JSON") from exc
    if not isinstance(manifest, Mapping):
        raise DashboardError("bundle manifest must be an object")

    declared_paths: Dict[Tuple[str, str], Path] = {}
    unique_paths = set()
    total_bytes = manifest_bytes
    for group_name in ("outputs", "attachments"):
        group = manifest.get(group_name)
        if not isinstance(group, Mapping):
            raise DashboardError(f"manifest.{group_name} must be an object")
        for item_id, metadata in group.items():
            if not isinstance(item_id, str) or not isinstance(metadata, Mapping):
                raise DashboardError(
                    f"manifest.{group_name} entries must be named objects"
                )
            path = _safe_declared_path(
                root,
                metadata.get("path"),
                f"manifest.{group_name}.{item_id}.path",
            )
            size = path.stat().st_size
            if size > MAX_DECLARED_FILE_BYTES:
                raise DashboardError(
                    f"manifest.{group_name}.{item_id} exceeds the per-file byte limit"
                )
            if path not in unique_paths:
                unique_paths.add(path)
                total_bytes += size
            declared_paths[(group_name, item_id)] = path

    if total_bytes > MAX_BUNDLE_BYTES:
        raise DashboardError("declared bundle content exceeds the aggregate byte limit")
    return dict(manifest), declared_paths


def _json_number(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, numbers.Real):
        return None
    converted = float(value)
    if not math.isfinite(converted):
        return None
    if isinstance(value, numbers.Integral):
        return int(value)
    return converted


def _json_axis_value(value: Any) -> str | int | float | None:
    if isinstance(value, str):
        return value
    return _json_number(value)


def _require_table_column(
    tables: Mapping[str, Any], artifact: Any, column: Any, field: str
):
    if not isinstance(artifact, str) or artifact not in tables:
        raise DashboardError(f"{field} references an unavailable source artifact")
    table = tables[artifact]
    if not isinstance(column, str) or column not in table.columns:
        raise DashboardError(f"{field} references an unavailable source column")
    return table[column]


def build_dashboard_payload(
    manifest: Mapping[str, Any],
    profile: Mapping[str, Any],
    tables: Mapping[str, Any],
) -> Dict[str, Any]:
    """Project a JSON-safe view from profile declarations, never raw columns."""

    time_source = profile.get("time_axis")
    if not isinstance(time_source, Mapping):
        raise DashboardError("profile time_axis must be an object")
    time_values = list(
        _require_table_column(
            tables,
            time_source.get("artifact"),
            time_source.get("column"),
            "time_axis",
        )
    )

    metrics = []
    warnings = []
    for declaration in profile.get("metrics", []):
        if not isinstance(declaration, Mapping):
            raise DashboardError("profile metrics must contain objects")
        source = declaration.get("source")
        if not isinstance(source, Mapping):
            raise DashboardError("metric source must be an object")
        values = list(
            _require_table_column(
                tables,
                source.get("artifact"),
                source.get("column"),
                f"metric {declaration.get('id', '<unknown>')}",
            )
        )
        if len(values) != len(time_values):
            raise DashboardError(
                f"metric {declaration.get('id', '<unknown>')} does not align "
                "with the declared time axis"
            )
        points = [
            {"x": _json_axis_value(x_value), "y": _json_number(y_value)}
            for x_value, y_value in zip(time_values, values)
        ]
        if not points:
            metric_state = "empty"
        elif any(point["x"] is None or point["y"] is None for point in points):
            metric_state = "partial"
        else:
            metric_state = "complete"
        if metric_state != "complete":
            warnings.append(
                {
                    "code": f"{metric_state}_metric",
                    "metric_id": declaration.get("id"),
                }
            )
        metrics.append(
            {
                "id": declaration.get("id"),
                "label": declaration.get("label"),
                "unit": declaration.get("unit"),
                "aggregation": declaration.get("aggregation"),
                "description": declaration.get("description"),
                "source": {
                    "artifact": source.get("artifact"),
                    "column": source.get("column"),
                },
                "state": metric_state,
                "points": points,
            }
        )

    if metrics and all(metric["state"] == "empty" for metric in metrics):
        state = "empty"
    elif any(metric["state"] != "complete" for metric in metrics):
        state = "partial"
    else:
        state = "success"

    outputs = manifest.get("outputs", {})
    downloads = []
    for artifact_id, declaration in profile.get("source_artifacts", {}).items():
        metadata = outputs.get(artifact_id, {})
        downloads.append(
            {
                "id": artifact_id,
                "label": declaration.get("role"),
                "filename": Path(str(metadata.get("path", ""))).name,
                "rows": metadata.get("rows"),
                "sha256": metadata.get("sha256"),
                "reproducible_content_sha256": metadata.get(
                    "reproducible_content_sha256"
                ),
                "url": f"/download/{quote(str(artifact_id), safe='')}",
            }
        )

    monte_carlo = manifest.get("monte_carlo", {})
    payload = {
        "dashboard_version": DASHBOARD_VERSION,
        "state": state,
        "profile": {
            "id": profile.get("profile_id"),
            "version": profile.get("profile_version"),
            "scenario_id": profile.get("scenario_id"),
        },
        "run": {
            "run_id": manifest.get("run_id"),
            "scenario_id": manifest.get("scenario_id"),
            "config_hash": manifest.get("config_hash"),
            "seed": manifest.get("seed"),
            "created_at": manifest.get("created_at"),
            "iterations": monte_carlo.get("iterations"),
            "repetitions": monte_carlo.get("repetitions"),
        },
        "time_axis": {
            "label": time_source.get("label"),
            "unit": time_source.get("unit"),
        },
        "metrics": metrics,
        "unavailable_concepts": list(profile.get("unavailable_concepts", [])),
        "downloads": downloads,
        "repeatability": dict(profile.get("repeatability", {})),
        "variability": dict(profile.get("variability", {})),
        "interpretation_boundary": profile.get("interpretation_boundary"),
        "warnings": warnings,
    }
    try:
        json.dumps(payload, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise DashboardError("dashboard payload is not JSON-safe") from exc
    return payload


def _read_declared_table(path: Path, file_format: Any):
    import pandas as pd

    if file_format == "csv":
        return pd.read_csv(path)
    if file_format == "parquet":
        return pd.read_parquet(path)
    raise DashboardError(f"unsupported validated table format {file_format!r}")


def load_dashboard(bundle_dir: str | Path) -> DashboardApplication:
    """Validate a bundle and build its declared-only dashboard application."""

    root = Path(bundle_dir)
    initial_manifest, _ = preflight_bundle(root)

    from .agentic.artifact_profile import validate_bundle

    validate_bundle(root)
    manifest, declared_paths = preflight_bundle(root)
    if manifest != initial_manifest:
        raise DashboardError("bundle manifest changed during validation")

    profile_path = declared_paths.get(("attachments", "artifact_profile"))
    if profile_path is None:
        raise DashboardError("validated bundle has no artifact profile")
    try:
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DashboardError("validated artifact profile is unreadable") from exc

    required_artifacts = set(profile.get("source_artifacts", {}))
    time_axis = profile.get("time_axis", {})
    if isinstance(time_axis, Mapping) and isinstance(time_axis.get("artifact"), str):
        required_artifacts.add(time_axis["artifact"])
    for metric in profile.get("metrics", []):
        source = metric.get("source", {}) if isinstance(metric, Mapping) else {}
        if isinstance(source.get("artifact"), str):
            required_artifacts.add(source["artifact"])

    tables = {}
    for artifact_id in required_artifacts:
        metadata = manifest.get("outputs", {}).get(artifact_id)
        path = declared_paths.get(("outputs", artifact_id))
        if not isinstance(metadata, Mapping) or path is None:
            raise DashboardError(
                f"profile references undeclared output {artifact_id!r}"
            )
        tables[artifact_id] = _read_declared_table(path, metadata.get("format"))

    payload = build_dashboard_payload(manifest, profile, tables)
    downloads = {}
    for artifact_id in profile.get("source_artifacts", {}):
        path = declared_paths.get(("outputs", artifact_id))
        metadata = manifest.get("outputs", {}).get(artifact_id, {})
        if path is None or not isinstance(metadata, Mapping):
            continue
        body = path.read_bytes()
        if hashlib.sha256(body).hexdigest() != metadata.get("sha256"):
            raise DashboardError(
                f"downloadable output {artifact_id!r} changed during validation"
            )
        downloads[artifact_id] = (path.name, body)
    return DashboardApplication(payload=payload, downloads=downloads)


def _sanitized_error(exc: Exception, root: Path) -> str:
    message = str(exc).strip() or exc.__class__.__name__
    sensitive_values = {str(root), str(root.resolve()), root.name}
    for sensitive in sorted(sensitive_values, key=len, reverse=True):
        if sensitive:
            message = message.replace(sensitive, "bundle")
    return f"Invalid artifact bundle: {message}"


def build_dashboard_application(bundle_dir: str | Path) -> DashboardApplication:
    """Return success/partial/empty data or a safe invalid-state application."""

    root = Path(bundle_dir)
    try:
        return load_dashboard(root)
    except (DashboardError, OSError, ValueError, json.JSONDecodeError) as exc:
        return DashboardApplication(
            payload={
                "dashboard_version": DASHBOARD_VERSION,
                "state": "invalid",
                "error": _sanitized_error(exc, root),
                "metrics": [],
                "unavailable_concepts": [],
                "downloads": [],
                "warnings": [{"code": "invalid_bundle"}],
            },
            downloads={},
        )


def dashboard_html() -> bytes:
    """Load the self-contained dashboard asset from package data."""

    try:
        return _HTML_RESOURCE.read_bytes()
    except (FileNotFoundError, OSError) as exc:
        raise DashboardError("packaged dashboard asset is missing") from exc


def gallery_html() -> bytes:
    """Load the self-contained interactive gallery asset from package data."""

    try:
        return _GALLERY_HTML_RESOURCE.read_bytes()
    except (FileNotFoundError, OSError) as exc:
        raise DashboardError("packaged gallery asset is missing") from exc


def _safe_download_name(filename: str) -> str:
    basename = Path(filename).name
    return _SAFE_FILENAME.sub("-", basename).strip(".-") or "artifact"


def _make_handler(application: DashboardApplication, html: bytes):
    class DashboardHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "TokenLabDashboard/1"

        def log_message(self, format, *args):
            return

        def _host_is_allowed(self) -> bool:
            host_header = self.headers.get("Host", "")
            try:
                hostname = urlsplit(f"//{host_header}").hostname
            except ValueError:
                return False
            return hostname in LOOPBACK_HOSTS

        def _send_bytes(
            self,
            status: int,
            body: bytes,
            content_type: str,
            *,
            head_only: bool,
            extra_headers: Mapping[str, str] | None = None,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'none'; script-src 'unsafe-inline'; "
                "style-src 'unsafe-inline'; connect-src 'self'; "
                "img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
            )
            for name, value in (extra_headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def _send_json(self, status: int, value: Any, *, head_only: bool) -> None:
            body = json.dumps(
                value, allow_nan=False, separators=(",", ":")
            ).encode("utf-8")
            self._send_bytes(
                status,
                body,
                "application/json; charset=utf-8",
                head_only=head_only,
            )

        def _route(self, *, head_only: bool) -> None:
            if not self._host_is_allowed():
                self._send_json(
                    400,
                    {"status": "error", "error": "invalid Host header"},
                    head_only=head_only,
                )
                return
            path = unquote(urlsplit(self.path).path)
            if path == "/":
                self._send_bytes(
                    200,
                    html,
                    "text/html; charset=utf-8",
                    head_only=head_only,
                )
                return
            if path == "/api/dashboard":
                self._send_json(200, application.payload, head_only=head_only)
                return
            if path == "/api/health":
                bundle_state = application.payload.get("state", "invalid")
                health_status = 503 if bundle_state == "invalid" else 200
                self._send_json(
                    health_status,
                    {
                        "status": "error" if health_status == 503 else "ok",
                        "bundle_state": bundle_state,
                    },
                    head_only=head_only,
                )
                return
            if path.startswith("/download/"):
                artifact_id = path[len("/download/") :]
                artifact = application.downloads.get(artifact_id)
                if artifact is not None:
                    artifact_filename, body = artifact
                    media_type = (
                        "text/csv; charset=utf-8"
                        if Path(artifact_filename).suffix.lower() == ".csv"
                        else "application/octet-stream"
                    )
                    filename = _safe_download_name(artifact_filename)
                    self._send_bytes(
                        200,
                        body,
                        media_type,
                        head_only=head_only,
                        extra_headers={
                            "Content-Disposition": f'attachment; filename="{filename}"'
                        },
                    )
                    return
            self._send_json(
                404,
                {"status": "error", "error": "not found"},
                head_only=head_only,
            )

        def do_GET(self):
            self._route(head_only=False)

        def do_HEAD(self):
            self._route(head_only=True)

        def _reject_mutation(self):
            self._send_json(
                405,
                {"status": "error", "error": "method not allowed"},
                head_only=False,
            )

        do_POST = _reject_mutation
        do_PUT = _reject_mutation
        do_PATCH = _reject_mutation
        do_DELETE = _reject_mutation
        do_OPTIONS = _reject_mutation
        do_TRACE = _reject_mutation

    return DashboardHandler


def _make_gallery_handler(application: GalleryApplication, html: bytes):
    from .agentic.artifact_profile import ArtifactProfileError
    from .agentic.gallery import GalleryError
    from .agentic.runner import ArtifactError

    class GalleryHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "TokenLabGallery/1"

        def log_message(self, format, *args):
            return

        def _host_is_allowed(self) -> bool:
            host_header = self.headers.get("Host", "")
            try:
                hostname = urlsplit(f"//{host_header}").hostname
            except ValueError:
                return False
            return hostname in LOOPBACK_HOSTS

        def _send_bytes(
            self,
            status: int,
            body: bytes,
            content_type: str,
            *,
            head_only: bool,
            extra_headers: Mapping[str, str] | None = None,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'none'; script-src 'unsafe-inline'; "
                "style-src 'unsafe-inline'; connect-src 'self'; "
                "img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
            )
            for name, value in (extra_headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def _send_json(self, status: int, value: Any, *, head_only: bool = False):
            body = json.dumps(
                value, allow_nan=False, separators=(",", ":")
            ).encode("utf-8")
            self._send_bytes(
                status,
                body,
                "application/json; charset=utf-8",
                head_only=head_only,
            )

        def _allowed_host_or_error(self, *, head_only: bool = False) -> bool:
            if self._host_is_allowed():
                return True
            self._send_json(
                400,
                {"status": "error", "state": "invalid", "error": "invalid Host header"},
                head_only=head_only,
            )
            return False

        def _download(self, path: str, *, head_only: bool) -> bool:
            match = re.fullmatch(
                r"/api/runs/([A-Za-z0-9][A-Za-z0-9._-]{0,127})/download/"
                r"([A-Za-z0-9][A-Za-z0-9._-]{0,127})",
                path,
            )
            if match is None:
                return False
            run_id, artifact_id = match.groups()
            run = application.runs.get(run_id)
            artifact = run.downloads.get(artifact_id) if run is not None else None
            if artifact is None:
                return False
            filename, body = artifact
            media_type = (
                "text/csv; charset=utf-8"
                if Path(filename).suffix.lower() == ".csv"
                else "application/octet-stream"
            )
            self._send_bytes(
                200,
                body,
                media_type,
                head_only=head_only,
                extra_headers={
                    "Content-Disposition": (
                        f'attachment; filename="{_safe_download_name(filename)}"'
                    )
                },
            )
            return True

        def _read_route(self, *, head_only: bool) -> None:
            if not self._allowed_host_or_error(head_only=head_only):
                return
            path = unquote(urlsplit(self.path).path)
            if path == "/":
                self._send_bytes(
                    200, html, "text/html; charset=utf-8", head_only=head_only
                )
                return
            if path == "/api/gallery":
                self._send_json(200, application.catalog, head_only=head_only)
                return
            if path == "/api/health":
                self._send_json(
                    200, {"status": "ok", "mode": "gallery"}, head_only=head_only
                )
                return
            status_match = re.fullmatch(
                r"/api/stochastic/runs/([A-Za-z0-9][A-Za-z0-9._-]{0,63})", path
            )
            if status_match is not None:
                job = (
                    application.jobs.status(status_match.group(1))
                    if application.jobs is not None
                    else None
                )
                if job is None:
                    self._send_json(
                        404,
                        {
                            "status": "error",
                            "state": "invalid",
                            "error": "not found",
                        },
                        head_only=head_only,
                    )
                    return
                self._send_json(200, job, head_only=head_only)
                return
            download_match = re.fullmatch(
                r"/api/stochastic/runs/([A-Za-z0-9][A-Za-z0-9._-]{0,63})"
                r"/download/([A-Za-z0-9][A-Za-z0-9._-]{0,127})",
                path,
            )
            if download_match is not None:
                artifact = (
                    application.jobs.download(*download_match.groups())
                    if application.jobs is not None
                    else None
                )
                if artifact is not None:
                    filename, body = artifact
                    media_type = (
                        "text/csv; charset=utf-8"
                        if Path(filename).suffix.lower() == ".csv"
                        else "application/octet-stream"
                    )
                    self._send_bytes(
                        200,
                        body,
                        media_type,
                        head_only=head_only,
                        extra_headers={
                            "Content-Disposition": (
                                "attachment; "
                                f'filename="{_safe_download_name(filename)}"'
                            )
                        },
                    )
                    return
                self._send_json(
                    404,
                    {"status": "error", "state": "invalid", "error": "not found"},
                    head_only=head_only,
                )
                return
            if self._download(path, head_only=head_only):
                return
            self._send_json(
                404,
                {"status": "error", "state": "invalid", "error": "not found"},
                head_only=head_only,
            )

        def do_GET(self):
            self._read_route(head_only=False)

        def do_HEAD(self):
            self._read_route(head_only=True)

        def _read_json_body(self):
            """Read a bounded JSON body; sends the error and returns None on failure."""
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
            if content_type != "application/json":
                self._send_json(
                    415,
                    {
                        "status": "error",
                        "state": "invalid",
                        "error": "Content-Type must be application/json",
                    },
                )
                return None
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                length = -1
            if length < 0:
                self._send_json(
                    411,
                    {
                        "status": "error",
                        "state": "invalid",
                        "error": "valid Content-Length is required",
                    },
                )
                return None
            if length > MAX_GALLERY_REQUEST_BYTES:
                self._send_json(
                    413,
                    {
                        "status": "error",
                        "state": "invalid",
                        "error": "request exceeds the gallery byte limit",
                    },
                )
                return None
            body = self.rfile.read(length)
            try:
                return json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(
                    400,
                    {
                        "status": "error",
                        "state": "invalid",
                        "error": "request must contain valid JSON",
                    },
                )
                return None

        def _post_stochastic_run(self) -> None:
            from .agentic.gallery import (
                InvalidSpecError,
                StochasticBusyError,
                StochasticCapacityError,
            )

            if application.jobs is None:
                self._send_json(
                    404,
                    {"status": "error", "state": "invalid", "error": "not found"},
                )
                return
            request = self._read_json_body()
            if request is None:
                return
            try:
                job = application.jobs.start(request)
            except InvalidSpecError as exc:
                self._send_json(
                    400,
                    {
                        "status": "error",
                        "state": "invalid-spec",
                        "error": str(exc),
                        "validation": exc.validation,
                    },
                )
                return
            except GalleryError as exc:
                self._send_json(
                    400,
                    {"status": "error", "state": "invalid", "error": str(exc)},
                )
                return
            except StochasticBusyError as exc:
                self._send_json(
                    409,
                    {"status": "error", "state": "running", "error": str(exc)},
                )
                return
            except StochasticCapacityError as exc:
                self._send_json(
                    429,
                    {"status": "error", "state": "invalid", "error": str(exc)},
                )
                return
            except Exception:
                self._send_json(
                    422,
                    {
                        "status": "error",
                        "state": "backend-error",
                        "error": "simulation could not be completed or validated",
                    },
                )
                return
            self._send_json(202, job)

        def _cancel_stochastic_run(self, job_id: str) -> None:
            try:
                length = int(self.headers.get("Content-Length", "0") or "0")
            except ValueError:
                length = 0
            if 0 < length <= MAX_GALLERY_REQUEST_BYTES:
                self.rfile.read(length)
            job = (
                application.jobs.cancel(job_id)
                if application.jobs is not None
                else None
            )
            if job is None:
                self._send_json(
                    404,
                    {"status": "error", "state": "invalid", "error": "not found"},
                )
                return
            self._send_json(200, job)

        def do_POST(self):
            if not self._allowed_host_or_error():
                return
            path = unquote(urlsplit(self.path).path)
            if path == "/api/stochastic/runs":
                self._post_stochastic_run()
                return
            cancel_match = re.fullmatch(
                r"/api/stochastic/runs/([A-Za-z0-9][A-Za-z0-9._-]{0,63})/cancel",
                path,
            )
            if cancel_match is not None:
                self._cancel_stochastic_run(cancel_match.group(1))
                return
            if path != "/api/runs":
                self._send_json(
                    404,
                    {"status": "error", "state": "invalid", "error": "not found"},
                )
                return
            request = self._read_json_body()
            if request is None:
                return
            try:
                result = application.execute(request)
            except GalleryBusyError as exc:
                self._send_json(
                    409,
                    {"status": "error", "state": "running", "error": str(exc)},
                )
                return
            except GalleryCapacityError as exc:
                self._send_json(
                    429,
                    {"status": "error", "state": "invalid", "error": str(exc)},
                )
                return
            except GalleryError as exc:
                self._send_json(
                    400,
                    {"status": "error", "state": "invalid", "error": str(exc)},
                )
                return
            except (ArtifactError, ArtifactProfileError, DashboardError, OSError):
                self._send_json(
                    422,
                    {
                        "status": "error",
                        "state": "invalid",
                        "error": "simulation could not be completed or validated",
                    },
                )
                return
            except Exception:
                self._send_json(
                    422,
                    {
                        "status": "error",
                        "state": "invalid",
                        "error": "simulation could not be completed or validated",
                    },
                )
                return
            self._send_json(201, result)

        def _reject_mutation(self):
            self._send_json(
                405,
                {"status": "error", "state": "invalid", "error": "method not allowed"},
            )

        do_PUT = _reject_mutation
        do_PATCH = _reject_mutation
        do_DELETE = _reject_mutation
        do_OPTIONS = _reject_mutation
        do_TRACE = _reject_mutation

    return GalleryHandler


def create_server(
    bundle_dir: str | Path,
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
    application: DashboardApplication | None = None,
) -> ThreadingHTTPServer:
    """Create, but do not start, the bounded dashboard HTTP server."""

    validate_host(host)
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise DashboardError("dashboard port must be an integer from 0 to 65535")
    app = application or build_dashboard_application(bundle_dir)
    handler = _make_handler(app, dashboard_html())
    server_class = ThreadingHTTPServer
    if host == "::1":
        class IPv6DashboardServer(ThreadingHTTPServer):
            address_family = socket.AF_INET6

        server_class = IPv6DashboardServer
    server = server_class((host, port), handler)
    server.daemon_threads = True
    return server


def create_gallery_server(
    output_dir: str | Path = "outputs/demo-gallery",
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
    application: GalleryApplication | None = None,
) -> ThreadingHTTPServer:
    """Create, but do not start, the bounded interactive gallery server."""

    validate_host(host)
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise DashboardError("dashboard port must be an integer from 0 to 65535")
    if application is None:
        from .agentic.gallery import DemoGallery

        gallery = DemoGallery(output_dir)
        application = GalleryApplication(gallery=gallery, catalog=gallery.catalog())
    if application.jobs is None:
        from .agentic.gallery import StochasticJobManager

        application.jobs = StochasticJobManager(
            application.gallery, run_lock=application.run_lock
        )
    handler = _make_gallery_handler(application, gallery_html())
    server_class = ThreadingHTTPServer
    if host == "::1":
        class IPv6GalleryServer(ThreadingHTTPServer):
            address_family = socket.AF_INET6

        server_class = IPv6GalleryServer
    server = server_class((host, port), handler)
    server.daemon_threads = True
    server.gallery_application = application
    return server


def _load_application_quietly(bundle_dir: str | Path) -> DashboardApplication:
    """Capture noisy native import diagnostics for the installed command."""

    original_stdout = os.dup(1)
    original_stderr = os.dup(2)
    try:
        with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as stream:
            sys.stdout.flush()
            sys.stderr.flush()
            os.dup2(stream.fileno(), 1)
            os.dup2(stream.fileno(), 2)
            try:
                return build_dashboard_application(bundle_dir)
            finally:
                sys.stdout.flush()
                sys.stderr.flush()
                os.dup2(original_stdout, 1)
                os.dup2(original_stderr, 2)
    finally:
        os.close(original_stdout)
        os.close(original_stderr)


def _port(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("port must be an integer") from exc
    if not 0 <= parsed <= 65535:
        raise argparse.ArgumentTypeError("port must be from 0 to 65535")
    return parsed


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Explore reviewed TokenLab scenarios or inspect one validated "
            "artifact bundle locally."
        )
    )
    parser.add_argument(
        "bundle",
        nargs="?",
        help="Path to a completed public-demo bundle (legacy read-only mode)",
    )
    parser.add_argument(
        "--gallery",
        action="store_true",
        help="Run the interactive reviewed-scenario gallery",
    )
    parser.add_argument(
        "--output-dir",
        help="Gallery-only directory for non-overwriting run bundles",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Loopback host")
    parser.add_argument("--port", default=8765, type=_port, help="Local port")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        validate_host(args.host)
        if args.gallery:
            if args.bundle is not None:
                raise DashboardError("bundle path cannot be combined with --gallery")
            output_dir = args.output_dir or "outputs/demo-gallery"
            server = create_gallery_server(
                output_dir,
                host=args.host,
                port=args.port,
            )
            application = None
        else:
            if args.bundle is None:
                raise DashboardError("bundle path is required unless --gallery is used")
            if args.output_dir is not None:
                raise DashboardError("--output-dir is valid only with --gallery")
            application = _load_application_quietly(args.bundle)
            server = create_server(
                args.bundle,
                host=args.host,
                port=args.port,
                application=application,
            )
    except (DashboardError, OSError) as exc:
        print(f"TokenLab dashboard: FAIL — {exc}", file=sys.stderr)
        return 1

    display_host = f"[{args.host}]" if ":" in args.host else args.host
    print("TokenLab dashboard: READY")
    print(f"URL: http://{display_host}:{server.server_port}")
    if args.gallery:
        print(f"Runs: {args.output_dir or 'outputs/demo-gallery'}")
        print(
            "Boundary: local illustrative scenario explorer; not investment, "
            "launch, legal, financial, forecast, or decision-grade advice."
        )
    else:
        print(f"Bundle state: {application.payload['state']}")
        print("Boundary: local read-only artifact view; press Ctrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

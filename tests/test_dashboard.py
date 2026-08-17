# @planner:story = US-002
# @planner:proves = crit:CRIT-001,crit:CRIT-002,crit:CRIT-003,crit:CRIT-004,crit:CRIT-005

import copy
import json
from pathlib import Path
import re
import shutil
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pandas as pd
import pytest

from TokenLab.agentic.demo import run_public_demo
from TokenLab.dashboard import (
    MAX_MANIFEST_BYTES,
    DashboardError,
    build_dashboard_application,
    build_dashboard_payload,
    create_server,
    dashboard_html,
    load_dashboard,
    preflight_bundle,
    validate_host,
)


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_METRICS = {
    "token_price",
    "fiat_transaction_volume",
    "transaction_count",
    "user_count",
    "holding_time",
    "token_supply",
}
EXPECTED_UNAVAILABLE = {
    "emissions",
    "vesting_unlocks",
    "liquidity",
    "treasury",
    "governance",
    "staking_yield",
    "fdv",
    "apy",
}


@pytest.fixture(scope="module")
def dashboard_bundle(tmp_path_factory):
    root = tmp_path_factory.mktemp("dashboard") / "runs"
    artifacts, validation = run_public_demo(root, run_id="dashboard-proof")
    assert validation["status"] == "pass"
    return artifacts.bundle_dir


def _json_get(base_url, route):
    with urlopen(f"{base_url}{route}", timeout=5) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def test_dashboard_projects_only_profile_declared_metrics(dashboard_bundle):
    app = load_dashboard(dashboard_bundle)
    payload = app.payload

    assert payload["dashboard_version"] == 1
    assert payload["state"] == "success"
    assert {metric["id"] for metric in payload["metrics"]} == EXPECTED_METRICS
    assert {
        concept["id"] for concept in payload["unavailable_concepts"]
    } == EXPECTED_UNAVAILABLE
    assert len(payload["metrics"]) == 6
    assert all(len(metric["points"]) == 24 for metric in payload["metrics"])
    assert all(metric["state"] == "complete" for metric in payload["metrics"])
    assert {item["id"] for item in payload["downloads"]} == {
        "results",
        "iteration_summary",
    }
    assert payload["run"]["run_id"] == "dashboard-proof"
    assert payload["run"]["iterations"] == 24
    assert payload["run"]["repetitions"] == 4
    assert "not investment" in payload["interpretation_boundary"].lower()

    serialized = json.dumps(payload, allow_nan=False)
    for raw_only_column in (
        "TLAB_price_std",
        "transactions_TLAB_mean",
        "effective_holding_time_mean",
        "repetition_run",
    ):
        assert raw_only_column not in serialized


def test_dashboard_payload_marks_partial_and_empty_series(dashboard_bundle):
    manifest = json.loads((dashboard_bundle / "manifest.json").read_text())
    profile = json.loads((dashboard_bundle / "artifact_profile.json").read_text())
    summary = pd.read_csv(dashboard_bundle / "iteration_summary.csv")

    partial_tables = {"iteration_summary": summary.copy()}
    partial_tables["iteration_summary"].loc[2, "TLAB_price_mean"] = float("nan")
    partial = build_dashboard_payload(manifest, profile, partial_tables)
    price = next(item for item in partial["metrics"] if item["id"] == "token_price")
    assert partial["state"] == "partial"
    assert price["state"] == "partial"
    assert price["points"][2]["y"] is None
    json.dumps(partial, allow_nan=False)

    empty_tables = {"iteration_summary": summary.iloc[0:0].copy()}
    empty = build_dashboard_payload(manifest, profile, empty_tables)
    assert empty["state"] == "empty"
    assert all(metric["state"] == "empty" for metric in empty["metrics"])
    assert all(metric["points"] == [] for metric in empty["metrics"])


def test_invalid_bundle_becomes_sanitized_read_only_application(tmp_path):
    missing = tmp_path / "private-bundle-name"
    app = build_dashboard_application(missing)

    assert app.payload["state"] == "invalid"
    assert app.downloads == {}
    assert "private-bundle-name" not in json.dumps(app.payload)
    assert "manifest" in app.payload["error"].lower()


def test_preflight_rejects_oversize_manifest_before_json_parse(tmp_path):
    bundle = tmp_path / "oversize"
    bundle.mkdir()
    (bundle / "manifest.json").write_bytes(b" " * (MAX_MANIFEST_BYTES + 1))

    with pytest.raises(DashboardError, match="manifest.*byte limit"):
        preflight_bundle(bundle)


def test_preflight_rejects_parent_and_symlink_escape(dashboard_bundle, tmp_path):
    parent_escape = tmp_path / "parent-escape"
    shutil.copytree(dashboard_bundle, parent_escape)
    manifest_path = parent_escape / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["outputs"]["results"]["path"] = "../outside.csv"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(DashboardError, match="safe relative path"):
        preflight_bundle(parent_escape)

    symlink_escape = tmp_path / "symlink-escape"
    shutil.copytree(dashboard_bundle, symlink_escape)
    outside = tmp_path / "outside.log"
    outside.write_text("outside", encoding="utf-8")
    escape_link = symlink_escape / "escape.log"
    escape_link.symlink_to(outside)
    manifest_path = symlink_escape / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["attachments"]["diagnostics"]["path"] = "escape.log"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(DashboardError, match="symlink|escapes"):
        preflight_bundle(symlink_escape)


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
def test_loopback_hosts_are_accepted(host):
    assert validate_host(host) == host


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.20", "example.com", ""])
def test_non_loopback_hosts_are_rejected(host):
    with pytest.raises(DashboardError, match="loopback"):
        validate_host(host)


def test_http_server_exposes_only_read_routes_and_allowlisted_downloads(
    dashboard_bundle,
):
    server = create_server(dashboard_bundle, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        status, health = _json_get(base_url, "/api/health")
        assert status == 200
        assert health == {"status": "ok", "bundle_state": "success"}

        status, payload = _json_get(base_url, "/api/dashboard")
        assert status == 200
        assert payload["state"] == "success"
        assert {metric["id"] for metric in payload["metrics"]} == EXPECTED_METRICS

        with urlopen(f"{base_url}/", timeout=5) as response:
            assert response.status == 200
            assert response.headers["Content-Type"].startswith("text/html")
            assert b"TokenLab" in response.read()

        with urlopen(f"{base_url}/download/results", timeout=5) as response:
            assert response.status == 200
            assert response.headers["Content-Type"].startswith("text/csv")
            assert b"run_id" in response.read(512)

        head = Request(f"{base_url}/api/dashboard", method="HEAD")
        with urlopen(head, timeout=5) as response:
            assert response.status == 200
            assert response.read() == b""

        for route in ("/download/manifest", "/download/..%2Fmanifest.json", "/nope"):
            with pytest.raises(HTTPError) as error:
                urlopen(f"{base_url}{route}", timeout=5)
            assert error.value.code == 404

        post = Request(f"{base_url}/api/dashboard", data=b"{}", method="POST")
        with pytest.raises(HTTPError) as error:
            urlopen(post, timeout=5)
        assert error.value.code == 405
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_server_downloads_the_validated_snapshot_if_bundle_changes_after_start(
    dashboard_bundle, tmp_path
):
    bundle = tmp_path / "mutable-bundle"
    shutil.copytree(dashboard_bundle, bundle)
    expected = (bundle / "results.csv").read_bytes()
    server = create_server(bundle, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        (bundle / "results.csv").write_text(
            "unvalidated,content\n1,2\n", encoding="utf-8"
        )
        with urlopen(f"{base_url}/download/results", timeout=5) as response:
            assert response.read() == expected
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_packaged_ui_has_five_states_responsive_a11y_and_no_remote_assets():
    html = dashboard_html().decode("utf-8")
    lower = html.lower()

    for state in ("loading", "empty", "partial", "invalid", "success"):
        assert state in lower
    for landmark in ("<header", "<main", "<section", "<footer"):
        assert landmark in lower
    assert 'aria-live="polite"' in lower
    assert 'role="img"' in lower
    assert ":focus-visible" in lower
    assert "@media (max-width: 720px)" in lower
    assert "@media (max-width: 420px)" in lower
    assert 'fetch("/api/dashboard"' in html
    assert "const segments = [];" in html
    assert "segments.forEach" in html
    assert "#state-panel { display: none; }" in html
    assert not re.search(r"(?:src|href)\s*=\s*[\"']https?://", html, re.I)
    assert "eval(" not in html
    assert "new Function(" not in html


def test_dashboard_entry_point_package_data_and_demo_docs_are_wired():
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    guide = (ROOT / "docs/public-demo.md").read_text(encoding="utf-8")

    assert 'tokenlab-dashboard = "TokenLab.dashboard:main"' in pyproject
    assert '"TokenLab" = ["dashboard_static/*.html"]' in pyproject
    assert "tokenlab-dashboard outputs/demo/public-demo" in readme
    assert "tokenlab-dashboard outputs/demo/public-demo" in guide


def test_legacy_viewer_contract(dashboard_bundle):
    """The Phase 5 stochastic additions leave the v1 viewer contract intact."""
    app = load_dashboard(dashboard_bundle)
    payload = app.payload

    assert set(payload) == {
        "dashboard_version",
        "state",
        "profile",
        "run",
        "time_axis",
        "metrics",
        "unavailable_concepts",
        "downloads",
        "repeatability",
        "variability",
        "interpretation_boundary",
        "warnings",
    }
    assert payload["dashboard_version"] == 1
    assert payload["state"] == "success"
    assert set(payload["run"]) == {
        "run_id",
        "scenario_id",
        "config_hash",
        "seed",
        "created_at",
        "iterations",
        "repetitions",
    }
    assert payload["variability"]["status"] == "unavailable"
    assert {item["id"] for item in payload["downloads"]} == {
        "results",
        "iteration_summary",
    }
    assert all(
        item["url"] == f"/download/{item['id']}" for item in payload["downloads"]
    )

    server = create_server(dashboard_bundle, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        status, served = _json_get(base_url, "/api/dashboard")
        assert status == 200
        assert served == payload

        status, health = _json_get(base_url, "/api/health")
        assert status == 200
        assert health == {"status": "ok", "bundle_state": "success"}

        # The gallery and stochastic job APIs stay absent from the viewer.
        for route, method in (
            ("/api/gallery", "GET"),
            ("/api/runs", "POST"),
            ("/api/stochastic/runs", "POST"),
            ("/api/stochastic/runs/mc-0", "GET"),
        ):
            request = Request(
                f"{base_url}{route}",
                data=b"{}" if method == "POST" else None,
                method=method,
                headers={"Content-Type": "application/json"},
            )
            with pytest.raises(HTTPError) as error:
                urlopen(request, timeout=5)
            assert error.value.code in {404, 405}

        with urlopen(f"{base_url}/download/results", timeout=5) as response:
            assert response.status == 200
            assert b"public-growth-path-v1" in response.read()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

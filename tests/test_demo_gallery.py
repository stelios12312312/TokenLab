# @planner:story = US-PM-AUTO-HCE13E9273E2C5559
# @planner:proves = crit:CRIT-001,crit:CRIT-002,crit:CRIT-003,crit:CRIT-004,crit:CRIT-005,crit:CRIT-006,crit:CRIT-007

from importlib import resources
import json
from pathlib import Path
import re
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest
import numpy as np
import pandas as pd
import yaml

from TokenLab.agentic.artifact_profile import validate_bundle
from TokenLab.agentic.factory import ScenarioFactory
from TokenLab.agentic.gallery import (
    DemoGallery,
    GalleryError,
    InvalidSpecError,
    StochasticJobManager,
    load_demo_registry,
    parse_demo_registry,
)
from TokenLab.agentic.runner import MonteCarloRunner
from TokenLab.dashboard import (
    MAX_GALLERY_REQUEST_BYTES,
    MAX_GALLERY_RUNS,
    GalleryApplication,
    GalleryBusyError,
    GalleryCapacityError,
    _parser,
    create_gallery_server,
    gallery_html,
    main,
)


ROOT = Path(__file__).resolve().parents[1]
STORY_ID = "US-PM-AUTO-HCE13E9273E2C5559"


def _raw_registry():
    path = resources.files("TokenLab.agentic").joinpath("data/demo_registry.json")
    return json.loads(path.read_text(encoding="utf-8"))


def _json_get(base_url, route):
    with urlopen(f"{base_url}{route}", timeout=20) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def _json_post(base_url, route, value):
    body = json.dumps(value, allow_nan=False).encode("utf-8")
    request = Request(
        f"{base_url}{route}",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=60) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def test_packaged_registry_declares_reviewed_presets_and_bounded_controls():
    registry = load_demo_registry()

    assert registry.registry_version == 1
    assert registry.gallery_id == "tokenlab-public-gallery-v1"
    assert len(registry.demos) == 4
    demo = registry.demos[0]
    assert demo.id == "growth-path"
    assert demo.kind == "deterministic"
    assert demo.role == "control"
    assert "not monte carlo" in demo.summary.lower()
    assert "zero-variance" in demo.summary.lower()
    assert demo.maturity == "illustrative"
    assert {preset.id for preset in demo.presets} == {
        "baseline",
        "downside",
        "upside",
    }
    assert {control.id for control in demo.controls} == {
        "user_ceiling",
        "transaction_value_end",
        "holding_time",
    }
    assert all(control.minimum < control.maximum for control in demo.controls)
    assert all(control.step > 0 for control in demo.controls)
    assert "not investment" in demo.boundary.lower()

    flagship = registry.demos[1]
    assert flagship.id == "public-growth-uncertainty-v2"
    assert flagship.kind == "stochastic"
    assert flagship.role == "flagship"
    assert flagship.default_run_tier == "fast"
    assert flagship.interactive_run_tiers == ("test", "fast", "standard")
    assert flagship.cli_only_run_tiers == ("deep",)
    assert "not investment" in flagship.boundary.lower()

    demand = registry.demos[2]
    assert demand.id == "public-demand-history-v2"
    assert demand.kind == "stochastic"
    assert demand.role == "historical-archetype"
    assert demand.default_run_tier == "fast"
    assert demand.interactive_run_tiers == ("test", "fast", "standard")
    assert demand.cli_only_run_tiers == ("deep",)
    assert demand.maturity == "illustrative"
    assert "not investment" in demand.boundary.lower()
    assert "synthetic" in demand.summary.lower()

    demand_control = registry.demos[3]
    assert demand_control.id == "public-demand-constant-v1"
    assert demand_control.kind == "deterministic"
    assert demand_control.role == "control"
    assert "not monte carlo" in demand_control.summary.lower()
    assert "zero-variance" in demand_control.summary.lower()
    assert {preset.id for preset in demand_control.presets} == {
        "baseline",
        "downside",
        "upside",
    }
    assert {control.id for control in demand_control.controls} == {
        "average_transaction_value",
        "holding_time",
    }
    assert all(
        control.minimum < control.maximum for control in demand_control.controls
    )
    assert "not investment" in demand_control.boundary.lower()


def test_public_catalog_hides_package_resources_and_nested_paths():
    catalog = DemoGallery(Path("unused")).catalog()
    serialized = json.dumps(catalog)

    assert catalog["registry_version"] == 1
    assert len(catalog["demos"][0]["presets"]) == 3
    assert "scenario_resource" not in serialized
    assert "profile_resource" not in serialized
    assert '"path"' not in serialized
    assert "public_demo.yaml" not in serialized


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda data: data.update({"unexpected": True}), "unexpected.*not allowed"),
        (
            lambda data: data["demos"][0].update(
                {"scenario_resource": "../private.yaml"}
            ),
            "safe package filename",
        ),
        (
            lambda data: data["demos"][0]["controls"][0].update(
                {"path": ["economy", "type"]}
            ),
            "allowed parameter path",
        ),
        (
            lambda data: data["demos"][0]["presets"][0]["values"].update(
                {"user_ceiling": True}
            ),
            "integer",
        ),
    ],
)
def test_registry_rejects_unknown_unsafe_or_invalid_data(mutation, match):
    data = _raw_registry()
    mutation(data)

    with pytest.raises(GalleryError, match=match):
        parse_demo_registry(data)


@pytest.mark.parametrize(
    "payload,match",
    [
        (
            {
                "demo_id": "growth-path",
                "preset_id": "baseline",
                "parameters": {},
                "scenario_path": "/tmp/private.yaml",
            },
            "scenario_path.*not allowed",
        ),
        (
            {"demo_id": "missing", "preset_id": "baseline", "parameters": {}},
            "unknown demo",
        ),
        (
            {"demo_id": "growth-path", "preset_id": "missing", "parameters": {}},
            "unknown preset",
        ),
        (
            {
                "demo_id": "growth-path",
                "preset_id": "baseline",
                "parameters": {"economy.type": "InjectedClass"},
            },
            "unknown control",
        ),
        (
            {
                "demo_id": "growth-path",
                "preset_id": "baseline",
                "parameters": {"user_ceiling": True},
            },
            "integer",
        ),
        (
            {
                "demo_id": "growth-path",
                "preset_id": "baseline",
                "parameters": {"holding_time": float("inf")},
            },
            "finite",
        ),
        (
            {
                "demo_id": "growth-path",
                "preset_id": "baseline",
                "parameters": {"transaction_value_end": 10000},
            },
            "between",
        ),
        (
            {
                "demo_id": "growth-path",
                "preset_id": "baseline",
                "parameters": {"holding_time": "__import__('os').system('id')"},
            },
            "number",
        ),
    ],
)
def test_run_request_rejects_every_undeclared_or_invalid_input(
    tmp_path, payload, match
):
    gallery = DemoGallery(tmp_path / "runs")

    with pytest.raises(GalleryError, match=match):
        gallery.run_request(payload)

    assert not (tmp_path / "runs").exists()


def test_real_gallery_runs_publish_validated_unique_bundles_and_apply_overrides(
    tmp_path,
):
    gallery = DemoGallery(tmp_path / "runs")

    baseline = gallery.run_request(
        {"demo_id": "growth-path", "preset_id": "baseline", "parameters": {}}
    )
    custom = gallery.run_request(
        {
            "demo_id": "growth-path",
            "preset_id": "baseline",
            "parameters": {"user_ceiling": 30000, "holding_time": 2.0},
        }
    )

    assert baseline.bundle_dir != custom.bundle_dir
    assert validate_bundle(baseline.bundle_dir)["status"] == "pass"
    assert validate_bundle(custom.bundle_dir)["status"] == "pass"
    assert baseline.application.payload["state"] == "success"
    assert custom.application.payload["state"] == "success"
    assert baseline.application.payload["run"]["config_hash"] != custom.application.payload[
        "run"
    ]["config_hash"]
    assert custom.resolved_parameters == {
        "user_ceiling": 30000,
        "transaction_value_end": 120,
        "holding_time": 2.0,
    }
    assert custom.application.payload["profile"]["scenario_id"] == custom.application.payload[
        "run"
    ]["scenario_id"]
    assert len(custom.application.payload["metrics"]) == 6
    assert {item["id"] for item in custom.application.payload["downloads"]} == {
        "results",
        "iteration_summary",
    }


def test_gallery_http_catalog_run_download_and_negative_paths(tmp_path):
    output_root = tmp_path / "gallery-runs"
    server = create_gallery_server(output_root, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        status, health = _json_get(base_url, "/api/health")
        assert status == 200
        assert health == {"status": "ok", "mode": "gallery"}

        status, catalog = _json_get(base_url, "/api/gallery")
        assert status == 200
        assert catalog["demos"][0]["id"] == "growth-path"

        status, result = _json_post(
            base_url,
            "/api/runs",
            {
                "demo_id": "growth-path",
                "preset_id": "downside",
                "parameters": {"holding_time": 1.0},
            },
        )
        assert status == 201
        assert result["status"] == "success"
        assert result["demo_id"] == "growth-path"
        assert result["preset_id"] == "downside"
        assert result["dashboard"]["state"] == "success"
        assert result["resolved_parameters"]["holding_time"] == 1.0
        assert all(
            item["url"].startswith(f"/api/runs/{result['run_id']}/download/")
            for item in result["dashboard"]["downloads"]
        )

        download_url = result["dashboard"]["downloads"][0]["url"]
        with urlopen(f"{base_url}{download_url}", timeout=20) as response:
            assert response.status == 200
            assert b"run_id" in response.read()

        request = Request(
            f"{base_url}/api/runs",
            data=b"{" + (b" " * MAX_GALLERY_REQUEST_BYTES) + b"}",
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with pytest.raises(HTTPError) as error:
            urlopen(request, timeout=20)
        assert error.value.code == 413

        before = set(output_root.iterdir())
        invalid = Request(
            f"{base_url}/api/runs",
            data=json.dumps(
                {
                    "demo_id": "growth-path",
                    "preset_id": "baseline",
                    "parameters": {"path": "../../secret"},
                }
            ).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with pytest.raises(HTTPError) as error:
            urlopen(invalid, timeout=20)
        assert error.value.code == 400
        assert set(output_root.iterdir()) == before

        for body, content_type, expected_status in (
            (b"not-json", "application/json", 400),
            (b"{}", "text/plain", 415),
            (
                b'{"demo_id":"growth-path","preset_id":"baseline","parameters":{"holding_time":NaN}}',
                "application/json",
                400,
            ),
        ):
            malformed = Request(
                f"{base_url}/api/runs",
                data=body,
                method="POST",
                headers={"Content-Type": content_type},
            )
            with pytest.raises(HTTPError) as error:
                urlopen(malformed, timeout=20)
            assert error.value.code == expected_status
            assert set(output_root.iterdir()) == before

        for route in (
            f"/api/runs/{result['run_id']}/download/manifest",
            f"/api/runs/{result['run_id']}/download/..%2Fmanifest.json",
            "/api/runs/unknown/download/results",
        ):
            with pytest.raises(HTTPError) as error:
                urlopen(f"{base_url}{route}", timeout=20)
            assert error.value.code == 404
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_gallery_busy_state_rejects_overlapping_run_without_output(tmp_path):
    output_root = tmp_path / "busy-runs"
    server = create_gallery_server(output_root, host="127.0.0.1", port=0)
    server.gallery_application.run_lock.acquire()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        request = Request(
            f"{base_url}/api/runs",
            data=json.dumps(
                {"demo_id": "growth-path", "preset_id": "baseline", "parameters": {}}
            ).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with pytest.raises(HTTPError) as error:
            urlopen(request, timeout=20)
        assert error.value.code == 409
        assert not output_root.exists()
    finally:
        server.gallery_application.run_lock.release()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_gallery_lock_and_completed_run_limit_are_process_bounded():
    first = GalleryApplication(gallery=object(), catalog={})
    second = GalleryApplication(gallery=object(), catalog={})

    first.run_lock.acquire()
    try:
        with pytest.raises(GalleryBusyError, match="already running"):
            second.execute({})
    finally:
        first.run_lock.release()

    second.runs.update({f"run-{index}": object() for index in range(MAX_GALLERY_RUNS)})
    with pytest.raises(GalleryCapacityError, match="run limit reached"):
        second.execute({})


def test_gallery_http_sanitizes_unexpected_backend_failures(tmp_path):
    class ExplodingGallery:
        def run_request(self, request):
            raise RuntimeError(f"private failure at {tmp_path / 'secret'}")

    application = GalleryApplication(gallery=ExplodingGallery(), catalog={})
    server = create_gallery_server(
        tmp_path / "runs", host="127.0.0.1", port=0, application=application
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        request = Request(
            f"{base_url}/api/runs",
            data=b'{}',
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with pytest.raises(HTTPError) as error:
            urlopen(request, timeout=20)
        assert error.value.code == 422
        payload = json.loads(error.value.read().decode("utf-8"))
        assert payload["error"] == "simulation could not be completed or validated"
        assert "secret" not in json.dumps(payload)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_gallery_cli_mode_contract_is_additive_and_mutually_exclusive():
    gallery = _parser().parse_args(["--gallery", "--output-dir", "runs", "--port", "0"])
    legacy = _parser().parse_args(["bundle", "--port", "0"])

    assert gallery.gallery is True
    assert gallery.bundle is None
    assert gallery.output_dir == "runs"
    assert legacy.gallery is False
    assert legacy.bundle == "bundle"


@pytest.mark.parametrize(
    "argv,message",
    [
        (["bundle", "--gallery"], "cannot be combined"),
        (["bundle", "--output-dir", "runs"], "valid only with --gallery"),
        ([], "required unless --gallery"),
    ],
)
def test_gallery_cli_rejects_invalid_mode_combinations(argv, message, capsys):
    assert main(argv) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert message in captured.err


def test_packaged_gallery_has_functional_states_a11y_responsiveness_and_no_remote_assets():
    html = gallery_html().decode("utf-8")
    lower = html.lower()

    for state in ("loading", "running", "success", "empty", "partial", "invalid"):
        assert state in lower
    for landmark in ("<header", "<main", "<section", "<footer"):
        assert landmark in lower
    for token in (
        'aria-live="polite"',
        ":focus-visible",
        "@media (max-width: 720px)",
        "@media (max-width: 420px)",
        'fetch("/api/gallery"',
        'fetch("/api/runs"',
        'type="range"',
        "run simulation",
        "compare scenarios",
        "illustrative",
        "not investment",
        "not modeled",
    ):
        assert token in lower
    assert "state.runs.clear()" in html
    assert not re.search(r"(?:src|href)\s*=\s*[\"']https?://", html, re.I)
    assert "eval(" not in html
    assert "new Function(" not in html


def test_gallery_package_data_docs_and_story_traceability_are_wired():
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    guide = (ROOT / "docs/public-demo.md").read_text(encoding="utf-8")
    stories = json.loads(
        (ROOT / "reports/user_story_audit/story_registry.json").read_text(
            encoding="utf-8"
        )
    )
    story = next(item for item in stories["stories"] if item["id"] == STORY_ID)

    assert '"TokenLab.agentic" = ["data/*.json", "data/*.yaml"]' in pyproject
    assert '"TokenLab" = ["dashboard_static/*.html"]' in pyproject
    assert "tokenlab-dashboard --gallery --output-dir outputs/demo-gallery" in readme
    assert "tokenlab-dashboard --gallery --output-dir outputs/demo-gallery" in guide
    assert "illustrative" in guide.lower()
    assert "not investment" in guide.lower()
    assert story["status"] in {"PARTIALLY_COVERED", "FULLY_COVERED"}
    assert "src/TokenLab/agentic/gallery.py" in story["code_refs"]
    assert "tests/test_demo_gallery.py" in story["test_refs"]
    assert "docs/public-demo.md" in story["doc_refs"]


_TERMINAL_JOB_STATES = ("success", "incomplete", "cancelled", "backend-error")


def _wait_for_job(base_url, job_id, timeout=180):
    deadline = time.time() + timeout
    seen = []
    while time.time() < deadline:
        status, job = _json_get(base_url, f"/api/stochastic/runs/{job_id}")
        assert status == 200
        seen.append(job)
        if job["state"] in _TERMINAL_JOB_STATES:
            return job, seen
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} never reached a terminal state")


class _FailingFactory:
    """Inject per-path build failures at exact path indices."""

    def __init__(self, fail_at):
        self._factory = ScenarioFactory()
        self._fail_at = set(fail_at)
        self._calls = 0

    def __getattr__(self, name):
        return getattr(self._factory, name)

    def build(self, config, rng_plan=None):
        index = self._calls
        self._calls += 1
        if index in self._fail_at:
            raise RuntimeError("injected per-path failure")
        return self._factory.build(config, rng_plan=rng_plan)


def test_job_progress_cancel_and_incomplete_states(tmp_path):
    output_root = tmp_path / "mc-jobs"
    server = create_gallery_server(output_root, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        # The deterministic control remains runnable and honestly labeled.
        _, catalog = _json_get(base_url, "/api/gallery")
        kinds = {demo["id"]: demo["kind"] for demo in catalog["demos"]}
        assert kinds == {
            "growth-path": "deterministic",
            "public-growth-uncertainty-v2": "stochastic",
            "public-demand-history-v2": "stochastic",
            "public-demand-constant-v1": "deterministic",
        }
        status, control = _json_post(
            base_url,
            "/api/runs",
            {"demo_id": "growth-path", "preset_id": "baseline", "parameters": {}},
        )
        assert status == 201
        assert control["status"] == "success"
        assert control["dashboard"]["variability"]["status"] == "unavailable"
        assert "monte carlo" not in json.dumps(control["dashboard"]).lower()

        # Happy-path job: live progress reconciles, terminal counts are exact.
        status, job = _json_post(
            base_url,
            "/api/stochastic/runs",
            {"demo_id": "public-growth-uncertainty-v2", "run_tier": "test"},
        )
        assert status == 202
        assert job["state"] in {"queued", "running"}
        assert job["requested"] == 32
        final, seen = _wait_for_job(base_url, job["job_id"])
        assert final["state"] == "success"
        assert (final["requested"], final["completed"], final["failed"]) == (
            32,
            32,
            0,
        )
        for snapshot in seen:
            assert 0 <= snapshot["completed"] <= snapshot["requested"]
            assert (
                snapshot["completed"] + snapshot["failed"] <= snapshot["requested"]
            )
        result = final["result"]
        assert result["run"]["run_tier"] == "test"
        assert result["run"]["sampler_version"] == "tokenlab-rng-v1"
        assert result["run"]["rng_algorithm"] == "PCG64"
        assert {metric["id"] for metric in result["metrics"]} == {
            "terminal_token_price",
            "terminal_fiat_transaction_volume",
            "cumulative_users",
        }
        assert all(len(metric["fan"]["x"]) == 24 for metric in result["metrics"])
        assert all(
            len(metric["terminal_values"]) == 32 for metric in result["metrics"]
        )
        assert all(
            metric["fan"]["label"] == "modeled outcomes: P10–P90"
            for metric in result["metrics"]
        )
        assert result["outcome_interval_label"] == "modeled outcome interval"
        # Insufficient state: 32 completed paths is below the frozen minimum.
        assert result["sensitivity"]["min_paths"] == 100
        assert result["sensitivity"]["completed_paths"] == 32
        assert {
            record["status"] for record in result["sensitivity"]["results"]
        } == {"insufficient_paths"}
        claim = result["claim_eligibility"]
        assert claim["eligible"] is True
        assert claim["reasons"] == []
        # test tier: no convergence checkpoints reached, so the eligibility
        # carries a standing limitation instead of a blank check.
        assert claim["limitations"]
        assert all(
            "insufficient_checkpoints" in limitation
            for limitation in claim["limitations"]
        )
        assert result["tokenomics_coverage"]["supply"]["status"] == "fixed"
        assert result["tokenomics_coverage"]["vesting_unlocks"]["status"] == "absent"
        with urlopen(
            f"{base_url}/api/stochastic/runs/{job['job_id']}/download/manifest",
            timeout=20,
        ) as response:
            downloaded = json.loads(response.read().decode("utf-8"))
        assert downloaded["manifest_version"] == 2
        assert downloaded["completed_paths"] == 32

        # Invalid-spec selection: renders invalid-spec, executes nothing.
        before = set(output_root.iterdir())
        with pytest.raises(HTTPError) as error:
            _json_post(
                base_url,
                "/api/stochastic/runs",
                {
                    "demo_id": "public-growth-uncertainty-v2",
                    "run_tier": "test",
                    "priors": {"holding_time": {"approval": "draft"}},
                },
            )
        assert error.value.code == 400
        payload = json.loads(error.value.read().decode("utf-8"))
        assert payload["state"] == "invalid-spec"
        assert payload["validation"]["warnings"]
        assert set(output_root.iterdir()) == before

        # The deep tier is CLI/background-only.
        with pytest.raises(HTTPError) as error:
            _json_post(
                base_url,
                "/api/stochastic/runs",
                {"demo_id": "public-growth-uncertainty-v2", "run_tier": "deep"},
            )
        assert error.value.code == 400
        assert "CLI/background-only" in error.value.read().decode("utf-8")

        # Cancel mid-run: cancelled state with truthful, reconciling counts.
        status, job = _json_post(
            base_url,
            "/api/stochastic/runs",
            {"demo_id": "public-growth-uncertainty-v2", "run_tier": "standard"},
        )
        assert status == 202
        job_id = job["job_id"]
        deadline = time.time() + 60
        while time.time() < deadline:
            _, snapshot = _json_get(base_url, f"/api/stochastic/runs/{job_id}")
            if snapshot["completed"] >= 3 or snapshot["state"] in _TERMINAL_JOB_STATES:
                break
            time.sleep(0.05)
        assert snapshot["state"] == "running"
        assert snapshot["requested"] == 500
        status, _ = _json_post(
            base_url, f"/api/stochastic/runs/{job_id}/cancel", {}
        )
        assert status == 200
        final, _ = _wait_for_job(base_url, job_id)
        assert final["state"] == "cancelled"
        assert final["requested"] == 500
        assert 0 < final["completed"] < final["requested"]
        assert final["completed"] + final["failed"] <= final["requested"]
        assert "result" not in final
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    # Incomplete state: injected per-path failures publish exact denominators
    # and block claim eligibility while remaining inspectable.
    gallery = DemoGallery(tmp_path / "mc-incomplete")
    manager = StochasticJobManager(
        gallery,
        runner_factory=lambda: MonteCarloRunner(factory=_FailingFactory({4, 9})),
    )
    application = GalleryApplication(
        gallery=gallery, catalog=gallery.catalog(), jobs=manager
    )
    server = create_gallery_server(
        tmp_path / "mc-incomplete",
        host="127.0.0.1",
        port=0,
        application=application,
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        status, job = _json_post(
            base_url,
            "/api/stochastic/runs",
            {"demo_id": "public-growth-uncertainty-v2", "run_tier": "test"},
        )
        assert status == 202
        final, _ = _wait_for_job(base_url, job["job_id"])
        assert final["state"] == "incomplete"
        assert (final["requested"], final["completed"], final["failed"]) == (
            32,
            30,
            2,
        )
        failures = final["result"]["path_failures"]
        assert failures["requested"] == 32
        assert failures["completed"] == 30
        assert failures["failed"] == 2
        assert len(failures["failures"]) == 2
        assert {record["path_index"] for record in failures["failures"]} == {4, 9}
        assert all(
            record["stage"] == "build" for record in failures["failures"]
        )
        claim = final["result"]["claim_eligibility"]
        assert claim["eligible"] is False
        assert any("path failure" in reason for reason in claim["reasons"])
        assert all(
            len(metric["terminal_values"]) == 30
            for metric in final["result"]["metrics"]
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _stochastic_resource_dict():
    path = resources.files("TokenLab.agentic").joinpath(
        "data/public_growth_uncertainty_v2.yaml"
    )
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _patch_scenario_resource(monkeypatch, raw):
    """Serve a doctored scenario resource; every other resource passes through."""
    import TokenLab.agentic.gallery as gallery_module

    original = gallery_module._read_resource

    def patched(name):
        if str(name).endswith("public_growth_uncertainty_v2.yaml"):
            return raw
        return original(name)

    monkeypatch.setattr(gallery_module, "_read_resource", patched)


def test_prior_approval_edits_are_downward_only(tmp_path, monkeypatch):
    gallery = DemoGallery(tmp_path / "mc")
    manager = StochasticJobManager(gallery)

    # Downward edits still work: approved -> draft renders invalid-spec via
    # validation (the browser invalid-spec journey depends on this).
    with pytest.raises(InvalidSpecError):
        manager._resolve_request(
            {
                "demo_id": "public-growth-uncertainty-v2",
                "run_tier": "test",
                "priors": {"holding_time": {"approval": "draft"}},
            }
        )

    # Approval authority is out of band: a caller facing a needs_evidence
    # prior cannot flip it to approved through the job API.
    raw = _stochastic_resource_dict()
    raw["uncertainty"]["parameters"][0]["approval"] = "needs_evidence"
    _patch_scenario_resource(monkeypatch, raw)
    with pytest.raises(InvalidSpecError) as blocked:
        manager._resolve_request(
            {
                "demo_id": "public-growth-uncertainty-v2",
                "run_tier": "test",
                "priors": {"max_users": {"approval": "approved"}},
            }
        )
    assert "out of band" in str(blocked.value)
    assert blocked.value.validation["errors"][0]["id"] == "max_users"


def test_support_edits_auto_sync_bounds_for_equal_support_families(
    tmp_path, monkeypatch
):
    # Bounds must equal the support for uniform/truncated families and are
    # not editable; a support edit auto-syncs them instead of dead-ending.
    raw = _stochastic_resource_dict()
    prior = raw["uncertainty"]["parameters"][0]
    assert prior["id"] == "max_users"
    prior["distribution"] = {
        "family": "uniform",
        "minimum": 12000,
        "maximum": 32000,
    }
    prior["bounds"] = {"minimum": 12000, "maximum": 32000}
    _patch_scenario_resource(monkeypatch, raw)

    gallery = DemoGallery(tmp_path / "mc")
    manager = StochasticJobManager(gallery)
    _, config, _, _, _ = manager._resolve_request(
        {
            "demo_id": "public-growth-uncertainty-v2",
            "run_tier": "test",
            "priors": {"max_users": {"maximum": 40000}},
        }
    )
    spec = next(
        spec for spec in config.uncertainty.parameters if spec.id == "max_users"
    )
    assert spec.distribution.family == "uniform"
    assert spec.distribution.parameters["maximum"] == 40000
    assert spec.bounds.maximum == 40000
    assert spec.bounds.minimum == 12000


def test_demand_history_demo_catalog_contract_and_prior_edits(tmp_path):
    gallery = DemoGallery(tmp_path / "mc")
    catalog = gallery.catalog()
    views = {demo["id"]: demo for demo in catalog["demos"]}
    demand = views["public-demand-history-v2"]

    assert demand["kind"] == "stochastic"
    assert demand["role"] == "historical-archetype"
    assert demand["default_run_tier"] == "fast"
    assert set(demand["run_tiers"]) == {"test", "fast", "standard", "deep"}
    assert demand["run_tiers"]["test"]["interactive"] is True
    assert demand["run_tiers"]["deep"]["interactive"] is False
    priors = demand["uncertainty_parameters"]
    assert {prior["id"] for prior in priors} == {
        "price_std_prior",
        "price_anchoring",
        "holding_time_dispersion",
    }
    assert all(prior["calibration"] == "illustrative" for prior in priors)
    assert all(prior["approval"] == "approved" for prior in priors)
    assert all(prior["dependence"] == "independent" for prior in priors)
    assert all(prior["distribution"]["family"] == "triangular" for prior in priors)
    assert demand["seed"] == 20260817
    assert demand["iterations"] == 20
    # The public catalog never leaks scenario resources or economy paths.
    serialized = json.dumps(demand)
    assert '"path"' not in serialized
    assert "public_demand_history_v2.yaml" not in serialized

    manager = StochasticJobManager(gallery)

    # Downward approval edits render invalid-spec and execute nothing.
    with pytest.raises(InvalidSpecError):
        manager._resolve_request(
            {
                "demo_id": "public-demand-history-v2",
                "run_tier": "test",
                "priors": {"price_anchoring": {"approval": "draft"}},
            }
        )

    # Triangular support edits inside the declared bounds resolve and validate.
    _, config, _, _, _ = manager._resolve_request(
        {
            "demo_id": "public-demand-history-v2",
            "run_tier": "test",
            "priors": {"price_std_prior": {"maximum": 0.15}},
        }
    )
    spec = next(
        spec for spec in config.uncertainty.parameters if spec.id == "price_std_prior"
    )
    assert spec.distribution.parameters["maximum"] == 0.15

    # The deep tier is CLI/background-only for this demo too.
    with pytest.raises(GalleryError, match="CLI/background-only"):
        manager._resolve_request(
            {"demo_id": "public-demand-history-v2", "run_tier": "deep"}
        )


def test_demand_history_stochastic_job_runs_real_runner(tmp_path):
    gallery = DemoGallery(tmp_path / "mc-jobs")
    manager = StochasticJobManager(gallery)
    job = manager.start({"demo_id": "public-demand-history-v2", "run_tier": "test"})
    assert job["requested"] == 32
    job_id = job["job_id"]
    deadline = time.time() + 180
    final = manager.status(job_id)
    while time.time() < deadline:
        final = manager.status(job_id)
        if final["state"] in _TERMINAL_JOB_STATES:
            break
        time.sleep(0.05)
    assert final["state"] == "success"
    assert (final["requested"], final["completed"], final["failed"]) == (32, 32, 0)

    result = final["result"]
    assert result["run"]["run_tier"] == "test"
    assert result["run"]["sampler_version"] == "tokenlab-rng-v1"
    assert {metric["id"] for metric in result["metrics"]} == {
        "terminal_token_price",
        "terminal_fiat_transaction_volume",
        "terminal_holding_time",
    }
    assert all(len(metric["fan"]["x"]) == 20 for metric in result["metrics"])
    assert all(len(metric["terminal_values"]) == 32 for metric in result["metrics"])
    # The replayed exogenous series is not an uncertain parameter: identical
    # terminal volume across paths, while price and holding time disperse.
    by_id = {metric["id"]: metric for metric in result["metrics"]}
    volume = by_id["terminal_fiat_transaction_volume"]
    assert len(set(volume["terminal_values"])) == 1
    assert len(set(by_id["terminal_token_price"]["terminal_values"])) > 1
    assert len(set(by_id["terminal_holding_time"]["terminal_values"])) > 1
    assert result["sensitivity"]["completed_paths"] == 32
    assert {
        record["status"] for record in result["sensitivity"]["results"]
    } == {"insufficient_paths"}
    coverage = result["tokenomics_coverage"]
    assert coverage["supply"]["status"] == "fixed"
    assert coverage["vesting_unlocks"]["status"] == "absent"
    assert coverage["demand_series"]["status"] == "synthetic_illustrative"
    assert "not investment" in result["interpretation_boundary"].lower()


def test_demand_constant_control_is_deterministic_and_bounded(tmp_path):
    gallery = DemoGallery(tmp_path / "runs")

    baseline = gallery.run_request(
        {"demo_id": "public-demand-constant-v1", "preset_id": "baseline", "parameters": {}}
    )
    custom = gallery.run_request(
        {
            "demo_id": "public-demand-constant-v1",
            "preset_id": "downside",
            "parameters": {"average_transaction_value": 600000},
        }
    )

    assert baseline.bundle_dir != custom.bundle_dir
    assert validate_bundle(baseline.bundle_dir)["status"] == "pass"
    assert baseline.application.payload["state"] == "success"
    assert baseline.application.payload["variability"]["status"] == "unavailable"
    assert "monte carlo" not in json.dumps(baseline.application.payload).lower()
    assert custom.resolved_parameters == {
        "average_transaction_value": 600000,
        "holding_time": 0.75,
    }

    # Zero variance across the repeated deterministic paths.
    results = pd.read_csv(baseline.bundle_dir / "results.csv")
    numeric = [
        column
        for column in results.select_dtypes(include=[np.number]).columns
        if column not in {"iteration_time", "repetition_run", "seed"}
    ]
    spread = results.groupby("iteration_time")[numeric].std(ddof=1).fillna(0.0)
    assert (spread == 0.0).all().all()

    # Bounded control: out-of-range values are rejected without running.
    with pytest.raises(GalleryError, match="between"):
        gallery.run_request(
            {
                "demo_id": "public-demand-constant-v1",
                "preset_id": "baseline",
                "parameters": {"average_transaction_value": 100},
            }
        )

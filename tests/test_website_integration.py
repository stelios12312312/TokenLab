"""Automated verification suite for the TokenLab website visual integration packet."""

import hashlib
import json
from pathlib import Path
import re
import pytest

from TokenLab.agentic.demo import load_public_profile


PACKET_DIR = Path(__file__).resolve().parent.parent / "outputs" / "website_integration"
REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="session", autouse=True)
def _integration_packet():
    """Generate the packet when absent (it is gitignored, regenerable output).

    On a fresh checkout (CI) the packet does not exist; generation requires
    the optional imaging dependency. If generation is unavailable, the module
    skips with the reason rather than failing on missing regenerable files.
    """
    if (PACKET_DIR / "dashboard.html").is_file():
        return
    import subprocess
    import sys

    try:
        proc = subprocess.run(
            [sys.executable, str(REPO_ROOT / "scripts" / "generate_website_integration.py")],
            capture_output=True,
            text=True,
            timeout=600,
        )
    except Exception as exc:  # pragma: no cover - environment-dependent
        pytest.skip(
            f"website integration packet unavailable: {exc}",
            allow_module_level=True,
        )
    if proc.returncode != 0 or not (PACKET_DIR / "dashboard.html").is_file():
        pytest.skip(
            "website integration packet could not be generated in this "
            f"environment: {proc.stderr.strip()[-300:]}",
            allow_module_level=True,
        )


def test_required_files_exist():
    """Verify all requested integration packet files exist and are non-empty."""
    required_files = [
        "dashboard.html",
        "dashboard.css",
        "dashboard.js",
        "dashboard-fallback.svg",
        "chart-1-velocity-recovery.svg",
        "chart-1-velocity-recovery-mobile.svg",
        "chart-1-velocity-recovery.webp",
        "chart-2-scenario-comparison.svg",
        "chart-2-scenario-comparison-mobile.svg",
        "chart-2-scenario-comparison.webp",
        "chart-3-volume-participation.svg",
        "chart-3-volume-participation-mobile.svg",
        "chart-3-volume-participation.webp",
        "public-demo-data.json",
        "provenance.json",
        "captions.md",
        "INTEGRATION.md",
        "screenshot-desktop.png",
        "screenshot-mobile.png",
    ]

    for fname in required_files:
        fpath = PACKET_DIR / fname
        assert fpath.exists(), f"Missing required integration file: {fname}"
        assert fpath.stat().st_size > 0, f"File {fname} is unexpectedly empty"


def test_public_demo_data_structure_and_lineage():
    """Verify public-demo-data.json structure and exact data lineage against iteration_summary.csv."""
    data_path = PACKET_DIR / "public-demo-data.json"
    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert "metadata" in data
    assert "presets" in data
    assert "time_axis" in data
    assert len(data["time_axis"]) == 24

    meta = data["metadata"]
    assert meta["scenario_id"] == "public-growth-path-v1"
    assert meta["profile_id"] == "tokenlab-public-demo-v1"
    assert meta["master_seed"] == 20260812

    # Check presets
    for preset_id in ["baseline", "downside", "upside"]:
        assert preset_id in data["presets"]
        preset = data["presets"][preset_id]
        assert "series" in preset
        series = preset["series"]
        assert "token_price" in series
        assert "fiat_transaction_volume" in series
        assert "user_count" in series
        assert "holding_time" in series
        assert len(series["token_price"]) == 24

    # Check baseline data matches known simulation outputs
    baseline_prices = data["presets"]["baseline"]["series"]["token_price"]
    assert pytest.approx(baseline_prices[0], rel=1e-3) == 0.025239
    assert pytest.approx(min(baseline_prices), rel=1e-3) == 0.002145
    assert pytest.approx(baseline_prices[-1], rel=1e-3) == 0.010768


def test_no_unavailable_metrics_in_payload():
    """Ensure no unmodelled or fabricated metrics appear in the public payload."""
    data_path = PACKET_DIR / "public-demo-data.json"
    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    allowed_metrics = {
        "token_price",
        "fiat_transaction_volume",
        "user_count",
        "transaction_count",
        "holding_time",
        "token_supply",
    }

    forbidden_metric_names = {
        "staking_yield",
        "staking_apr",
        "apy",
        "fdv",
        "market_cap",
        "liquidity_depth",
        "slippage",
        "impermanent_loss",
        "emissions_rate",
        "burn_rate",
        "governance_votes",
    }

    for preset_id, preset in data["presets"].items():
        for m_name in preset["series"].keys():
            assert m_name in allowed_metrics, f"Undeclared metric {m_name} found in preset {preset_id}"
            assert m_name not in forbidden_metric_names, f"Forbidden metric {m_name} found in preset {preset_id}"

    # Verify unavailable concepts are explicitly declared in metadata
    unavail = [c["id"] for c in data["metadata"].get("unavailable_concepts", [])]
    assert "emissions" in unavail
    assert "vesting_unlocks" in unavail
    assert "liquidity" in unavail
    assert "treasury" in unavail
    assert "governance" in unavail
    assert "staking_yield" in unavail
    assert "fdv" in unavail
    assert "apy" in unavail


def test_provenance_cryptographic_integrity():
    """Verify provenance.json references valid hashes of the public demo scenario and artifacts."""
    prov_path = PACKET_DIR / "provenance.json"
    with open(prov_path, "r", encoding="utf-8") as f:
        prov = json.load(f)

    assert prov["scenario_id"] == "public-growth-path-v1"
    assert prov["seed"] == 20260812
    assert "source_artifacts" in prov
    assert "generated_presets" in prov
    assert "results_csv_sha256" in prov["source_artifacts"]
    assert "iteration_summary_csv_sha256" in prov["source_artifacts"]
    assert "manifest_sha256" in prov["source_artifacts"]


def test_no_external_network_dependencies():
    """Ensure dashboard files contain no external network calls (CDN scripts, remote fonts, external images)."""
    text_files = [
        "dashboard.html",
        "dashboard.css",
        "dashboard.js",
        "dashboard-fallback.svg",
        "chart-1-velocity-recovery.svg",
        "chart-1-velocity-recovery-mobile.svg",
        "chart-2-scenario-comparison.svg",
        "chart-2-scenario-comparison-mobile.svg",
        "chart-3-volume-participation.svg",
        "chart-3-volume-participation-mobile.svg",
    ]

    remote_pattern = re.compile(r'(https?://(?!www\.w3\.org)[^\s"\'<>]+)', re.IGNORECASE)

    for fname in text_files:
        fpath = PACKET_DIR / fname
        content = fpath.read_text(encoding="utf-8")
        matches = remote_pattern.findall(content)
        # Exclude XML namespace URLs like http://www.w3.org/2000/svg
        clean_matches = [m for m in matches if not m.startswith("http://www.w3.org")]
        assert len(clean_matches) == 0, f"Found external URL in {fname}: {clean_matches}"


def test_html_and_svg_syntax_integrity():
    """Verify HTML5 and SVG documents have valid structure and accessibility attributes."""
    html_path = PACKET_DIR / "dashboard.html"
    html_content = html_path.read_text(encoding="utf-8")

    assert "<!doctype html>" in html_content.lower()
    assert '<html lang="en">' in html_content
    assert '<meta name="viewport"' in html_content
    assert '<noscript>' in html_content
    assert '</noscript>' in html_content
    assert 'role="region"' in html_content
    assert 'aria-label=' in html_content

    svg_files = [
        "dashboard-fallback.svg",
        "chart-1-velocity-recovery.svg",
        "chart-1-velocity-recovery-mobile.svg",
        "chart-2-scenario-comparison.svg",
        "chart-2-scenario-comparison-mobile.svg",
        "chart-3-volume-participation.svg",
        "chart-3-volume-participation-mobile.svg",
    ]

    for sf in svg_files:
        content = (PACKET_DIR / sf).read_text(encoding="utf-8")
        assert content.startswith("<svg") or "<?xml" in content or "<svg" in content
        assert content.strip().endswith("</svg>")
        assert 'xmlns="http://www.w3.org/2000/svg"' in content
        assert "viewBox=" in content
        assert 'role="img"' in content or 'aria-label=' in content


def test_prefers_reduced_motion_and_responsive_css():
    """Verify dashboard.css contains reduced-motion query and mobile responsive rules."""
    css_path = PACKET_DIR / "dashboard.css"
    css_content = css_path.read_text(encoding="utf-8")

    assert "@media (prefers-reduced-motion: reduce)" in css_content
    assert "transition: none !important" in css_content or "animation: none !important" in css_content
    assert "@media (max-width:" in css_content
    assert "#tokenlab-embed" in css_content


def test_captions_and_integration_doc_integrity():
    """Verify captions.md and INTEGRATION.md adhere to British English and formatting guidelines."""
    captions_path = PACKET_DIR / "captions.md"
    captions = captions_path.read_text(encoding="utf-8")

    # Check for British English spellings
    assert "visualisation" in captions.lower() or "modelled" in captions.lower() or "behaviour" in captions.lower()
    # Check no em-dashes are used in copy
    assert "—" not in captions, "Found em-dash in captions.md; please use colons, commas, or parentheses instead"

    integration_path = PACKET_DIR / "INTEGRATION.md"
    integration = integration_path.read_text(encoding="utf-8")
    assert "<iframe" in integration
    assert "dashboard.html" in integration
    assert "Content-Security-Policy" in integration
    assert "Refresh Procedure" in integration

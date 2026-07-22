import csv
import json

from projects.z1.v2_growth.growth_model import V2GrowthModule
from scripts.ledger_anchors import ANCHORS_BY_ID
from scripts.parse_pdf import extract_metrics, write_anchor_registry


def test_ledger_anchor_registry_defines_required_semantics(tmp_path, monkeypatch):
    monkeypatch.setattr("scripts.parse_pdf.OUTPUT_DIR", str(tmp_path))
    write_anchor_registry()

    with open(tmp_path / "ledger_anchor_registry.json", encoding="utf-8") as f:
        anchors = {row["anchor_id"]: row for row in json.load(f)}

    assert anchors["cumulative_engaged_audience_total"]["value"] == 1_450_000_000
    assert anchors["cumulative_engaged_audience_total"]["cumulative_or_point_in_time"] == "cumulative"
    assert "Current live users" in anchors["cumulative_engaged_audience_total"]["prohibited_use"]
    assert anchors["cdp_unified_identity_stock"]["value"] == 220_000_000
    assert "Installed identity stock" in anchors["cdp_unified_identity_stock"]["allowed_use"]
    assert "new future users" in anchors["cdp_unified_identity_stock"]["prohibited_use"]

    with open(tmp_path / "ledger_anchor_registry.csv", newline="", encoding="utf-8") as f:
        csv_rows = list(csv.DictReader(f))
    assert len(csv_rows) == len(ANCHORS_BY_ID)


def test_pdf_extraction_includes_otp_and_campaign_anchor():
    metrics = extract_metrics()
    assert metrics["total_cumulative_engaged_audience"] == 1_450_000_000
    assert metrics["total_unified_user_ids"] == 220_000_000
    assert metrics["zee5_registered_users"] == 180_000_000
    assert metrics["zee5_registration_conversion_rate"] == 0.67
    assert metrics["zee5_otp_verification_rate"] == 0.94
    assert metrics["gold_coin_2024_unique_users"] == 581_684


def test_growth_module_exposes_ledger_state_transitions_without_recasting_reach_as_stock():
    growth = V2GrowthModule(scheme_id=2, n_epochs=260)
    schedule = growth.generate_schedule()

    assert growth.production_adoption_family == "state_transition_hazard"
    assert growth.linear_profile_role == "control_only"
    assert "must not map directly" in growth.profile_tier_semantics
    assert growth.ledger_anchors["registration_wall_conversion"] == 0.67
    assert growth.ledger_anchors["otp_verification_conversion"] == 0.94

    final = schedule.iloc[-1]
    assert final["ledger_cumulative_reach_ceiling_nominal"] == 1_450_000_000
    assert final["ledger_existing_cdp_identity_stock_nominal"] == 220_000_000
    assert final["ledger_z1_aware_nominal"] <= 220_000_000
    assert final["ledger_verified_claimant_nominal"] <= final["ledger_claim_attempt_nominal"]
    assert final["ledger_settlement_participant_nominal"] <= final["ledger_verified_claimant_nominal"]


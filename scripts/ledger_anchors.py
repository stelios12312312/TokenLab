from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class LedgerAnchor:
    anchor_id: str
    value: float
    unit: str
    source_page: int
    source_date: str
    stock_or_flow: str
    cumulative_or_point_in_time: str
    population: str
    denominator: str
    allowed_use: str
    prohibited_use: str
    confidence: str
    evidence_reference: str


LEDGER_ANCHORS = [
    LedgerAnchor(
        "cumulative_engaged_audience_total",
        1_450_000_000,
        "people",
        126,
        "March 2026",
        "stock",
        "cumulative",
        "All documented Zee engaged audience, 1992-2026",
        "deduplicated historical reach",
        "Reach ceiling and ACR addressable-base ceiling",
        "Current live users, simultaneous audience, or new Z1 onboarding stock",
        "high",
        "Table 7.1.1: cumulative engaged viewership, not simultaneous audience",
    ),
    LedgerAnchor(
        "cumulative_engaged_audience_domestic",
        1_050_000_000,
        "people",
        126,
        "March 2026",
        "stock",
        "cumulative",
        "India domestic Zee engaged audience, 1992-2026",
        "domestic share of cumulative reach",
        "Domestic reach ceiling for segmentation",
        "Current domestic active users or incremental future users",
        "high",
        "Domestic component of 1.45B cumulative audience",
    ),
    LedgerAnchor(
        "cumulative_engaged_audience_international",
        400_000_000,
        "people",
        126,
        "March 2026",
        "stock",
        "cumulative",
        "International Zee engaged audience, 1992-2026",
        "international share of cumulative reach",
        "International reach ceiling for segmentation",
        "Current international active users or incremental future users",
        "high",
        "International component of 1.45B cumulative audience",
    ),
    LedgerAnchor(
        "cdp_unified_identity_stock",
        220_000_000,
        "identities",
        135,
        "December 2025",
        "stock",
        "point_in_time",
        "Deduplicated CDP mobile-anchored user identities",
        "cross-source deduplicated CDP records",
        "Installed identity stock available for Z1 transition modeling",
        "220M new future users or 220M automatic Z1 claimants",
        "high",
        "CDP unified user IDs, verified mobile-anchored",
    ),
    LedgerAnchor(
        "zee5_registered_user_stock",
        180_000_000,
        "users",
        135,
        "December 2025",
        "stock",
        "point_in_time",
        "ZEE5 registered users",
        "OTP-validated registration records",
        "Subset of identity stock and registration-wall calibration anchor",
        "Additional to CDP identities or automatic active Z1 participants",
        "high",
        "ZEE5 registered users, OTP-validated mobile plus email",
    ),
    LedgerAnchor(
        "monthly_active_user_stock",
        95_000_000,
        "users",
        123,
        "December 2025",
        "stock",
        "point_in_time",
        "Monthly active ZEE5/platform users",
        "operational monthly activity base",
        "Activity-stock calibration and exposure prior",
        "Cumulative reach, registered stock, or automatic claimant stock",
        "medium",
        "Operational MAU anchor used as activity stock",
    ),
    LedgerAnchor(
        "gold_profile_stock",
        45_000_000,
        "profiles",
        123,
        "December 2025",
        "stock",
        "point_in_time",
        "Tier 1 Gold FPD profiles",
        "CDP profile quality tier",
        "Profile-completeness metadata and data-quality prior",
        "Passive/active/power cohort behavior mapping",
        "high",
        "Gold profiles: full Golden Record, 7+ fields",
    ),
    LedgerAnchor(
        "silver_profile_stock",
        75_000_000,
        "profiles",
        123,
        "December 2025",
        "stock",
        "point_in_time",
        "Tier 2 Silver FPD profiles",
        "CDP profile quality tier",
        "Profile-completeness metadata and data-quality prior",
        "Passive/active/power cohort behavior mapping",
        "high",
        "Silver profiles: enriched, 4-6 fields",
    ),
    LedgerAnchor(
        "bronze_profile_stock",
        100_000_000,
        "profiles",
        123,
        "December 2025",
        "stock",
        "point_in_time",
        "Tier 3 Bronze/guest FPD profiles",
        "CDP profile quality tier",
        "Profile-completeness metadata and data-quality prior",
        "Passive/active/power cohort behavior mapping",
        "high",
        "Bronze/guest profiles: baseline verified mobile and consent timestamp",
    ),
    LedgerAnchor(
        "registration_wall_conversion_rate",
        0.67,
        "rate",
        135,
        "December 2025",
        "flow",
        "conditional_rate",
        "Sessions encountering the 8-minute ZEE5 registration wall",
        "registration-wall attempts",
        "Conditional conversion after registration wall exposure",
        "Top-of-funnel conversion before registration wall exposure",
        "high",
        "Registration conversion rate, 8-minute model",
    ),
    LedgerAnchor(
        "otp_verification_rate",
        0.94,
        "rate",
        135,
        "December 2025",
        "flow",
        "conditional_rate",
        "ZEE5 registration attempts that reach OTP",
        "OTP attempts",
        "Conditional pass rate after OTP attempt",
        "Overall audience verification rate or replacement for claim eligibility",
        "high",
        "OTP verification rate of registrations",
    ),
    LedgerAnchor(
        "gold_coin_2024_unique_users",
        581_684,
        "users",
        136,
        "2024",
        "flow",
        "campaign_count",
        "Gold Coin campaign confirmed unique users",
        "contest-entry and delivery-confirmed campaign logs",
        "Campaign evidence, enrichment, and lower-bound participation calibration",
        "Fully incremental new users, deduplicated across all campaigns, or durable active stock",
        "high",
        "Gold Coin unique users, contest logs and prize confirmation",
    ),
]


ANCHORS_BY_ID = {anchor.anchor_id: anchor for anchor in LEDGER_ANCHORS}


def anchors_as_dicts():
    return [asdict(anchor) for anchor in LEDGER_ANCHORS]


def anchor_value(anchor_id: str) -> float:
    return ANCHORS_BY_ID[anchor_id].value

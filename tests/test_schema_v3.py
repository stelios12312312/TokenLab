"""Schema v3 grammar, v1/v2 byte-identity, and the fail-closed security
battery for typed references (staking, treasuries, ecosystem channels,
named curves, distribution specs).

# @planner:story = US-PM-AUTO-HBD48E6CAE9D9DF04

Covers the staking/multi-token migration invariants:

- S-001: schema v1 and v2 parsing is byte-identical under the v3-capable
  parser — the pinned ``config_hash`` of every pre-existing v1/v2 scenario
  is unchanged (the hashes below were verified identical between the
  pre-v3 parser at the foundation commit and the v3 parser), and v3-only
  keys stay rejected in v1/v2 documents.
- S-002: every named unsafe input fails closed BEFORE any object is
  constructed, with the allowed list named in the error: missing reward
  source/treasury reference, unknown economy or channel reference,
  duplicate ids, channel cycles, master-not-in-set, invalid channel kind,
  non-allowlisted curve/distribution/component names, and any
  callable/import-shaped value.
"""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path

import pytest

from TokenLab.agentic.factory import ScenarioBuildError, ScenarioFactory
from TokenLab.agentic.schema import (
    CHANNEL_KINDS,
    CURVE_NAMES,
    DISTRIBUTION_NAMES,
    STAKING_COMPONENT_NAMES,
    SUPPORTED_SCHEMA_VERSIONS,
    ScenarioError,
    load_scenario,
    scenario_from_dict,
)

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "src" / "TokenLab" / "agentic" / "data"

# Pinned under the pre-v3 parser (foundation commit) and re-verified
# byte-identical under the v3 parser: v1/v2 parsing and semantics must not
# move when the additive v3 grammar ships.
V1_V2_CONFIG_HASHES = {
    "public_demo.yaml": "30c98082f0ef79e2879e6f71dd66bdafe082d694ed54c490db96171585c5fcaf",
    "public_growth_uncertainty_v2.yaml": "b1b11ca0dbdb5039030dbe3b3c1c190bb9df263277428c1730797820ef154e33",
    "public_demand_history_v2.yaml": "32d229a5e8f3894adaa1e415483a8814b0d8559542575bff3bb9a4d946cfc8b6",
    "public_demand_constant_v1.yaml": "bdcfd6a835bd090aacc6b274463fe19f57929aeb989e7a7e148819c8d1da493a",
    "public_vesting_concentrated_v2.yaml": "de245267594f20dad3ab6e3ce8d550659ac60b033ebc0b67187b0b442865d8ad",
    "public_vesting_smoothed_v2.yaml": "28d7e07fb8da33cf3e6b0b66b23687d245e6b966b3681a23f09c424366480288",
    "public_vesting_constant_v1.yaml": "8c3be8ed28bdced416bf5c28a1ba28653aacb2d2a97eeb86c77a2ed1c3633a3e",
}

# The shipped v3 documents are pinned too: the additive grammar and the
# reviewed demo contents cannot drift silently.
V3_CONFIG_HASHES = {
    "public_staking_rewards_v3.yaml": "c878288b3dc4827ab5f0df38ecea4abdab8a882a8548cfe4b98d6b5d0be21af6",
    "public_multitoken_dependency_v3.yaml": "84cc43f5d0db6a98e80493ca27864d1830e4ddc7df6eb24051845f1f68a49465",
    "public_multitoken_disconnected_v3.yaml": "f996bbafbbb3d50716a9a975a219f7a1184a3eff11e32e4542c9c588a37dbe63",
}


def test_v1_and_v2_documents_parse_byte_identically():
    assert SUPPORTED_SCHEMA_VERSIONS == (1, 2, 3)
    for name, pinned in V1_V2_CONFIG_HASHES.items():
        config = load_scenario(DATA_DIR / name)
        assert config.schema_version in (1, 2)
        assert config.config_hash == pinned, name
        # v3-only structures are absent from v1/v2 documents.
        assert config.treasuries == ()
        assert config.ecosystem is None
        for pool in config.economy.agent_pools:
            assert pool.staking is None
            assert pool.treasury is None


def test_shipped_v3_documents_parse_with_pinned_hashes():
    for name, pinned in V3_CONFIG_HASHES.items():
        config = load_scenario(DATA_DIR / name)
        assert config.schema_version == 3
        assert config.config_hash == pinned, name


def _staking_doc():
    """A minimal valid schema v3 single-economy staking document."""
    return {
        "schema_version": 3,
        "scenario_id": "v3-test-staking",
        "economy": {
            "type": "TokenEconomy_Basic",
            "parameters": {"initial_price": 0.05, "fiat": "$", "token": "STLB"},
            "holding_time": {
                "type": "HoldingTime_Constant",
                "parameters": {"holding_time": 6.0},
            },
            "supply": {
                "type": "SupplyController_FromData",
                "parameters": {"values": [1000000, 1000000]},
            },
            "price": {"type": "PriceFunction_EOE", "parameters": {}},
            "agent_pools": [
                {
                    "id": "staking-demand",
                    "type": "AgentPool_Staking",
                    "parameters": {"currency": "STLB", "name": "staking-demand"},
                    "staking": {
                        "type": "SupplyStakerLockup",
                        "parameters": {
                            "staking_amount": 40000,
                            "rewards": 1600,
                            "lockup_duration": 4,
                            "reward_as_perc": False,
                        },
                    },
                    "users": {
                        "type": "UserGrowth_Constant",
                        "parameters": {"constant": 10},
                    },
                    "transactions": {
                        "type": "TransactionManagement_FromData",
                        "parameters": {"data": [120000, 120000]},
                    },
                }
            ],
        },
        "monte_carlo": {
            "simulator": "TokenMetaSimulator",
            "iterations": 4,
            "repetitions": 1,
            "seed": 7,
        },
        "artifacts": {"format": "csv"},
    }


def _ecosystem_doc():
    """A minimal valid schema v3 two-economy ecosystem document."""
    master = {
        "id": "master",
        "type": "TokenEconomy_Basic",
        "parameters": {
            "initial_price": 0.1,
            "fiat": "$",
            "token": "MTLB",
            "name": "MTLB",
            "safeguard_current_supply_level": False,
        },
        "holding_time": {
            "type": "HoldingTime_Constant",
            "parameters": {"holding_time": 4.0},
        },
        "supply": {"type": "SupplyController_Bonding", "parameters": {}},
        "price": {
            "type": "PriceFunction_IssuanceCurve",
            "parameters": {
                "function": {
                    "name": "log_power",
                    "params": {"multiplier": 0.1, "growth": 0.05, "base": 1.5},
                }
            },
        },
        "agent_pools": [
            {
                "id": "master-demand",
                "type": "AgentPool_Basic",
                "parameters": {"currency": "$", "name": "master-demand"},
                "users": {
                    "type": "UserGrowth_Constant",
                    "parameters": {"constant": 1},
                },
                "transactions": {
                    "type": "TransactionManagement_Trend",
                    "parameters": {
                        "average_transaction_initial": 120000,
                        "average_transaction_final": 240000,
                        "num_steps": 4,
                    },
                },
            }
        ],
    }
    dependent = {
        "id": "dependent",
        "type": "TokenEconomy_Dependent",
        "parameters": {
            "initial_price": 1.0,
            "fiat": "MTLB",
            "token": "MTDB",
            "name": "MTDB",
            "ignore_supply_controller": True,
            "safeguard_current_supply_level": False,
        },
        "holding_time": {
            "type": "HoldingTime_Constant",
            "parameters": {"holding_time": 4.0},
        },
        "supply": {
            "type": "SupplyController_Constant",
            "parameters": {"supply": 0},
        },
        "price": {
            "type": "PriceFunction_BondingCurve",
            "parameters": {
                "function": {
                    "name": "quadratic",
                    "params": {"base": 0.5, "coefficient": 1.0e-9, "exponent": 2},
                }
            },
        },
        "agent_pools": [
            {
                "id": "dependent-demand",
                "type": "AgentPool_Basic",
                "parameters": {"currency": "MTLB", "name": "dependent-demand"},
                "users": {
                    "type": "UserGrowth_Constant",
                    "parameters": {"constant": 1},
                },
                "transactions": {
                    "type": "TransactionManagement_Channeled",
                    "parameters": {"channel": "master"},
                },
            }
        ],
    }
    return {
        "schema_version": 3,
        "scenario_id": "v3-test-ecosystem",
        "ecosystem": {
            "master": "master",
            "economies": [master, dependent],
            "channels": [
                {"from": "master", "to": "dependent", "kind": "token", "percentage": 0.01}
            ],
        },
        "monte_carlo": {
            "simulator": "TokenMetaSimulator",
            "iterations": 4,
            "repetitions": 1,
            "seed": 11,
        },
        "artifacts": {"format": "csv"},
    }


def test_v3_positive_grammar_and_two_pass_resolution():
    staking = scenario_from_dict(_staking_doc())
    assert staking.schema_version == 3
    pool = staking.economy.agent_pools[0]
    assert pool.staking.type == "SupplyStakerLockup"
    assert pool.staking.parameters["reward_as_perc"] is False
    built = ScenarioFactory().build(staking)
    assert built.simulator.execute(iterations=4, repetitions=1).shape[0] == 4

    ecosystem = scenario_from_dict(_ecosystem_doc())
    assert ecosystem.ecosystem.master == "master"
    assert [economy.id for economy in ecosystem.ecosystem.economies] == [
        "master",
        "dependent",
    ]
    assert ecosystem.ecosystem.channels[0].kind == "token"
    built = ScenarioFactory().build(ecosystem)
    assert built.simulator.execute(iterations=4, repetitions=1).shape[0] == 4

    # Distribution specs and treasury wiring resolve through the allowlists.
    doc = _staking_doc()
    doc["treasuries"] = [
        {"id": "rewards", "parameters": {"name": "rewards", "treasury": {"STLB": 1000000}}}
    ]
    pool_doc = doc["economy"]["agent_pools"][0]
    pool_doc["treasury"] = "rewards"
    pool_doc["parameters"]["fee"] = 0.0
    pool_doc["staking"]["parameters"]["staking_amount"] = {
        "dist": "uniform",
        "low": 20000,
        "high": 80000,
    }
    config = scenario_from_dict(doc)
    spec = config.economy.agent_pools[0].staking.parameters["staking_amount"]
    assert spec == {"dist": "uniform", "low": 20000, "high": 80000}
    built = ScenarioFactory().build(config)
    treasury = built.economy._agent_pools[0].treasury
    assert treasury.treasury["STLB"] == 1000000


def test_v3_keys_are_rejected_in_v1_and_v2_documents():
    doc = _staking_doc()
    for version in (1, 2):
        v_doc = deepcopy(doc)
        v_doc["schema_version"] = version
        with pytest.raises(ScenarioError, match="not allowed"):
            scenario_from_dict(v_doc)
    # v2 without the v3 blocks still requires its uncertainty block.
    doc2 = _staking_doc()
    doc2["schema_version"] = 2
    del doc2["economy"]["agent_pools"][0]["staking"]
    doc2["economy"]["agent_pools"][0]["type"] = "AgentPool_Basic"
    with pytest.raises(ScenarioError, match="uncertainty is required"):
        scenario_from_dict(doc2)
    # economy XOR ecosystem.
    doc3 = _staking_doc()
    doc3["ecosystem"] = _ecosystem_doc()["ecosystem"]
    with pytest.raises(ScenarioError, match="economy XOR ecosystem"):
        scenario_from_dict(doc3)
    # v3 requires exactly one of them.
    doc4 = _staking_doc()
    del doc4["economy"]
    with pytest.raises(ScenarioError, match="exactly one of economy or ecosystem"):
        scenario_from_dict(doc4)


def _ecosystem_mutation(mutate):
    doc = _ecosystem_doc()
    mutate(doc)
    return doc


_FAIL_CLOSED_ECOSYSTEM_CASES = [
    (
        "unknown channel source economy",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["channels"][0].update({"from": "ghost"})
        ),
        "unknown economy 'ghost'",
    ),
    (
        "unknown channel target economy",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["channels"][0].update({"to": "ghost"})
        ),
        "unknown economy 'ghost'",
    ),
    (
        "undeclared channel reference in transactions",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["economies"][1]["agent_pools"][0][
                "transactions"
            ]["parameters"].update({"channel": "ghost"})
        ),
        "must reference a declared channel",
    ),
    (
        "duplicate economy ids",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["economies"][1].update({"id": "master"})
        ),
        "ids must be unique",
    ),
    (
        "duplicate agent pool ids",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["economies"][0]["agent_pools"].append(
                deepcopy(doc["ecosystem"]["economies"][0]["agent_pools"][0])
            )
        ),
        "ids must be unique",
    ),
    (
        "channel cycle",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["channels"].append(
                {"from": "dependent", "to": "master", "kind": "token", "percentage": 0.5}
            )
        ),
        "dependency cycle",
    ),
    (
        "self channel",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["channels"][0].update({"to": "master"})
        ),
        "channels must be directional",
    ),
    (
        "master not in economy set",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"].update({"master": "ghost"})
        ),
        "master references unknown economy 'ghost'",
    ),
    (
        "invalid channel kind",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["channels"][0].update({"kind": "hybrid"})
        ),
        "kind must be one of: fiat, token",
    ),
    (
        "channel percentage out of range",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["channels"][0].update({"percentage": 1.5})
        ),
        "percentage must lie in",
    ),
    (
        "non-allowlisted issuance curve",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["economies"][0]["price"]["parameters"].update(
                {"function": {"name": "black_scholes", "params": {}}}
            )
        ),
        "must name an allowlisted curve",
    ),
    (
        "curve with unknown parameter",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["economies"][0]["price"]["parameters"][
                "function"
            ]["params"].update({"strike": 1})
        ),
        "not allowed for curve 'log_power'",
    ),
    (
        "curve with invalid parameter range",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["economies"][0]["price"]["parameters"][
                "function"
            ]["params"].update({"base": 0.5})
        ),
        "base > 1",
    ),
    (
        "import-shaped curve value",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["economies"][0]["price"]["parameters"].update(
                {"function": "os.system"}
            )
        ),
        "callables and import strings are never allowed",
    ),
    (
        "dotted module path as curve name",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["economies"][0]["price"]["parameters"].update(
                {"function": {"name": "projects.demo.curve", "params": {}}}
            )
        ),
        "must name an allowlisted curve",
    ),
    (
        "function parameter on a non-curve price type",
        _ecosystem_mutation(
            lambda doc: doc["ecosystem"]["economies"][0]["price"].update(
                {
                    "type": "PriceFunction_EOE",
                    "parameters": {
                        "function": {
                            "name": "log_power",
                            "params": {"multiplier": 0.1, "growth": 0.05, "base": 1.5},
                        }
                    },
                }
            )
        ),
        "only allowed for price types",
    ),
]

def _staking_mutation(mutate):
    doc = _staking_doc()
    mutate(doc)
    return doc


_FAIL_CLOSED_STAKING_CASES = [
    (
        "undeclared treasury reference (missing reward source)",
        lambda doc: doc["economy"]["agent_pools"][0].update({"treasury": "ghost"}),
        "references undeclared treasury 'ghost'",
    ),
    (
        "duplicate treasury ids",
        lambda doc: doc.update(
            {
                "treasuries": [
                    {"id": "rewards", "parameters": {"treasury": {"STLB": 10}}},
                    {"id": "rewards", "parameters": {"treasury": {"STLB": 20}}},
                ]
            }
        ),
        "ids must be unique",
    ),
    (
        "non-allowlisted staking component",
        lambda doc: doc["economy"]["agent_pools"][0]["staking"].update(
            {"type": "SupplyStakerMonthly_Callable"}
        ),
        "must name an allowlisted staking component",
    ),
    (
        "non-allowlisted distribution name",
        lambda doc: doc["economy"]["agent_pools"][0]["staking"]["parameters"].update(
            {"staking_amount": {"dist": "norm", "low": 1, "high": 2}}
        ),
        "must name an allowlisted distribution",
    ),
    (
        "distribution with inverted bounds",
        lambda doc: doc["economy"]["agent_pools"][0]["staking"]["parameters"].update(
            {"staking_amount": {"dist": "uniform", "low": 2, "high": 1}}
        ),
        "low < high",
    ),
    (
        "import-shaped staking amount",
        lambda doc: doc["economy"]["agent_pools"][0]["staking"]["parameters"].update(
            {"staking_amount": "os.system"}
        ),
        "callables and import strings are never allowed",
    ),
    (
        "missing explicit reward_as_perc pin",
        lambda doc: doc["economy"]["agent_pools"][0]["staking"]["parameters"].pop(
            "reward_as_perc"
        ),
        "reward_as_perc is required",
    ),
    (
        "staking block on a non-staking pool",
        lambda doc: doc["economy"]["agent_pools"][0].update(
            {"type": "AgentPool_Basic"}
        ),
        "requires pool type 'AgentPool_Staking'",
    ),
    (
        "unknown staking parameter",
        lambda doc: doc["economy"]["agent_pools"][0]["staking"]["parameters"].update(
            {"reward_function": "lambda x: x"}
        ),
        "not allowed",
    ),
    (
        "quit probability out of range",
        lambda doc: doc["economy"]["agent_pools"][0]["staking"]["parameters"].update(
            {"quit_prob": 1.5}
        ),
        "quit_prob must lie in",
    ),
]


@pytest.mark.parametrize(
    "case_id,doc,match",
    [
        *[(case_id, doc, match) for case_id, doc, match in _FAIL_CLOSED_ECOSYSTEM_CASES],
        *[
            (case_id, _staking_mutation(mutate), match)
            for case_id, mutate, match in _FAIL_CLOSED_STAKING_CASES
        ],
    ],
    ids=[case_id for case_id, _, _ in _FAIL_CLOSED_ECOSYSTEM_CASES]
    + [case_id for case_id, _, _ in _FAIL_CLOSED_STAKING_CASES],
)
def test_fail_closed_security_negatives(case_id, doc, match):
    """Every named unsafe input is a parse error before ANY object is built."""
    with pytest.raises(ScenarioError, match=match):
        scenario_from_dict(doc)


def test_fail_closed_at_build_time_with_allowed_lists():
    # AgentPool_Staking without a staking block refuses to build (the reward
    # mode can never be inherited silently).
    doc = _staking_doc()
    del doc["economy"]["agent_pools"][0]["staking"]
    config = scenario_from_dict(doc)
    with pytest.raises(ScenarioBuildError, match="requires a staking block"):
        ScenarioFactory().build(config)

    # A channeled controller outside an ecosystem refuses to build.
    doc = _staking_doc()
    doc["economy"]["agent_pools"][0]["type"] = "AgentPool_Basic"
    del doc["economy"]["agent_pools"][0]["staking"]
    doc["economy"]["agent_pools"][0]["transactions"] = {
        "type": "TransactionManagement_Channeled",
        "parameters": {"channel": "master"},
    }
    config = scenario_from_dict(doc)
    with pytest.raises(ScenarioBuildError, match="requires a schema v3 ecosystem"):
        ScenarioFactory().build(config)

    # Unknown component names fail at resolve time with the allowed list.
    doc = _staking_doc()
    doc["economy"]["agent_pools"][0]["type"] = "AgentPool_Basic"
    del doc["economy"]["agent_pools"][0]["staking"]
    doc["economy"]["agent_pools"][0]["users"] = {
        "type": "UserGrowth_Evil",
        "parameters": {},
    }
    config = scenario_from_dict(doc)
    with pytest.raises(ScenarioBuildError, match="unknown user_growth component"):
        ScenarioFactory().build(config)

    # A hand-built curve spec with a non-allowlisted name fails closed even
    # when it bypasses the schema parser.
    from TokenLab.agentic.factory import _build_curve

    with pytest.raises(ScenarioBuildError, match="unknown curve"):
        _build_curve({"name": "eval", "params": {}}, "test")


def test_allowlist_constants_are_finite_and_documented():
    assert set(STAKING_COMPONENT_NAMES) == {"SupplyStakerLockup", "SupplyStakerMonthly"}
    assert set(CHANNEL_KINDS) == {"fiat", "token"}
    assert set(DISTRIBUTION_NAMES) == {"uniform"}
    assert set(CURVE_NAMES) == {"log_power", "quadratic"}


def test_ecosystem_uncertainty_paths_resolve_for_v3_only():
    # ecosystem.* paths resolve against the ecosystem tree for v3 documents.
    doc = _ecosystem_doc()
    doc["uncertainty"] = {
        "parameters": [
            {
                "id": "channel_percentage",
                "path": "ecosystem.channels[0].percentage",
                "value_type": "number",
                "unit": "fraction",
                "layer": "parameter",
                "cadence": "per_path",
                "distribution": {
                    "family": "triangular",
                    "minimum": 0.005,
                    "mode": 0.01,
                    "maximum": 0.02,
                },
                "bounds": {"minimum": 0.005, "maximum": 0.02},
                "provenance": "Illustrative test prior, uncalibrated.",
                "rationale": "Exercises ecosystem channel path resolution.",
                "calibration": "illustrative",
                "approval": "approved",
                "dependence": "independent",
            }
        ],
        "dependence_groups": [],
    }
    config = scenario_from_dict(doc)
    assert config.is_stochastic
    assert config.uncertainty.parameters[0].path == "ecosystem.channels[0].percentage"

    # The same path shape must NOT resolve against a v2 economy document:
    # v1/v2 resolution stays byte-identical.
    v2_doc = {
        "schema_version": 2,
        "scenario_id": "v2-no-ecosystem-paths",
        "economy": _staking_doc()["economy"],
        "monte_carlo": {
            "simulator": "TokenMetaSimulator",
            "iterations": 4,
            "repetitions": 1,
            "seed": 7,
        },
        "artifacts": {"format": "csv"},
        "uncertainty": deepcopy(doc["uncertainty"]),
    }
    del v2_doc["economy"]["agent_pools"][0]["staking"]
    v2_doc["economy"]["agent_pools"][0]["type"] = "AgentPool_Basic"
    with pytest.raises(ScenarioError, match="does not resolve"):
        scenario_from_dict(v2_doc)

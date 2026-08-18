"""Deterministic assumption-aware operations for agent-driven TokenLab runs.

# @planner:module = assumptions
# @planner:story = US-PM-AUTO-H5C4D76290B437A5B
# @planner:proves = crit:CRIT-004

This module is the Phase 4 agent operation layer. It exposes five frozen
operations an agent can call but cannot override:

- ``inspect_assumptions`` — classify every governed input of a scenario as
  ``fixed`` / ``uncertain`` / ``draft`` / ``process`` and ledger the
  tokenomics domain coverage actually present in the scenario;
- ``validate_uncertainty`` — wrap the Phase 2 validator and surface every
  missing range/provenance/unit/calibration/approval/dependence item as a
  structured question;
- ``propose_run`` — map a declared purpose to a frozen run tier and return a
  proposal only (never executes);
- ``run_simulation`` — gated execution: non-executable validations, seed
  problems, out-of-bounds budgets, and non-allowlisted paths are structured
  refusals, never silent coercions; schema v1 scenarios route to the
  deterministic ``HeadlessRunner`` with Monte Carlo claims forbidden;
- ``summarize_evidence`` — read a published bundle back into a cited summary
  in which every number traces to an exact artifact file and field; bundle
  outputs are re-hashed and contained-resolved before use, and claim
  eligibility is recomputed from the verified contents rather than echoed
  from the manifest.

Every operation returns a JSON-safe envelope
``{"operation": <name>, "status": "ok" | "refused" | "error", ...}``.
Refusals carry ``reasons`` and, where evidence is missing, structured
``questions`` of the shape ``{id, subject, question, needed_evidence}``.
There is no LLM anywhere in this layer.

Safety contract:

- scenario path inputs must resolve under an allowlisted root (the package
  ``data/`` directory, the repository ``examples/scenarios/`` and
  ``tests/fixtures/`` directories, or explicit caller-provided
  ``allowed_roots``) and end in ``.yaml``/``.yml``/``.json``; anything else —
  including ``..`` escapes and absolute system paths — is refused;
- ``output_dir`` must resolve under the repository ``outputs/`` root or an
  explicit caller-provided ``allowed_output_roots`` entry; nothing is ever
  written outside ``output_dir``;
- operations never mutate the input config: calibration is never set to
  ``calibrated``, approval is never flipped to ``approved``, and absent
  tokenomics domains are never marked modeled. Inspect/summarize echo those
  states read-only.
"""

from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd
import yaml

from .artifact_profile import file_sha256
from .factory import ScenarioFactory, default_registry
from .runner import (
    RUN_TIERS,
    ArtifactError,
    HeadlessRunner,
    MonteCarloError,
    MonteCarloRunner,
    evaluate_claim_eligibility,
)
from .schema import ScenarioConfig, ScenarioError, load_scenario, scenario_from_dict
from .statistics import (
    IntervalLabelError,
    NON_CAUSAL_INTERPRETATION,
    OUTCOME_INTERVAL_LABEL,
    validate_interval_labels,
)
from .uncertainty import (
    FAMILIES,
    UncertaintySpec,
    UncertaintyValidation,
    parse_uncertainty,
    validate_v2_scenario,
)


_AGENTIC_ROOT = Path(__file__).resolve().parent
_REPO_ROOT = _AGENTIC_ROOT.parents[2]

# Frozen path allowlists. Callers may extend them per operation; they can
# never shrink them from scenario data.
DEFAULT_SCENARIO_ROOTS: Tuple[Path, ...] = (
    _AGENTIC_ROOT / "data",
    _REPO_ROOT / "examples" / "scenarios",
    _REPO_ROOT / "tests" / "fixtures",
)
DEFAULT_OUTPUT_ROOTS: Tuple[Path, ...] = (_REPO_ROOT / "outputs",)
SCENARIO_SUFFIXES = {".yaml", ".yml", ".json"}

SUPPORTED_DEPENDENCE = (
    "independent",
    "gaussian_copula (continuous marginals only)",
)

# Frozen purpose -> run tier mapping.
PURPOSE_TIERS: Dict[str, str] = {
    "interactive": "fast",
    "exploration": "fast",
    "analysis": "standard",
    "report": "standard",
    "decision": "deep",
    "decision-facing": "deep",
    "promotion": "deep",
    "smoke": "test",
    "test": "test",
}
EXPECTED_PRECISION: Dict[str, str] = {
    "test": "smoke check only; no precision claim",
    "fast": "illustrative / low precision",
    "standard": (
        "convergence diagnostics required; insufficient checkpoints or a "
        "not_converged metric block claim eligibility"
    ),
    "deep": (
        "promotion candidate; insufficient checkpoints or a not_converged "
        "metric block claim eligibility"
    ),
}

# Measured on the reference machine; used for cost proposals only.
REFERENCE_SECONDS_PER_PATH = 0.004
REFERENCE_SECONDS_PER_RESAMPLE = 0.0005

PROPOSAL_BOUNDARY = (
    "This proposal is not a forecast and executes nothing. Uncalibrated or "
    "illustrative priors cannot support decision-grade claims; live launch, "
    "investment, or legal decisions require qualified review."
)
INTERPRETATION_BOUNDARY = (
    "Modeled outcome intervals are not confidence intervals, and neither "
    "modeled intervals nor estimator confidence intervals are forecasts. "
    "This summary is not investment, legal, financial, or launch-readiness "
    "advice. Prior calibration states are echoed read-only from the bundle; "
    "illustrative or uncalibrated priors cannot support decision-grade claims."
)

TOKENOMICS_DOMAINS = (
    "supply",
    "emissions",
    "vesting_unlocks",
    "incentive_source",
    "liquidity",
    "treasury",
    "governance",
    "staking",
    "fdv",
    "apy",
)

_NEEDED_EVIDENCE = {
    "range": "numeric bounds (minimum/maximum) and distribution support for this prior",
    "unit": "a unit label for this parameter (for example 'users' or 'usd')",
    "provenance": "a provenance note naming the source of this prior",
    "calibration": "calibration evidence (data, study, or reviewed estimate) for this prior",
    "approval": "explicit approval of this prior by the scenario owner",
    "dependence": "a dependence declaration: 'independent' or {group: <id>} naming a valid group",
    "structure": "a corrected uncertainty block entry matching the schema",
}


class _Refusal(Exception):
    """Internal control flow: turn a gate failure into a refused envelope."""

    def __init__(self, reasons: Sequence[str], questions: Sequence[Dict[str, Any]] = ()):
        super().__init__("; ".join(reasons))
        self.reasons = list(reasons)
        self.questions = list(questions)


def _refused(
    operation: str,
    reasons: Sequence[str],
    questions: Sequence[Dict[str, Any]] = (),
) -> Dict[str, Any]:
    return {
        "operation": operation,
        "status": "refused",
        "reasons": [str(reason) for reason in reasons],
        "questions": list(questions),
    }


def _error(operation: str, reasons: Sequence[str]) -> Dict[str, Any]:
    return {
        "operation": operation,
        "status": "error",
        "reasons": [str(reason) for reason in reasons],
    }


# ---------------------------------------------------------------------------
# Path allowlist enforcement
# ---------------------------------------------------------------------------


def _resolve_under_roots(
    value: Union[str, Path],
    *,
    roots: Sequence[Union[str, Path]],
    kind: str,
    require_suffix: bool,
) -> Path:
    """Resolve ``value`` and require it to live under one of ``roots``."""
    try:
        resolved = Path(value).expanduser().resolve()
    except OSError as exc:
        raise _Refusal([f"{kind} path {value!r} cannot be resolved: {exc}"])
    if require_suffix and resolved.suffix.lower() not in SCENARIO_SUFFIXES:
        raise _Refusal(
            [
                f"{kind} path {resolved} must end in .yaml, .yml, or .json; "
                f"got {resolved.suffix!r}"
            ]
        )
    allowed: List[str] = []
    for root in roots:
        try:
            resolved_root = Path(root).expanduser().resolve()
        except OSError:
            continue
        try:
            resolved.relative_to(resolved_root)
            return resolved
        except ValueError:
            allowed.append(str(resolved_root))
    raise _Refusal(
        [
            f"{kind} path {resolved} is outside the allowlisted roots "
            f"({'; '.join(allowed) or 'none available'}); pass explicit "
            "allowed_roots to admit it"
        ]
    )


def _scenario_roots(allowed_roots: Optional[Sequence[Union[str, Path]]]) -> List[Path]:
    return [*DEFAULT_SCENARIO_ROOTS, *(Path(root) for root in (allowed_roots or []))]


def _output_roots(
    allowed_output_roots: Optional[Sequence[Union[str, Path]]]
) -> List[Path]:
    return [*DEFAULT_OUTPUT_ROOTS, *(Path(root) for root in (allowed_output_roots or []))]


def _coerce_scenario(
    scenario: Union[str, Path, ScenarioConfig],
    allowed_roots: Optional[Sequence[Union[str, Path]]],
) -> ScenarioConfig:
    """Accept a config object (no path check) or an allowlisted file path."""
    if isinstance(scenario, ScenarioConfig):
        return scenario
    if isinstance(scenario, (str, Path)):
        resolved = _resolve_under_roots(
            scenario,
            roots=_scenario_roots(allowed_roots),
            kind="scenario",
            require_suffix=True,
        )
        return load_scenario(resolved)
    raise ScenarioError(
        f"unsupported scenario input type {type(scenario).__name__!r}; "
        "expected a ScenarioConfig or a scenario file path"
    )


# ---------------------------------------------------------------------------
# Structured questions
# ---------------------------------------------------------------------------


def _subject_for(reason: str) -> str:
    text = reason.lower()
    if "provenance" in text:
        return "provenance"
    if "calibration" in text:
        return "calibration"
    if "approval" in text:
        return "approval"
    if "dependence" in text or "group" in text:
        return "dependence"
    if "unit" in text:
        return "unit"
    if any(
        token in text
        for token in ("bounds", "minimum", "maximum", "support", "range")
    ):
        return "range"
    return "structure"


def _question(ident: Optional[str], subject: str, question: str) -> Dict[str, Any]:
    return {
        "id": ident,
        "subject": subject,
        "question": question,
        "needed_evidence": _NEEDED_EVIDENCE[subject],
    }


def _structured_questions(validation: UncertaintyValidation) -> List[Dict[str, Any]]:
    """One structured question per error, non-approved entry, and calibration gap."""
    questions: List[Dict[str, Any]] = []
    for error in validation.errors:
        reason = error["reason"]
        questions.append(_question(error.get("id"), _subject_for(reason), reason))
    for warning in validation.warnings:
        questions.append(_question(warning.get("id"), "approval", warning["reason"]))
    for question in validation.questions:
        questions.append(
            _question(question.get("id"), "calibration", question["reason"])
        )
    return questions


def _non_executable_reasons(validation: UncertaintyValidation) -> List[str]:
    return [
        f"{error['id'] or 'uncertainty'}: {error['reason']}"
        for error in validation.errors
    ] + [
        f"{warning['id']}: {warning['reason']}" for warning in validation.warnings
    ]


# ---------------------------------------------------------------------------
# inspect_assumptions
# ---------------------------------------------------------------------------


def _scalar_leaves(parameters: Mapping[str, Any], prefix: str = ""):
    for key in sorted(parameters):
        value = parameters[key]
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(value, Mapping):
            yield from _scalar_leaves(value, path)
        elif isinstance(value, list):
            for index, item in enumerate(value):
                if isinstance(item, Mapping):
                    yield from _scalar_leaves(item, f"{path}[{index}]")
                else:
                    yield f"{path}[{index}]", item
        else:
            yield path, value


def _v1_leaves(config: ScenarioConfig) -> List[Tuple[str, Any]]:
    """Every scalar input leaf of a v1 scenario, as dotted economy paths."""
    economy = config.economy
    leaves: List[Tuple[str, Any]] = []

    def collect(prefix: str, parameters: Mapping[str, Any]) -> None:
        leaves.extend((f"{prefix}.{path}", value) for path, value in _scalar_leaves(parameters))

    collect("economy.parameters", economy.parameters)
    collect("economy.holding_time.parameters", economy.holding_time.parameters)
    collect("economy.supply.parameters", economy.supply.parameters)
    collect("economy.price.parameters", economy.price.parameters)
    for index, pool in enumerate(economy.supply_pools):
        collect(f"economy.supply_pools[{index}].parameters", pool.parameters)
    for index, pool in enumerate(economy.agent_pools):
        collect(f"economy.agent_pools[{index}].parameters", pool.parameters)
        collect(f"economy.agent_pools[{index}].users.parameters", pool.users.parameters)
        collect(
            f"economy.agent_pools[{index}].transactions.parameters",
            pool.transactions.parameters,
        )
    return leaves


def _v1_entry(path: str, value: Any) -> Dict[str, Any]:
    return {
        "id": f"fixed:{path}",
        "classification": "fixed",
        "path": path,
        "unit": None,
        "family": "fixed",
        "value": value,
        "provenance": "scenario file (schema v1 carries no assumption metadata)",
        "rationale": None,
        "calibration": "not_tracked",
        "approval": "not_applicable",
        "dependence": "independent",
        "layer": "parameter",
        "cadence": "per_path",
    }


def _spec_entry(spec: UncertaintySpec) -> Dict[str, Any]:
    family = spec.distribution.family
    if spec.approval != "approved":
        classification = "draft"
    elif family == "fixed":
        classification = "fixed"
    else:
        classification = "uncertain"
    entry: Dict[str, Any] = {
        "id": spec.id,
        "classification": classification,
        "path": spec.path,
        "unit": spec.unit,
        "family": family,
        "value": (
            spec.distribution.parameters.get("value") if family == "fixed" else None
        ),
        "provenance": spec.provenance,
        "rationale": spec.rationale,
        "calibration": spec.calibration,
        "approval": spec.approval,
        "dependence": (
            "independent" if spec.group is None else {"group": spec.group.id}
        ),
        "layer": spec.layer,
        "cadence": spec.cadence,
    }
    if classification == "draft":
        entry["executable"] = False
        entry["note"] = (
            "draft/needs_evidence priors are explicitly non-executable until approved"
        )
    return entry


def _process_entries(config: ScenarioConfig) -> List[Dict[str, Any]]:
    """Stochastic component RNG sites: allowlisted classes accepting ``rng``."""
    registry = default_registry()
    factory = ScenarioFactory(registry)
    economy = config.economy
    contexts: List[Tuple[str, str, str]] = [
        ("economy", "economy", economy.type),
        ("economy.holding_time", "holding_time", economy.holding_time.type),
        ("economy.supply", "supply", economy.supply.type),
        ("economy.price", "price", economy.price.type),
    ]
    for index, pool in enumerate(economy.supply_pools):
        contexts.append((f"economy.supply_pools[{index}]", "supply", pool.type))
    for index, pool in enumerate(economy.agent_pools):
        contexts.extend(
            [
                (f"economy.agent_pools[{index}]", "agent_pool", pool.type),
                (f"economy.agent_pools[{index}].users", "user_growth", pool.users.type),
                (
                    f"economy.agent_pools[{index}].transactions",
                    "transaction",
                    pool.transactions.type,
                ),
            ]
        )
    contexts.append(
        ("monte_carlo.simulator", "simulator", config.monte_carlo.simulator)
    )
    entries: List[Dict[str, Any]] = []
    for context, category, type_name in contexts:
        try:
            component = registry.resolve(category, type_name)
        except ScenarioError:
            continue
        if not factory._accepts_rng(component):
            continue
        entries.append(
            {
                "id": f"process:{context}",
                "classification": "process",
                "path": context,
                "unit": None,
                "family": "process_rng",
                "value": None,
                "provenance": (
                    f"component class {type_name} declares an rng parameter "
                    "(stochastic process site)"
                ),
                "rationale": None,
                "calibration": "not_applicable",
                "approval": "not_applicable",
                "dependence": "independent",
                "layer": "process",
                "cadence": "per_iteration",
            }
        )
    return entries


def _tokenomics_coverage(config: ScenarioConfig) -> Dict[str, Dict[str, str]]:
    """Ledger the tokenomics domains actually present in the scenario.

    Statuses are ``modeled`` / ``fixed`` / ``absent``; values for absent
    domains are never inferred.
    """
    economy = config.economy
    token = economy.parameters.get("token", "token")
    supply_type = economy.supply.type
    pool_types = [pool.type for pool in economy.supply_pools]
    governed = set()
    if config.uncertainty is not None:
        governed = {spec.path for spec in config.uncertainty.parameters}
    supply_sampled = any(
        path == "economy.supply"
        or path.startswith("economy.supply.")
        or path.startswith("economy.supply_pools")
        for path in governed
    )
    supply_types = [supply_type, *pool_types]

    coverage: Dict[str, Dict[str, str]] = {}
    if supply_sampled:
        coverage["supply"] = {
            "status": "modeled",
            "basis": f"supply is governed by uncertainty priors under {supply_type}",
        }
    elif supply_type == "SupplyController_Constant":
        coverage["supply"] = {
            "status": "fixed",
            "basis": (
                "SupplyController_Constant holds supply fixed at "
                f"{economy.supply.parameters.get('supply')} {token}"
            ),
        }
    else:
        coverage["supply"] = {
            "status": "modeled",
            "basis": f"supply varies over time under {supply_type}",
        }
    if supply_sampled or supply_type != "SupplyController_Constant":
        coverage["emissions"] = {
            "status": "modeled",
            "basis": f"supply issuance varies under {supply_type}, so emissions are represented",
        }
    else:
        coverage["emissions"] = {
            "status": "absent",
            "basis": "constant supply; no emissions schedule is configured",
        }
    if "SupplyController_CliffVesting" in supply_types:
        coverage["vesting_unlocks"] = {
            "status": "modeled",
            "basis": "a SupplyController_CliffVesting component models vesting unlocks",
        }
    else:
        coverage["vesting_unlocks"] = {
            "status": "absent",
            "basis": "no vesting or unlock controller is configured",
        }
    if pool_types:
        coverage["incentive_source"] = {
            "status": "modeled",
            "basis": f"supply pools configured: {', '.join(pool_types)}",
        }
    else:
        coverage["incentive_source"] = {
            "status": "absent",
            "basis": "no supply pool or incentive mechanism is configured",
        }
    if "SupplyController_Bonding" in supply_types:
        coverage["liquidity"] = {
            "status": "modeled",
            "basis": "a bonding-curve supply controller provides an implicit liquidity mechanism",
        }
    else:
        coverage["liquidity"] = {
            "status": "absent",
            "basis": "no liquidity or pool-depth component is configured",
        }
    if config.treasuries:
        coverage["treasury"] = {
            "status": "modeled",
            "basis": (
                "declared treasuries configured: "
                + ", ".join(treasury.id for treasury in config.treasuries)
            ),
        }
    else:
        coverage["treasury"] = {
            "status": "absent",
            "basis": "no treasury component or authority is configured",
        }
    coverage["governance"] = {
        "status": "absent",
        "basis": "no governance process or authority is configured",
    }
    staking_pools = [
        pool for pool in economy.agent_pools if pool.staking is not None
    ]
    if staking_pools:
        funded = any(pool.treasury is not None for pool in staking_pools)
        coverage["staking"] = {
            "status": "modeled",
            "basis": (
                "staking pools configured with reward source: "
                + (
                    "declared treasury (treasury-drawn rewards)"
                    if funded
                    else "minted dilution (no declared treasury)"
                )
            ),
        }
    else:
        coverage["staking"] = {
            "status": "absent",
            "basis": "no staking pool or reward source is configured",
        }
    coverage["fdv"] = {
        "status": "absent",
        "basis": "FDV is not emitted by this scenario and is never inferred",
    }
    coverage["apy"] = {
        "status": "absent",
        "basis": "APY is not emitted by this scenario and is never inferred",
    }
    return coverage


def inspect_assumptions(
    scenario: Union[str, Path, ScenarioConfig],
    *,
    allowed_roots: Optional[Sequence[Union[str, Path]]] = None,
) -> Dict[str, Any]:
    """Classify every governed input and ledger tokenomics coverage."""
    operation = "inspect_assumptions"
    try:
        config = _coerce_scenario(scenario, allowed_roots)
    except _Refusal as refusal:
        return _refused(operation, refusal.reasons, refusal.questions)
    except ScenarioError as exc:
        return _error(operation, [str(exc)])

    if config.ecosystem is not None:
        return _error(
            operation,
            [
                "ecosystem (schema v3) scenarios are not supported by "
                "inspect_assumptions yet; run them through the Monte Carlo "
                "runner or the gallery, which validate the same uncertainty "
                "contract"
            ],
        )

    assumptions: List[Dict[str, Any]] = []
    if config.schema_version in (2, 3) and config.uncertainty is not None:
        assumptions.extend(_spec_entry(spec) for spec in config.uncertainty.parameters)
    else:
        assumptions.extend(_v1_entry(path, value) for path, value in _v1_leaves(config))
    assumptions.extend(_process_entries(config))
    return {
        "operation": operation,
        "status": "ok",
        "schema_version": config.schema_version,
        "scenario_id": config.scenario_id,
        "config_hash": config.config_hash,
        "is_stochastic": config.is_stochastic,
        "assumptions": assumptions,
        "tokenomics_coverage": _tokenomics_coverage(config),
    }


# ---------------------------------------------------------------------------
# validate_uncertainty
# ---------------------------------------------------------------------------


def _load_raw_document(path: Path) -> Any:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        return json.loads(text)
    return yaml.safe_load(text)


def _salvage_validation(data: Any) -> Optional[UncertaintyValidation]:
    """Collect structured validation issues from a raw v2 document.

    Structural uncertainty errors make the full scenario unparsable; this
    re-validates the raw block against the (separately parsed) economy so the
    agent still receives per-entry errors and questions instead of a bare
    parse failure. Returns None when even the base scenario cannot be parsed.
    """
    if (
        not isinstance(data, Mapping)
        or data.get("schema_version") != 2
        or not isinstance(data.get("uncertainty"), Mapping)
    ):
        return None
    base = {key: value for key, value in data.items() if key != "uncertainty"}
    base["schema_version"] = 1
    try:
        base_config = scenario_from_dict(base)
    except ScenarioError:
        return None
    return parse_uncertainty(data["uncertainty"], base_config.economy)


def _validation_result(
    validation: UncertaintyValidation,
    *,
    schema_version: Optional[int],
    scenario_id: Optional[str],
    config_hash: Optional[str],
) -> Dict[str, Any]:
    result: Dict[str, Any] = {
        "operation": "validate_uncertainty",
        "status": "ok",
        "schema_version": schema_version,
        "scenario_id": scenario_id,
        "executable": bool(validation.executable) and not validation.errors,
        "errors": list(validation.errors),
        "warnings": list(validation.warnings),
        "questions": _structured_questions(validation),
        "supported_families": list(FAMILIES),
        "supported_dependence": list(SUPPORTED_DEPENDENCE),
    }
    if config_hash is not None:
        result["config_hash"] = config_hash
    if schema_version == 1:
        result["note"] = (
            "schema v1 scenario: executable as deterministic; no uncertainty "
            "is modeled (this is not an error)"
        )
    return result


def validate_uncertainty(
    scenario: Union[str, Path, ScenarioConfig],
    *,
    allowed_roots: Optional[Sequence[Union[str, Path]]] = None,
) -> Dict[str, Any]:
    """Validate the uncertainty block and surface structured questions."""
    operation = "validate_uncertainty"
    if isinstance(scenario, ScenarioConfig):
        return _validation_result(
            validate_v2_scenario(scenario),
            schema_version=scenario.schema_version,
            scenario_id=scenario.scenario_id,
            config_hash=scenario.config_hash,
        )
    if not isinstance(scenario, (str, Path)):
        return _error(
            operation,
            [
                f"unsupported scenario input type {type(scenario).__name__!r}; "
                "expected a ScenarioConfig or a scenario file path"
            ],
        )
    try:
        resolved = _resolve_under_roots(
            scenario,
            roots=_scenario_roots(allowed_roots),
            kind="scenario",
            require_suffix=True,
        )
    except _Refusal as refusal:
        return _refused(operation, refusal.reasons, refusal.questions)
    try:
        config = load_scenario(resolved)
    except ScenarioError as exc:
        try:
            data = _load_raw_document(resolved)
        except Exception as parse_exc:  # unreadable documents are plain errors
            return _error(
                operation, [f"could not parse scenario document: {parse_exc}"]
            )
        salvaged = _salvage_validation(data)
        if salvaged is None:
            return _error(operation, [f"scenario could not be loaded: {exc}"])
        return _validation_result(
            salvaged,
            schema_version=2,
            scenario_id=data.get("scenario_id"),
            config_hash=None,
        )
    return _validation_result(
        validate_v2_scenario(config),
        schema_version=config.schema_version,
        scenario_id=config.scenario_id,
        config_hash=config.config_hash,
    )


# ---------------------------------------------------------------------------
# propose_run
# ---------------------------------------------------------------------------


def _estimated_cost(paths: int, bootstrap_resamples: int) -> Dict[str, Any]:
    seconds = round(
        paths * REFERENCE_SECONDS_PER_PATH
        + bootstrap_resamples * REFERENCE_SECONDS_PER_RESAMPLE,
        2,
    )
    return {
        "seconds": seconds,
        "basis": (
            "reference-machine estimate (~0.004 s/path plus bootstrap "
            "overhead); actual cost varies by hardware"
        ),
        "reference_machine": True,
    }


def propose_run(
    scenario: Union[str, Path, ScenarioConfig],
    purpose: str,
    *,
    allowed_roots: Optional[Sequence[Union[str, Path]]] = None,
) -> Dict[str, Any]:
    """Propose (never execute) a run tier for a declared purpose."""
    operation = "propose_run"
    try:
        config = _coerce_scenario(scenario, allowed_roots)
    except _Refusal as refusal:
        return _refused(operation, refusal.reasons, refusal.questions)
    except ScenarioError as exc:
        return _error(operation, [str(exc)])
    if not isinstance(purpose, str) or purpose not in PURPOSE_TIERS:
        return _refused(
            operation,
            [f"unknown purpose {purpose!r}; allowed: {sorted(PURPOSE_TIERS)}"],
        )

    if config.schema_version != 2 or config.uncertainty is None:
        return {
            "operation": operation,
            "status": "ok",
            "mode": "deterministic",
            "schema_version": config.schema_version,
            "scenario_id": config.scenario_id,
            "run_tier": None,
            "paths": None,
            "bootstrap_resamples": None,
            "expected_precision": (
                "deterministic single-config run; no Monte Carlo precision"
            ),
            "estimated_cost": _estimated_cost(config.monte_carlo.repetitions, 0),
            "reasons": [
                "schema v1 scenario runs deterministically via HeadlessRunner; "
                "Monte Carlo tiers do not apply"
            ],
            "boundary": PROPOSAL_BOUNDARY,
        }

    validation = validate_v2_scenario(config)
    if validation.errors or not validation.executable:
        return _refused(
            operation,
            [
                "uncertainty validation is not executable "
                "(draft/needs_evidence/errors)",
                *_non_executable_reasons(validation),
            ],
            _structured_questions(validation),
        )
    tier = PURPOSE_TIERS[purpose]
    budget = RUN_TIERS[tier]
    return {
        "operation": operation,
        "status": "ok",
        "mode": "monte_carlo",
        "schema_version": config.schema_version,
        "scenario_id": config.scenario_id,
        "config_hash": config.config_hash,
        "run_tier": tier,
        "paths": budget["paths"],
        "bootstrap_resamples": budget["bootstrap_resamples"],
        "expected_precision": EXPECTED_PRECISION[tier],
        "estimated_cost": _estimated_cost(
            budget["paths"], budget["bootstrap_resamples"]
        ),
        "reasons": [f"purpose {purpose!r} maps to run tier {tier!r}"],
        "boundary": PROPOSAL_BOUNDARY,
    }


# ---------------------------------------------------------------------------
# run_simulation
# ---------------------------------------------------------------------------


def _output_hashes(manifest: Mapping[str, Any]) -> Dict[str, Any]:
    return {
        name: {
            "path": meta["path"],
            "sha256": meta["sha256"],
            "reproducible_content_sha256": meta["reproducible_content_sha256"],
        }
        for name, meta in manifest.get("outputs", {}).items()
    }


def run_simulation(
    scenario: Union[str, Path, ScenarioConfig],
    *,
    run_tier: Optional[str] = None,
    paths: Optional[int] = None,
    seed: Optional[int] = None,
    output_dir: Union[str, Path],
    run_id: Optional[str] = None,
    allowed_roots: Optional[Sequence[Union[str, Path]]] = None,
    allowed_output_roots: Optional[Sequence[Union[str, Path]]] = None,
) -> Dict[str, Any]:
    """Gated execution of a scenario; every gate failure is a refusal."""
    operation = "run_simulation"
    try:
        config = _coerce_scenario(scenario, allowed_roots)
    except _Refusal as refusal:
        return _refused(operation, refusal.reasons, refusal.questions)
    except ScenarioError as exc:
        return _error(operation, [str(exc)])
    try:
        resolved_output = _resolve_under_roots(
            output_dir,
            roots=_output_roots(allowed_output_roots),
            kind="output_dir",
            require_suffix=False,
        )
    except _Refusal as refusal:
        return _refused(operation, refusal.reasons, refusal.questions)

    if config.schema_version != 2 or config.uncertainty is None:
        try:
            artifacts = HeadlessRunner().run(config, resolved_output, run_id=run_id)
        except ArtifactError as exc:
            return _error(operation, [str(exc)])
        manifest = artifacts.manifest
        repetitions = manifest["monte_carlo"]["repetitions"]
        return {
            "operation": operation,
            "status": "ok",
            "claim": "deterministic",
            "mode": "deterministic",
            "note": (
                "schema v1 scenario executed deterministically via "
                "HeadlessRunner; Monte Carlo claims are forbidden for this result"
            ),
            "schema_version": config.schema_version,
            "scenario_id": config.scenario_id,
            "config_hash": config.config_hash,
            "bundle_dir": str(artifacts.bundle_dir),
            "manifest_path": str(artifacts.manifest_path),
            "run_id": manifest["run_id"],
            "seed": manifest["seed"],
            "seed_source": "scenario",
            "requested_paths": repetitions,
            "completed_paths": repetitions,
            "failed_paths": 0,
            "claim_eligibility": {
                "eligible": False,
                "reasons": [
                    "deterministic v1 run: Monte Carlo claim eligibility is "
                    "not computed"
                ],
            },
            "outputs": _output_hashes(manifest),
            "interpretation_boundary": INTERPRETATION_BOUNDARY,
        }

    # Gate 1: the uncertainty validation must be executable.
    validation = validate_v2_scenario(config)
    if validation.errors or not validation.executable:
        return _refused(
            operation,
            [
                "uncertainty validation is not executable "
                "(draft/needs_evidence/errors)",
                *_non_executable_reasons(validation),
            ],
            _structured_questions(validation),
        )

    # Gate 2: a stochastic run needs an explicit or embedded master seed; a
    # generated seed is persisted in the bundle and shown in this result
    # before any claim is made.
    if seed is not None:
        if (
            isinstance(seed, bool)
            or not isinstance(seed, int)
            or not 0 <= seed <= 2**32 - 1
        ):
            return _refused(
                operation,
                ["seed must be an integer in [0, 4294967295]"],
            )
        resolved_seed, seed_source = seed, "explicit"
    elif config.monte_carlo.seed is not None:
        resolved_seed, seed_source = config.monte_carlo.seed, "scenario"
    else:
        resolved_seed = int(np.random.SeedSequence().entropy) % (2**32)
        seed_source = "generated"
    if resolved_seed != config.monte_carlo.seed:
        # Never mutate the caller's config; the replaced copy carries the seed.
        config = replace(
            config, monte_carlo=replace(config.monte_carlo, seed=resolved_seed)
        )

    # Gate 3: the budget must name exactly one of run_tier/paths and stay
    # within the frozen tier/explicit bounds.
    try:
        MonteCarloRunner._resolve_run_plan(run_tier, paths, None)
    except MonteCarloError as exc:
        return _refused(operation, [str(exc)])

    try:
        artifacts = MonteCarloRunner().run(
            config,
            resolved_output,
            run_id=run_id,
            run_tier=run_tier,
            paths=paths,
        )
    except ArtifactError as exc:
        return _error(operation, [str(exc)])
    manifest = artifacts.manifest
    return {
        "operation": operation,
        "status": "ok",
        "claim": "monte_carlo",
        "mode": "monte_carlo",
        "schema_version": config.schema_version,
        "scenario_id": config.scenario_id,
        "config_hash": config.config_hash,
        "bundle_dir": str(artifacts.bundle_dir),
        "manifest_path": str(artifacts.manifest_path),
        "run_id": manifest["run_id"],
        "run_tier": manifest["run_tier"],
        "seed": resolved_seed,
        "seed_source": seed_source,
        "requested_paths": manifest["requested_paths"],
        "completed_paths": manifest["completed_paths"],
        "failed_paths": manifest["failed_paths"],
        "path_failures": artifacts.path_failures,
        "claim_eligibility": manifest["claim_eligibility"],
        "outputs": _output_hashes(manifest),
        "interpretation_boundary": INTERPRETATION_BOUNDARY,
    }


# ---------------------------------------------------------------------------
# summarize_evidence
# ---------------------------------------------------------------------------


def _cite(
    citations: List[Dict[str, Any]],
    artifact: str,
    field: str,
    value: Any,
    statistic_id: str,
) -> None:
    citations.append(
        {
            "statistic_id": statistic_id,
            "artifact": artifact,
            "field": field,
            "value": value,
        }
    )


def _bundle_artifact_path(
    operation: str, bundle: Path, name: str, meta: Any
) -> Union[Path, Dict[str, Any]]:
    """Resolve a manifest-declared artifact, contained inside the bundle.

    Returns the resolved :class:`Path`, or an error envelope when the
    manifest entry is malformed, absolute, or escapes the bundle via ``..``
    or a symlink. A hand-crafted manifest must never turn
    ``summarize_evidence`` into a read primitive outside the bundle.
    """
    if not isinstance(meta, Mapping):
        return _error(operation, [f"manifest output {name!r} is malformed"])
    relative = meta.get("path")
    if not isinstance(relative, str) or not relative:
        return _error(
            operation, [f"manifest output {name!r} has no usable path field"]
        )
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        return _error(
            operation,
            [
                f"manifest output {name!r} path {relative!r} escapes the "
                "bundle: absolute paths and '..' segments are refused"
            ],
        )
    resolved = (bundle / candidate).resolve()
    root = bundle.resolve()
    if resolved != root and root not in resolved.parents:
        return _error(
            operation,
            [
                f"manifest output {name!r} path {relative!r} resolves outside "
                "the bundle directory"
            ],
        )
    return resolved


def _verify_bundle_outputs(
    operation: str, bundle: Path, manifest: Mapping[str, Any]
) -> Optional[Dict[str, Any]]:
    """Re-verify every manifest-listed output before summarizing it.

    The manifest is treated as a claim, not as proof: each listed artifact
    must resolve inside the bundle, exist, and match its declared sha256.
    Any mismatch returns an error envelope; ``None`` means verified.
    """
    problems: List[str] = []
    for name, meta in sorted(manifest.get("outputs", {}).items()):
        resolved = _bundle_artifact_path(operation, bundle, name, meta)
        if isinstance(resolved, dict):
            return resolved
        if not resolved.is_file():
            problems.append(
                f"bundle artifact listed in the manifest is missing: {name}"
            )
            continue
        expected = meta.get("sha256")
        if not isinstance(expected, str) or not expected:
            problems.append(
                f"manifest output {name!r} declares no sha256 to verify"
            )
            continue
        actual = file_sha256(resolved)
        if actual != expected:
            problems.append(
                f"bundle artifact {name!r} failed its manifest hash check: "
                f"manifest declares {expected}, recomputed {actual}"
            )
    if problems:
        return _error(operation, problems)
    return None


def _summarize_v1(
    operation: str, bundle: Path, manifest: Mapping[str, Any]
) -> Dict[str, Any]:
    verification_failure = _verify_bundle_outputs(operation, bundle, manifest)
    if verification_failure is not None:
        return verification_failure
    citations: List[Dict[str, Any]] = []
    outputs: Dict[str, Any] = {}
    for name, meta in sorted(manifest.get("outputs", {}).items()):
        outputs[name] = {
            "path": meta["path"],
            "format": meta["format"],
            "rows": meta["rows"],
            "sha256": meta["sha256"],
        }
        _cite(
            citations,
            "manifest.json",
            f"outputs.{name}.rows",
            meta["rows"],
            f"manifest:outputs.{name}.rows",
        )
    monte_carlo = manifest.get("monte_carlo", {})
    for key in ("iterations", "repetitions"):
        if key in monte_carlo:
            _cite(
                citations,
                "manifest.json",
                f"monte_carlo.{key}",
                monte_carlo[key],
                f"manifest:monte_carlo.{key}",
            )
    return {
        "operation": operation,
        "status": "ok",
        "claim": "deterministic",
        "manifest_version": 1,
        "scenario_id": manifest.get("scenario_id"),
        "run_id": manifest.get("run_id"),
        "seed": manifest.get("seed"),
        "config_hash": manifest.get("config_hash"),
        "note": (
            "deterministic v1 bundle: no Monte Carlo statistics, intervals, "
            "or claim eligibility"
        ),
        "outputs": outputs,
        "citations": citations,
        "interpretation_boundary": INTERPRETATION_BOUNDARY,
    }


def _load_json_documents(
    operation: str, bundle: Path, manifest: Mapping[str, Any]
) -> Union[Dict[str, Any], Dict[str, Any]]:
    documents: Dict[str, Any] = {}
    for name in ("terminal_summary", "sensitivity", "convergence", "path_failures"):
        meta = manifest.get("outputs", {}).get(name)
        if meta is None:
            return _error(
                operation, [f"manifest is missing the required {name} output"]
            )
        resolved = _bundle_artifact_path(operation, bundle, name, meta)
        if isinstance(resolved, dict):
            return resolved
        try:
            document = json.loads(resolved.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return _error(
                operation, [f"bundle artifact {meta['path']} is unreadable: {exc}"]
            )
        try:
            validate_interval_labels(document)
        except IntervalLabelError as exc:
            return _error(
                operation,
                [f"{name} artifact carries mislabeled intervals: {exc}"],
            )
        documents[name] = document
    return documents


def _check_denominators(
    manifest: Mapping[str, Any], failures_doc: Mapping[str, Any]
) -> List[str]:
    problems: List[str] = []
    pairs = (
        ("requested", "requested_paths"),
        ("completed", "completed_paths"),
        ("failed", "failed_paths"),
    )
    for doc_key, manifest_key in pairs:
        if failures_doc.get(doc_key) != manifest.get(manifest_key):
            problems.append(
                f"path_failures.{doc_key}={failures_doc.get(doc_key)} != "
                f"manifest.{manifest_key}={manifest.get(manifest_key)}"
            )
    if (
        failures_doc.get("completed", 0) + failures_doc.get("failed", 0)
        != failures_doc.get("requested")
    ):
        problems.append(
            "path_failures completed + failed != requested "
            f"({failures_doc.get('completed')} + {failures_doc.get('failed')} "
            f"!= {failures_doc.get('requested')})"
        )
    if len(failures_doc.get("failures", [])) != failures_doc.get("failed"):
        problems.append(
            "path_failures.failures records do not match the failed count"
        )
    return problems


def _summarize_v2(
    operation: str, bundle: Path, manifest: Mapping[str, Any]
) -> Dict[str, Any]:
    verification_failure = _verify_bundle_outputs(operation, bundle, manifest)
    if verification_failure is not None:
        return verification_failure
    documents = _load_json_documents(operation, bundle, manifest)
    if documents.get("status") == "error":
        return documents
    terminal = documents["terminal_summary"]
    sensitivity_doc = documents["sensitivity"]
    convergence_doc = documents["convergence"]
    failures_doc = documents["path_failures"]

    problems = _check_denominators(manifest, failures_doc)
    if problems:
        return _error(
            operation, [f"bad bundle denominators: {p}" for p in problems]
        )
    completed = failures_doc["completed"]

    citations: List[Dict[str, Any]] = []
    outcome_bands: List[Dict[str, Any]] = []
    estimator_intervals: List[Dict[str, Any]] = []
    for index, metric in enumerate(terminal.get("metrics", [])):
        metric_id = metric["id"]
        if metric.get("n") != completed:
            return _error(
                operation,
                [
                    f"bad bundle denominators: terminal metric {metric_id!r} "
                    f"n={metric.get('n')} != completed paths {completed}"
                ],
            )
        prefix = f"metrics.{index}"
        if metric.get("kind") == "binary":
            probability = metric["probability"]
            band = {
                "id": metric_id,
                "kind": "binary",
                "unit": metric.get("unit"),
                "label": probability["label"],
                "estimate": probability["estimate"],
                "ci_low": probability["ci_low"],
                "ci_high": probability["ci_high"],
                "level": probability["level"],
                "method": probability["method"],
                "successes": metric["successes"],
                "n": metric["n"],
            }
            for key in ("estimate", "ci_low", "ci_high"):
                _cite(
                    citations,
                    "terminal_summary.json",
                    f"{prefix}.probability.{key}",
                    probability[key],
                    f"terminal:{metric_id}:probability.{key}",
                )
            _cite(
                citations,
                "terminal_summary.json",
                f"{prefix}.n",
                metric["n"],
                f"terminal:{metric_id}:n",
            )
            outcome_bands.append(band)
            continue

        interval = metric.get("outcome_interval", {})
        if interval.get("label") != OUTCOME_INTERVAL_LABEL:
            return _error(
                operation,
                [
                    f"terminal metric {metric_id!r} outcome interval is "
                    f"mislabeled: {interval.get('label')!r} (expected "
                    f"{OUTCOME_INTERVAL_LABEL!r})"
                ],
            )
        band = {
            "id": metric_id,
            "kind": "continuous",
            "unit": metric.get("unit"),
            "label": interval["label"],
            "p10": interval["p10"],
            "p90": interval["p90"],
            "mean": metric["estimates"]["mean"],
            "median": metric["estimates"]["median"],
            "n": metric["n"],
        }
        for key, field in (
            ("p10", f"{prefix}.outcome_interval.p10"),
            ("p90", f"{prefix}.outcome_interval.p90"),
            ("mean", f"{prefix}.estimates.mean"),
            ("median", f"{prefix}.estimates.median"),
            ("n", f"{prefix}.n"),
        ):
            _cite(
                citations,
                "terminal_summary.json",
                field,
                band[key],
                f"terminal:{metric_id}:{key}",
            )
        outcome_bands.append(band)
        for ci_index, interval_ci in enumerate(metric.get("confidence_intervals", [])):
            entry = {
                "metric": metric_id,
                "estimator": interval_ci["estimator"],
                "label": interval_ci["label"],
                "estimate": interval_ci["estimate"],
                "ci_low": interval_ci["ci_low"],
                "ci_high": interval_ci["ci_high"],
                "level": interval_ci["level"],
                "method": interval_ci["method"],
                "resamples": interval_ci["resamples"],
                "n": interval_ci["n"],
            }
            for key in ("estimate", "ci_low", "ci_high"):
                _cite(
                    citations,
                    "terminal_summary.json",
                    f"{prefix}.confidence_intervals.{ci_index}.{key}",
                    interval_ci[key],
                    f"terminal:{metric_id}:ci:{interval_ci['estimator']}.{key}",
                )
            estimator_intervals.append(entry)

    highlights: List[Dict[str, Any]] = []
    for index, record in enumerate(sensitivity_doc.get("results", [])):
        entry: Dict[str, Any] = {
            "parameter": record["parameter"],
            "metric": record["metric"],
            "status": record["status"],
            "n": record["n"],
            "interpretation": record["interpretation"],
        }
        _cite(
            citations,
            "sensitivity.json",
            f"results.{index}.n",
            record["n"],
            f"sensitivity:{record['parameter']}:{record['metric']}:n",
        )
        if record["status"] == "ok":
            entry.update(
                {
                    "rho": record["rho"],
                    "direction": record["direction"],
                    "magnitude": record["magnitude"],
                    "ci_low": record["ci_low"],
                    "ci_high": record["ci_high"],
                }
            )
            for key in ("rho", "ci_low", "ci_high"):
                _cite(
                    citations,
                    "sensitivity.json",
                    f"results.{index}.{key}",
                    record[key],
                    f"sensitivity:{record['parameter']}:{record['metric']}:{key}",
                )
        highlights.append(entry)
    sensitivity_section = {
        "method": sensitivity_doc.get("method"),
        "min_paths": sensitivity_doc.get("min_paths"),
        "completed_paths": sensitivity_doc.get("completed_paths"),
        "interpretation": sensitivity_doc.get("interpretation"),
        "note": (
            f"{NON_CAUSAL_INTERPRETATION}; insufficient/constant statuses are "
            "reported, never fabricated"
        ),
        "highlights": highlights,
    }

    convergence_metrics: Dict[str, Any] = {}
    for metric_id, result in convergence_doc.get("metrics", {}).items():
        entry = {"status": result["status"]}
        if result["status"] != "insufficient_checkpoints":
            entry["reference_checkpoint"] = result["reference_checkpoint"]
            entry["final_checkpoint"] = result["final_checkpoint"]
            drift: Dict[str, Any] = {}
            for quantile in ("p10", "p50", "p90"):
                record = result["drift"][quantile]
                drift[quantile] = record["relative_drift"]
                _cite(
                    citations,
                    "convergence.json",
                    f"metrics.{metric_id}.drift.{quantile}.relative_drift",
                    record["relative_drift"],
                    f"convergence:{metric_id}:drift.{quantile}",
                )
            entry["relative_drift"] = drift
        convergence_metrics[metric_id] = entry
    convergence_section = {
        "checkpoints_requested": convergence_doc.get("checkpoints_requested"),
        "checkpoints_used": convergence_doc.get("checkpoints_used"),
        "metrics": convergence_metrics,
    }

    failures_section = {
        "requested": failures_doc["requested"],
        "completed": failures_doc["completed"],
        "failed": failures_doc["failed"],
        "failures": list(failures_doc.get("failures", [])),
    }
    for key in ("requested", "completed", "failed"):
        _cite(
            citations,
            "path_failures.json",
            key,
            failures_doc[key],
            f"path_failures:{key}",
        )

    calibration_states: Dict[str, Any] = {}
    samples_meta = manifest.get("outputs", {}).get("parameter_samples")
    samples_artifact = None
    if samples_meta is not None:
        resolved_samples = _bundle_artifact_path(
            operation, bundle, "parameter_samples", samples_meta
        )
        if isinstance(resolved_samples, dict):
            return resolved_samples
        samples_artifact = samples_meta["path"]
        frame = (
            pd.read_parquet(resolved_samples)
            if samples_meta["format"] == "parquet"
            else pd.read_csv(resolved_samples)
        )
        for param_id, group in frame.groupby("id", sort=True):
            calibration_states[str(param_id)] = {
                "calibration": sorted(group["calibration"].unique()),
                "approval": sorted(group["approval"].unique()),
            }

    # Claim eligibility is recomputed from the verified bundle contents —
    # never echoed from the manifest, which a hand-crafted bundle could
    # simply declare. The manifest's own claim is reported alongside for
    # comparison.
    verified_claim = evaluate_claim_eligibility(
        executable=True,
        requested=failures_doc["requested"],
        completed=failures_doc["completed"],
        failed=failures_doc["failed"],
        run_tier=str(manifest.get("run_tier")),
        convergence_statuses={
            metric_id: result.get("status")
            for metric_id, result in convergence_doc.get("metrics", {}).items()
        },
    )
    provenance_missing = [
        key
        for key in (
            "sampler_version",
            "rng_algorithm",
            "master_seed",
            "seed_lineage",
            "uncertainty_spec_hash",
        )
        if manifest.get(key) is None
    ]
    if provenance_missing:
        verified_claim["eligible"] = False
        verified_claim["reasons"] = [
            "missing executable provenance: " + ", ".join(provenance_missing),
            *verified_claim["reasons"],
        ]
    manifest_claim = manifest.get("claim_eligibility")
    if (
        isinstance(manifest_claim, Mapping)
        and "eligible" in manifest_claim
        and bool(manifest_claim["eligible"]) != verified_claim["eligible"]
    ):
        verified_claim["manifest_disagreement"] = (
            "the manifest claims eligible="
            f"{bool(manifest_claim['eligible'])} but the verified inputs say "
            f"eligible={verified_claim['eligible']}; the verified value is "
            "authoritative for this summary"
        )

    return {
        "operation": operation,
        "status": "ok",
        "claim": "monte_carlo",
        "manifest_version": 2,
        "scenario_id": manifest.get("scenario_id"),
        "run_id": manifest.get("run_id"),
        "seed": manifest.get("master_seed"),
        "config_hash": manifest.get("config_hash"),
        "uncertainty_spec_hash": manifest.get("uncertainty_spec_hash"),
        "claim_eligibility": verified_claim,
        "manifest_claim_eligibility": manifest_claim,
        "interval_definitions": terminal.get("interval_definitions"),
        "outcome_bands": outcome_bands,
        "estimator_intervals": estimator_intervals,
        "sensitivity": sensitivity_section,
        "convergence": convergence_section,
        "failures": failures_section,
        "calibration_states": {
            "source_artifact": samples_artifact,
            "states": calibration_states,
        },
        "citations": citations,
        "interpretation_boundary": INTERPRETATION_BOUNDARY,
    }


def summarize_evidence(source: Any) -> Dict[str, Any]:
    """Summarize a published bundle with citations for every number."""
    operation = "summarize_evidence"
    if isinstance(source, Mapping):
        source = source.get("bundle_dir")
    if not isinstance(source, (str, Path)):
        return _error(
            operation,
            ["source must be a bundle directory or a run_simulation result"],
        )
    bundle = Path(source)
    manifest_path = bundle / "manifest.json"
    if not manifest_path.is_file():
        return _error(operation, [f"bundle manifest not found: {manifest_path}"])
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return _error(operation, [f"bundle manifest is not valid JSON: {exc}"])
    version = manifest.get("manifest_version")
    if version == 1:
        return _summarize_v1(operation, bundle, manifest)
    if version == 2:
        return _summarize_v2(operation, bundle, manifest)
    return _error(operation, [f"unsupported manifest_version {version!r}"])


__all__ = [
    "DEFAULT_OUTPUT_ROOTS",
    "DEFAULT_SCENARIO_ROOTS",
    "EXPECTED_PRECISION",
    "INTERPRETATION_BOUNDARY",
    "PROPOSAL_BOUNDARY",
    "PURPOSE_TIERS",
    "SCENARIO_SUFFIXES",
    "SUPPORTED_DEPENDENCE",
    "TOKENOMICS_DOMAINS",
    "inspect_assumptions",
    "propose_run",
    "run_simulation",
    "summarize_evidence",
    "validate_uncertainty",
]

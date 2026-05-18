# Universal Mistakes
*Language-level and framework-agnostic mistakes observed across 8+ projects. Seed file for new project knowledge bases.*

## M-001 | Unconditional Raise in Error Handler
**Project origin**: Value Investing AI
**Pattern**: Error handler raises unconditionally instead of using conditional logic. Breaks all callers, not just the error case.
**Prevention**: Always verify the condition before raising. Use `if condition: raise` not bare `raise`.
**Blast radius**: Any caller that doesn't catch the exception.

## M-002 | Semantic Defaults (Silent Wrong Behavior)
**Project origin**: Value Investing AI, Tesseract Engine
**Pattern**: A parameter defaults to a value that silently changes behavior (e.g., `strict=False` when True is expected, empty string when None would raise).
**Prevention**: Default to the strictest setting. Fail loudly on invalid/missing config.

## M-003 | Serialization Silent Drop
**Project origin**: Value Investing AI
**Pattern**: Object serialization (JSON, pickle, Parquet) silently drops fields that can't be serialized instead of raising.
**Prevention**: Verify round-trip: `assert deserialize(serialize(obj)) == obj`.

## M-004 | Indirect Monkeypatch (Test Isolation)
**Project origin**: Value Investing AI, ATP Tennis
**Pattern**: Mocking `module_a.function` but the code imports from `module_b` which re-exports it. Patch never reaches the actual call site.
**Prevention**: Always patch at the point of use: `@patch('module_that_calls.function')` not `@patch('module_that_defines.function')`.

## M-005 | Coding Blind (No Runtime Verification)
**Project origin**: WordPress CQA, IPBS
**Pattern**: Three or more successive fix attempts without verifying actual runtime state. Agent reads source code but never runs a diagnostic.
**Prevention**: Diagnostic-First Gate — for runtime bugs, run a diagnostic BEFORE writing any fix.

## M-006 | Aborted CLOSE Phase
**Project origin**: All projects
**Pattern**: The CLOSE phase is skipped when conversations end. Knowledge base never gets updated. Same mistakes rediscovered in next session.
**Prevention**: Emergency CLOSE — if context is running low, write minimal summary.md and append at least session mistakes to KB.

## M-007 | Distributed Simulation Gaps (Parity Drift)
**Project origin**: Value Investing AI
**Pattern**: Fix applied to `simulator.py` but not `fast_simulator.py`. Parallel code paths drift apart silently.
**Prevention**: Parity registry — register parallel paths and check all siblings when one changes.

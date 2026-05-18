#!/usr/bin/env node
// test_path_classifiers.mjs — Path-classification contract for the test-evidence gate.
//
// F-04 fix: looksLikeConfigPath/requiresTestEvidence must classify config-only
// changes (version.json, .config_integrity, .project_registry.json, etc.) so
// that GATE-VAL-011 does not demand a per-file test path for pure data files
// whose consumers are tested separately.

import {
  looksLikeTestPath,
  looksLikeDocumentationPath,
  looksLikeConfigPath,
  requiresTestEvidence,
} from "../scripts/lib/plan_refresh.mjs";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

console.log("\nPath Classifier Contracts\n");

// looksLikeTestPath — preserved from before the F-04 change.
assert(looksLikeTestPath("tests/test_foo.mjs"), "tests/test_foo.mjs is a test path");
assert(looksLikeTestPath(".agent/skills/iterative-planner/tests/test_migration.mjs"), "nested tests/test_*.mjs is a test path");
assert(looksLikeTestPath("src/__tests__/foo.spec.ts"), "__tests__/*.spec.ts is a test path");
assert(!looksLikeTestPath("src/foo.mjs"), "src/foo.mjs is not a test path");

// looksLikeDocumentationPath — preserved.
assert(looksLikeDocumentationPath("docs/README.md"), "docs/README.md is documentation");
assert(looksLikeDocumentationPath("plans/findings.md"), "plans/findings.md is documentation");
assert(!looksLikeDocumentationPath("src/foo.mjs"), "src/foo.mjs is not documentation");

// looksLikeConfigPath — new in F-04. Audit case from version-bump plan:
assert(looksLikeConfigPath(".agent/skills/iterative-planner/config/version.json"),
  "config/version.json is config (the audit case)");
assert(looksLikeConfigPath(".agent/skills/iterative-planner/config/.config_integrity"),
  "config/.config_integrity is config (audit case dotfile)");
assert(looksLikeConfigPath(".agent/skills/iterative-planner/config/.project_registry.json"),
  "config/.project_registry.json is config (audit case dotfile)");

// Other reasonable config locations
assert(looksLikeConfigPath("config/database.yaml"), "config/database.yaml is config");
assert(looksLikeConfigPath("project/configs/feature_flags.toml"), "configs/feature_flags.toml is config");
assert(looksLikeConfigPath("package.json"), "package.json is config (well-known top-level)");
assert(looksLikeConfigPath("pyproject.toml"), "pyproject.toml is config");
assert(looksLikeConfigPath("tsconfig.json"), "tsconfig.json is config");

// Things that should NOT be config:
assert(!looksLikeConfigPath("src/database.json"), "src/database.json is NOT config (no config/ ancestor and not well-known)");
assert(!looksLikeConfigPath("tests/fixtures/data.json"), "tests/fixtures/data.json is NOT config (it's a test fixture)");
assert(!looksLikeConfigPath("src/handler.mjs"), "code file is NOT config");
assert(!looksLikeConfigPath("src/handler.py"), "python file is NOT config");
assert(!looksLikeConfigPath("docs/spec.md"), "markdown is NOT config");
assert(!looksLikeConfigPath("setup.py"), "setup.py is NOT config (executable code)");

// requiresTestEvidence — the contract that drives GATE-VAL-011:
assert(requiresTestEvidence("src/handler.mjs"), "src/handler.mjs requires test evidence");
assert(requiresTestEvidence("lib/util.py"), "lib/util.py requires test evidence");

// Audit case: config-only changes no longer require test evidence
assert(!requiresTestEvidence(".agent/skills/iterative-planner/config/version.json"),
  "config/version.json does NOT require test evidence (F-04 fix)");
assert(!requiresTestEvidence(".agent/skills/iterative-planner/config/.config_integrity"),
  "config/.config_integrity does NOT require test evidence");
assert(!requiresTestEvidence(".agent/skills/iterative-planner/config/.project_registry.json"),
  "config/.project_registry.json does NOT require test evidence");
assert(!requiresTestEvidence("docs/README.md"), "docs are exempt from test evidence (preserved)");
assert(!requiresTestEvidence("tests/test_foo.mjs"), "test files do not need their own test pair (preserved)");
assert(!requiresTestEvidence("package.json"), "package.json is exempt from test evidence");

// Boundary: a JSON fixture under tests/ should still NOT be classified as
// requiring test evidence (it's already a test path).
assert(!requiresTestEvidence("tests/fixtures/data.json"),
  "test fixture .json is exempt (via test-path classification)");

// Boundary: a JSON fixture in a non-tests path with no config/ ancestor IS a code path.
// (This is intentional — if you're shipping data your code consumes, the
// consumer's tests should cover it; we mark it as code so the gate insists
// on that linkage.)
assert(requiresTestEvidence("src/data/products.json"),
  "src/data/products.json still requires test evidence (no config/ ancestor)");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

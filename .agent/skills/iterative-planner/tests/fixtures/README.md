# Gate Fixture Definitions

Fixture files defining plan states and expected gate check outcomes. Run `node tests/run_golden_tests.mjs` to validate fixture schema correctness.

**Important:** `run_golden_tests.mjs` validates fixture *structure* (valid failure codes, status values, expected_result). It does **not** execute the actual gate scripts against these fixtures. For behavioral regression testing of gate logic, run the scripts directly (e.g., `node scripts/verify_gate.mjs explore-to-plan`) against a controlled plan directory and compare outputs.

## Fixture Structure

Each fixture is a JSON file with:
- `description`: What scenario this fixture represents
- `gate`: Which gate transition this tests (e.g., `explore-to-plan`)
- `input`: The input state (plan files, content, KB files, etc.)
- `expected_checks`: Array of expected check results with `name`, `status` (PASS/WARN/FAIL), and `code` (GATE-XXX-NNN format)
- `expected_result`: Overall expected gate outcome (PASS or FAIL)

## Adding New Fixtures

1. Define the plan state scenario in a new JSON file
2. Specify expected check outcomes for each gate check
3. Run `node tests/run_golden_tests.mjs` to validate the fixture is well-formed
4. (Optional) Run the actual gate script against the fixture's plan state to verify behavioral correctness

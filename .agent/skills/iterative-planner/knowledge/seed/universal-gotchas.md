# Universal Gotchas
*Non-obvious traps observed across multiple projects. Seed file for new project knowledge bases.*

## G-001 | Python StringDtype vs object (pandas 2.x+)
**Trigger**: `pd.read_csv()` with `dtype_backend='numpy'` returns `StringDtype` that breaks `isinstance(x, str)` checks.
**Fix**: Use `pd.api.types.is_string_dtype(col)` or convert with `.astype(str)`.

## G-002 | Mutable Default Arguments
**Trigger**: `def foo(x=[])` — the list is shared across ALL calls. Same for `dict`, `set`.
**Fix**: `def foo(x=None): x = x or []`

## G-003 | Pickle Version Drift
**Trigger**: Model pickled on Python 3.11, loaded on 3.12 — silent behavior change if internal attributes changed.
**Fix**: Pin pickle protocol version. Prefer joblib or ONNX for models.

## G-004 | URL-Encoded Paths (Spaces in Directories)
**Trigger**: `import.meta.url` returns URL-encoded paths (`%20` for spaces). `dirname()` on this gives wrong paths.
**Fix**: Use `fileURLToPath(import.meta.url)` to properly decode.

## G-005 | REST API Silent Auth Degradation
**Trigger**: API returns 200 with empty/partial data instead of 401 when auth fails. Code processes empty data as "no results."
**Fix**: Check response shape, not just status code. Verify expected fields exist.

## G-006 | Environment Variable Empty String vs Missing
**Trigger**: `os.getenv('VAR')` returns `None` if missing but `''` (empty string) if set-but-empty. Code treats `''` as truthy.
**Fix**: `val = os.getenv('VAR') or None` or explicit `if val and val.strip()`.

## G-007 | Git Merge Conflict in JSON/YAML
**Trigger**: Two branches edit the same JSON/YAML file. Git merge produces syntactically invalid JSON.
**Fix**: After any merge, run `node -e "JSON.parse(fs.readFileSync('file'))"` or equivalent to validate.

## G-008 | Mermaid Diagram Compatibility
**Trigger**: Using newer/advanced Mermaid syntax (e.g., `flowchart`, `stateDiagram-v2`, sub-graph `style` directives) in Markdown documentation.
**Fix**: Many IDE renderers (VS Code native, GitHub natively) use older/stricter Mermaid parsers that crash with "no diagram type detected". Stick to lowest-common-denominator syntax (`graph` instead of `flowchart`, `<br/>` instead of `\n`, plain ascii text).

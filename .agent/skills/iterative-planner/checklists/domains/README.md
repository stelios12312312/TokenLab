# Domain Checklists — Security Note

## ⚠️ `run_command` Check Type

The YAML checklist format supports a `run_command` check type that executes shell commands via Node.js `execSync()`. This is by design — it enables powerful deterministic checks like verifying test counts, checking git state, or running linters.

**Security consideration**: Only use checklists from **trusted, version-controlled sources**. A malicious YAML checklist with a `run_command` item could execute arbitrary shell commands.

### Safe usage guidelines

1. **Only commit checklists that have been reviewed** — treat `.yaml` checklist files with the same care as executable scripts
2. **Domain-specific checklists** in this directory should be project-specific and reviewed before use
3. **Never accept checklists from untrusted external sources** without reviewing the `command` fields
4. **The `timeout` parameter** limits execution to 30 seconds by default, preventing runaway processes

### Example of a `run_command` check

```yaml
items:
  - name: "Tests pass"
    check: run_command
    command: "npm test"
    expected: "PASS"
    severity: fail
```

This runs `npm test` and checks if the output contains "PASS". If the command fails or doesn't match, the check is marked as FAIL.

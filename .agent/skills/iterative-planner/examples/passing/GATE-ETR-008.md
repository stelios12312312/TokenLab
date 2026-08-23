## Vector 1: Parser label drift
**Attack**: An agent writes red-team notes with a markdown style that looks reasonable but keeps the section labels ambiguous, then retries the gate under time pressure.

**Impact**: The execute-to-reflect gate can block repeatedly even though the operator has real analysis, delaying the plan and encouraging ad-hoc edits to gate-owned artifacts.

**Mitigation**:
1. Use one accepted label shape consistently: `Attack:`, `**Attack**:`, or `### Attack`.
2. Keep each section substantive enough to name the trigger, production consequence, and concrete guard.

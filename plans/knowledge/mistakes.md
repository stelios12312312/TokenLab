# Mistakes

Recurring mistakes and antipatterns. Format: `M-NNN: Short title (date)`.

<!-- Next mistake: M-002 -->

## M-001: Instance-scoped guards around process-scoped simulation state (2026-08-14)

- **Failure mode**: `MISSED_BLAST_RADIUS` / `SILENT_DEGRADATION`.
- **Trigger**: A new server/application wrapper serializes simulation calls, but
  the underlying runner saves, seeds, and restores process-global RNG state.
- **Mistake**: Giving every wrapper its own lock makes each instance look safe
  while concurrent sibling instances can still interleave global mutations.
  Evicting only in-memory run metadata similarly looks bounded while durable
  bundles continue accumulating.
- **Guard**: Match synchronization and resource limits to the lifetime of the
  protected state. For TokenLab gallery execution, share a process-wide lock,
  reject work at the declared process cap, and sanitize unexpected exceptions
  at the outer HTTP boundary.
- **Proof**: `tests/test_demo_gallery.py` exercises cross-application busy
  rejection, capacity rejection, and path-free unexpected-failure responses.
- **Red-team refs**: `F-DG-001`, `F-DG-002`, `F-DG-003`; `AP-007` through
  `AP-009` in `reports/red_team_audit/`.

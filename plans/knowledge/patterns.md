# Patterns

Proven implementation patterns. Record what worked so future plans can reuse it.

Format: `P-NNN: Short title (date)` — What worked, why it worked, when to apply it.

<!-- Next pattern: P-004 -->

## P-003: Scope guards to the mutable resource, not the request wrapper (2026-08-14)

- **Trigger**: Several servers, sessions, or adapters can call code that mutates
  module-level or process-global state.
- **Pattern**: Put the synchronization primitive at the same scope as the
  mutable resource, then test contention across two independent wrapper
  instances. Put admission limits before expensive work and keep the transport
  boundary's final error response generic and path-free.
- **Why**: Per-instance tests can all pass while sibling instances race the real
  shared resource. Cross-instance negative controls expose that false green.
- **Apply when**: Wrapping simulation engines, random seeds, global caches, file
  publication, or any backend with process-wide lifecycle.

## P-001: Reproducibility hashes should use persisted representations (2026-08-12)

- **Trigger**: A table hash must be recomputed after CSV/Parquet publication,
  especially when floats and lineage fields are present.
- **Pattern**: Write the table first, re-read the persisted representation, then
  canonicalize and hash it. Keep exact file integrity and reproducible content
  as separate named hashes, and declare any excluded identity fields.
- **Why**: In-memory floats can serialize and parse to a numerically equivalent
  but byte/text-distinct value. Hashing the pre-serialization object creates a
  false-red validator even though the file is correct.
- **Apply when**: Publishing machine-readable artifacts that another process or
  later run must validate independently.

## P-002: Validate once, then serve immutable snapshots (2026-08-12)

- **Trigger**: A local viewer validates files at startup and later exposes those
  files through an HTTP download route.
- **Pattern**: Enforce path and size limits, validate the full artifact bundle,
  and cache the exact allowlisted bytes. Build both the rendered payload and
  downloads from that immutable startup snapshot.
- **Why**: Re-reading a path after validation creates a time-of-check/time-of-use
  gap: another process can replace the file and make the viewer serve bytes that
  were never validated.
- **Apply when**: Building read-only artifact dashboards, report viewers, or
  other local inspection tools where the source directory can change while the
  process is running.

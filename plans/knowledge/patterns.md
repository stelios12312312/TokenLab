# Patterns

Proven implementation patterns. Record what worked so future plans can reuse it.

Format: `P-NNN: Short title (date)` — What worked, why it worked, when to apply it.

<!-- Next pattern: P-002 -->

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

# Repository governance

This document defines the public repository boundaries used for TokenLab releases
and demonstrations.

## Verification authority

The repository-owned GitHub Actions workflows—`Test suite` and
`Z1 shared-core contract`—are the authoritative automated checks for `main` and
pull requests. Local verification uses the supported Python 3.10 environment and
the same test surfaces.

The combined commit status may also contain a third-party `GitBook` context. As of
12 August 2026, that legacy context reports “Error while updating content” even
when both repository-owned Actions workflows pass. It is therefore recorded as a
legacy, non-authoritative publishing integration. Removing or reconfiguring it
requires a separate review of the exact GitHub integration; repository cleanup
must not silently delete it.

## Generated artifacts

New date-shaped report bundles under `docs_final/YYYY-MM-DD/` are local generated
outputs by default. Existing tracked bundles are retained as historical product
evidence. Publishing a new bundle is an explicit review decision and requires a
force-add so it cannot be included accidentally.

Simulation bundles under `outputs/` are reproducible local artifacts and are not
tracked. Public claims should link the scenario, seed, configuration hash,
manifest, and verification evidence rather than committing routine run output.

## Historical and client material

Repository hygiene does not authorize deleting historical product deliverables or
client/project material. Disclosure, licensing, confidentiality, and retention
decisions for those paths require a separate scoped review.

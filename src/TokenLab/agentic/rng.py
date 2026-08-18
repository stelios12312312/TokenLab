"""Deterministic seed derivation for reproducible TokenLab runs.

# @planner:story = US-PM-AUTO-H2A2D347E9E110A84

This module freezes the derivation contract used to turn one master seed
into independent, namespaced random streams. The contract is:

- ``SAMPLER_VERSION = "tokenlab-rng-v1"``
- ``RNG_ALGORITHM = "PCG64"`` (the numpy ``default_rng`` bit generator)
- namespace prefix ``"tokenlab.rng.v1"``

``namespace_words(namespace)`` hashes ``f"tokenlab.rng.v1:{namespace}"``
with SHA-256 (UTF-8) and reads the first 16 bytes as four uint32
big-endian words.

``derive_seed_sequence(master_seed, namespace, path_index)`` builds
``np.random.SeedSequence(entropy=[master_seed, *namespace_words(namespace)],
spawn_key=(path_index,))``.

``derive_generator(...)`` wraps that seed sequence in
``np.random.default_rng``.

Properties guaranteed by this contract (covered by
``tests/test_rng_reproducibility.py``):

- The same ``(master_seed, namespace, path_index)`` triple replays an
  identical stream.
- Changing any one of the three inputs changes the stream.
- Streams depend only on those three inputs: path indices ``0..k`` derived
  under a budget of ``N`` paths are identical to paths ``0..k`` derived
  under any other budget (``SeedSequence.spawn_key`` carries no budget).
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict

import numpy as np

SAMPLER_VERSION = "tokenlab-rng-v1"
RNG_ALGORITHM = "PCG64"
NAMESPACE_PREFIX = "tokenlab.rng.v1"


def namespace_words(namespace: str) -> tuple[int, int, int, int]:
    """Map a namespace string to four uint32 words via SHA-256."""
    digest = hashlib.sha256(
        f"{NAMESPACE_PREFIX}:{namespace}".encode("utf-8")
    ).digest()
    return tuple(
        int.from_bytes(digest[offset : offset + 4], "big")
        for offset in (0, 4, 8, 12)
    )


def derive_seed_sequence(
    master_seed: int, namespace: str, path_index: int
) -> np.random.SeedSequence:
    """Build the frozen SeedSequence for one (seed, namespace, path) triple."""
    return np.random.SeedSequence(
        entropy=[master_seed, *namespace_words(namespace)],
        spawn_key=(path_index,),
    )


def derive_generator(
    master_seed: int, namespace: str, path_index: int = 0
) -> np.random.Generator:
    """Derive one independent ``PCG64`` generator for the given triple."""
    return np.random.default_rng(
        derive_seed_sequence(master_seed, namespace, path_index)
    )


def seed_lineage(master_seed: int, namespace: str, path_index: int) -> Dict[str, Any]:
    """Return a JSON-safe record of how a generator was derived."""
    return {
        "master_seed": master_seed,
        "namespace": namespace,
        "namespace_sha256": hashlib.sha256(
            f"{NAMESPACE_PREFIX}:{namespace}".encode("utf-8")
        ).hexdigest(),
        "path_index": path_index,
        "spawn_key": [path_index],
        "rng_algorithm": RNG_ALGORITHM,
        "sampler_version": SAMPLER_VERSION,
    }


__all__ = [
    "NAMESPACE_PREFIX",
    "RNG_ALGORITHM",
    "SAMPLER_VERSION",
    "derive_generator",
    "derive_seed_sequence",
    "namespace_words",
    "seed_lineage",
]

"""Compatibility shim for legacy ``setup.py`` tooling.

All package metadata lives in ``pyproject.toml``.
"""

from setuptools import setup


if __name__ == "__main__":
    setup()

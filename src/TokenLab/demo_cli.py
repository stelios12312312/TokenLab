"""Quiet import bootstrap for the installed public demo command."""

# @planner:story = US-PM-AUTO-HFC7DB1681D268A66
# @planner:proves = crit:CRIT-001,crit:CRIT-002

from __future__ import annotations

import importlib
import os
import sys
import tempfile
from typing import Sequence


def _load_demo_with_captured_native_output():
    """Import the numerical stack without leaking native import diagnostics."""

    original_stdout = os.dup(1)
    original_stderr = os.dup(2)
    try:
        with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as stream:
            sys.stdout.flush()
            sys.stderr.flush()
            os.dup2(stream.fileno(), 1)
            os.dup2(stream.fileno(), 2)
            try:
                demo = importlib.import_module("TokenLab.agentic.demo")
            finally:
                sys.stdout.flush()
                sys.stderr.flush()
                os.dup2(original_stdout, 1)
                os.dup2(original_stderr, 2)
            stream.seek(0)
            diagnostics = stream.read()
    finally:
        os.close(original_stdout)
        os.close(original_stderr)
    return demo, diagnostics


def main(argv: Sequence[str] | None = None) -> int:
    demo, diagnostics = _load_demo_with_captured_native_output()
    return demo.main(argv, diagnostic_preamble=diagnostics or None)


if __name__ == "__main__":
    raise SystemExit(main())

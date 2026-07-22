"""M1 stable-parameter search entry point backed by shared tooling."""

from projects.z1.shared_core import analysis_tools as _shared
from .metrics import summarize_run
from .run import _run_single
from .scenarios import load_m1_scenario


def run_random_search(n_iter=100):
    return _shared.run_random_search(n_iter, load_scenario=load_m1_scenario, run_single=_run_single, summarize_run=summarize_run)


if __name__ == "__main__":
    run_random_search(100)

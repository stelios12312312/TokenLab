"""M2 boundary-hunt entry point backed by shared operator tooling."""

from projects.z1.shared_core import analysis_tools as _shared
from .metrics import summarize_run
from .run import _run_single
from .scenarios import load_m1_scenario, load_yaml


def run_sweep(name, param_name, values, base_config):
    return _shared.run_sweep(name, param_name, values, base_config, run_single=_run_single, summarize_run=summarize_run)


def main():
    return _shared.boundary_main(load_scenario=load_m1_scenario, load_yaml=load_yaml, run_single=_run_single, summarize_run=summarize_run)


if __name__ == "__main__":
    main()

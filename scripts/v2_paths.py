import argparse
import os


DEFAULT_OUTPUT_DIR = "outputs/v2_2026-07-06_120557"


def resolve_output_dir(argv=None) -> str:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--output-dir", default=os.environ.get("Z1_V2_OUTPUT_DIR", DEFAULT_OUTPUT_DIR))
    args, _ = parser.parse_known_args(argv)
    return args.output_dir


def output_path(output_dir: str, *parts: str) -> str:
    return os.path.join(output_dir, *parts)

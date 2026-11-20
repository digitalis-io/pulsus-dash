#!/usr/bin/env python3
"""ci:no-pulsusdb-host (stub: the checker is not implemented yet)."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path

COMPOSE_HOSTS = frozenset({"pulsus-fake"})
URL_RULE_EXEMPT = "tools/no-pulsusdb-host/testdata/"
REPO = Path(__file__).resolve().parents[2]


class UsageError(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise UsageError()


def is_local(host: str) -> bool:
    return False


def url_host(authority: str) -> str:
    return ""


def forbidden_hosts(env: Mapping[str, str]) -> list[str]:
    return []


def main(argv, env, out, err, *, read_bytes=Path.read_bytes, readlink=os.readlink,
         walk=os.walk, run=subprocess.run) -> int:
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], os.environ, sys.stdout, sys.stderr))

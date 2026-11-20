#!/usr/bin/env python3
"""ci:no-pulsusdb-host (T05 §7.1, T19-010): no private PulsusDB host in any tracked file.

Python 3.12 standard library only. Usage:

    python3 -I tools/no-pulsusdb-host/check.py [--root DIR] [--require-secret] [--show-paths]

Rules (docs/development/build-and-ci.md#ci-no-pulsusdb-host):
- forbidden-host: each DASH_FORBIDDEN_HOSTS entry (and the host of PULSUS_DASH_DATASOURCE_URL, if
  set and not local) in the bytes of every file, binaries, symlinks and fixtures included;
- forbidden-host-in-path: the same entries in the file's relative path;
- non-local-pulsusdb-url: a URL whose host contains "pulsusdb", or the value of a PulsusDB
  datasource key, whose host is not local. Text files only; not symlinks; in repository mode not
  under URL_RULE_EXEMPT.

Output rule: no path, host, line text, argument or subprocess message is ever printed. A file is
F<i>, its 1-based index in the sorted scanned list; --show-paths (refused when CI is set) prints
the path instead, for local use. Exit: 0 clean, 1 findings, 2 usage, git, bad root, unreadable,
missing secret with --require-secret, or an internal error.
"""

from __future__ import annotations

import argparse
import errno
import io
import ipaddress
import os
import re
import stat
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path

COMPOSE_HOSTS = frozenset({"pulsus-fake"})
URL_RULE_EXEMPT = "tools/no-pulsusdb-host/testdata/"  # repository mode; exempts ONLY the URL rule
REPO = Path(__file__).resolve().parents[2]

USAGE = "usage: python3 -I tools/no-pulsusdb-host/check.py [--root DIR] [--require-secret] [--show-paths]"
SECRET_TEXT = (
    "DASH_FORBIDDEN_HOSTS is not set: a repository owner must create this repository secret "
    "(see docs/development/build-and-ci.md#ci-no-pulsusdb-host); pull requests from forks cannot read it"
)
TEXT_PROBE = 8192

_DELIMS = "\\s/?#\"'<>()\\[\\]{}\\\\`"
URL = (
    r"[Hh][Tt][Tt][Pp][Ss]?://(?P<a>(?:[^" + _DELIMS + r"@]*@)?"
    r"(?:\[[0-9A-Fa-f:.]+(?:%(?:25)?[0-9A-Za-z._~-]+)?\]|[^" + _DELIMS + r":@]+)"
    r"(?::[0-9]{1,5})?)"
)
URL_RE = re.compile(URL)
B1_RE = re.compile(r"(?P<i>\s*)url\s*:\s*[\"']?" + URL)
B1_PARENT_RE = re.compile(r"\s*datasource\s*:\s*")
KEY_RES = (
    re.compile(r"(?<![A-Za-z0-9_.])datasource\.url\s*[:=]\s*[\"']?" + URL),  # b2
    re.compile(r"(?<![A-Za-z0-9_])PULSUS_DASH_DATASOURCE_URL\s*[:=]\s*[\"']?" + URL),  # b3
    re.compile(r"(?<![A-Za-z0-9_])(?:datasource_url|DatasourceURL)[\"']?\s*[:=]\s*[\"']?" + URL),  # b4
)


class UsageError(Exception):
    """Any argument problem; its message is never printed."""


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise UsageError()


def is_local(host: str) -> bool:
    """True only for loopback, reserved example/test names and the compose service names."""
    h = host.lower()
    if h == "localhost" or h.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        pass
    if h.endswith((".example", ".test", ".invalid")):
        return True
    if any(h == d or h.endswith("." + d) for d in ("example.com", "example.net", "example.org")):
        return True
    return h in COMPOSE_HOSTS


def url_host(authority: str) -> str:
    """The lower-case host of a URL authority: no userinfo, port, brackets, zone or trailing dot."""
    h = authority.rsplit("@", 1)[-1]
    if h.startswith("["):
        h = h[1:].split("]", 1)[0].split("%", 1)[0]
    elif h.count(":") == 1:
        h = h.split(":", 1)[0]
    return h.rstrip(".").lower()


def _entry_host(value: str) -> str:
    value = value.strip()
    if "://" in value:
        value = re.split(r"[/?#]", value.split("://", 1)[1], maxsplit=1)[0]
        return url_host(value)
    return value.lower()


def _dash_entries(env: Mapping[str, str]) -> list[str]:
    raw = env.get("DASH_FORBIDDEN_HOSTS", "")
    hosts = (_entry_host(part) for part in re.split(r"[,\n]", raw))
    return [h for h in hosts if h]


def forbidden_hosts(env: Mapping[str, str]) -> list[str]:
    """DASH_FORBIDDEN_HOSTS entries (1..n), then the non-local datasource host (n+1)."""
    hosts = _dash_entries(env)
    ds = env.get("PULSUS_DASH_DATASOURCE_URL", "")
    if ds.strip():
        h = _entry_host(ds if "://" in ds else "http://" + ds.strip())
        if h and not is_local(h):
            hosts.append(h)
    return hosts


def _errno_name(e: OSError) -> str:
    return errno.errorcode.get(e.errno, "unknown") if e.errno is not None else "unknown"


def _show(path: str) -> str:
    s = "".join(f"\\x{ord(c):02x}" if ord(c) < 0x20 or ord(c) == 0x7F else c for c in path)
    while "::" in s:
        s = s.replace("::", ": :")
    return s


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip())


def _url_findings(text: str) -> list[int]:
    """Line numbers of non-local PulsusDB URL candidates (rules a, b1-b4), deduplicated."""
    starts: list[int] = []
    for m in URL_RE.finditer(text):  # (a)
        h = url_host(m.group("a"))
        if "pulsusdb" in h and not is_local(h):
            starts.append(m.start())
    for rx in KEY_RES:  # (b2)-(b4)
        for m in rx.finditer(text):
            if not is_local(url_host(m.group("a"))):
                starts.append(m.start("a"))
    lines = text.split("\n")
    found = {text.count("\n", 0, s) + 1 for s in starts}
    for n, line in enumerate(lines):  # (b1)
        m = B1_RE.match(line)
        if m and not is_local(url_host(m.group("a"))):
            ind = len(m.group("i"))
            for prev in reversed(lines[:n]):
                if not prev.strip() or prev.lstrip().startswith("#"):
                    continue  # blank and comment lines are not YAML nodes
                if _indent(prev) < ind:
                    if B1_PARENT_RE.fullmatch(prev):
                        found.add(n + 1)
                    break
    return sorted(found)


def _walk_root(root: Path, walk, onerror) -> list[tuple[str, Path]]:
    entries: list[tuple[str, Path]] = []
    for dirpath, dirnames, filenames in walk(str(root), onerror=onerror, followlinks=False):
        if ".git" in dirnames:
            dirnames.remove(".git")
        for name in list(dirnames):
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                dirnames.remove(name)
                entries.append((os.path.relpath(full, root), Path(full)))
        for name in filenames:
            full = os.path.join(dirpath, name)
            mode = os.lstat(full).st_mode
            if stat.S_ISREG(mode) or stat.S_ISLNK(mode):
                entries.append((os.path.relpath(full, root), Path(full)))
    return sorted(entries, key=lambda e: os.fsencode(e[0]))


def _scan(argv, env, out, err, read_bytes, readlink, walk, run) -> int:
    parser = Parser(add_help=False, allow_abbrev=False, exit_on_error=False)
    parser.add_argument("--root")
    parser.add_argument("--require-secret", action="store_true")
    parser.add_argument("--show-paths", action="store_true")
    parser.add_argument("--help", action="store_true")
    try:
        args = parser.parse_args(argv)
    except (UsageError, argparse.ArgumentError):
        err.write("error[usage] invalid arguments\n")
        return 2
    if args.help:
        out.write(USAGE + "\n")
        return 0
    if args.show_paths and env.get("CI"):
        err.write("error[usage] --show-paths is refused in CI\n")
        return 2

    hosts = forbidden_hosts(env)
    if not _dash_entries(env):
        if args.require_secret:
            err.write(f"error[missing-secret] {SECRET_TEXT}\n")
            return 2
        err.write(f"warning[missing-secret] {SECRET_TEXT}\n")

    status2 = False
    if args.root is not None:
        root = Path(args.root)
        if not root.is_dir():
            err.write("error[bad-root] --root is not a directory\n")
            return 2

        def onerror(_e):
            nonlocal status2
            status2 = True
            err.write("error[unreadable] a directory under --root could not be listed\n")

        files = _walk_root(root, walk, onerror)
        repo_mode = False
    else:
        try:
            res = run(["git", "-C", str(REPO), "ls-files", "-z"], capture_output=True)
        except OSError:
            res = None
        if res is None or res.returncode != 0:
            err.write("error[git] ls-files failed\n")
            return 2
        names = sorted({p for p in res.stdout.split(b"\0") if p})
        files = [(os.fsdecode(p), REPO / os.fsdecode(p)) for p in names]
        repo_mode = True

    count = 0
    for i, (rel, full) in enumerate(files, start=1):
        fid = _show(rel) if args.show_paths else f"F{i}"
        low_path = rel.lower()
        for k, h in enumerate(hosts, start=1):
            if h in low_path:
                out.write(f"error[forbidden-host-in-path] {fid} (entry {k})\n")
                count += 1
        try:
            is_link = stat.S_ISLNK(os.lstat(full).st_mode)
            data = os.fsencode(readlink(full)) if is_link else read_bytes(full)
        except OSError as e:
            err.write(f"error[unreadable] {fid} ({_errno_name(e)})\n")
            status2 = True
            continue
        low = data.lower()
        hits = set()
        for k, h in enumerate(hosts, start=1):
            needle = h.encode("utf-8")
            at = low.find(needle)
            while at != -1:
                hits.add((low.count(b"\n", 0, at) + 1, k))
                at = low.find(needle, at + 1)
        for line, k in sorted(hits):
            out.write(f"error[forbidden-host] {fid}:{line} (entry {k})\n")
            count += 1
        if is_link or b"\0" in data[:TEXT_PROBE]:
            continue
        if repo_mode and rel.startswith(URL_RULE_EXEMPT):
            continue
        for line in _url_findings(data.decode("utf-8", errors="replace")):
            out.write(f"error[non-local-pulsusdb-url] {fid}:{line}\n")
            count += 1

    if count:
        out.write(
            f"no-pulsusdb-host: {count} finding(s) in {len(files)} files; "
            "run make no-pulsusdb-host ARGS=--show-paths locally to see paths\n"
        )
    else:
        out.write(f"no-pulsusdb-host: clean ({len(files)} files)\n")
    if status2:
        return 2
    return 1 if count else 0


def main(argv, env, out, err, *, read_bytes=Path.read_bytes, readlink=os.readlink,
         walk=os.walk, run=subprocess.run) -> int:
    """Runs the check. Output is buffered, so a crash prints only error[internal] <ClassName>."""
    bout, berr = io.StringIO(), io.StringIO()
    try:
        code = _scan(argv, env, bout, berr, read_bytes, readlink, walk, run)
    except Exception as e:  # noqa: BLE001 - the class name only; the message may hold a host
        err.write(f"error[internal] {type(e).__name__}\n")
        return 2
    out.write(bout.getvalue())
    err.write(berr.getvalue())
    return code


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:], os.environ, sys.stdout, sys.stderr))
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001
        sys.stderr.write(f"error[internal] {type(e).__name__}\n")
        sys.exit(2)

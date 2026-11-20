"""Tests of ci:no-pulsusdb-host (tools/no-pulsusdb-host/check.py), N1-N27 of #59 Part C.

Run: python3 -I -m unittest discover -s tools/no-pulsusdb-host -p 'test_*.py'
  or: python3 -I tools/no-pulsusdb-host/test_check.py

The forbidden host in these tests is the fictional db.secret-host.corp. No real host appears here.

URL literals spell the colon of "://" as \x3a: the strings are the same at run time, but this file
is scanned in repository mode, where only testdata/ is exempt from the URL rule.
"""

from __future__ import annotations

import errno
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# The checker sits next to this file. python3 -I does not put the script's directory on sys.path, so
# add it: the file runs directly (python3 -I tools/no-pulsusdb-host/test_check.py) and through
# unittest discovery.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import check  # noqa: E402

HERE = Path(__file__).resolve().parent
BAD = HERE / "testdata" / "bad"
GOOD = HERE / "testdata" / "good"
HOST = "db.secret-host.corp"
SECRET = {"DASH_FORBIDDEN_HOSTS": HOST}


def scan(argv, env=None, **kw):
    """Calls check.main with string streams; returns (exit, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    code = check.main(list(argv), dict(env or {}), out, err, **kw)
    return code, out.getvalue(), err.getvalue()


def findings(text):
    return [line for line in text.splitlines() if line.startswith("error[")]


def summary(text):
    lines = text.splitlines()
    return lines[-1] if lines else ""


def git_ok(paths):
    """An injected run that returns the given paths as git ls-files -z output."""
    data = b"".join(os.fsencode(p) + b"\0" for p in paths)

    def run(cmd, **kw):
        assert cmd[0] == "git" and cmd[-2:] == ["ls-files", "-z"], cmd
        return subprocess.CompletedProcess(cmd, 0, stdout=data, stderr=b"")

    return run


class Recorder:
    """Records calls and delegates to Path.read_bytes."""

    def __init__(self):
        self.calls = []

    def __call__(self, path):
        self.calls.append(Path(path))
        return Path(path).read_bytes()


class TmpTree(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.root = self.tmp / "root"
        self.root.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def put(self, rel, content, base=None):
        p = (base or self.root) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, str):
            content = content.encode()
        p.write_bytes(content)
        return p

    def n4_tree(self):
        self.put(f"{HOST}/a.md", "nothing here\n")
        self.put("notes-DB.Secret-Host.corp.md", f"see {HOST}\n")

    def assert_no_leak(self, *texts, words=("secret-host",)):
        for text in texts:
            for w in words:
                self.assertNotIn(w.lower(), text.lower())


class FixtureTests(unittest.TestCase):
    def test_bad_fixture(self):  # N1
        code, out, err = scan(["--root", str(BAD)])
        self.assertEqual(code, 1)
        self.assertEqual(
            findings(out),
            [
                "error[non-local-pulsusdb-url] F1:2",
                "error[non-local-pulsusdb-url] F2:1",
                "error[non-local-pulsusdb-url] F3:1",
                "error[non-local-pulsusdb-url] F4:1",
                "error[non-local-pulsusdb-url] F5:2",
                "error[non-local-pulsusdb-url] F6:2",
                "error[non-local-pulsusdb-url] F7:2",
            ],
        )
        self.assertEqual(
            summary(out),
            "no-pulsusdb-host: 7 finding(s) in 7 files; "
            "run make no-pulsusdb-host ARGS=--show-paths locally to see paths",
        )
        for word in ("pulsusdb.internal", "10.1.2.3", "pulsusdb-metrics", "db8.corp", "2001:db8",
                     "fe80", "config.yaml", "local.env", "notes", "seed_test", "single-label",
                     "v6", "zone"):
            self.assertNotIn(word, out + err)

    def test_good_fixture(self):  # N2
        code, out, err = scan(["--root", str(GOOD)], SECRET)
        self.assertEqual((code, findings(out), err), (0, [], ""))
        self.assertEqual(summary(out), "no-pulsusdb-host: clean (5 files)")

    def test_missing_secret_warning(self):  # N17
        code, out, err = scan(["--root", str(GOOD)])
        self.assertEqual(code, 0)
        self.assertTrue(err.startswith("warning[missing-secret] DASH_FORBIDDEN_HOSTS is not set"), err)
        self.assertEqual(summary(out), "no-pulsusdb-host: clean (5 files)")


class ForbiddenHostTests(TmpTree):
    def test_forbidden_host_content(self):  # N3
        self.put("notes.md", "ping DB.secret-host.corp now\nb.corp\n")
        env = {"DASH_FORBIDDEN_HOSTS": "a.corp,\ndb.secret-host.corp , b.corp"}
        code, out, err = scan(["--root", str(self.root)], env)
        self.assertEqual(code, 1)
        self.assertEqual(
            findings(out),
            ["error[forbidden-host] F1:1 (entry 2)", "error[forbidden-host] F1:2 (entry 3)"],
        )
        self.assert_no_leak(out, err)

    def test_host_in_path_opaque(self):  # N4
        self.n4_tree()
        code, out, err = scan(["--root", str(self.root)], SECRET)
        self.assertEqual(code, 1)
        self.assertEqual(
            sorted(findings(out)),
            sorted([
                "error[forbidden-host-in-path] F1 (entry 1)",
                "error[forbidden-host-in-path] F2 (entry 1)",
                "error[forbidden-host] F2:1 (entry 1)",
            ]),
        )
        self.assert_no_leak(out, err, words=("secret-host", "notes", "a.md"))

    def test_unknown_host_in_path(self):  # N5
        self.put("pulsusdb.internal.corp/config.yaml",
                 "datasource:\n  url: https\x3a//pulsusdb.internal.corp:3100\n")
        code, out, err = scan(["--root", str(self.root)])
        self.assertEqual(code, 1)
        self.assertEqual(findings(out), ["error[non-local-pulsusdb-url] F1:2"])
        self.assert_no_leak(out, err, words=("internal.corp",))

    def test_forbidden_host_in_fixture_dir(self):  # N6
        self.put("tools/no-pulsusdb-host/testdata/bad/x.md",
                 f"{HOST}\ndatasource:\n  url: https\x3a//pulsusdb.internal.corp:3100\n")
        self.put("README.md", "hello\n")
        run = git_ok(["tools/no-pulsusdb-host/testdata/bad/x.md", "README.md"])
        with mock.patch.object(check, "REPO", self.root):
            code, out, err = scan([], SECRET, run=run)
        self.assertEqual(code, 1)
        self.assertEqual(findings(out), ["error[forbidden-host] F2:1 (entry 1)"])
        self.assertEqual(summary(out).split(" in ")[1].split(";")[0], "2 files")
        self.assert_no_leak(out, err)

    def test_forbidden_host_after_nul(self):  # N7
        self.put("b.bin", b"\0\x01" + b"\n" + HOST.encode())
        code, out, err = scan(["--root", str(self.root)], SECRET)
        self.assertEqual(code, 1)
        self.assertEqual(findings(out), ["error[forbidden-host] F1:2 (entry 1)"])

    def test_binary_url_not_scanned(self):  # N8
        self.put("c.bin", b"\0" + b"https\x3a//pulsusdb.internal.corp")
        code, out, err = scan(["--root", str(self.root)])
        self.assertEqual(code, 0)
        self.assertEqual(findings(out), [])
        self.assertTrue(err.startswith("warning[missing-secret]"), err)
        self.assertEqual(summary(out), "no-pulsusdb-host: clean (1 files)")

    def test_datasource_env_host(self):  # N18
        self.put("f.txt", "uses db.other.corp\n")
        env = {"PULSUS_DASH_DATASOURCE_URL": "https\x3a//db.other.corp:3100", "DASH_FORBIDDEN_HOSTS": "a.corp"}
        code, out, err = scan(["--root", str(self.root)], env)
        self.assertEqual(code, 1)
        self.assertEqual(findings(out), ["error[forbidden-host] F1:1 (entry 2)"])
        self.assert_no_leak(out, err, words=("other.corp",))
        env["PULSUS_DASH_DATASOURCE_URL"] = "http\x3a//localhost:3100"
        code, out, err = scan(["--root", str(self.root)], env)
        self.assertEqual((code, findings(out)), (0, []))
        self.assertEqual(summary(out), "no-pulsusdb-host: clean (1 files)")


class ErrorPathTests(TmpTree):
    def test_unreadable_file(self):  # N9
        self.n4_tree()
        first = self.root / HOST / "a.md"

        def read_bytes(path):
            if Path(path) == first:
                raise PermissionError(errno.EACCES, f"x {HOST}")
            return Path(path).read_bytes()

        code, out, err = scan(["--root", str(self.root)], SECRET, read_bytes=read_bytes)
        self.assertEqual(code, 2)
        self.assertIn("error[unreadable] F1 (EACCES)", err.splitlines())
        self.assertIn("error[forbidden-host] F2:1 (entry 1)", findings(out))
        self.assert_no_leak(out, err)

    def test_unreadable_directory(self):  # N10
        self.put("ok.md", "fine\n")

        def walk(top, onerror=None, followlinks=False):
            onerror(PermissionError(errno.EACCES, HOST))
            yield str(self.root), [], ["ok.md"]

        code, out, err = scan(["--root", str(self.root)], SECRET, walk=walk)
        self.assertEqual(code, 2)
        self.assertIn("error[unreadable] a directory under --root could not be listed", err.splitlines())
        self.assert_no_leak(out, err)

    def test_crash_prints_class_only(self):  # N11
        self.put("a.md", "x\n")

        def read_bytes(path):
            raise RuntimeError(f"boom {HOST}")

        code, out, err = scan(["--root", str(self.root)], SECRET, read_bytes=read_bytes)
        self.assertEqual((code, out, err), (2, "", "error[internal] RuntimeError\n"))

    def test_invalid_arguments(self):  # N12
        for argv in (["--bogus", HOST], ["--root"], [f"extra-{HOST}"]):
            with self.subTest(argv=argv):
                code, out, err = scan(argv, SECRET)
                self.assertEqual((code, out, err), (2, "", "error[usage] invalid arguments\n"))

    def test_git_failure(self):  # N13
        def failing(cmd, **kw):
            return subprocess.CompletedProcess(cmd, 128, stdout=b"", stderr=f"fatal: {HOST}".encode())

        def missing(cmd, **kw):
            raise FileNotFoundError(errno.ENOENT, f"git {HOST}")

        for run in (failing, missing):
            with self.subTest(run=run.__name__):
                code, out, err = scan([], SECRET, run=run)
                self.assertEqual((code, out, err), (2, "", "error[git] ls-files failed\n"))

    def test_workflow_command_chars(self):  # N14
        self.put(f"::error::{HOST}.md", f"{HOST}\n")
        code, out, err = scan(["--root", str(self.root)], SECRET)
        self.assertEqual(code, 1)
        self.assertEqual(
            out.splitlines(),
            [
                "error[forbidden-host-in-path] F1 (entry 1)",
                "error[forbidden-host] F1:1 (entry 1)",
                "no-pulsusdb-host: 2 finding(s) in 1 files; "
                "run make no-pulsusdb-host ARGS=--show-paths locally to see paths",
            ],
        )
        self.assertNotIn("::", out + err)
        self.assert_no_leak(out, err)

    def test_show_paths(self):  # N15
        self.n4_tree()
        rec = Recorder()
        code, out, err = scan(["--root", str(self.root), "--show-paths"], {**SECRET, "CI": "true"},
                              read_bytes=rec)
        self.assertEqual((code, out, err), (2, "", "error[usage] --show-paths is refused in CI\n"))
        self.assertEqual(rec.calls, [])

        code, out, err = scan(["--root", str(self.root), "--show-paths"], SECRET)
        self.assertEqual(code, 1)
        self.assertIn(f"error[forbidden-host-in-path] {HOST}/a.md (entry 1)", findings(out))
        self.assertIn("error[forbidden-host] notes-DB.Secret-Host.corp.md:1 (entry 1)", findings(out))

        self.put(f"::error::{HOST}.md", "clean\n")
        code, out, err = scan(["--root", str(self.root), "--show-paths"], SECRET)
        self.assertIn(f"error[forbidden-host-in-path] : :error: :{HOST}.md (entry 1)", findings(out))
        self.assertNotIn("::", out)

    def test_show_paths_escapes_control_bytes(self):  # N15, control bytes
        self.put("a\x1bb.md", f"{HOST}\n")
        code, out, err = scan(["--root", str(self.root), "--show-paths"], SECRET)
        self.assertEqual(code, 1)
        self.assertIn("error[forbidden-host] a\\x1bb.md:1 (entry 1)", findings(out))
        self.assertNotIn("\x1b", out)

    def test_missing_secret_required(self):  # N16
        for env in ({}, {"DASH_FORBIDDEN_HOSTS": " , \n"}):
            with self.subTest(env=env):
                calls = []

                def run(cmd, **kw):
                    calls.append(("run", cmd))
                    return git_ok([])(cmd, **kw)

                def read_bytes(path):
                    calls.append(("read", path))
                    return b""

                code, out, err = scan(["--require-secret"], env, run=run, read_bytes=read_bytes)
                self.assertEqual(code, 2)
                self.assertTrue(
                    err.startswith(
                        "error[missing-secret] DASH_FORBIDDEN_HOSTS is not set: "
                        "a repository owner must create"
                    ),
                    err,
                )
                self.assertIn("docs/development/build-and-ci.md#ci-no-pulsusdb-host", err)
                self.assertEqual(calls, [])

    def test_bad_root(self):
        f = self.put("file.txt", "x\n")
        code, out, err = scan(["--root", str(f)], SECRET)
        self.assertEqual((code, out, err), (2, "", "error[bad-root] --root is not a directory\n"))

    def test_help(self):
        code, out, err = scan(["--help"])
        self.assertEqual(code, 0)
        self.assertEqual(
            out,
            "usage: python3 -I tools/no-pulsusdb-host/check.py "
            "[--root DIR] [--require-secret] [--show-paths]\n",
        )


class SymlinkTests(TmpTree):
    def test_symlink_target_present(self):  # N22
        outside = self.put(f"{HOST}.txt", "clean\n", base=self.tmp / "outside")
        (self.root / "link.md").symlink_to(f"../outside/{outside.name}")
        rec = Recorder()
        with mock.patch.object(check, "REPO", self.root):
            code, out, err = scan([], SECRET, run=git_ok(["link.md"]), read_bytes=rec)
        self.assertEqual(code, 1)
        self.assertEqual(findings(out), ["error[forbidden-host] F1:1 (entry 1)"])
        self.assertEqual(rec.calls, [])

    def test_symlink_target_dangling(self):  # N23
        (self.root / "link.md").symlink_to(f"../outside/{HOST}.txt")
        rec = Recorder()
        with mock.patch.object(check, "REPO", self.root):
            code, out, err = scan([], SECRET, run=git_ok(["link.md"]), read_bytes=rec)
        self.assertEqual(code, 1)
        self.assertEqual(findings(out), ["error[forbidden-host] F1:1 (entry 1)"])
        self.assertNotIn("unreadable", err)
        self.assertEqual(rec.calls, [])

    def test_symlink_url_not_applied(self):  # N24
        (self.root / "link").symlink_to("https\x3a//pulsusdb.internal.corp")
        code, out, err = scan(["--root", str(self.root)])
        self.assertEqual(code, 0)
        self.assertEqual(findings(out), [])
        self.assertEqual(summary(out), "no-pulsusdb-host: clean (1 files)")

    def test_symlink_readlink_error(self):
        (self.root / "link").symlink_to("target")

        def readlink(path):
            raise PermissionError(errno.EACCES, HOST)

        code, out, err = scan(["--root", str(self.root)], SECRET, readlink=readlink)
        self.assertEqual(code, 2)
        self.assertIn("error[unreadable] F1 (EACCES)", err.splitlines())
        self.assert_no_leak(out, err)

    def test_root_dir_symlink(self):  # N26
        self.put("inside.md", f"{HOST}\n", base=self.tmp / f"{HOST}-docs")
        (self.root / "docs-link").symlink_to(f"../{HOST}-docs")
        rec = Recorder()
        code, out, err = scan(["--root", str(self.root)], SECRET, read_bytes=rec)
        self.assertEqual(code, 1)
        self.assertEqual(
            out.splitlines(),
            [
                "error[forbidden-host] F1:1 (entry 1)",
                "no-pulsusdb-host: 1 finding(s) in 1 files; "
                "run make no-pulsusdb-host ARGS=--show-paths locally to see paths",
            ],
        )
        self.assertEqual(rec.calls, [])


class UrlRuleTests(TmpTree):
    def one(self, content, env=None):
        for p in self.root.iterdir():
            p.unlink()
        self.put("f.txt", content)
        return scan(["--root", str(self.root)], env)

    def test_url_pattern_ipv6(self):  # N25
        for content, want, word in (
            ("datasource:\n  url: http\x3a//[2001:db8::7]:3100/x\n", ["error[non-local-pulsusdb-url] F1:2"], "2001"),
            ("PULSUS_DASH_DATASOURCE_URL=http\x3a//u:p@[2001:db8::9]:3100\n",
             ["error[non-local-pulsusdb-url] F1:1"], "2001"),
            ("datasource:\n  url: http\x3a//[::1]:3100\n", [], "::1"),
        ):
            with self.subTest(content=content):
                code, out, err = self.one(content)
                self.assertEqual((code, findings(out)), (1 if want else 0, want))
                self.assertNotIn(word, out + err)

    def test_url_authority_table(self):  # N27
        flagged = [
            "http\x3a//[fe80::1%25eth0]:3100", "http\x3a//[fe80::1%eth0]:3100", "http\x3a//[2001:DB8::7]",
            "http\x3a//u:p@db.corp.net:3100", "http\x3a//10.1.2.3:3100", "HTTPS\x3a//DB.CORP.NET:3100/x",
            "http\x3a//db.corp.net.:3100", "http\x3a//db.corp.net?x=1", "http\x3a//db.corp.net#f",
            "http\x3a//db.corp.net", "http\x3a//db.corp.net:65535",
        ]
        clean = [
            "http\x3a//[::1]:3100", "http\x3a//[::1%25lo]:3100", "http\x3a//[0:0:0:0:0:0:0:1]:3100",
            "http\x3a//u:p@localhost:3100", "http\x3a//127.0.0.2", "http\x3a//LOCALHOST:3100",
            "http\x3a//localhost.:3100", "https\x3a//pulsusdb.example:3100", "http\x3a//pulsus-fake:3100",
        ]
        for url in flagged:
            with self.subTest(url=url):
                code, out, err = self.one(f"PULSUS_DASH_DATASOURCE_URL={url}\n")
                self.assertEqual((code, findings(out)), (1, ["error[non-local-pulsusdb-url] F1:1"]))
                for word in ("corp", "fe80", "2001", "10.1.2.3"):
                    self.assertNotIn(word, (out + err).lower())
        for url in clean:
            with self.subTest(url=url):
                code, out, err = self.one(f"PULSUS_DASH_DATASOURCE_URL={url}\n")
                self.assertEqual((code, findings(out)), (0, []))
                self.assertEqual(summary(out), "no-pulsusdb-host: clean (1 files)")

    def test_datasource_keys(self):  # rules b2 and b4 forms; b1 only directly under datasource:
        for content, want in (
            ("datasource.url = https\x3a//db.corp.net\n", 1),
            ("x.datasource.url = https\x3a//db.corp.net\n", 0),
            ("datasource_url: 'https\x3a//db.corp.net'\n", 1),
            ('"datasource_url": "https\x3a//db.corp.net"\n', 1),
            ("Datasource_URL: https\x3a//db.corp.net\n", 0),
            ("datasource:\n  name: x\n\n  url: https\x3a//db.corp.net\n", 1),
            ("datasource:\n  nested:\n    url: https\x3a//db.corp.net\n", 0),
            ("url: https\x3a//db.corp.net\n", 0),
        ):
            with self.subTest(content=content):
                code, out, err = self.one(content)
                self.assertEqual(len(findings(out)), want)
                self.assertEqual(code, 1 if want else 0)


class FunctionTests(unittest.TestCase):
    def test_is_local_table(self):  # N19
        for h in ("localhost", "a.localhost", "127.0.0.2", "127.255.255.254", "::1", "x.example",
                  "x.test", "x.invalid", "example.com", "a.b.example.org", "pulsus-fake"):
            with self.subTest(host=h):
                self.assertTrue(check.is_local(h))
        for h in ("pulsusdb", "db", "0.0.0.0", "10.0.0.1", "example.co", "myexample.com",
                  "pulsus-fake.corp", "localhost.corp", "128.0.0.1"):
            with self.subTest(host=h):
                self.assertFalse(check.is_local(h))

    def test_url_host(self):  # N20
        for authority, want in (
            ("u:p@[::1]:3100", "::1"),
            ("Host.Example:80", "host.example"),
            ("a.corp.", "a.corp"),
            ("h", "h"),
            ("[fe80::1%25eth0]:3100", "fe80::1"),
            ("[fe80::1%eth0]", "fe80::1"),
        ):
            with self.subTest(authority=authority):
                self.assertEqual(check.url_host(authority), want)

    def test_forbidden_hosts(self):
        env = {
            "DASH_FORBIDDEN_HOSTS": " A.corp ,\nhttps\x3a//u@B.corp:3100/x,, \n",
            "PULSUS_DASH_DATASOURCE_URL": "https\x3a//C.corp:3100",
        }
        self.assertEqual(check.forbidden_hosts(env), ["a.corp", "b.corp", "c.corp"])
        env["PULSUS_DASH_DATASOURCE_URL"] = "http\x3a//localhost:3100"
        self.assertEqual(check.forbidden_hosts(env), ["a.corp", "b.corp"])


if __name__ == "__main__":
    unittest.main()

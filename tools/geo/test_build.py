"""unit:geo-build and unit:geo-gazetteer-build (T24 §10.3, T24-085 to T24-087): the geo build tool.

Run: python3 -I -m unittest discover -s tools/geo -p 'test_*.py' (make geo-test).
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import build

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CASES = json.loads((HERE / "fixtures" / "basemap-cases.json").read_text(encoding="utf-8"))["cases"]
GAZ = json.loads((HERE / "fixtures" / "gazetteer-case.json").read_text(encoding="utf-8"))


def features(case: dict) -> list:
    """The case's features as build_basemap input: (a2, a3, name, [[ring, ...], ...]), points as tuples."""
    return [
        (f["a2"], f["a3"], f["name"], [[[tuple(p) for p in ring] for ring in poly] for poly in f["polygons"]])
        for f in case["features"]
    ]


def dbf_bytes(rows: list[dict[str, str]]) -> bytes:
    """A dBASE III file of character fields holding rows (the fields of the first row, in order)."""
    fields = list(rows[0])
    enc = [[r.get(f, "").encode("utf-8") for f in fields] for r in rows]
    widths = [max([1] + [len(v[i]) for v in enc]) for i in range(len(fields))]
    hlen = 32 + 32 * len(fields) + 1
    rlen = 1 + sum(widths)
    out = bytearray(struct.pack("<B3BIHH20x", 3, 126, 11, 25, len(rows), hlen, rlen))
    for name, w in zip(fields, widths):
        out += name.encode("ascii").ljust(11, b"\0") + b"C" + b"\0" * 4 + bytes([w, 0]) + b"\0" * 14
    out += b"\x0d"
    for v in enc:
        out += b" " + b"".join(x.ljust(w, b" ") for x, w in zip(v, widths))
    out += b"\x1a"
    return bytes(out)


def shp_bytes(records: list[list[list[tuple[float, float]]]]) -> bytes:
    """A polygon (type 5) shapefile: each record a list of closed rings."""
    body = bytearray()
    for n, parts in enumerate(records, 1):
        pts = [p for ring in parts for p in ring]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        idx, k = [], 0
        for ring in parts:
            idx.append(k)
            k += len(ring)
        c = struct.pack("<i4d2i", 5, min(xs), min(ys), max(xs), max(ys), len(parts), len(pts))
        c += struct.pack(f"<{len(idx)}i", *idx) + struct.pack(f"<{2 * len(pts)}d", *[v for p in pts for v in p])
        body += struct.pack(">2i", n, len(c) // 2) + c
    head = struct.pack(">7i", 9994, 0, 0, 0, 0, 0, (100 + len(body)) // 2)
    head += struct.pack("<2i8d", 1000, 5, 0, 0, 0, 0, 0, 0, 0, 0)
    return head + bytes(body)


def closed(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    return ring + [ring[0]]


class BasemapBuild(unittest.TestCase):
    """unit:geo-build: the T24 §10.3 build fixtures (T24-086)."""

    def test_cases(self) -> None:
        self.assertEqual(len(CASES), 17)
        for case in CASES:
            with self.subTest(case=case["name"]):
                if "error" in case:
                    with self.assertRaises(build.BuildError) as cm:
                        build.build_basemap(features(case), polar=tuple(case["polar"]))
                    self.assertEqual(str(cm.exception), case["error"])
                    continue
                obj, report = build.build_basemap(features(case), polar=tuple(case["polar"]))
                self.assertEqual(build.dumps(obj), (case["expect"] + "\n").encode("utf-8"))
                self.assertEqual(report, case["report"])
                again, report2 = build.build_basemap(features(case), polar=tuple(case["polar"]))
                self.assertEqual(build.dumps(again), build.dumps(obj))
                self.assertEqual(report2, report)

    def test_only_sliver_reports(self) -> None:
        reports = {c["name"]: c["report"] for c in CASES if "expect" in c}
        self.assertEqual({k for k, v in reports.items() if v}, {"SLIVER"})
        self.assertEqual(reports["SLIVER"], ["dropped sliver polygon AAA (3 points, 5.0e-07 sq deg)"])

    def test_qv(self) -> None:
        self.assertEqual([build.qv(v) for v in (53.335007, -6.250852, -1.125, 0.005, -0.005, -0.0, 85.0511)],
                         [5334, -625, -113, 1, -1, 0, 8505])

    def test_assembly(self) -> None:
        outer = closed([(0, 0), (0, 10), (10, 10), (10, 0)])  # clockwise
        hole = closed([(2, 2), (4, 2), (4, 4), (2, 4)])  # counter-clockwise
        outer2 = closed([(20, 0), (20, 10), (30, 10), (30, 0)])
        stray = closed([(50, 50), (60, 50), (60, 60), (50, 60)])
        recs = build.read_shp(shp_bytes([[outer, hole, outer2], [outer, stray]]))
        self.assertEqual(len(recs), 2)
        polys = build.assemble("AAA", recs[0])
        self.assertEqual(len(polys), 2)
        self.assertEqual([len(p) for p in polys], [2, 1])
        self.assertEqual(polys[0][1], hole[:-1])
        self.assertEqual(polys[1][0], outer2[:-1])
        with self.assertRaises(build.BuildError) as cm:
            build.assemble("XXX", recs[1])
        self.assertEqual(str(cm.exception), "XXX: hole outside every outer ring")


class GazetteerBuild(unittest.TestCase):
    """unit:geo-gazetteer-build (T24-085)."""

    def rows(self, key: str) -> list[dict[str, str]]:
        return build.read_dbf(dbf_bytes(GAZ[key]))

    def test_dbf_round_trip(self) -> None:
        rows = self.rows("admin1")
        self.assertEqual(len(rows), 5)
        self.assertEqual(rows[2], GAZ["admin1"][2])

    def test_output(self) -> None:
        g = build.build_gazetteer(self.rows("admin0"), self.rows("admin1"), GAZ["airports"],
                                  self.rows("places"), GAZ["cloud"])
        self.assertEqual(build.dumps(g), (GAZ["expect"] + "\n").encode("utf-8"))

    def test_cloud_errors(self) -> None:
        for v in GAZ["cloudErrors"]:
            with self.subTest(error=v["error"]):
                with self.assertRaises(build.BuildError) as cm:
                    build.build_gazetteer(self.rows("admin0"), self.rows("admin1"), GAZ["airports"],
                                          self.rows("places"), v["cloud"])
                self.assertEqual(str(cm.exception), v["error"])

    def test_name_length(self) -> None:
        admin1 = [dict(GAZ["admin1"][0], name_en="x" * 101)]
        with self.assertRaises(build.BuildError) as cm:
            build.build_gazetteer(self.rows("admin0"), build.read_dbf(dbf_bytes(admin1)), GAZ["airports"],
                                  self.rows("places"), GAZ["cloud"])
        self.assertEqual(str(cm.exception), "region US-CA: name length")


class Sources(unittest.TestCase):
    """unit:geo-build (sources, check, fixtures, notices; T24-085, T24-087)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.src = self.tmp.name
        self.sources = []
        for name in ("airports.csv", "ne_10m_admin_0_countries.zip"):
            data = name.encode("ascii") * 3
            Path(self.src, name).write_bytes(data)
            self.sources.append({"file": name, "sha256": hashlib.sha256(data).hexdigest()})

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_build_all(self, sources: list[dict]) -> str:
        spies = [mock.patch.object(build, n, wraps=getattr(build, n)) for n in ("read_dbf", "read_shp", "build_gazetteer")]
        with mock.patch.object(build, "load_sources", return_value=sources), contextlib.ExitStack() as st:
            mocks = [st.enter_context(s) for s in spies]
            with self.assertRaises(build.BuildError) as cm:
                build.build_all(self.src)
            for m in mocks:
                m.assert_not_called()
        return str(cm.exception)

    def test_digest_mismatch_before_parse(self) -> None:
        bad = [dict(self.sources[0], sha256="0" * 64), self.sources[1]]
        self.assertEqual(self.run_build_all(bad), "airports.csv: SHA-256 mismatch")

    def test_missing_before_parse(self) -> None:
        os.remove(Path(self.src, "ne_10m_admin_0_countries.zip"))
        self.assertEqual(self.run_build_all(self.sources), "ne_10m_admin_0_countries.zip: missing")

    def test_verify_returns_bytes(self) -> None:
        got = build.verify_sources(self.src, self.sources)
        self.assertIn("airports.csv", got)
        self.assertEqual(got["airports.csv"], b"airports.csv" * 3)

    def committed(self) -> dict[str, bytes]:
        paths = ("client/src/vis/geo/data/basemap.json", "client/src/vis/geo/data/gazetteer.json",
                 "tools/geo/report.txt", "tools/geo/manifest.json")
        return {p: (ROOT / p).read_bytes() if (ROOT / p).exists() else b"" for p in paths}

    def test_check(self) -> None:
        same = self.committed()
        out = io.StringIO()
        with mock.patch.object(build, "build_all", return_value=same), contextlib.redirect_stdout(out):
            self.assertEqual(build.main([self.src, "--check"]), 0)
        self.assertIn("geo-build: 4 files identical", out.getvalue())
        changed = dict(same)
        changed["client/src/vis/geo/data/gazetteer.json"] += b" "
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(build, "build_all", return_value=changed), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(build.main([self.src, "--check"]), 1)
        text = out.getvalue() + err.getvalue()
        self.assertIn("client/src/vis/geo/data/gazetteer.json", text)
        self.assertNotIn("basemap.json", text)

    def test_fixtures_committed(self) -> None:
        files = build.build_fixtures()
        names = sorted(Path(p).name for p in files)
        self.assertEqual(names, sorted(f"{n}.json" for n in (
            "rt", "rot", "holeclamp", "ant", "enclave", "sliver", "ell",
            "corner", "cross", "touch", "collinear", "nested")))
        for path, data in files.items():
            with self.subTest(path=path):
                self.assertEqual((ROOT / path).read_bytes(), data)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(build.main(["--fixtures", "--check"]), 0)

    def test_x100_assets(self) -> None:
        files = build.build_fixtures()
        for case in CASES:
            if "x100Polygons" in case:
                with self.subTest(case=case["name"]):
                    path = f"client/src/vis/geo/fixtures/build/{case['x100']}.json"
                    self.assertIn(path, files)
                    j = json.loads(files[path])
                    self.assertEqual(j["countries"][0][3], case["x100Polygons"])

    def test_notices(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(build.main(["--notices"]), 0)
        lines = out.getvalue().splitlines()
        self.assertEqual(lines[0], "== Data ==")
        self.assertEqual(len(lines), 7)
        self.assertIn("PulsusIX cloud region list · tools/geo/cloud-regions.csv · AGPL-3.0", lines)
        self.assertIn("Natural Earth 110m Admin 0 Countries 5.1.1 (2022-05-09) · ne_110m_admin_0_countries.zip"
                      " · public domain", lines)
        for line in lines:
            self.assertNotIn("://", line)

    def test_sources_json(self) -> None:
        s = build.load_sources()
        self.assertEqual([r["file"] for r in s], sorted(r["file"] for r in s))
        self.assertEqual(len(s), 6)
        self.assertEqual(sum(1 for r in s if r["sha256"] is None), 1)
        text = (HERE / "sources.json").read_text(encoding="utf-8")
        self.assertNotIn("://", text)


if __name__ == "__main__":
    unittest.main()

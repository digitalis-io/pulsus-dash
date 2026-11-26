#!/usr/bin/env python3
"""tools/geo/build.py (T24 §5.13, T24-085, T24-086): the bundled geo assets from pinned sources.

Python standard library only. Usage (run from any directory):

    python3 -I tools/geo/build.py SRC_DIR            write the 4 outputs
    python3 -I tools/geo/build.py SRC_DIR --check    rebuild in memory and compare byte for byte
    python3 -I tools/geo/build.py --fixtures [--check]  the client build fixtures
    python3 -I tools/geo/build.py --notices          the "Data" section of the notices file

SRC_DIR holds the five source files of tools/geo/sources.json (never committed, never downloaded
by CI); every SHA-256 is checked before any file is parsed. The outputs are
client/src/vis/geo/data/{basemap,gazetteer}.json, tools/geo/report.txt (the T24-086 drops) and
tools/geo/manifest.json (the assets' digests and the source digests they were built from). The
procedure is in docs/client/supply-chain.md.

Exit: 0 written, identical or printed; 1 --check found a differing file (each is named);
2 usage or a build error ("geo-build: <message>" on stderr).
"""

from __future__ import annotations

import collections
import csv
import hashlib
import io
import json
import math
import re
import struct
import sys
import zipfile
from pathlib import Path

GEO = Path(__file__).resolve().parent
ROOT = GEO.parents[1]
SOURCES_JSON = GEO / "sources.json"
CLOUD_CSV = "cloud-regions.csv"
CASES_JSON = GEO / "fixtures" / "basemap-cases.json"
FIXTURE_DIR = "client/src/vis/geo/fixtures/build"
BASEMAP = "client/src/vis/geo/data/basemap.json"
GAZETTEER = "client/src/vis/geo/data/gazetteer.json"
REPORT = "tools/geo/report.txt"
MANIFEST = "tools/geo/manifest.json"
OUTLINES = "ne_110m_admin_0_countries.zip"
ADMIN0 = "ne_10m_admin_0_countries.zip"
ADMIN1 = "ne_10m_admin_1_states_provinces.zip"
PLACES = "ne_10m_populated_places_simple.zip"
AIRPORTS = "airports.csv"
CLOUD_HEADER = ["provider", "id", "place", "iso_a2", "ne_id", "source", "retrieved"]

Q, LAT, YQ = 100, 85.0511, 8505
XQ = 180 * Q
# §5.12 patterns.
A2, A3 = re.compile(r"[A-Z]{2}"), re.compile(r"[A-Z]{3}")
REGION = re.compile(r"[A-Z]{2}-[A-Z0-9]{1,3}")
PROVIDER, CLOUD_ID = re.compile(r"[a-z][a-z0-9]{1,15}"), re.compile(r"[a-z0-9-]{1,40}")
AS_OF = re.compile(r"# as of \d{4}-\d{2}-\d{2}")

Point = tuple[float, float]
Ring = list[Point]


class BuildError(Exception):
    """A build failure; str() is the user message, e.g. "PPP: hole not strictly inside its outer ring"."""


# ---- readers ----


def read_dbf(data: bytes) -> list[dict[str, str]]:
    """dBASE III records: every field as its UTF-8 text, stripped of blanks and NULs."""
    n, hlen, rlen = struct.unpack("<IHH", data[4:12])
    fields: list[tuple[str, int]] = []
    off = 32
    while data[off] != 0x0D:
        name = data[off : off + 11].split(b"\0")[0].decode("ascii")
        fields.append((name, data[off + 16]))
        off += 32
    recs = []
    for i in range(n):
        r = data[hlen + i * rlen : hlen + (i + 1) * rlen]
        p = 1
        d = {}
        for name, ln in fields:
            d[name] = r[p : p + ln].decode("utf-8").strip(" \x00")
            p += ln
        recs.append(d)
    return recs


def read_shp(data: bytes) -> list[list[Ring]]:
    """Polygon (type 5) records -> their parts, each without the repeated closing point."""
    off = 100
    out: list[list[Ring]] = []
    while off < len(data):
        _, ln = struct.unpack(">ii", data[off : off + 8])
        c = data[off + 8 : off + 8 + ln * 2]
        off += 8 + ln * 2
        t = struct.unpack("<i", c[:4])[0]
        if t == 0:
            out.append([])
            continue
        if t != 5:
            raise BuildError(f"shape type {t} is not a polygon")
        nparts, npts = struct.unpack("<ii", c[36:44])
        parts = list(struct.unpack(f"<{nparts}i", c[44 : 44 + 4 * nparts])) + [npts]
        pts = struct.unpack(f"<{2 * npts}d", c[44 + 4 * nparts : 44 + 4 * nparts + 16 * npts])
        rings = []
        for i in range(nparts):
            r = [(pts[2 * k], pts[2 * k + 1]) for k in range(parts[i], parts[i + 1])]
            if len(r) > 1 and r[0] == r[-1]:
                r = r[:-1]
            rings.append(r)
        out.append(rings)
    return out


def zip_member(data: bytes, name: str) -> bytes:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return z.read(name)


# ---- geometry ----


def area(r) -> float:
    """Signed shoelace area, counter-clockwise positive (x right, y up)."""
    n = len(r)
    return sum(r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1] for i in range(n)) / 2


def _inside_float(pt: Point, r: Ring) -> bool:
    x, y = pt
    c = False
    for i in range(len(r)):
        (x1, y1), (x2, y2) = r[i], r[(i + 1) % len(r)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def assemble(a3: str, rings: list[Ring]) -> list[list[Ring]]:
    """Shapefile rings (outer clockwise, holes counter-clockwise) -> [[outer, holes...]] in source
    order; a hole joins the first outer that holds its first vertex."""
    polys = [[r] for r in rings if area(r) < 0]
    for h in (r for r in rings if area(r) > 0):
        for p in polys:
            if _inside_float(h[0], p[0]):
                p.append(h)
                break
        else:
            raise BuildError(f"{a3}: hole outside every outer ring")
    return polys


def qv(v: float) -> int:
    """Quantise to hundredths, rounding half away from zero: sign(v) * floor(|v| * 100 + 0.5)."""
    m = int(math.floor(abs(v) * Q + 0.5))
    return m if v >= 0 else -m


def _qring(r: Ring) -> list[tuple[int, int]]:
    """Clamp latitude, quantise and remove consecutive duplicate points (cyclically)."""
    q: list[tuple[int, int]] = []
    for x, y in r:
        p = (qv(x), qv(max(-LAT, min(LAT, y))))
        if not q or q[-1] != p:
            q.append(p)
    while len(q) > 1 and q[0] == q[-1]:
        q.pop()
    return q


def _collapsed(q) -> bool:
    return len(set(q)) < 3 or area(q) == 0


def _canon(r, outer: bool):
    """Orient (outer counter-clockwise, hole clockwise) and start at the smallest (x, y)."""
    a = area(r)
    if (outer and a < 0) or (not outer and a > 0):
        r = r[::-1]
    i = min(range(len(r)), key=lambda k: r[k])
    return r[i:] + r[:i]


def _enc(r) -> list[int]:
    a = [r[0][0], r[0][1]]
    for i in range(1, len(r)):
        a += [r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]]
    return a


def _check_source(a3: str, polys: list[list[Ring]], polar) -> None:
    for poly in polys:
        for r in poly:
            for i in range(len(r)):
                (x0, y0), (x1, y1) = r[i - 1], r[i]
                if abs(y1) >= LAT and a3 not in polar:
                    raise BuildError(f"{a3}: vertex at |lat| >= {LAT} outside polarFeatures")
                if abs(x1 - x0) > 180 and not (abs(y0) >= LAT and abs(y1) >= LAT):
                    raise BuildError(f"{a3}: edge spans more than 180 degrees of longitude")


def canonical_feature(a3: str, polys: list[list[Ring]], polar, report: list[str]):
    """T24-086 up to orientation, rotation and the polygon sort; no hole check. Drops go to report."""
    if not polys:
        raise BuildError(f"{a3}: no polygons")
    _check_source(a3, polys, polar)
    big = max(range(len(polys)), key=lambda i: abs(area(polys[i][0])))
    out = []
    for pi, poly in enumerate(polys):
        q = [_qring(r) for r in poly]
        if _collapsed(q[0]):
            src = abs(area(poly[0]))
            if pi == big:
                raise BuildError(f"{a3}: largest polygon collapses under quantisation")
            if src >= 1e-4:
                raise BuildError(f"{a3}: polygon of {src:.2e} sq deg collapses")
            report.append(f"dropped sliver polygon {a3} ({len(poly[0])} points, {src:.1e} sq deg)")
            continue
        holes = []
        for h, hs in zip(q[1:], poly[1:]):
            if _collapsed(h):
                report.append(f"dropped sliver hole {a3} ({len(hs)} points, {abs(area(hs)):.1e} sq deg)")
                continue
            holes.append(_canon(h, False))
        out.append([_canon(q[0], True)] + holes)
    out.sort(key=lambda p: (min(x for x, _ in p[0]), min(y for _, y in p[0])))
    return out


# ---- the hole predicate (T24-087), exact on integers; decode.ts implements the same ----


def _orient(a, b, c) -> int:
    v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    return (v > 0) - (v < 0)


def _on_box(a, b, p) -> bool:
    return min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])


def _segments_meet(a, b, c, d) -> bool:
    """True if the closed segments ab and cd share a point (crossing, touching or collinear overlap)."""
    o1, o2, o3, o4 = _orient(a, b, c), _orient(a, b, d), _orient(c, d, a), _orient(c, d, b)
    if o1 * o2 < 0 and o3 * o4 < 0:
        return True
    return ((o1 == 0 and _on_box(a, b, c)) or (o2 == 0 and _on_box(a, b, d))
            or (o3 == 0 and _on_box(c, d, a)) or (o4 == 0 and _on_box(c, d, b)))


def _strictly_inside(p, r) -> bool:
    """Even-odd with cross products; a point on the boundary is not inside."""
    c = False
    for i in range(len(r)):
        a, b = r[i - 1], r[i]
        o = _orient(a, b, p)
        if o == 0 and _on_box(a, b, p):
            return False
        if (a[1] > p[1]) != (b[1] > p[1]) and (o if b[1] > a[1] else -o) > 0:
            c = not c
    return c


def _holes_ok(poly) -> bool:
    outer, holes = poly[0], poly[1:]

    def edges(r):
        return [(r[i - 1], r[i]) for i in range(len(r))]

    oe = edges(outer)
    he = [edges(h) for h in holes]
    for k, h in enumerate(holes):
        if not all(_strictly_inside(p, outer) for p in h):
            return False
        for a, b in he[k]:
            if any(_segments_meet(a, b, c, d) for c, d in oe):
                return False
            for m in range(k + 1, len(holes)):
                if any(_segments_meet(a, b, c, d) for c, d in he[m]):
                    return False
        for m in range(k + 1, len(holes)):
            if _strictly_inside(holes[m][0], h) or _strictly_inside(h[0], holes[m]):
                return False
    return True


def check_holes(a3: str, polys) -> None:
    """The T24-087 hole predicate on each polygon of integer point lists."""
    for p in polys:
        if len(p) > 1 and not _holes_ok(p):
            raise BuildError(f"{a3}: hole not strictly inside its outer ring")


# ---- strokes ----


def _strokes(feats) -> tuple[list[list[int]], list[list[int]]]:
    edges: collections.Counter = collections.Counter()
    for f in feats:
        for poly in f[3]:
            for r in poly:
                for i in range(len(r)):
                    edges[frozenset((r[i - 1], r[i]))] += 1
    seam = {f[1] for f in feats if {x for p in f[3] for r in p for x, _ in r} >= {XQ, -XQ}}
    seen: set = set()
    coast: list[list[int]] = []
    border: list[list[int]] = []
    for f in feats:
        on_seam = f[1] in seam

        def artificial(p, q) -> bool:
            return (abs(p[1]) == YQ and p[1] == q[1]) or (on_seam and abs(p[0]) == XQ and p[0] == q[0])

        for poly in f[3]:
            for r in poly:
                n = len(r)
                runs: list = []
                run = None
                cls = None
                for i in range(1, n + 1):
                    p, q = r[i - 1], r[i % n]
                    e = frozenset((p, q))
                    c = None if artificial(p, q) else ("border" if edges[e] >= 2 else "coast")
                    if c == "border":
                        if e in seen:
                            c = None
                        else:
                            seen.add(e)
                    if c != cls:
                        if run and len(run) > 1:
                            runs.append((cls, run))
                        run = [p] if c else None
                        cls = c
                    if c:
                        run.append(q)
                if run and len(run) > 1:
                    runs.append((cls, run))
                if len(runs) > 1 and runs[-1][0] == runs[0][0] and runs[-1][1][-1] == runs[0][1][0]:
                    c0, last = runs.pop()
                    runs[0] = (c0, last + runs[0][1][1:])
                for c, rr in runs:
                    (coast if c == "coast" else border).append(_enc(rr))
    return coast, border


def _name(kind: str, code: str, name: str) -> str:
    if not 1 <= len(name) <= 100:
        raise BuildError(f"{kind} {code}: name length")
    return name


def build_basemap(features, polar=("ATA",)) -> tuple[dict, list[str]]:
    """features: [(a2, a3, name, [[outer, holes...], ...])] in lon/lat, any orientation.
    Returns the basemap.json object and the report lines (T24-086)."""
    report: list[str] = []
    feats = []
    for a2, a3, name, polys in features:
        _name("country", a3, name)
        ps = canonical_feature(a3, polys, polar, report)
        check_holes(a3, ps)
        feats.append((a2, a3, name, ps))
    feats.sort(key=lambda f: (f[1], f[2]))
    coast, border = _strokes(feats)
    countries = [[a2, a3, nm, [[_enc(r) for r in poly] for poly in ps]] for a2, a3, nm, ps in feats]
    return {"v": 1, "q": Q, "countries": countries, "coast": coast, "border": border}, report


# ---- gazetteer (T24-085) ----


def _xy(lon: str, lat: str) -> list[int]:
    return [qv(float(lon)), qv(float(lat))]


def _cloud_rows(cloud_csv: str, places: list[dict[str, str]]) -> list[list]:
    lines = cloud_csv.splitlines(keepends=True)
    if lines and AS_OF.fullmatch(lines[0].rstrip("\r\n")):
        lines = lines[1:]
    reader = csv.reader(io.StringIO("".join(lines), newline=""))
    header = next(reader, None)
    if header != CLOUD_HEADER:
        raise BuildError(f"{CLOUD_CSV}: the header is not {','.join(CLOUD_HEADER)}")
    by_id = {p["ne_id"]: p for p in places}
    rows = []
    for rec in reader:
        if len(rec) != len(CLOUD_HEADER):
            raise BuildError(f"{CLOUD_CSV}: a record has {len(rec)} fields, not {len(CLOUD_HEADER)}")
        provider, cid, place, iso, ne_id = rec[:5]
        who = f"{CLOUD_CSV}: {provider} {cid}"
        if not PROVIDER.fullmatch(provider) or not CLOUD_ID.fullmatch(cid):
            raise BuildError(f"{who}: provider or id outside the §5.12 patterns")
        p = by_id.get(ne_id)
        if p is None:
            raise BuildError(f"{who}: ne_id {ne_id} is not a populated place")
        if p["iso_a2"] != iso:
            raise BuildError(f"{who}: iso_a2 {iso} is not the place's {p['iso_a2']}")
        name = _name("cloud", f"{provider} {cid}", place)
        rows.append([provider, cid, name, *_xy(p["longitude"], p["latitude"])])
    return sorted(rows, key=lambda r: (r[0], r[1]))


def build_gazetteer(admin0, admin1, airports_csv: str, places, cloud_csv: str) -> dict:
    """The gazetteer.json object from the DBF records of Admin 0, Admin 1 and the populated places,
    the airports CSV text and the cloud regions CSV text."""
    by_a2: dict[str, list[dict[str, str]]] = collections.defaultdict(list)
    for d in admin0:
        a2, a3 = d["ISO_A2_EH"], d["ISO_A3_EH"]
        if A2.fullmatch(a2) and A3.fullmatch(a3):
            by_a2[a2].append(d)
    country = []
    for a2, ds in by_a2.items():
        main = [d for d in ds if d["ADM0_A3"] == d["ISO_A3_EH"]]
        for d in main if len(ds) > 1 and len(main) == 1 else ds:
            name = _name("country", a2, d["NAME_EN"])
            country.append([a2, d["ISO_A3_EH"], name, *_xy(d["LABEL_X"], d["LABEL_Y"])])
    region = []
    for d in admin1:
        code = d["iso_3166_2"]
        if REGION.fullmatch(code):
            name = _name("region", code, d["name_en"] or d["name"] or code)
            region.append([code, name, *_xy(d["longitude"], d["latitude"])])
    iata = []
    for r in csv.DictReader(io.StringIO(airports_csv, newline="")):
        code = r["iata_code"]
        if r["type"] in ("large_airport", "medium_airport") and r["scheduled_service"] == "yes" \
                and A3.fullmatch(code):
            place = _name("iata", code, r["municipality"] or r["name"] or code)
            iata.append([code, place, *_xy(r["longitude_deg"], r["latitude_deg"])])
    return {"v": 1, "q": Q, "country": sorted(country), "region": sorted(region), "iata": sorted(iata),
            "cloud": _cloud_rows(cloud_csv, places)}


# ---- outputs ----


def dumps(obj) -> bytes:
    """Compact UTF-8 JSON, keys in insertion order (v, q, then the data members), and a trailing LF."""
    return (json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def _pretty(obj) -> bytes:
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def load_sources() -> list[dict]:
    return json.loads(SOURCES_JSON.read_text(encoding="utf-8"))["sources"]


def verify_sources(src_dir: str, sources: list[dict]) -> dict[str, bytes]:
    """Every source's bytes, keyed by file, after checking every digest (before any parse). A source
    whose sha256 is null is a tracked file of tools/geo/."""
    out: dict[str, bytes] = {}
    for s in sources:
        path = GEO / s["file"] if s["sha256"] is None else Path(src_dir) / s["file"]
        try:
            data = path.read_bytes()
        except OSError:
            raise BuildError(f"{s['file']}: missing") from None
        if s["sha256"] is not None and hashlib.sha256(data).hexdigest() != s["sha256"]:
            raise BuildError(f"{s['file']}: SHA-256 mismatch")
        out[s["file"]] = data
    return out


def _member(blobs: dict[str, bytes], zip_name: str, ext: str) -> bytes:
    return zip_member(blobs[zip_name], zip_name.removesuffix(".zip") + ext)


def _asset(path: str, data: bytes, sources: list[str]) -> dict:
    return {"file": path, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
            "sources": sorted(sources)}


def build_all(src_dir: str) -> dict[str, bytes]:
    """Repository-relative path -> bytes of the four outputs."""
    blobs = verify_sources(src_dir, load_sources())
    digests = {f: hashlib.sha256(b).hexdigest() for f, b in sorted(blobs.items())}
    shp = read_shp(_member(blobs, OUTLINES, ".shp"))
    recs = read_dbf(_member(blobs, OUTLINES, ".dbf"))
    if len(shp) != len(recs):
        raise BuildError(f"{OUTLINES}: {len(shp)} shapes but {len(recs)} records")
    features = [(d["ISO_A2_EH"], d["ISO_A3_EH"], d["NAME_EN"], assemble(d["ISO_A3_EH"], rings))
                for rings, d in zip(shp, recs)]
    basemap, report = build_basemap(features)
    gazetteer = build_gazetteer(
        read_dbf(_member(blobs, ADMIN0, ".dbf")), read_dbf(_member(blobs, ADMIN1, ".dbf")),
        blobs[AIRPORTS].decode("utf-8"), read_dbf(_member(blobs, PLACES, ".dbf")),
        blobs[CLOUD_CSV].decode("utf-8"))
    b, g = dumps(basemap), dumps(gazetteer)
    manifest = {"v": 1,
                "assets": [_asset(BASEMAP, b, [OUTLINES]),
                           _asset(GAZETTEER, g, [f for f in digests if f != OUTLINES])],
                "sources": digests}
    return {BASEMAP: b, GAZETTEER: g, REPORT: "".join(f"{x}\n" for x in report).encode("utf-8"),
            MANIFEST: _pretty(manifest)}


def build_fixtures() -> dict[str, bytes]:
    """client/src/vis/geo/fixtures/build/*.json from fixtures/basemap-cases.json: the build output of
    each `fixture` case, and for each `x100` case its source scaled by 100, oriented and rotated."""
    out: dict[str, bytes] = {}
    for c in json.loads(CASES_JSON.read_text(encoding="utf-8"))["cases"]:
        feats = [(f["a2"], f["a3"], f["name"],
                  [[[tuple(p) for p in r] for r in poly] for poly in f["polygons"]]) for f in c["features"]]
        if "fixture" in c:
            obj, _ = build_basemap(feats, polar=tuple(c["polar"]))
            out[f"{FIXTURE_DIR}/{c['fixture']}.json"] = dumps(obj)
        if "x100" in c:
            countries = []
            for a2, a3, name, polys in feats:
                ps = []
                for poly in polys:
                    rs = [[(round(x * Q), round(y * Q)) for x, y in r] for r in poly]
                    ps.append([_enc(_canon(rs[0], True))] + [_enc(_canon(h, False)) for h in rs[1:]])
                countries.append([a2, a3, name, ps])
            out[f"{FIXTURE_DIR}/{c['x100']}.json"] = dumps(
                {"v": 1, "q": Q, "countries": countries, "coast": [], "border": []})
    return out


def notices() -> str:
    """The "Data" section: one line per source (T24 §5.13)."""
    lines = ["== Data =="]
    for s in load_sources():
        if s["sha256"] is None:
            lines.append(f"{s['dataset']} · tools/geo/{s['file']} · {s['licence']}")
        else:
            lines.append(f"{s['dataset']} {s['version']} ({s['fileDate']}) · {s['file']} · {s['licence']}")
    return "\n".join(lines) + "\n"


def _compare(files: dict[str, bytes]) -> int:
    differ = [p for p, data in files.items() if not (ROOT / p).is_file() or (ROOT / p).read_bytes() != data]
    for p in differ:
        print(f"geo-build: {p} differs from the rebuild")
    if differ:
        return 1
    print(f"geo-build: {len(files)} files identical")
    return 0


def _write(files: dict[str, bytes]) -> None:
    for p, data in files.items():
        (ROOT / p).parent.mkdir(parents=True, exist_ok=True)
        (ROOT / p).write_bytes(data)
    print(f"geo-build: wrote {len(files)} files")


USAGE = "usage: build.py SRC_DIR [--check] | build.py --fixtures [--check] | build.py --notices"


def main(argv: list[str]) -> int:
    args = [a for a in argv if a != "--check"]
    check = len(args) < len(argv)
    try:
        if args == ["--notices"] and not check:
            sys.stdout.write(notices())
            return 0
        if args == ["--fixtures"]:
            files = build_fixtures()
        elif len(args) == 1 and not args[0].startswith("--"):
            files = build_all(args[0])
        else:
            print(f"geo-build: {USAGE}", file=sys.stderr)
            return 2
    except BuildError as e:
        print(f"geo-build: {e}", file=sys.stderr)
        return 2
    if check:
        return _compare(files)
    _write(files)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""Check designs/ for broken links, requirement-ID hygiene and traceability; regenerate traceability.md.

Usage: python3 -I designs/tools/check.py [--write]
Exit code 1 on any error.
"""
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AREAS = {
    "01-": "PRN", "01a-": "AUD", "02-": "IA", "03-": "INT", "04-": "SRF", "05-": "VIZ",
    "06-": "AI", "07-": "ALR", "08-": "VL", "09-": "PRF", "11-": "ENT", "13-": "SCN", "15-": "EST",
}
REQ_HEAD = re.compile(r"^#### ((?:[A-Z]{2,3})-\d{3}) — (.+)$")
META = re.compile(r"^\*\*(MUST|SHOULD|MAY)\*\* · (M-UI\d) · (.+)$")
TECH_RULE = re.compile(r"^#### (T\d\d-\d{3}) — (.+)$")
LINK = re.compile(r"\]\(([^)\s]+)\)")
REQ_REF = re.compile(r"\b((?:PRN|AUD|IA|INT|SRF|VIZ|AI|ALR|VL|PRF|ENT|SCN|EST)-\d{3})\b")
WITHDRAWN = "Withdrawn"


def slug(h):
    h = h.strip().lstrip("#").strip().lower()
    h = re.sub(r"[^\w\- ]", "", h)
    return h.replace(" ", "-")


def anchors(path, cache={}):
    if path not in cache:
        out, seen = set(), {}
        in_code = False
        for line in open(path, encoding="utf-8"):
            if line.startswith("```"):
                in_code = not in_code
            if in_code or not line.startswith("#"):
                continue
            s = slug(line)
            n = seen.get(s, 0)
            out.add(s if n == 0 else f"{s}-{n}")
            seen[s] = n + 1
        cache[path] = out
    return cache[path]


def strip_code(text):
    return re.sub(r"```.*?```", "", text, flags=re.S)


def main():
    errors, warnings = [], []
    md = sorted(glob.glob(os.path.join(ROOT, "**", "*.md"), recursive=True))
    reqs = {}  # id -> dict
    rules = {}
    satisfies = {}  # req id -> list of (tdoc, section, verification)

    for f in md:
        rel = os.path.relpath(f, ROOT)
        if rel.endswith("TEMPLATE.md") or rel == "traceability.md":
            continue
        text = open(f, encoding="utf-8").read()
        body = strip_code(text)
        # links
        for m in LINK.finditer(body):
            target = m.group(1)
            if re.match(r"^[a-z]+:", target):
                continue
            path, _, frag = target.partition("#")
            if "plans/" in path:
                errors.append(f"{rel}: links into plans/: {target}")
                continue
            dest = f if not path else os.path.normpath(os.path.join(os.path.dirname(f), path))
            if not os.path.exists(dest):
                errors.append(f"{rel}: broken link {target}")
                continue
            if frag and dest.endswith(".md") and frag not in anchors(dest):
                errors.append(f"{rel}: missing anchor {target}")
        lines = text.splitlines()
        # product requirements
        if rel.startswith("product/"):
            base = os.path.basename(f)
            area = next((a for p, a in AREAS.items() if base.startswith(p)), None)
            for i, line in enumerate(lines):
                m = REQ_HEAD.match(line)
                if not m:
                    continue
                rid, title = m.groups()
                if area and not rid.startswith(area + "-"):
                    errors.append(f"{rel}:{i+1}: {rid} not in area {area}")
                if rid in reqs:
                    errors.append(f"{rel}:{i+1}: duplicate {rid} (also {reqs[rid]['doc']})")
                meta = META.match(lines[i + 1].strip()) if i + 1 < len(lines) else None
                if not meta and WITHDRAWN not in lines[i + 1]:
                    errors.append(f"{rel}:{i+1}: {rid} missing '**MUST** · M-UIn · audiences' line")
                block = "\n".join(lines[i + 1:i + 40])
                nxt = re.search(r"^#{1,4} ", block, flags=re.M)
                block = block[: nxt.start()] if nxt else block
                if meta and "*Acceptance:*" not in block:
                    errors.append(f"{rel}:{i+1}: {rid} has no *Acceptance:*")
                reqs[rid] = {
                    "doc": rel, "title": title, "anchor": slug(line),
                    "prio": meta.group(1) if meta else WITHDRAWN,
                    "ms": meta.group(2) if meta else "—",
                }
        # technical
        if rel.startswith("technical/"):
            for i, line in enumerate(lines):
                m = TECH_RULE.match(line)
                if m:
                    if m.group(1) in rules:
                        errors.append(f"{rel}:{i+1}: duplicate rule {m.group(1)}")
                    rules[m.group(1)] = rel
            sat = re.search(r"^## \d+\. Satisfies\s*$(.*?)^## ", text, flags=re.S | re.M)
            if os.path.basename(f).startswith("T"):
                if not sat:
                    errors.append(f"{rel}: no '## n. Satisfies' section")
                else:
                    for row in sat.group(1).splitlines():
                        cells = [c.strip() for c in row.strip().strip("|").split("|")]
                        if len(cells) < 3 or cells[0].startswith("---") or cells[0] == "Requirement":
                            continue
                        for rid in REQ_REF.findall(cells[0]):
                            satisfies.setdefault(rid, []).append(
                                (os.path.basename(f)[:3], cells[1], cells[2]))

    for rid, rows in satisfies.items():
        if rid not in reqs:
            errors.append(f"Satisfies references unknown requirement {rid} ({rows[0][0]})")
    for f in md:
        rel = os.path.relpath(f, ROOT)
        for rid in set(REQ_REF.findall(strip_code(open(f, encoding='utf-8').read()))):
            if rid not in reqs and reqs and not rel.endswith("README.md") and "TEMPLATE" not in rel:
                warnings.append(f"{rel}: mentions unknown requirement {rid}")

    if "--write" in sys.argv:
        out = ["# Traceability matrix", "",
               "> Generated by `tools/check.py --write`. Do not edit by hand.", "",
               f"{len(reqs)} requirements · "
               f"{sum(1 for r in reqs if r in satisfies)} traced to a technical design.", "",
               "| Requirement | Title | Priority | Milestone | Satisfied by | Verification |",
               "|---|---|---|---|---|---|"]
        order = sorted(reqs, key=lambda r: (reqs[r]["doc"], r))
        for rid in order:
            r = reqs[rid]
            rows = satisfies.get(rid, [])
            by = "<br>".join(f"{t} {s}" for t, s, _ in rows) or "—"
            ver = "<br>".join(v for _, _, v in rows) or "—"
            out.append(f"| [{rid}]({r['doc']}#{r['anchor']}) | {r['title']} | {r['prio']} | "
                       f"{r['ms']} | {by} | {ver} |")
        open(os.path.join(ROOT, "traceability.md"), "w", encoding="utf-8").write("\n".join(out) + "\n")

    untraced = [r for r in reqs if r not in satisfies and reqs[r]["prio"] == "MUST"
                and reqs[r]["ms"] in ("M-UI0", "M-UI1")]
    for w in warnings[:50]:
        print("warn:", w)
    for e in errors:
        print("error:", e)
    print(f"{len(reqs)} requirements, {len(rules)} design rules, "
          f"{len(satisfies)} traced, {len(untraced)} untraced M-UI0/1 MUSTs, "
          f"{len(errors)} errors, {len(warnings)} warnings")
    if "--untraced" in sys.argv:
        print("\n".join(sorted(untraced)))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())

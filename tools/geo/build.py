"""tools/geo/build.py (T24 §5.13): stub for the failing tests (#231)."""
from __future__ import annotations


class BuildError(Exception):
    pass


def qv(v): return 0
def read_dbf(data): return []
def read_shp(data): return []
def assemble(a3, rings): return []
def build_basemap(features, polar=("ATA",)): return {}, []
def build_gazetteer(admin0, admin1, airports_csv, places, cloud_csv): return {}
def dumps(obj): return b""
def load_sources(): return []
def verify_sources(src_dir, sources): return {}
def build_all(src_dir): return {}
def build_fixtures(): return {}
def main(argv): return 2

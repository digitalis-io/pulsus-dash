# Geomap data and location resolution

The geomap's data layer (issue #231, part E step 1a of
[T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md)): how a series' labels
resolve to a place, the two bundled offline assets (a world basemap and a gazetteer), how they are
validated and loaded, and what they cover. It implements
[VIZ-045](../../designs/product/05-visualisation-catalogue.md) and the bundled offline data of
VIZ-046, by the rules T24-080 to T24-087. The map frame that draws them comes in E2 (#234); nothing
in the app imports these modules yet.

The modules live in `client/src/vis/geo/` and import nothing outside it except types:

| Module | What it holds |
|---|---|
| `aliases.ts` | `normKey`, the alias lists, `HINT_KEY`, `GEO_AUTO_RULES` and `GEO_ALIAS_KEYS` (no imports) |
| `geohash.ts` | `decodeGeohash` (no imports) |
| `locate.ts` | `locate` and its types `GeoSource`, `GeoPlace`, `LocationResult`, `LocationOption` |
| `types.ts` | `Basemap`, `BasemapCountry`, `Gazetteer` and its rows, `GeoData` |
| `decode.ts` | `decodeBasemap`, `decodeGazetteer` (type-only imports, so `ci:geo-data` runs it in Node) |
| `urls.ts` | `basemapUrl`, `gazetteerUrl`: the assets imported with `?url` (the `geo-assets` build input) |
| `assets.ts` | `geoLoader`, `loadGeoData`; re-exports the decoders |
| `data/basemap.json`, `data/gazetteer.json` | the assets, built by `tools/geo/build.py` ([below](#how-the-assets-are-built)) |

## Resolving a location (`locate`)

```ts
locate(labels: Labels, o: LocationOption, g: Gazetteer | null): LocationResult
```

`locate` reads one series' labels. It is pure, total and deterministic: it never throws, reads only
its arguments, and returns a fresh, deeply frozen result (T24-080).

**Keys.** A label key is compared in its normal form: ASCII capitals are lower-cased and `.` reads
as `_` (`Cloud.Region` is `cloud_region`; `Ünit.X` is `Ünit_x`). An empty value is the same as an
absent key. Two raw keys with one normal form and different values are a **collision**; with equal
values they merge, and the first raw key in UTF-16 order names the merged key.

### Auto mode (`{ mode: 'auto' }`)

The first rule with a present alias decides; there is no fallback to a later rule (T24-081 (c)).
Within a rule the aliases are in precedence order:

| # | Aliases (normal form) | Source |
|---|---|---|
| 1 | lat `lat`, `latitude`, `geo_location_lat`; lon `lon`, `lng`, `longitude`, `geo_location_lon` | coordinates |
| 2 | `geohash`, `geo_hash` | geohash |
| 3 | `cloud_region` (hint `cloud_provider`) | cloud |
| 4 | `geo_region_iso_code`, `region_iso_code` | region (ISO 3166-2) |
| 5 | `geo_country_iso_code`, `country_code`, `country` | country (ISO 3166-1) |
| 6 | `iata`, `iata_code`, `airport` | airport |
| 7 | `region` (hint `cloud_provider`) | cloud or region |

The order of outcomes:

1. **Collisions** count only among the keys the deciding rule reads: its aliases, plus
   `cloud_provider` for rules 3 and 7. A collision elsewhere is ignored.
2. **Coordinates** (rule 1): an axis with no present alias is `incompleteCoords`. Then every
   present alias, the latitude's first, then the longitude's, is checked: a coordinate is a whole
   string matching `^-?\d{1,3}(\.\d{1,12})?$` with |lat| ≤ 90 and |lon| ≤ 180, and the first that
   fails is `invalid: coords` with its key. Only then are an axis's values compared as numbers:
   `10` and `10.0` agree; different numbers are `aliasConflict`.
3. **Geohash** (rule 2): the lower-cased value must match `^[0-9b-hjkmnp-z]{1,12}$`, else
   `invalid: geohash`; different lower-cased hashes are `aliasConflict`. The place is the cell's
   centre, with `cell` its height and width in degrees.
4. **Lookups** (rules 3 to 7): no gazetteer gives `gazetteerUnavailable`. Each present alias is
   looked up in precedence order (unknown, then the hint, then several rows, then one row) and the
   first result that is not `placed` wins. Aliases that place different gazetteer rows (two rows
   that share a code and a name included) are `aliasConflict`.

**Lookups** (T24-084):

- **Country:** a 2-letter value is an alpha-2 code, a 3-letter value an alpha-3 code (both
  upper-cased); anything else is an English name, compared after NFC normalisation and
  `toLowerCase`. Several rows: `sharedCode` for a code, `name` for a name. The place's `code` is
  the alpha-2 code.
- **Region** and **IATA:** upper-cased; several rows are `sharedCode`.
- **Cloud:** the id is lower-cased; `cloud_provider`, lower-cased, then filters the rows. No row
  left is `providerMismatch` with all the id's rows as candidates; several rows are `providers`.
- **Rule 7** (`region`): the hint-filtered cloud rows and the region rows together; rows of both
  kinds are `regionOrCloud`.
- No row: `unknownCode` with the source (rule 7 reports `cloud`) and the value as written.

Candidates are sorted by UTF-16 code units: country `‹a2› ‹name›`, region and IATA `‹code› ‹name›`,
cloud `‹provider› ‹id›`, and `‹raw key›=‹value›` for `keyCollision` and `aliasConflict`.
`place.key` is the raw key of the first present alias (for coordinates, the latitude's).

### Explicit modes

| Option | Reads | Notes |
|---|---|---|
| `{ mode: 'coords', lat, lon }` | the two named fields | none present `noLocation`; one `incompleteCoords`; then as rule 1 |
| `{ mode: 'geohash', field }` | the field | absent `noLocation`; then as rule 2 |
| `{ mode: 'lookup', field, gazetteer, country? }` | the field, and `cloud_provider` for `cloud` | absent `noLocation`; no gazetteer `gazetteerUnavailable`; with `gazetteer: 'region'` and `country`, a value without `-` is prefixed `‹country›-` (`CA` → `US-CA`) |

### One example per status

Against a gazetteer holding the rows named (auto mode unless given):

| Labels | Result |
|---|---|
| `cloud_region=eu-west-1` | `placed`: cloud, `eu-west-1`, aws, Dublin, lat 53.34, lon −6.25 |
| `service=web` | `noLocation` |
| `cloud_region=eu-west-1` with no gazetteer | `gazetteerUnavailable` (coordinates and geohashes still place) |
| `lat=91 lon=0` | `invalid: coords`, key `lat` |
| `latitude=10` | `invalid: incompleteCoords`, key `latitude` |
| `geohash=U4PA` | `invalid: geohash` (`a` is not a geohash character) |
| `cloud_region=mars-north-1` | `unknownCode`: cloud, `cloud_region`, `mars-north-1` |
| `cloud_provider=gcp cloud_region=eu-west-1` | `providerMismatch`: `cloud_region`, gcp, [`aws eu-west-1`] |
| `cloud.region=eu-west-1 cloud_region=eu-west-2` | `ambiguous: keyCollision` |
| `lat=10 latitude=11 lon=5` | `ambiguous: aliasConflict` [`lat=10`, `latitude=11`] |
| `country=ZZ` (two `ZZ` rows) | `ambiguous: sharedCode` |
| `country=atlantis` (two rows of that name) | `ambiguous: name` |
| `cloud_region=xx-dup-1` (two providers) | `ambiguous: providers` |
| `region=xx-dup` (a region and a cloud id) | `ambiguous: regionOrCloud` |

### Precision

| Source | Position |
|---|---|
| Coordinates | exactly the label's numbers (`-0` places at 0) |
| Geohash | the cell's centre; `cell` gives its size (11 characters ≈ 1.3 × 10⁻⁶ degrees) |
| Gazetteer | the row's label point, quantised to 0.01°: a country's Natural Earth label point, a region's, an airport's position, a cloud region's metro (below) |

## The assets

Both files are compact UTF-8 JSON with the keys in the listed order (`v`, `q`, then the data
members) and a trailing LF (T24 §5.12). Coordinates are integers x = round(lon · 100) and
y = round(lat · 100), rounded half away from zero; the basemap's latitudes are clamped to ±85.0511.

- **`basemap.json`** (Natural Earth 110m Admin 0, 177 features): `countries` (a2, a3, English name,
  polygons; each polygon an outer ring counter-clockwise and its holes clockwise, as delta arrays),
  `coast` and `border` polylines. An edge shared by two features is drawn once as border; the
  ±85.0511 closures and the ±180° seams are never stroked.
- **`gazetteer.json`**: `country` (238 rows), `region` (4 408 rows, ISO 3166-2), `iata` (3 245
  rows: large and medium airports with scheduled service) and `cloud` (134 rows: aws 34, gcp 43,
  azure 57). A code may repeat (60 region codes have two or more Natural Earth rows): such a
  lookup is `sharedCode`, not a guess.

Sizes: 138 106 and 260 498 bytes raw; 31 441 and 91 909 bytes brotli, inside the `geoBasemap`
(40 000) and `geoGazetteer` (104 000) budgets of `ci:bundle-size`
([bundle budgets](../development/build-and-ci.md#bundle-budgets)).

### Cloud regions

`tools/geo/cloud-regions.csv` holds 134 regions (aws 34, gcp 43, azure 57), sorted by provider and
id, as of the date on its first line (`# as of 2026-11-26`). It was reconciled on that date with
each provider's published public-cloud region list, named by title in each record's `source`:

| Provider | Published list (`source`) | Date the page shows | Included |
|---|---|---|---|
| aws | AWS Regions - AWS Regions and Availability Zones | none | every row of "Available AWS Regions" (opt-in regions included) |
| gcp | Regions and zones - Compute Engine | 2026-11-25 | every region with zones |
| azure | List of Azure Regions - Microsoft Learn | 2026-10-13 | every row, restricted-access regions included (`australiacentral2`, `brazilsoutheast`, `francesouth`, `germanynorth`, `norwaywest`, `southafricawest`, `switzerlandwest`, `uaecentral`): they are deployable sites whose ids telemetry carries |

`client/src/vis/geo/fixtures/cloud-inventory.json` is the same dated id list, and
`unit:geo-assets` checks the gazetteer against it exactly. **Excluded:**

- preview and announced regions: azure `saudiarabiaeast`, `southeastasia3`, `taiwannorth`; aws
  `me-west-1` and `sa-west-1`, which SDK endpoint data names but the AWS list does not;
- ids that are not on the published list: azure `jioindiacentral`, `jioindiawest`;
- the government, sovereign and China partitions: aws GovCloud (`us-gov-*`), ISO (`us-iso*`),
  China (`cn-*`) and the European Sovereign Cloud (`eusc-*`); azure Government (`usgov*`,
  `usdod*`) and China (`china*`); gcp sovereign and partner-operated clouds.

An unlisted id resolves to `unknownCode`. A region added later needs a new dated reconciliation
([refreshing the data](supply-chain.md#geo-data)).

**Places.** `place` is the provider's published location, in the provider's spelling (`Sao Paulo
State`, `Queretaro`, `Tokyo, Saitama`). Where the provider gives only a country, `place` is a
**curated choice**, not a provider statement: aws `eu-west-1` Dublin, `ap-southeast-5` Malaysia,
`ap-southeast-6` New Zealand, `ap-southeast-7` Thailand, `ca-central-1` Canada (Central),
`eu-south-2` Spain, `me-central-1` UAE, `mx-central-1` Mexico (Central); azure `westeurope`
Amsterdam. Where the provider gives a state or a country (azure `eastus` Virginia, `norwayeast`
Norway), that is the place, and the position below is curated.

**Positions.** The position is the Natural Earth populated place `ne_id`. Where the published
location is not one (a state, a country, a campus, another spelling), it is a curated populated
place in the same country, the named city where there is one, else the nearest:

| Region | Place | Natural Earth place used |
|---|---|---|
| aws `us-east-1`; gcp `us-east4` | N. Virginia; Ashburn | Alexandria |
| aws `us-west-2`; `us-east-2`; `us-west-1` | Oregon; Ohio; N. California | Richland; Columbus; San Jose |
| aws `ca-central-1`; `eu-south-2`; `mx-central-1` | Canada (Central); Spain; Mexico (Central) | Montréal; Zaragoza; Querétaro |
| aws `ap-southeast-5`, `-6`, `-7` | Malaysia; New Zealand; Thailand | Kuala Lumpur; Auckland; Bangkok |
| aws `me-central-1`; `me-south-1` | UAE; Bahrain | Abu Dhabi; Manama |
| gcp `asia-east1`; `asia-south2` | Changhua County; Delhi | Changhua; New Delhi |
| gcp `asia-southeast1`; `southamerica-east1` | Jurong West; Osasco | Singapore; São Paulo |
| gcp `europe-north1`; `europe-west1`; `europe-west4` | Hamina; St. Ghislain; Eemshaven | Kouvola; Mons; Groningen |
| gcp `us-east1`; `us-west1` | Moncks Corner; The Dalles | Charleston; Vancouver (WA) |
| azure `eastus`; `eastus2` | Virginia | Roanoke; Durham |
| azure `centralus`; `northcentralus`; `southcentralus` | Iowa; Illinois; Texas | Des Moines; Chicago; San Antonio |
| azure `westus`; `westus2`; `westcentralus` | California; Washington; Wyoming | San Francisco; Wenatchee; Cheyenne |
| azure `australiaeast`; `australiasoutheast` | New South Wales; Victoria | Sydney; Melbourne |
| azure `brazilsouth`; `brazilsoutheast` | Sao Paulo State; Rio | São Paulo; Rio de Janeiro |
| azure `northeurope`; `norwayeast`; `norwaywest`; `israelcentral` | Ireland; Norway; Norway; Israel | Dublin; Oslo; Stavanger; Tel Aviv |

Spelling-only differences (Osaka and Ōsaka, Zurich and Zürich, Quebec and Québec, Copenhagen and
København, Queretaro and Querétaro) are not listed.

## Validation (T24-087)

`decodeBasemap` and `decodeGazetteer` validate the whole asset and return null on the first
violation; they never throw and never return part of an asset:

- exactly the §5.12 top-level keys; integer `v` 1 and `q` 100; every field's type and pattern
  (a2 `[A-Z]{2}` or `-99` and a3 `[A-Z]{3}` or `-99` in the basemap; region codes
  `[A-Z]{2}-[A-Z0-9]{1,3}`, IATA `[A-Z]{3}`, providers `[a-z][a-z0-9]{1,15}`, ids `[a-z0-9-]{1,40}`);
  names 1–100 code points; exact gazetteer row lengths;
- integers only, |x| ≤ 18000, |y| ≤ 8505 (basemap) or 9000 (gazetteer);
- even delta arrays; each ring ≥ 3 distinct points with no repeated consecutive point (the closing
  edge included); outer area > 0, hole area < 0; no empty polygon list;
- holes, exact on the integers: every hole vertex strictly inside its outer (a point on the boundary
  fails); no hole edge sharing any point with an outer edge or another hole's edge (crossing,
  touching or collinear overlap); no hole inside another;
- ring edges |Δx| ≤ 18000, except a polar closure (both ends on the same y = ±8505); polylines
  ≥ 2 points, no repeated consecutive point, |Δx| ≤ 18000.

The decoded basemap holds absolute interleaved `Int32Array` rings and polylines; the gazetteer holds
frozen rows in file order and six indexes (`countryByA2`, `countryByA3`, `countryByName` keyed by
the NFC lower-cased name, `regionByCode`, `iataByCode`, `cloudById`), each value in file order.

## Loading (`loadGeoData`)

```ts
loadGeoData(): Promise<GeoData>   // { basemap: Basemap | null; gazetteer: Gazetteer | null }
geoLoader(get, { basemap, gazetteer }): () => Promise<GeoData>   // the same over any fetch, for tests
```

The first call fetches both assets in parallel from the same origin (`fetch(url, { cache:
'force-cache' })`); every later call on the page returns that same promise and makes no request.
The promise never rejects. An asset whose GET fails or is not `ok`, whose body is not JSON, or that
does not validate is null, and one `console.debug` line `geo-data: basemap.json unavailable` (or
`gazetteer.json`) names it; the other asset is unaffected. There is no retry and no cancellation
(the request is shared): a failed asset stays null until the page reloads (T24 §9). With a null
basemap the frame (E2) shows "Map data unavailable"; with a null gazetteer every lookup is
`gazetteerUnavailable`, while coordinates and geohashes still place.

The asset files are content-hashed by the build: `urls.ts` imports both with `?url` and is the
`geo-assets` input of `vite.config.ts`, so the build emits `assets/basemap-<hash>.json` and
`assets/gazetteer-<hash>.json` and the signed asset manifest
([ADR-0016](../../designs/adr/0016-asset-integrity-verified-by-bff.md)) lists them. Until a route
imports `urls.ts` its entry chunk is empty and the initial JS is unchanged. No label leaves the
browser: the data is public and same-origin (T24 §8).

## How the assets are built

`tools/geo/build.py` (Python standard library only) builds both assets from five pinned public
domain sources and the tracked `tools/geo/cloud-regions.csv`; the sources, their digests and the
refresh procedure are in [the supply chain page](supply-chain.md#geo-data), and the make targets in
[Build, test and CI](../development/build-and-ci.md#geo-data). In outline (T24-085, T24-086):

- **Gazetteer.** Countries from Natural Earth 10m Admin 0 (`ISO_A2_EH`, `ISO_A3_EH`, `NAME_EN`,
  `LABEL_X`/`LABEL_Y`; a `-99` code drops the feature; of several features with one alpha-2 code
  the one whose `ADM0_A3` equals its alpha-3 code, if exactly one does, else all). Regions from
  Admin 1 (`iso_3166_2`; name `name_en`, else `name`, else the code; codes outside the pattern
  dropped). Airports from OurAirports (`large_airport` or `medium_airport`, scheduled service,
  `iata_code` `[A-Z]{3}`; place `municipality`, else `name`, else the code). Cloud rows joined on
  `ne_id` with Natural Earth populated places; an unknown `ne_id` or an `iso_a2` other than the
  place's fails the build.
- **Basemap.** Shapefile rings (outer clockwise; a hole joins the outer holding its first vertex).
  Assertions: no edge over 180° of longitude except a polar closure; vertices at |lat| ≥ 85.0511
  only in Antarctica. Then clamp, quantise and remove consecutive duplicates; a ring that collapses
  (fewer than 3 distinct points or zero area) is dropped and written to `tools/geo/report.txt`
  (today: one PRK sliver), unless it is its feature's largest polygon or covers ≥ 10⁻⁴ deg², which
  fails the build. Rings are oriented, rotated to their smallest point and checked with the hole
  predicate above; the strokes follow.

A build error prints `geo-build: ‹message›` (for example `PPP: hole not strictly inside its outer
ring`) and exits 2; `--check` exits 1 naming each file that differs from the rebuild.

## Tests

| Gate | Where | What |
|---|---|---|
| `unit:geo-locate` | `src/vis/geo/locate.test.ts` | the T24 §10.3 fixtures L, C, E and G0, coordinate aliases X1–X3, row identity, the normal form, 500 random label maps |
| `unit:geo-geohash` | `src/vis/geo/geohash.test.ts` | cell centres and sizes; `''`, 13 characters and `u4pa` are null |
| `unit:geo-decode` | `src/vis/geo/assets.test.ts` | the build fixtures decode (round trip); M1–M15, the ×100 hole cases and G1–G8 are null |
| `unit:geo-assets` | same | the bundled assets decode, the counts, the cloud inventory and exclusions, Dublin, St. Ghislain and Amsterdam, the manifest digests |
| `unit:geo-load` | same | one shared promise, two `force-cache` requests, a failed asset nulls only itself with one debug line |
| `unit:geo-build`, `unit:geo-gazetteer-build` | `tools/geo/test_build.py` (`make geo-test`) | the exact build outputs and errors of T24 §10.3, assembly, the gazetteer rules, digests before parsing, `--check`, the fixtures, the notices |
| `ci:geo-data` | `scripts/check-geo-data.ts` (`make geo-data`) | the committed assets match `tools/geo/manifest.json` and decode |

The client build fixtures under `src/vis/geo/fixtures/build/` are written by `build.py --fixtures`
from `tools/geo/fixtures/basemap-cases.json`; `unit:geo-build` checks they are current.

# Geomap data and location resolution

The geomap's data layer (issue #231, part E step 1a of
[T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md)): how a series' labels
resolve to a place, the two bundled offline assets (a world basemap and a gazetteer), how they are
validated and loaded, and what they cover. It implements
[VIZ-045](../../designs/product/05-visualisation-catalogue.md) and the bundled offline data of
VIZ-046, by the rules T24-080 to T24-087. The map frame that draws them comes in E2 (#234): its
first part adds the rows, the table, the CSV, the facts and the Inspector targets
([below](#the-map-frames-rows-234-part-1)); its second part draws them in the Canvas 2D engine, with
the camera, the input and the marks ([below](#the-map-in-the-canvas-2d-engine-234-part-2)); its
third part is the panel itself on a board: the host, the states, the mark list, the legend, the
table and the Inspector ([below](#the-map-panel-234-part-3)).

The modules live in `client/src/vis/geo/`. The data layer (step 1a: `aliases.ts` to `assets.ts`)
imports nothing outside the directory except types. The map frame's modules (#234 Part 1) do:
`frame.ts` imports `data/frames` (`seriesName`), `vis/reduce` (the merge, the reducer, the cap and
the T22-004 disambiguator), `vis/thresholds`, `engine/canvas2d/seriesColour`, `engine/patterns` and
`i18n/t`; `rows.ts` imports `vis/reduce` (`panelCsv`, `focusOf`, `largestChange`) and
`i18n/format`; `targets.ts` imports only `i18n/t` at run time (its imports of `frame.ts` are
types).

| Module | What it holds |
|---|---|
| `aliases.ts` | `normKey`, the alias lists, `HINT_KEY`, `GEO_AUTO_RULES` and `GEO_ALIAS_KEYS` (no imports) |
| `geohash.ts` | `decodeGeohash` (no imports) |
| `locate.ts` | `locate` and its types `GeoSource`, `GeoPlace`, `LocationResult`, `LocationOption` |
| `types.ts` | `Basemap`, `BasemapCountry`, `Gazetteer` and its rows, `GeoData` |
| `decode.ts` | `decodeBasemap`, `decodeGazetteer` (type-only imports, so `ci:geo-data` runs it in Node) |
| `urls.ts` | `basemapUrl`, `gazetteerUrl`: the assets imported with `?url` (the `geo-assets` build input, which nothing imports) |
| `assets.ts` | `geoLoader`, `loadGeoData` (it imports the two `?url` assets itself, so the `geo-assets` entry stays standalone; #234 Part 3); re-exports the decoders |
| `frame.ts` | the map frame's rows (#234 Part 1): `geoRowSet`, `validateGeoRows`, `geoFrame`, `finalLabels`, `valueStatusOf` and their types |
| `rows.ts` | `geoTable`, `geoCsv`, `geoFacts` |
| `targets.ts` | `geoTarget`, `geoPlace`, `locationDetail`, `resolveGeoMembers`, `seedOf`, `worstState`, `seedOrdered` (type-only imports of `frame.ts`, so the shared Inspector can take it alone) |
| `plan.ts` | `planGeo`, `geoSpec`, `GeoMapFrameProps`, `GeoPlan` (#234 Part 3) |
| `fixtures/series.ts` | the T24 §10.4 and §10.5 fixtures as series (G, H, O, X, Cap, …) and gazetteer T, for the tests |
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

Sizes: 138 106 and 260 490 bytes raw; 31 441 and 91 842 bytes brotli, inside the `geoBasemap`
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

**Places.** `place` is the provider's published location in the provider's spelling (`St.
Ghislain`, `Queretaro`, `Tokyo, Saitama`) where that is a city or a campus. Where the provider gives
only a country or a state, `place` is a **curated city**, not a provider statement: the provider's
metro where it is known, else the obvious data-centre metro, always a Natural Earth populated place,
so the name and the position agree. `unit:geo-assets` fails if any place is a bare country or a US
or Australian state name (Hong Kong and Singapore are cities too). The curated choices:

| Region | Provider location | Curated city (and position) |
|---|---|---|
| aws `us-east-1` | N. Virginia | Alexandria (the Ashburn area; Natural Earth has no Ashburn) |
| aws `us-east-2`; `us-west-1` | Ohio; N. California | Columbus; San Jose |
| aws `us-west-2` | Oregon | Pendleton (the nearest Oregon place to the Boardman campus) |
| aws `ca-central-1`; `mx-central-1` | Canada; Mexico | Montréal; Querétaro |
| aws `ap-southeast-5`, `-6`, `-7` | Malaysia; New Zealand; Thailand | Kuala Lumpur; Auckland; Bangkok |
| aws `eu-west-1`; `eu-south-2` | Ireland; Spain | Dublin; Zaragoza (Aragón) |
| aws `me-central-1`; `me-south-1` | United Arab Emirates; Bahrain | Abu Dhabi; Manama |
| azure `eastus`; `eastus2` | Virginia | Roanoke (at the provider's published coordinates); Danville (the nearest Virginia place to the Boydton campus) |
| azure `centralus`; `northcentralus`; `southcentralus` | Iowa; Illinois; Texas | Des Moines; Chicago; San Antonio |
| azure `westus`; `westus2`; `westcentralus` | California; Washington; Wyoming | San Francisco; Wenatchee (by the Quincy campus); Cheyenne |
| azure `australiaeast`; `australiasoutheast` | New South Wales; Victoria | Sydney; Melbourne |
| azure `brazilsouth`; `mexicocentral` | Sao Paulo State; Querétaro State | São Paulo; Querétaro |
| azure `northeurope`; `westeurope` | Ireland; Netherlands | Dublin; Amsterdam |
| azure `norwayeast`; `norwaywest`; `israelcentral` | Norway; Norway; Israel | Oslo; Stavanger; Tel Aviv |

**Positions.** For every other region the position is the Natural Earth populated place `ne_id` of
the published location; where that location is not one (a campus or a district), it is a curated
populated place in the same country, the named city where there is one, else the nearest:

| Region | Place | Natural Earth place used |
|---|---|---|
| gcp `us-east4` | Ashburn | Alexandria |
| gcp `asia-east1`; `asia-south2` | Changhua County; Delhi | Changhua; New Delhi |
| gcp `asia-southeast1`; `southamerica-east1` | Jurong West; Osasco | Singapore; São Paulo |
| gcp `europe-north1`; `europe-west1`; `europe-west4` | Hamina; St. Ghislain; Eemshaven | Kouvola; Mons; Groningen |
| gcp `us-east1`; `us-west1` | Moncks Corner; The Dalles | Charleston; Vancouver (WA) |
| azure `brazilsoutheast`; `japaneast` | Rio; Tokyo, Saitama | Rio de Janeiro; Tokyo |

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

## The map frame's rows (#234 Part 1)

```ts
geoRowSet(series, source: 'instant' | 'range', o: GeomapOptions, th: Thresholds | null,
  g: Gazetteer | null, q: Completeness): GeoRowSet
validateGeoRows(s: GeoRowSet, th: Thresholds | null): FrameDataIssue | null
geoFrame(s: GeoRowSet, b: Basemap, seq: number): GeoFrame
```

`geoRowSet` makes one `GeoRow` per series (T24-089). It merges duplicate series first (T22-003: an
instant result keeps the max on a tie and counts a conflict), then sorts by key in UTF-16 code
units, so the same series in any order give the same row set. Each row has:

- **`value`**: an instant result's one sample, or a range result reduced by `o.reducer`;
- **`valueStatus`** (T21-012): `noValue` (NaN), `infinite` (±Infinity), `outOfRange` (not 0, and
  smaller than 1e−290 or larger than 1e290 in size) or `ok`;
- **`state`**: null without thresholds; with them `unknown` for a value that is not `ok`, else the
  threshold state (`vis/thresholds.ts`);
- **`location`**: `locate(labels, o.location, g)` ([above](#resolving-a-location-locate));
- **`draw`**, the first that holds (zoom-independent):

| Draw status | When | Example (T24 §10.4 fixture G) |
|---|---|---|
| `notPlaced` | the location is not `placed` | `cloud_region=mars-north-1` (unknown code) |
| `outsideMap` | placed, but \|lat\| > 85.0511 | `lat=-89.9 lon=0` |
| `excluded` | placed on the map, but the value is not `ok` (the row is in the table and the meter only) | `lat=10 lon=10` with no value |
| `capped` | left out by the cap: above 5 000 drawable rows, `capMarks` keeps the max, the min, the worst state's rows (up to 500) and then the rest in key order (T22-006) | the Cap fixture's `c4999`–`c5001` |
| `shown` | drawn | `cloud_region=eu-west-1` (Dublin) |

`geoFrame(s, basemap, seq)` adds `shown`, the indices of the `shown` rows.

**Groups and labels (T24-090).** A row's group id is `{series: key}` without `groupBy`, else
`{present: true, value}` or `{present: false}` (the label is absent). Groups are numbered by first
appearance in key order. With 8 or more ids, ids 0–6 keep their own group and the rest join one
aggregate, group 7: id `{other: true}`, label `other (n)` (n = its member groups), pattern `grid`,
colour `category-other` (`colourIndex` null), with `members` (the ids) and `memberLabels` (their
final labels) in first-appearance order; an aggregated row keeps its own id. One group has the
`solid` pattern; several have `CATEGORY_PATTERNS[j]`. The colour is `seriesColourIndex` without
`groupBy`, else j mod 8. Labels:

- a series group: the series name (`{cloud_region="eu-west-1"}`);
- a present value: plain (`prod`), or `JSON.stringify` when it starts with `"`, equals `other` or
  `‹L› absent`, ends with ` (‹digits›)` or holds a control character (`"other (2)"`);
- an absent label: `‹L› absent` (`env absent`).

`finalLabels` then runs over every group and member label together: labels with the same base get
T22-004's distinguishing parts (`{lat="1", lon="2"} · __name__ absent`), and a label still shared,
or equal to the aggregate's, gets ` (n)`, n from 1 in key order, skipping labels in use. The
aggregate is never suffixed. So labels never collide.

**Coverage (T24 §4.11).** Counted before the cap: `total` (the drawable rows: `shown` or `capped`),
`drawn` (`shown`), what the cap kept, the worst state of the drawable rows and how many of them
were capped, the merge counts, the run's completeness and `geo`: `notPlaced` (not placed, ambiguous
and `gazetteerUnavailable` apart), `ambiguous`, `locationsUnavailable`, `outsideMap`, `noValue`,
`infinite` and `outOfRange`. The meter reads, for fixture G with a truncated run and two warnings:
`truncated · limited (2 warnings) · 3 not placed · 1 ambiguous · 1 outside the map · 4 without a
usable value (2 missing, 1 infinite, 1 out of range) · 1 duplicate series combined; 1 conflicts (max
kept)`.

**Validation.** `validateGeoRows` returns the first failing check as `{code: 'geo', detail}`, in
this order: `order` (keys non-empty and strictly increasing), `value`, `state` (against the
panel's thresholds), `draw` (recomputed with the cap), `group` (indices, ids, patterns, colours and
the aggregate's members) and `coverage` (every count recounted). A chart shows it as "Invalid map
data (‹detail›)".

**Table and CSV (T24-094, §4.14).** `geoTable(s, unit)` has one row per `GeoRow`, ordered by name
then key, with the columns `name, key, value, value_status, state, location_status,
location_detail, source, code, provider, place, lat, lon, group, group_member, draw_status`. The
cells are raw: `value` is `String(v)` (NaN empty, `Infinity`, `5e-300`); `location_detail` is
`‹reason› ‹key›` (invalid), `‹source› ‹key›=‹value›` (unknown code), `‹provider›: c1; c2` (provider
mismatch) or `‹reason›: c1; c2` (ambiguous); `place` is `geoPlace`; `group` is the drawn group's
label (`other (n)` for an aggregate member) and `group_member` the member's own label. `geoCsv` is
the same through `panelCsv`: RFC 4180, CRLF, every cell through `csvCell`, so a place `-89.9000,
0.0000` becomes `"'-89.9000, 0.0000"` while a number such as `-30` stays as it is.

**Facts (T22-014).** `geoFacts(title, s, series, instant, unit)` reads the rows with an `ok` value
(before the cap, any draw status): the focus is the worst state, then the higher value, then the
lower key; `current` its value and name, `change` (a range result) its series' largest step,
`extent` the min and max, `baselineRatio` null. With no `ok` value it is null.

**Inspector targets (T24-092, §4.13).** `geoTarget(s, frameSeq, ref)` builds a snapshot, so a
refetch never changes an open one: a `marker` (its row, no members), a `cluster`
(`cluster:‹seed›`, "Cluster of n", the keys' rows and one member per row), the `aggregate`
(`other:geo`, its rows and one member per member group with its label and label map) or a `group`
of an aggregate's entry (`group:` + the id as JSON, built from that target's snapshot only).
Every target carries the row set it came from (`set`). `geoPlace(row)` is the gazetteer's name,
else `lat, lon` to 4 places, else `''`.

## The map in the Canvas 2D engine (#234 Part 2)

The Canvas 2D engine draws a `geomap` spec ([ADR-0027](../../designs/adr/0027-geomap-frame-seam.md),
T24-090, T24-091). The work splits by what depends on the renderer, so the GPU engine can take the
kind later by reusing the first half and replacing the painter
([ADR-0031](../../designs/adr/0031-gpu-engine-default-renderer.md)):

| Module | What it holds |
|---|---|
| `engine/controller/inertia.ts` | `spring`, `releaseVelocity`: the T02-022 spring, shared |
| `engine/controller/geo/project.ts` | `normLon`, `uOf`, `vOf`, `lonOf`, `latOf`, `worldPx`: one Web Mercator world |
| `engine/controller/geo/camera.ts` | `zoomRange`, `insetOf`, `contain`, `fitView`, `fitBox`, `zoomAbout`, `panPx`, `boundsOf`, `toPx`, `fromPx` |
| `engine/controller/geo/marks.ts` | `radiiOf`, `levelMarks` (clusters), `drawOrder`, `keyboardOrder`, `placeLabels` |
| `engine/controller/geo/pick.ts` | `placeMarks`, `pickMark`, `marksInBox` |
| `engine/controller/geo/controller.ts` | `GeoController`: the listeners, gestures, wheel, keys, eases, inertia, ownership and commits |
| `engine/canvas2d/geo/basemap.ts`, `paint.ts`, `patterns.ts` | the painter: basemap, marks, patterns, glyphs, labels, rings, bands |
| `engine/canvas2d/geo/scene.ts` | `createGeoScene`, the dynamic entry: the controller and the painter, the geo events and the summary |

The `controller/geo/` modules import no renderer. Nothing geo is in the board route's static
closure: `Canvas2DFrame` imports `geo/scene.ts` on its first `geomap` spec (`loadGeoModule`), and
the scene's chunk holds the rest. How the frame loads, guards and replays the scene is in
[the engine page](engine.md#the-geomap-on-canvas-2d-234-part-2).

### The camera

A view is `{lat, lon, zoom}` (`GeoView`). The engine owns it; the host only persists what the
engine commits.

- **One world.** A longitude is normalised to [−180, 180); u = (lon + 180)/360 and v = ½ −
  ln((1 + sin φ)/(1 − sin φ))/(4π). The world is 256·2^z CSS px square; the plot is the whole canvas.
  The map never repeats across ±180°, and the bounds never wrap.
- **Zoom range.** zMin = log2(max(W, H)/256), clamped to [0, 14]; zMax = 14. A view below zMin is
  raised to it, so the world always fills the plot's longer side.
- **Containment.** Per axis: a world at least as large as the plot keeps its edges outside the
  plot; a smaller one is centred and letterboxed (`surface-1` around `map-water`). Every move ends
  contained, so a pan stops at the world's edge: at fixture G's fit the east edge is 135.84 px
  from the centre, so Shift+→ moves only that far.
- **Fit** (the view is null): the box of the `shown` rows with the inset p = min(48, 10 % of the
  shorter side), z the smaller of the two axes' fits, clamped to [zMin, max(6, zMin)]. With no
  shown row the view is (20, 0, zMin). G on 1024 × 512 fits at (33.3885, 31.9970, 2.6219).
- **Wheel** (`wheelZoom: true`): a vertical wheel zooms by Δz = −log2(factor) about the pointer,
  which stays on the same place unless containment shifts the view; a horizontal wheel pans by its
  fraction of the width. With `wheelZoom: false` the page scrolls. A wheel commits `wheel` after
  300 ms idle; a page scroll already in progress keeps scrolling.
- **Drag** pans with the pointer. A release faster than 0.3 px/ms (the displacement over the last
  80 ms) continues on the T02-022 spring with the release velocity: it lands 2v/ω px further (103
  px at 1 px/ms), never overshoots, and settles at about 267 ms, then commits `pan` once. A slower
  release commits at once.
- **Right drag** draws the box band and fits the box exactly on release (`box`); the browser menu
  is suppressed. **Alt+drag** draws the brush band and sends `geoBrush` with the sorted keys of the
  marks whose centres it holds.
- **Click** sends `select` with the mark under the pointer, or null. **Hover** sends a geo hover
  with the mark and its centre, or null once. **Double-click** on a cluster fits its members; else
  it zooms ×2 about the pointer (`dblclick`).
- **Keys** on the key target only (not from its children, no Ctrl, ⌘ or Alt): `+`/`=` zoom in, `-`
  out, about the focus mark (`setFocusMark`) when its centre is in view, else the centre; `0` fits;
  Shift+arrows pan 25 % of the plot. They are prevented and still propagate. `cameraKey(k)` does
  the same for the mark list. A key that moves the view commits once (`keys`, or `fit` for `0`), at
  the end of its ease. A key sent while the map is still loading, or before it has a size, does
  nothing: keys act on the map shown and are not queued (the scene loads in milliseconds).
- **Eases and reduced motion.** Keys, fit, box, double-click and a changed `spec.view` ease 200 ms
  (ease-out cubic; a zoom re-anchors every frame). With `motion: 'cut'` (set by the host under
  reduced motion) they land at once, and a fling lands at its end offset at once. A new
  pointer-down, wheel or camera key first stops a running ease or fling where it is: a stopped
  fling or user ease commits what moved; a stopped `spec.view` ease commits nothing.
- **Ownership.** Only a `spec.view` that changed by more than 1e−9 and differs from the camera
  moves it (an ease, no commit). A view set back to null refits at once. While the view is null and
  nothing was committed, new data and resizes refit. A title, colour or size change keeps the
  camera; a resize raises the zoom to zMin and contains it.

The summary's `geo` is the committed view and its bounds, the level, and the mark and cluster
counts. Events: `geoCommit {view, bounds, gesture}` once per gesture that moved the view. A gesture
that leaves the view where it began (a zoom in at 14, a pan held by containment, `0` at the fit, an
ease stopped before its first frame) commits nothing, and a data-following camera keeps following.

### Marks

- **Sizes** (T24-090). With two or more groups (patterned) a marker is at least 8 px:
  min′ = max(min, 8), max′ = max(max, min′); one group keeps min and max. With `size.by: 'value'`
  r = max(min′, max′·√(|v|/M)), M the largest |v| shown (M = 0 → min′); `fixed` → max′. G's
  default sizes run from 20 (k07, 300 ms) down to 8.
- **Clusters and levels.** The level is Z = ⌊zoom⌋. Seeds in seed order (worst state, then the
  larger |v|, then the key) take the unassigned shown rows within 40 world px at Z; two or more
  make a cluster `cluster:‹seed key›` at the seed, a `surface-2` disc of r 14, 16, 18 or 20 (fewer
  than 10, 100, 1 000 rows, more) with its count and, when its worst state is watch or worse, that
  state's chip. `cluster: false` joins only rows at the same position. The marks of a level are
  cached under the level, the data, `size`, `cluster` and the group count; G at fit (Z 2) has
  `cluster:k03` (5 rows), `cluster:k07` (2), k05, k14 and k06.
- **Orders** (T24 §4.11). Drawn bottom to top by (−r, rank, |v|, id), a cluster taking its
  members' worst rank and largest |v|; the mark list's keyboard order is (y, x, id) of the centres.
  rank is failing 4, degraded 3, watch 2, else 0; strings compare by UTF-16 code units.
- **Pick.** The last mark in draw order whose disc of radius max(r + 4, 12) holds the pointer.
- **Crossfade.** A level change fades the old marks out and the new in over 150 ms; only the new
  marks are pickable. `motion: 'cut'` draws none.
- **Labels.** With `labels: 'auto'` and at most 50 marks, marker names go right of their marks,
  greedily in seed order, skipping any that would overlap another or leave the plot.
- **Fill and state.** A marker is a circle, square, triangle or diamond of the same area. Its fill
  is its group's colour (`series-‹n›`; aggregate members `category-other`), with its group's
  pattern over it in `pattern-ink` when patterned. With thresholds, `colour: 'group'` adds a 2 px
  outline in the state colour and the state glyph; `colour: 'state'` fills with the state colour,
  the pattern over it and the glyph. The glyph sits inside at r ≥ 8 and on a `surface-2` chip at
  the upper right below that, so state is never colour alone.
- **Selection** (T24-092). When a selected key is among the loaded rows (shown or not), the shown
  marks without one are drawn at `dimmed` and the marks with one get a 2 px `focus` ring; only
  foreign keys dim nothing. The focus mark has its own 2 px ring 3 px outside the mark.
- **`geoMarks`** `{level, marks}`: every mark of the level in keyboard order with its id, kind,
  keys and whether its centre is in the plot. It goes out right after each commit (one per commit,
  also for a wheel commit at idle with no draw pending), on the first draw, on new data and on a
  level change, and after any other draw only when that payload changed.

**Limits.** At most 5 000 drawn rows (the cap above); no wrap across ±180° (a Pacific view ends at
the world's edge); no spiderfying of a cluster at zoom 14.

## The map panel (#234 Part 3)

A board panel of kind `geomap` is drawn by the map host. Its modules:

| Module | What it holds |
|---|---|
| `pages/board/GeoMapBody.tsx` | the panel body in the board route: the lazy host inside a panel-local error boundary, and the load-failure state |
| `charts/GeoMapFrame.tsx` (+ `.module.css`) | the host, a dynamic entry (default export): the plan, the view hand-off, the events, the states, the list, legend, meter and table |
| `charts/geo/GeoMarkList.tsx` | the hidden keyboard mark list and `geoMarkName` |
| `charts/geo/GeoLegend.tsx` | the legend buttons (two groups or more) |
| `charts/geo/geoText.ts` | the state texts; re-exports `drawStatusText` and `valueStatusText` |
| `inspector/geoModel.ts` | the Inspector model of the four geo targets, `drawStatusText`, `valueStatusText` |
| `kit/announce.ts` | `usePoliteAnnouncer()`: one polite live region, at most one write per 500 ms, the latest text wins (T08-018) |

### Routing

`panelView` ([boards](boards.md#panel-states-panelview)) gives a geomap panel `{kind: 'geomap'}`
after the blocked rows (an empty query, a missing variable, a refusal), or `notMetric` for a LogQL
log answer; the host renders loading and errors itself. `framePlan('geomap')` returns the notice
`geomap` and no spec. `PanelFrame` renders `GeoMapBody` with `geomapOptions(panel.vis.options)`
(every option at its default when absent), the panel's thresholds, its run and its unit (`/s` after
the rate rewrite, else none); the panel's `data-panel-state` is `frame` and `data-panel-vis`
`geomap`. The panel editor lists **Map** with the other kinds and saves `{kind: 'geomap'}`; it has
no options fieldset yet, only Thresholds. The editor's preview passes `inspectorSource={false}`: it
never inspects or selects.

### The plan (`planGeo`, T24-088)

`planGeo(props, size, view, {seq, motion, staleAtMs})` returns the first state that holds:

| Order | Condition | State |
|---|---|---|
| 1 | the assets are loading, or the run has no answer and no error, or the run shows a placeholder while fetching | `loading` |
| 2 | the run failed and has no answer of its own (none, or a placeholder) | `error` |
| 3 | a string result (`{code: 'kind'}`), or `validateGeoRows` refuses the rows | `invalid` |
| 4 | no basemap | `mapDataUnavailable` |
| 5 | the plot is under 160 × 120 CSS px | `tooSmall` |
| 6 | no rows; no shown row | `empty`; `noneShown` |
| 7 | — | `ok` |

Only `empty`, `noneShown` and `ok` build a frame. A scalar result is one `SCALAR_KEY` series. A
refetch that fails on the same key keeps its rows, with `coverage.staleAtMs` set to when the
failure was first seen, so the meter ends with `· stale (HH:mm:ss)`. `PanelRun` gains `placeholder`
(TanStack's `isPlaceholderData`) and `retry()` (its `refetch()`). The host memoises the plan: the
rows and the frame are rebuilt only when the result, the options other than `view`, the
thresholds, the assets, the run's state, the size class, the motion or the stale time change, so a
selection, a commit or the start of a refetch never hands the engine new data. `seq` grows by one
per new row set.

### The host (`GeoMapFrame`)

- **Size and motion.** The body's content box, the caller's `sizeMemo` first so a re-mounted map
  plans at once; `motion` is `cut` under reduced motion.
- **View** (T24-088). The host keeps `lastView` (the latest `geoCommit`) and `applied` (the last
  applied `options.view`). An `options.view` that differs from `applied` by value (null included)
  becomes the spec's view once and clears `lastView`; otherwise the spec's view is
  `lastView ?? options.view`. A new engine frame (an engine swap) starts at that view.
- **Events.** `ChartFrame` creates the frame and keeps `select` and `hover`; through `onFrame` the
  host subscribes to exactly `geoCommit`, `geoBrush` and `geoMarks` and disposes them with the frame
  (`onFrame(null)` comes before `dispose`). A new frame gets the list's focus mark.
- **The surface.** `ChartFrame surface="geo"`: the host div is the plot surface, `tabIndex 0`,
  `role="application"`, `aria-roledescription="map"`, named by the title, and the engine's key
  target; the canvas is `aria-hidden`; no crosshair, threshold or event targets. A hover shows the
  tooltip beside the pointer: a marker's name, `value · state` and place; a cluster's
  `Cluster of n`, `worst ‹state›` and its first five names in seed order (`, +k more`). States
  show only with thresholds.
- **Load failure** (§4.4a). When the scene chunk fails for the live geomap, Canvas 2D emits one
  summary with `geo: null` (see [the engine](engine.md#the-geomap-on-canvas-2d-234-part-2)); the
  host's `onSummary` calls `onLoadFailed`.

### Selection and targets (T24-092)

| Gesture | Effect |
|---|---|
| a marker click, or Enter/Space on a list marker | a `marker` target; the selection is its key |
| a cluster click, or Enter/Space on a list cluster | a `cluster` target with its keys; no filter |
| a legend entry (two groups or more) | selects the group's keys (`member`) only |
| the legend's `other (n)` | an `aggregate` target; the selection is its rows' keys |
| Alt+drag (`geoBrush`) | selects the covered keys (`brush`); an empty brush changes nothing |
| a click on no mark | clears the selection |
| a table row's toggle | selects that row (`tableRow`), or clears when it is selected |
| a table row's Inspect | a `marker` target of any row, drawn or not |

Targets are snapshots (`geoTarget`): a refetch never changes an open one. A selected row that is
not drawn reads its draw status in the table ("Not placed"). The editor preview neither inspects
nor selects.

### The mark list (T24-093)

A visually hidden `<ul aria-label="‹title›: map marks">` holds one button per mark in view, in the
engine's keyboard order (centres by y, then x), with one roving tab stop. Each item has
`aria-posinset` and `aria-setsize` (the count only when the meter reads `100 %` and every mark is
in view, else −1). Names:

- a marker: `‹name›, ‹value›[, ‹state›], ‹place›[, selected]`;
- a cluster: `Cluster of ‹n›, near ‹seed place›[, worst ‹state›][, ‹k› selected]`.

| Key on a list item | Action |
|---|---|
| ↑ ← / ↓ → | the previous / next mark |
| Home / End | the first / last mark |
| PageUp / PageDown | 10 back / on, clamped |
| Enter, Space | inspect; a keyboard inspect focuses the Inspector's heading |
| Shift+arrows | pan the map 25 % of the plot (`cameraKey`) |
| `+` `=` / `-` / `0` | zoom in, out (about the focused mark when it is in view), fit |
| anything else, Esc included | goes on to the page's Esc ladder |

The focused mark is the engine's focus mark (`setFocusMark`), cleared when focus leaves both the
list and the surface. With no mark in view the list holds one item, "No marks in view · Fit"
(Enter fits); while it is focused it stays when marks return, and ↓ → Home go to the first mark,
↑ ← End to the last. On new marks the active item is repaired: the same id, else the mark that
holds the old seed or key, else the old index clamped, else the placeholder. Focus moves only when
it was inside the list. A refetch that drops the focused mark announces "‹old name› is no longer
shown".

Tab order: the surface, the list, the legend's entries, the meter. Shift+T anywhere in the panel
(not in a text field) shows the table, and again the map. While there are no rows (loading, an
error, invalid data) the table is disabled: Shift+T does nothing and nothing is queued for later.

### The table

The table shows every row of the result in T24-094's order and columns (the same as the CSV,
[above](#the-map-frames-rows-234-part-1)). Each row starts with a 24 px `aria-pressed` toggle, "Select
‹name›" (T25-016), then the name, an Inspect button and, on a selected row that is not drawn, its
draw status. Export CSV downloads the CSV. "Show table" focuses the first toggle, else the grid.

### States (T24-095, T24 §4.12)

| State | The map cell | Focus target | Announced |
|---|---|---|---|
| loading | a busy status; "Loading…" after 300 ms | the status | — |
| error | "Couldn't load data" and Retry (`run.retry()`) | Retry | "Couldn't load data" |
| invalid | "Invalid map data (‹detail›)" | the status | the text |
| mapDataUnavailable | "Map data unavailable" and Show table | Show table | the text |
| tooSmall | "Too small to show a map: ‹N› series" and Show table | Show table | the text |
| empty | the basemap and "No series in this window" | that line | the text |
| noneShown | the basemap, "No series could be placed: ‹parts›" and Show table | that line | the text |
| ok | the marks, the list | the first item (or the placeholder), once the marks arrive | "‹n› marks" |
| a refetch that failed | the map kept; the meter `… · stale (HH:mm:ss)` | unchanged | "Couldn't refresh" |

Every state but `ok` has a `role="status"` region (`tabIndex=-1`) from its first render. Focus
moves to the new state's target, and the announcement follows, only when focus was inside the
panel at the moment of the move; focus in the board header or the Inspector stays there. That
holds for the delayed move to the first list item too: if focus leaves the panel before the engine
sends its marks, nothing moves and nothing is announced. The table follows the same rule: an
explicit open (Shift+T, Show table) focuses its first toggle and an explicit close returns focus to
Show table, else the map; a table that goes away or comes back with a state change (a new window)
moves no focus. When loading ends within 300 ms the
map comes back without an announcement. A state change never changes the selection or closes the
Inspector. The meter reads `loading` while loading and `unavailable` for an error or invalid data.

### The Inspector's geo targets

`InspectorTarget` gains `{type: 'geo', target}`. `inspectorModel` renders it through
`inspector/geoModel.ts` ([the Inspector](inspector.md#the-geo-target-234-part-3)): a marker's name,
place, value and facts with the T25 `mark` pivots over the origin window; a cluster, the
aggregate and a group with their spread and members and no pivots. A list of more than eight
members resolves its `geo:` run id from the open request's top view; no map instance registers
a resolver for it.

### Drilling down (#234 Part 4)

The members of a cluster, a group and the aggregate are buttons that open a deeper view inside the
same Inspector request (the [navigation stack](inspector.md#the-navigation-stack-234-part-4),
[T25 §4.8, §4.9](../../designs/technical/T25-inspector-and-pivots.md)):

| From | An entry opens | Its selection | Its title |
|---|---|---|---|
| a cluster or a group | the `marker` of that row | `[key]` | the row's name |
| the aggregate `other (n)` | the `group` of that entry (`geoTarget({kind: 'group', from, entry})`) | the group's keys | the entry's text |
| a marker | — (no members) | — | — |

- **Snapshots (T25-012).** Every view is built from the root target's row set (`target.set`), so a
  refresh that removes a row leaves the open views and their entries as they were, and Back shows
  them again. A marker view's pivots use the request's origin window.
- **Members past eight (T25-011).** Each view has its own "+k more": `resolveGeoMembers(top,
  'geo:' + top.id)` answers from the top view's own entries, so a board panel, its full screen and
  the editor preview resolve alike. Pushing or popping starts the next view with its first eight.
- **Back, the path and Esc (T25-007).** "Back to ‹previous›" and the path above the heading pop
  the stack; Esc pops one view before it clears the selection, then closes the Inspector (focus
  returns to the legend entry, list item or table row that opened it).
- **Levels (T25-008).** A view below the root is announced with its level:
  `Inspector: Level 2: e18, 12 series`, `Inspector: Level 3: ‹name›, 27 ms`. Each push and pop
  focuses the new heading and writes the live region once (at most once per 500 ms, the latest
  wins).
- **Races.** Two entry presses before the next render push only the first; a press on a closed or
  replaced request does nothing.

### Load failure (`GeoMapBody`)

`GeoMapBody` keeps an attempt count and one lazy host per attempt inside its own error boundary.
The host chunk's rejection (the boundary) and the scene chunk's (`onLoadFailed`) show one state in
the panel's error style, focused when focus was in the panel and read politely:

- attempt 0: "Map couldn't load" with **Retry**. Retry remounts the boundary, the lazy host and its
  chart frame, so both imports run again (Part 2's loader forgets a rejected scene import); no
  cache-busting URL.
- attempt 1 and later: "Map couldn't load. Reload the page to try again." with **Reload**
  (`location.reload()`), for an engine that keeps a failed module.

The other panels stay usable. `e2e:geomap-chunk` records which path each engine took; see
[the results](#chunk-failure-paths-by-engine).

### Chunk failure paths by engine

`e2e:geomap-chunk` aborts the host chunk (`GeoMapFrame-*.js`) or the scene chunk (`scene-*.js`)
once, then lets it load, and records which path ran (a test annotation and a `geomap-chunk` line in
the report). On 2026-11-27, against this build:

| Engine | Host chunk | Scene chunk |
|---|---|---|
| Chromium | Retry | Retry |
| Firefox | Retry | Retry |
| WebKit | Retry | Retry |

No engine kept the failed module, so Reload was not needed; the Reload path stays covered by
`unit:geo-render-failed` (d) and `unit:geo-chunk-failed` (b).

### The bundle rule (`geoInRoute`)

`npm run origins` runs `check-bundle-modules.ts`, which applies `geoInRoute` to both builds,
fail-closed like the Markdown rule: no module of `src/vis/geo/`, `src/engine/(canvas2d|controller)/geo/`,
`src/charts/geo/`, `GeoMapFrame` or `inspector/geoModel` may be in the static closure of
`index.html` or `src/pages/boards/BoardsPage.tsx`; the board route (`BoardPage.tsx`) may hold only
`vis/geo/targets.ts` and `inspector/geoModel.ts`. A missing root, an import the manifest lacks and
a closure chunk without a module list are findings. `src/charts/GeoMapFrame.tsx` and
`src/engine/canvas2d/geo/scene.ts` must be dynamic entries (`missing-geo-entry`), and both are in
`bundle-budgets.json`'s `required.lazyModules`.

### The gallery

The development and stub builds serve `/t/‹tenant›/dev/geo?page=` with `geomap-markers` (G),
`geomap-groups` (H), `geomap-states` (G against thresholds, coloured by group and by state),
`geomap-offline` (no rows at Dublin, zoom 6) and `geomap-bench` (Cap: 5 000 drawn), each map
1024 × 512 on the bundled basemap with gazetteer T. `golden:gallery` compares the first three in
dark, light and greyscale (the map surface), and the whole `geomap-groups` host with its legend
and coverage meter in the three themes; `bench:geomap-markers` pans and zooms the last for 10 s.

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
| `unit:geo-rows`, `unit:geo-identity` | `src/vis/geo/frame.test.ts` | fixture G's statuses with and without thresholds, each invalid set's detail, order independence; the groups, labels, patterns and colours of G, H, H′, A, O, Q, D, U, one row and S |
| `unit:geo-coverage` | `src/vis/reduce.test.ts` | G's meter line; the Cap selection and "showing 5,000 of 5,003; kept min, max" |
| `unit:geo-table-csv`, `unit:geo-facts` | `src/vis/geo/rows.test.ts` | CSV G and CSV X byte for byte, the unguarded table cells; the facts block |
| `unit:geo-targets` (builder rows) | `src/vis/geo/targets.test.ts` | the marker, cluster, O2 aggregate and `e8` group targets; `geoPlace` |
| `unit:geo-radius-project`, `unit:geo-marks-options` | `src/engine/controller/geo/marks.test.ts` | G's radii, the min 2 / max 4 sets, the projection block; a live scene's size and cluster changes |
| `unit:geo-camera`, `unit:geo-ownership` | `src/engine/controller/geo/camera.test.ts` | the zoom range, inset, fit, containment, persisted views, the anchored wheels and their drift; who owns the camera |
| `unit:geo-keys-engine`, `unit:geo-inertia`, `unit:geo-ease-origin` | `src/engine/controller/geo/input.test.ts` | the camera keys and the wheel pan; the spring and a fling, interrupted; what a stopped ease commits |
| `unit:geo-marks` | `src/engine/controller/geo/pick.test.ts` | G's marks at fit and Z3–Z6, `cluster: false`, the orders, picks, the tie, the crossfade, the UTF-16 order line |
| `unit:geo-basemap-draw` | `src/engine/canvas2d/geo/basemap.test.ts` | RT's fill paths and winding, the coast and border strokes; ANT's clamped edges never stroked |
| `unit:geo-state-glyph` | `src/engine/canvas2d/geo/paint.test.ts` | the state fill, pattern and glyph; the chip below r 8; the group fill with the state outline |
| `unit:geo-scene`, `unit:geo-scene-lifecycle`, `unit:geo-marks-emit` | `src/engine/canvas2d/Canvas2DEngine.geo.test.ts` | the lazy scene, its summary and events; the generation guard and the retry after a rejected import; when `geoMarks` goes out |
| `unit:selection-draw` (geomap rows) | `src/engine/canvas2d/Canvas2DEngine.selection.test.ts` | G with [k03], [k10] and [zz]: the ring and the dimming |
| `unit:geo-plan` | `src/vis/geo/plan.test.ts` | `planGeo`'s order (a)–(j): loading, error, invalid, mapDataUnavailable, tooSmall, empty, noneShown, ok, a placeholder, a kept refetch failure |
| `unit:geo-host`, `unit:geo-targets` (host rows), `unit:geo-single-group`, `unit:geo-states`, `unit:geo-render-failed` (c, d), `unit:geo-preview-members` (a, b) | `src/charts/GeoMapFrame.test.tsx` | the view hand-off and an engine swap; the selections and targets; one group; every state's focus and announcement; Retry and Reload over the real Canvas 2D engine; the preview and full screen |
| `unit:geo-select-hover` | `src/charts/ChartFrame.inspect.test.tsx` | the geo surface, a cluster's target and selection, the marker and cluster tooltips |
| `unit:geo-list`, `unit:geo-list-keys`, `unit:geo-list-repair` | `src/charts/geo/GeoMarkList.test.tsx` | the T24 §10.5 list and G3 blocks on the real scene's marks; the keys (Shift+← 256 px, Shift+→ held at the east edge); repair (a)–(d) |
| `unit:geo-inspect` | `src/inspector/model.test.ts` | the four kinds' header, facts, members and pivots; k01 with and without `f=env=prod` |
| `unit:geo-render-failed` (a, b) | `src/engine/canvas2d/Canvas2DEngine.geo.test.ts` | the one `geo: null` summary, and none after a line spec or dispose |
| `unit:geo-chunk-failed` | `src/pages/board/GeoMapBody.test.tsx` | the host chunk failing once and twice on a board with a line panel |
| `unit:geo-preview-members` (c) | `src/inspector/host.test.tsx` | the per-panel resolver stack |
| `unit:geo-members` | `src/inspector/members.test.ts`, `src/charts/GeoMapFrame.nav.test.tsx` | M12's cluster and N's aggregate and e18 group: the texts with parallel labels, the 12 resolved, `next` to the marker or group; the snapshot after a refresh; bins and state runs keep `next` null |
| `unit:geo-members-fullscreen` | `src/inspector/host.test.tsx`, `src/charts/GeoMapFrame.nav.test.tsx` | "+4 more" resolving 12 at the root and at e18 before, during and after a full screen of the panel |
| `unit:geo-announce`, `unit:geo-nav`, `unit:geo-nav-life`, `unit:geo-targets` (member rows) | `src/charts/GeoMapFrame.nav.test.tsx` | the level texts and the 500 ms limiter; the keyboard path with its selections, path, focus and close; snapshots, the origin window, every close, a double press, an unmount, the per-view "+4 more"; O2's e8 group and q10 |
| `unit:geo-inspect` (levels) | `src/inspector/model.test.ts` | the N aggregate at depth 0 and its e18 group at depth 1 |
| `unit:panel-table` (amended) | `src/charts/PanelTable.test.tsx` | the toggle, Inspect and the note |
| `unit:bundle-modules` (geo) | `scripts/check-bundle-modules.test.ts` | the geo fixtures: clean, geo in the initial and board closures, targets allowed, a static host |
| `e2e:geomap-offline`, `e2e:geomap`, `e2e:geomap-a11y`, `e2e:geomap-chunk` | `e2e/geomap.spec.ts` | the offline basemap's pixels; a board map's Inspector, Esc, table and CSV G, and the drill-down leg (`other (11)` → its first group → its row → Back → Back, by keys, then Esc twice: the first clears the selection, the second closes the Inspector and focus returns to the legend entry); axe per state, Tab order, keys, reduced motion; the chunk failures |
| `golden:gallery` (geomap pages) | `e2e/golden-gallery.spec.ts` | the three pages in three themes |
| `bench:geomap-markers` (report-only) | `e2e/perf-geomap-markers.spec.ts` | the p95 of `chart-draw` (`kind: geomap`) against 16 ms |

The client build fixtures under `src/vis/geo/fixtures/build/` are written by `build.py --fixtures`
from `tools/geo/fixtures/basemap-cases.json`; `unit:geo-build` checks they are current.

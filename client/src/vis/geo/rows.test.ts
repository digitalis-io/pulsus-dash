/**
 * `unit:geo-table-csv` and `unit:geo-facts` (T24 §10.5, T24-094, T24 §4.14; plan #234 Part 1 §5):
 * CSV G and CSV X byte for byte, the unguarded table cells, and the facts block.
 */
import { describe, expect, it } from 'vitest';
import type { SeriesFrame } from '../../data/frames';
import type { Unit } from '../../i18n/format';
import type { Thresholds } from '../thresholds';
import { Cap, COMPLETE, F1, G, gazT, opts, R, TH, X } from './fixtures/series';
import { geoRowSet, type GeoRowSet } from './frame';
import { geoCsv, geoFacts, geoTable } from './rows';

const MS: Unit = { kind: 'time', base: 'ms' };
const gaz = gazT();

function rows(
  series: readonly SeriesFrame[],
  th: Thresholds | null,
  source: 'instant' | 'range' = 'instant',
): GeoRowSet {
  return geoRowSet(series, source, opts(), th, gaz, COMPLETE);
}

const HEADER =
  'name,key,value,value_status,state,location_status,location_detail,source,code,provider,place,lat,lon,group,group_member,draw_status';

const CSV_G = [
  HEADER,
  '"{cloud_provider=""gcp"", cloud_region=""europe-west1""}",k03,210,ok,degraded,placed,,cloud,europe-west1,gcp,Mons,50.45,3.94,"{cloud_provider=""gcp"", cloud_region=""europe-west1""}",,shown',
  '"{cloud_region=""eu-west-1""}",k01,120,ok,ok,placed,,cloud,eu-west-1,aws,Dublin,53.34,-6.25,"{cloud_region=""eu-west-1""}",,shown',
  '"{cloud_region=""eu-west-2""}",k02,97,ok,ok,placed,,cloud,eu-west-2,aws,London,51.5,-0.12,"{cloud_region=""eu-west-2""}",,shown',
  '"{cloud_region=""mars-north-1""}",k09,50,ok,ok,unknownCode,cloud cloud_region=mars-north-1,,,,,,,other (11),"{cloud_region=""mars-north-1""}",notPlaced',
  '"{cloud_region=""westeurope""}",k04,180,ok,watch,placed,,cloud,westeurope,azure,Amsterdam,52.35,4.91,"{cloud_region=""westeurope""}",,shown',
  '"{cloud_region=""xx-dup-1""}",k11,20,ok,ok,ambiguous,providers: ta xx-dup-1; tb xx-dup-1,,,,,,,other (11),"{cloud_region=""xx-dup-1""}",notPlaced',
  '"{geo_country_iso_code=""jp""}",k05,60,ok,ok,placed,,country,JP,,Japan,36,138,"{geo_country_iso_code=""jp""}",,shown',
  '"{geohash=""u4pruydqqvj""}",k08,75,ok,ok,placed,,geohash,u4pruydqqvj,,"57.6491, 10.4074",57.64911063015461,10.407439693808556,other (11),"{geohash=""u4pruydqqvj""}",shown',
  '"{iata=""sin""}",k06,40,ok,ok,placed,,iata,SIN,,Singapore,1.35,103.99,"{iata=""sin""}",,shown',
  '"{lat=""-89.9"", lon=""0""}",k13,5,ok,ok,placed,,coords,,,"\'-89.9000, 0.0000",-89.9,0,other (11),"{lat=""-89.9"", lon=""0""}",outsideMap',
  '"{lat=""0"", lon=""0""}",k14,-30,ok,ok,placed,,coords,,,"0.0000, 0.0000",0,0,other (11),"{lat=""0"", lon=""0""}",shown',
  '"{lat=""10"", lon=""10""}",k12,,noValue,unknown,placed,,coords,,,"10.0000, 10.0000",10,10,other (11),"{lat=""10"", lon=""10""}",excluded',
  '"{lat=""20"", lon=""20""}",k16,Infinity,infinite,unknown,placed,,coords,,,"20.0000, 20.0000",20,20,other (11),"{lat=""20"", lon=""20""}",excluded',
  '"{lat=""25"", lon=""25""}",k17,5e-300,outOfRange,unknown,placed,,coords,,,"25.0000, 25.0000",25,25,other (11),"{lat=""25"", lon=""25""}",excluded',
  '"{lat=""40.7128"", lon=""-74.0060"", site=""b""}",k18,150,ok,watch,placed,,coords,,,"40.7128, -74.0060",40.7128,-74.006,other (11),"{lat=""40.7128"", lon=""-74.0060"", site=""b""}",shown',
  '"{lat=""40.7128"", lon=""-74.0060""}",k07,300,ok,failing,placed,,coords,,,"40.7128, -74.0060",40.7128,-74.006,"{lat=""40.7128"", lon=""-74.0060""}",,shown',
  '"{lat=""91"", lon=""0""}",k10,,noValue,unknown,invalid,coords lat,,,,,,,other (11),"{lat=""91"", lon=""0""}",notPlaced',
  '"{service=""web""}",k15,1,ok,ok,noLocation,,,,,,,,other (11),"{service=""web""}",notPlaced',
];

const CSV_X = [
  HEADER,
  '"{cloud_region=""=1""}",x4,-4,ok,,unknownCode,cloud cloud_region==1,,,,,,,"{cloud_region=""=1""}",,notPlaced',
  '"{cloud_region=""a,b""}",x1,1,ok,,unknownCode,"cloud cloud_region=a,b",,,,,,,"{cloud_region=""a,b""}",,notPlaced',
  '"{cloud_region=""say \\""hi\\""""}",x2,2,ok,,unknownCode,"cloud cloud_region=say ""hi""",,,,,,,"{cloud_region=""say \\""hi\\""""}",,notPlaced',
  '"{cloud_region=""x\\ny""}",x3,3,ok,,unknownCode,"cloud cloud_region=x\ny",,,,,,,"{cloud_region=""x\\ny""}",,notPlaced',
];

/** RFC 4180: the records of `csv` (CRLF-terminated), quoted cells unquoted. */
function parseCsv(csv: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && csv[i + 1] === '\n') {
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += c;
  }
  return out;
}

describe('unit:geo-table-csv', () => {
  it('CSV G, byte for byte (CRLF)', () => {
    expect(geoCsv(rows(G(), TH), MS)).toBe(CSV_G.map((l) => `${l}\r\n`).join(''));
  });

  it('CSV X, byte for byte (CRLF)', () => {
    expect(geoCsv(rows(X(), null), MS)).toBe(CSV_X.map((l) => `${l}\r\n`).join(''));
  });

  it('the table cells are unguarded; the parsed CSV holds the guarded ones', () => {
    const g = geoTable(rows(G(), TH), MS);
    expect(g.columns.join(',')).toBe(HEADER);
    const place = g.columns.indexOf('place');
    const detail = g.columns.indexOf('location_detail');
    const k13 = g.rows.find((r) => r.mark.key === 'k13');
    expect(k13?.cells[place]).toBe('-89.9000, 0.0000');
    expect(k13?.drawn).toBe(false);
    expect(k13?.shownAs).toBe('other (11)');
    expect(k13?.mark).toEqual({
      key: 'k13',
      labels: { lat: '-89.9', lon: '0' },
      name: '{lat="-89.9", lon="0"}',
      value: 5,
      state: 'ok',
      baseline: null,
      anomaly: null,
    });
    expect(g.rows.find((r) => r.mark.key === 'k07')?.drawn).toBe(true);
    expect(g.rows.map((r) => r.mark.key)).toEqual(
      parseCsv(geoCsv(rows(G(), TH), MS))
        .slice(1)
        .map((r) => r[1]),
    );
    const x = geoTable(rows(X(), null), MS);
    expect(x.rows.find((r) => r.mark.key === 'x3')?.cells[detail]).toBe('cloud cloud_region=x\ny');
    expect(x.rows.find((r) => r.mark.key === 'x4')?.cells[detail]).toBe('cloud cloud_region==1');
    const parsed = parseCsv(geoCsv(rows(G(), TH), MS));
    expect(parsed.find((r) => r[1] === 'k13')?.[place]).toBe("'-89.9000, 0.0000");
    expect(parsed).toHaveLength(19);
  });
});

describe('unit:geo-facts', () => {
  it('the facts block', () => {
    expect(geoFacts('Map', rows(G(), TH), G(), true, MS)).toEqual({
      subject: 'Map',
      current: { text: '300 ms', series: '{lat="40.7128", lon="-74.0060"}' },
      change: null,
      extent: { min: -30, max: 300 },
      baselineRatio: null,
    });
    const g900 = G({ k13: 900 });
    expect(geoFacts('Map', rows(g900, TH), g900, true, MS)).toMatchObject({
      current: { text: '900 ms', series: '{lat="-89.9", lon="0"}' },
      extent: { min: -30, max: 900 },
    });
    expect(geoFacts('Map', rows(F1(), null), F1(), true, MS)).toMatchObject({
      current: { text: '10 ms', series: '{lat="2", lon="2"}' },
      extent: { min: -30, max: 10 },
    });
    expect(geoFacts('Map', rows(Cap(), null), Cap(), true, MS)?.extent).toEqual({
      min: 0,
      max: 5002,
    });
    expect(geoFacts('Map', rows(R(), TH, 'range'), R(), false, MS)).toEqual({
      subject: 'Map',
      current: { text: '250 ms', series: '{lat="1", lon="1"}' },
      change: { series: '{lat="1", lon="1"}', from: '100 ms', to: '300 ms', atMs: 60000 },
      extent: { min: 30, max: 250 },
      baselineRatio: null,
    });
  });

  it('no ok value → null', () => {
    const none = G().filter((s) => ['k10', 'k12', 'k16', 'k17'].includes(s.key));
    expect(geoFacts('Map', rows(none, TH), none, true, MS)).toBeNull();
  });
});

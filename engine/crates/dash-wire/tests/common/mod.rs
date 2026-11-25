//! Test kit for `dash-wire` (plan #68 B2 §5): the B1 fixtures, DSF frames, a flatbuffer tree of
//! the Arrow tables the reader uses (read and write), and Arrow message builders. Independent of
//! the crate under test, so the unit tests (`crate::testkit`) and the integration tests
//! (`mod common`) share it. Panics on malformed input: it is only fed fixtures and its own
//! output.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::PathBuf;

// ---------------------------------------------------------------------------------------------
// Fixtures

/// The five B1 fixtures (`wire/fixtures/arrow/`).
pub const FIXTURES: [&str; 5] = [
    "promql-range-counter",
    "grid-batches",
    "grid-error",
    "grid-empty",
    "part-ids",
];

pub fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../wire/fixtures/arrow")
}

pub fn fixture(name: &str) -> Vec<u8> {
    let p = fixture_dir().join(format!("{name}.dsf"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

pub fn expect(name: &str) -> serde_json::Value {
    let p = fixture_dir().join(format!("{name}.expect.json"));
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

// ---------------------------------------------------------------------------------------------
// Little-endian helpers

pub fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
pub fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
pub fn i32_at(b: &[u8], at: usize) -> i32 {
    u32_at(b, at) as i32
}
pub fn i64_at(b: &[u8], at: usize) -> i64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[at..at + 8]);
    i64::from_le_bytes(a)
}
pub fn put_u16(b: &mut [u8], at: usize, v: u16) {
    b[at..at + 2].copy_from_slice(&v.to_le_bytes());
}
pub fn put_u32(b: &mut [u8], at: usize, v: u32) {
    b[at..at + 4].copy_from_slice(&v.to_le_bytes());
}
pub fn put_i64(b: &mut [u8], at: usize, v: i64) {
    b[at..at + 8].copy_from_slice(&v.to_le_bytes());
}
pub fn round_up(n: usize, to: usize) -> usize {
    n.div_ceil(to) * to
}

// ---------------------------------------------------------------------------------------------
// DSF frames

pub const SCHEMA: u8 = 1;
pub const BATCH: u8 = 2;
pub const META: u8 = 3;
pub const END: u8 = 4;
pub const ERROR: u8 = 5;
pub const PROGRESS: u8 = 6;
pub const PING: u8 = 8;
pub const LAST: u16 = 1;
pub const VOLATILE: u16 = 2;

/// A 16-byte DSF header.
pub fn header(
    version: u8,
    kind: u8,
    flags: u16,
    part: u32,
    len: u32,
    rank: u16,
    reserved: u16,
) -> [u8; 16] {
    let mut h = [0u8; 16];
    h[0] = version;
    h[1] = kind;
    put_u16(&mut h, 2, flags);
    put_u32(&mut h, 4, part);
    put_u32(&mut h, 8, len);
    put_u16(&mut h, 12, rank);
    put_u16(&mut h, 14, reserved);
    h
}

/// The frame start offsets of a well-formed body.
pub fn frame_offsets(body: &[u8]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut p = 0;
    while p + 16 <= body.len() {
        out.push(p);
        p += 16 + u32_at(body, p + 8) as usize;
    }
    out
}

/// One frame of the body model. `raw` (when set) is written verbatim as the payload;
/// otherwise the pieces are encapsulated at their position (minimal metadata length, B1 §3.2).
#[derive(Clone, Debug, PartialEq)]
pub struct F {
    pub kind: u8,
    pub flags: u16,
    pub part: u32,
    pub rank: u16,
    pub pieces: Vec<Piece>,
    pub raw: Option<Vec<u8>>,
}

impl F {
    pub fn new(kind: u8, flags: u16, part: u32, rank: u16, pieces: Vec<Piece>) -> Self {
        Self {
            kind,
            flags,
            part,
            rank,
            pieces,
            raw: None,
        }
    }
    pub fn raw(kind: u8, flags: u16, part: u32, rank: u16, payload: Vec<u8>) -> Self {
        Self {
            kind,
            flags,
            part,
            rank,
            pieces: Vec::new(),
            raw: Some(payload),
        }
    }
    /// The `i`-th IPC message of the payload.
    pub fn msg(&self, i: usize) -> &Msg {
        match self
            .pieces
            .iter()
            .filter(|p| matches!(p, Piece::M(_)))
            .nth(i)
        {
            Some(Piece::M(m)) => m,
            _ => panic!("frame has no message {i}"),
        }
    }
    pub fn msg_mut(&mut self, i: usize) -> &mut Msg {
        match self
            .pieces
            .iter_mut()
            .filter(|p| matches!(p, Piece::M(_)))
            .nth(i)
        {
            Some(Piece::M(m)) => m,
            _ => panic!("frame has no message {i}"),
        }
    }
}

/// Parses a well-formed body into frames and messages.
pub fn parse(body: &[u8]) -> Vec<F> {
    frame_offsets(body)
        .into_iter()
        .map(|p| {
            let kind = body[p + 1];
            let flags = u16_at(body, p + 2);
            let part = u32_at(body, p + 4);
            let len = u32_at(body, p + 8) as usize;
            let rank = u16_at(body, p + 12);
            let payload = &body[p + 16..p + 16 + len];
            if matches!(kind, SCHEMA | BATCH | META | ERROR) {
                F::new(kind, flags, part, rank, pieces(payload))
            } else {
                F::raw(kind, flags, part, rank, payload.to_vec())
            }
        })
        .collect()
}

/// Encodes frames; every message is placed with the minimal `L` for its position.
pub fn encode(frames: &[F]) -> Vec<u8> {
    let mut out = Vec::new();
    for f in frames {
        let payload = match &f.raw {
            Some(r) => r.clone(),
            None => encode_pieces(&f.pieces, out.len() + 16),
        };
        out.extend_from_slice(&header(
            1,
            f.kind,
            f.flags,
            f.part,
            payload.len() as u32,
            f.rank,
            0,
        ));
        out.extend_from_slice(&payload);
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Encapsulated IPC messages

/// One message: the flatbuffer (`m` = round_up(h, 8) bytes) and its body.
#[derive(Clone, Debug, PartialEq)]
pub struct Msg {
    pub meta: Vec<u8>,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Piece {
    M(Msg),
    Eos,
}

/// The least `L ≥ m` with `L ≡ 0 (mod 8)` and `(p + 8 + L) ≡ 0 (mod 64)` (B1 §3.2).
pub fn min_l(m: usize, p: usize) -> usize {
    let mut l = m;
    while (p + 8 + l) % 64 != 0 {
        l += 8;
    }
    l
}

/// Splits a payload into messages and EOS markers.
pub fn pieces(payload: &[u8]) -> Vec<Piece> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < payload.len() {
        assert_eq!(u32_at(payload, at), 0xFFFF_FFFF, "continuation at {at}");
        let l = i32_at(payload, at + 4) as usize;
        if l == 0 {
            out.push(Piece::Eos);
            at += 8;
            continue;
        }
        let meta = &payload[at + 8..at + 8 + l];
        let (tree, h) = read_tree(meta);
        let m = round_up(h, 8);
        let body_len = tree.int(3) as usize;
        let start = at + 8 + l;
        out.push(Piece::M(Msg {
            meta: meta[..m].to_vec(),
            body: payload[start..start + body_len].to_vec(),
        }));
        at = start + body_len;
    }
    out
}

/// Encodes pieces at response-body offset `payload_offset`.
pub fn encode_pieces(pieces: &[Piece], payload_offset: usize) -> Vec<u8> {
    let mut out = Vec::new();
    for p in pieces {
        match p {
            Piece::Eos => out.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0]),
            Piece::M(m) => {
                let l = min_l(m.meta.len(), payload_offset + out.len());
                out.extend_from_slice(&[0xFF; 4]);
                out.extend_from_slice(&(l as i32).to_le_bytes());
                out.extend_from_slice(&m.meta);
                out.resize(out.len() + l - m.meta.len(), 0);
                out.extend_from_slice(&m.body);
            }
        }
    }
    out
}

impl Msg {
    pub fn tree(&self) -> Tb {
        read_tree(&self.meta).0
    }
    /// The same body with a rewritten flatbuffer.
    pub fn with_tree(&self, t: &Tb) -> Msg {
        Msg {
            meta: write_tree(t),
            body: self.body.clone(),
        }
    }
    pub fn edit(&self, f: impl FnOnce(&mut Tb)) -> Msg {
        let mut t = self.tree();
        f(&mut t);
        self.with_tree(&t)
    }
    /// The high-water mark of the flatbuffer.
    pub fn h(&self) -> usize {
        read_tree(&self.meta).1
    }
    /// A new body, with `bodyLength` updated.
    pub fn with_body(&self, body: Vec<u8>) -> Msg {
        let mut t = self.tree();
        t.set_int(3, 8, body.len() as i64);
        Msg {
            meta: write_tree(&t),
            body,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Flatbuffer tree

/// A field value: scalar bytes (LE, width = len), table, string, vector of tables, or vector
/// of fixed-size structs/scalars (element size, bytes).
#[derive(Clone, Debug, PartialEq)]
pub enum V {
    S(Vec<u8>),
    T(Tb),
    Str(Vec<u8>),
    Tv(Vec<Tb>),
    Sv(usize, Vec<u8>),
}

/// A table: present fields by vtable index.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Tb {
    pub f: BTreeMap<u16, V>,
}

impl Tb {
    pub fn t(&self, id: u16) -> &Tb {
        match self.f.get(&id) {
            Some(V::T(t)) => t,
            other => panic!("field {id} is not a table: {other:?}"),
        }
    }
    pub fn t_mut(&mut self, id: u16) -> &mut Tb {
        match self.f.get_mut(&id) {
            Some(V::T(t)) => t,
            other => panic!("field {id} is not a table: {other:?}"),
        }
    }
    pub fn tv(&self, id: u16) -> &Vec<Tb> {
        match self.f.get(&id) {
            Some(V::Tv(t)) => t,
            other => panic!("field {id} is not a table vector: {other:?}"),
        }
    }
    pub fn tv_mut(&mut self, id: u16) -> &mut Vec<Tb> {
        match self.f.get_mut(&id) {
            Some(V::Tv(t)) => t,
            other => panic!("field {id} is not a table vector: {other:?}"),
        }
    }
    /// A signed scalar (0 when absent).
    pub fn int(&self, id: u16) -> i64 {
        match self.f.get(&id) {
            Some(V::S(b)) => {
                let mut a = [0u8; 8];
                a[..b.len()].copy_from_slice(b);
                let v = i64::from_le_bytes(a);
                let shift = 64 - 8 * b.len() as u32;
                (v << shift) >> shift
            }
            None => 0,
            other => panic!("field {id} is not a scalar: {other:?}"),
        }
    }
    pub fn set_int(&mut self, id: u16, width: usize, v: i64) {
        self.f.insert(id, V::S(v.to_le_bytes()[..width].to_vec()));
    }
    pub fn string(&self, id: u16) -> Option<String> {
        match self.f.get(&id) {
            Some(V::Str(s)) => Some(String::from_utf8_lossy(s).into_owned()),
            _ => None,
        }
    }
    pub fn set_str(&mut self, id: u16, s: &[u8]) {
        self.f.insert(id, V::Str(s.to_vec()));
    }
    /// A vector of 16-byte `{i64, i64}` structs (`FieldNode`, `Buffer`).
    pub fn pairs(&self, id: u16) -> Vec<(i64, i64)> {
        match self.f.get(&id) {
            Some(V::Sv(16, b)) => b.chunks(16).map(|c| (i64_at(c, 0), i64_at(c, 8))).collect(),
            None => Vec::new(),
            other => panic!("field {id} is not a struct vector: {other:?}"),
        }
    }
    pub fn set_pairs(&mut self, id: u16, v: &[(i64, i64)]) {
        let mut b = Vec::new();
        for (x, y) in v {
            b.extend_from_slice(&x.to_le_bytes());
            b.extend_from_slice(&y.to_le_bytes());
        }
        self.f.insert(id, V::Sv(16, b));
    }
}

/// The Arrow table kinds the kit knows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum K {
    Message,
    Schema,
    Field,
    KeyValue,
    Int,
    Fp,
    Ts,
    Fsl,
    Empty,
    RecordBatch,
    DictEnc,
    BodyComp,
}

#[derive(Clone, Copy, Debug)]
enum Fk {
    S(usize),
    T(K),
    Str,
    Tv(K),
    Sv(usize),
    /// A union value whose kind follows from the u8 type field `0`.
    Union(u16),
}

fn fk(k: K, id: u16) -> Option<Fk> {
    use Fk::*;
    Some(match (k, id) {
        (K::Message, 0) => S(2),
        (K::Message, 1) => S(1),
        (K::Message, 2) => Union(1),
        (K::Message, 3) => S(8),
        (K::Message, 4) => Tv(K::KeyValue),
        (K::Schema, 0) => S(2),
        (K::Schema, 1) => Tv(K::Field),
        (K::Schema, 2) => Tv(K::KeyValue),
        (K::Schema, 3) => Sv(8),
        (K::Field, 0) => Str,
        (K::Field, 1) => S(1),
        (K::Field, 2) => S(1),
        (K::Field, 3) => Union(2),
        (K::Field, 4) => T(K::DictEnc),
        (K::Field, 5) => Tv(K::Field),
        (K::Field, 6) => Tv(K::KeyValue),
        (K::KeyValue, 0 | 1) => Str,
        (K::Int, 0) => S(4),
        (K::Int, 1) => S(1),
        (K::Fp, 0) => S(2),
        (K::Ts, 0) => S(2),
        (K::Ts, 1) => Str,
        (K::Fsl, 0) => S(4),
        (K::RecordBatch, 0) => S(8),
        (K::RecordBatch, 1 | 2) => Sv(16),
        (K::RecordBatch, 3) => T(K::BodyComp),
        (K::RecordBatch, 4) => Sv(8),
        (K::DictEnc, 0) => S(8),
        (K::DictEnc, 1) => T(K::Int),
        (K::DictEnc, 2) => S(1),
        (K::BodyComp, 0 | 1) => S(1),
        _ => return None,
    })
}

fn union_kind(k: K, ty: i64) -> K {
    match (k, ty) {
        (K::Message, 1) => K::Schema,
        (K::Message, _) => K::RecordBatch,
        (K::Field, 2) => K::Int,
        (K::Field, 3) => K::Fp,
        (K::Field, 10) => K::Ts,
        (K::Field, 16) => K::Fsl,
        _ => K::Empty,
    }
}

struct Reader<'a> {
    b: &'a [u8],
    h: usize,
}

impl Reader<'_> {
    fn mark(&mut self, end: usize) {
        self.h = self.h.max(end);
    }
    fn table(&mut self, pos: usize, k: K) -> Tb {
        let vt = (pos as i64 - i64::from(i32_at(self.b, pos))) as usize;
        let vl = u16_at(self.b, vt) as usize;
        let ol = u16_at(self.b, vt + 2) as usize;
        self.mark(vt + vl);
        self.mark(pos + ol);
        let mut t = Tb::default();
        let entries: Vec<(u16, usize)> = (0..(vl - 4) / 2)
            .map(|i| (i as u16, u16_at(self.b, vt + 4 + 2 * i) as usize))
            .filter(|(_, o)| *o != 0)
            .collect();
        // Scalars first, so unions can see their type field.
        for &(id, off) in &entries {
            if let Some(Fk::S(w)) = fk(k, id) {
                t.f.insert(id, V::S(self.b[pos + off..pos + off + w].to_vec()));
            }
        }
        for &(id, off) in &entries {
            let fp = pos + off;
            let target = fp + u32_at(self.b, fp) as usize;
            let v = match fk(k, id) {
                Some(Fk::S(_)) => continue,
                Some(Fk::T(k2)) => V::T(self.table(target, k2)),
                Some(Fk::Union(tf)) => {
                    let k2 = union_kind(k, t.int(tf));
                    V::T(self.table(target, k2))
                }
                Some(Fk::Str) => {
                    let n = u32_at(self.b, target) as usize;
                    self.mark(target + 4 + n + 1);
                    V::Str(self.b[target + 4..target + 4 + n].to_vec())
                }
                Some(Fk::Tv(k2)) => {
                    let n = u32_at(self.b, target) as usize;
                    self.mark(target + 4 + 4 * n);
                    V::Tv(
                        (0..n)
                            .map(|i| {
                                let e = target + 4 + 4 * i;
                                let tp = e + u32_at(self.b, e) as usize;
                                self.table(tp, k2)
                            })
                            .collect(),
                    )
                }
                Some(Fk::Sv(size)) => {
                    let n = u32_at(self.b, target) as usize;
                    self.mark(target + 4 + n * size);
                    V::Sv(size, self.b[target + 4..target + 4 + n * size].to_vec())
                }
                None => panic!("unknown field {id} of {k:?}"),
            };
            t.f.insert(id, v);
        }
        t
    }
}

/// Reads a `Message` flatbuffer; returns the tree and the high-water mark.
pub fn read_tree(meta: &[u8]) -> (Tb, usize) {
    let mut r = Reader { b: meta, h: 4 };
    let root = u32_at(meta, 0) as usize;
    let t = r.table(root, K::Message);
    (t, r.h)
}

struct Writer {
    out: Vec<u8>,
}

impl Writer {
    fn align(&mut self, a: usize, rem: usize) {
        while self.out.len() % a != rem {
            self.out.push(0);
        }
    }
    fn table(&mut self, t: &Tb, k: K) -> usize {
        let mut layout: Vec<(u16, usize)> =
            t.f.iter()
                .map(|(id, v)| {
                    (
                        *id,
                        match v {
                            V::S(b) => b.len(),
                            _ => 4,
                        },
                    )
                })
                .collect();
        layout.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let mut offs = BTreeMap::new();
        let mut cursor = 4;
        for (id, w) in &layout {
            cursor = round_up(cursor, *w);
            offs.insert(*id, cursor);
            cursor += w;
        }
        let obj_len = cursor;
        let n = t.f.keys().max().map_or(0, |m| *m as usize + 1);
        self.align(2, 0);
        let vt = self.out.len();
        self.out
            .extend_from_slice(&((4 + 2 * n) as u16).to_le_bytes());
        self.out.extend_from_slice(&(obj_len as u16).to_le_bytes());
        for i in 0..n {
            let o = offs.get(&(i as u16)).copied().unwrap_or(0);
            self.out.extend_from_slice(&(o as u16).to_le_bytes());
        }
        self.align(8, 0);
        let pos = self.out.len();
        self.out.resize(pos + obj_len, 0);
        let so = (pos - vt) as i32;
        self.out[pos..pos + 4].copy_from_slice(&so.to_le_bytes());
        for (id, v) in &t.f {
            if let V::S(b) = v {
                let o = pos + offs[id];
                self.out[o..o + b.len()].copy_from_slice(b);
            }
        }
        for (id, v) in &t.f {
            let fp = pos + offs[id];
            let target = match v {
                V::S(_) => continue,
                V::T(c) => {
                    let k2 = match fk(k, *id) {
                        Some(Fk::T(k2)) => k2,
                        Some(Fk::Union(tf)) => union_kind(k, t.int(tf)),
                        _ => K::Empty,
                    };
                    self.table(c, k2)
                }
                V::Str(s) => {
                    self.align(4, 0);
                    let p = self.out.len();
                    self.out.extend_from_slice(&(s.len() as u32).to_le_bytes());
                    self.out.extend_from_slice(s);
                    self.out.push(0);
                    p
                }
                V::Tv(ts) => {
                    let k2 = match fk(k, *id) {
                        Some(Fk::Tv(k2)) => k2,
                        _ => K::Empty,
                    };
                    self.align(4, 0);
                    let p = self.out.len();
                    self.out.extend_from_slice(&(ts.len() as u32).to_le_bytes());
                    self.out.resize(p + 4 + 4 * ts.len(), 0);
                    for (i, c) in ts.iter().enumerate() {
                        let e = p + 4 + 4 * i;
                        let cp = self.table(c, k2);
                        put_u32(&mut self.out, e, (cp - e) as u32);
                    }
                    p
                }
                V::Sv(size, b) => {
                    self.align(8, 4);
                    let p = self.out.len();
                    self.out
                        .extend_from_slice(&((b.len() / size) as u32).to_le_bytes());
                    self.out.extend_from_slice(b);
                    p
                }
            };
            put_u32(&mut self.out, fp, (target - fp) as u32);
        }
        pos
    }
}

/// Writes a `Message` tree: objects in forward order, every reference forward, no overlap,
/// zero-padded to a multiple of 8 (= `m`).
pub fn write_tree(t: &Tb) -> Vec<u8> {
    let mut w = Writer { out: vec![0; 4] };
    let root = w.table(t, K::Message);
    put_u32(&mut w.out, 0, root as u32);
    w.align(8, 0);
    w.out
}

// ---------------------------------------------------------------------------------------------
// Arrow builders

pub fn kv(k: &str, v: &str) -> Tb {
    let mut t = Tb::default();
    t.set_str(0, k.as_bytes());
    t.set_str(1, v.as_bytes());
    t
}

/// A `Field` table.
pub fn field(name: &str, nullable: bool, type_type: u8, ty: Tb, children: Vec<Tb>) -> Tb {
    let mut t = Tb::default();
    t.set_str(0, name.as_bytes());
    if nullable {
        t.set_int(1, 1, 1);
    }
    t.set_int(2, 1, i64::from(type_type));
    t.f.insert(3, V::T(ty));
    t.f.insert(5, V::Tv(children));
    t
}

/// An unsigned `Int` type table.
pub fn int_ty(bits: i64) -> Tb {
    let mut t = Tb::default();
    t.set_int(0, 4, bits);
    t
}

/// Sets (or appends) a schema metadata value in a Schema message tree.
pub fn set_kv(msg: &mut Tb, key: &str, value: &str) {
    let kvs = msg.t_mut(2).tv_mut(2);
    match kvs.iter_mut().find(|t| t.string(0).as_deref() == Some(key)) {
        Some(t) => t.set_str(1, value.as_bytes()),
        None => kvs.push(kv(key, value)),
    }
}

/// The metadata value of `key` in a Schema message tree.
pub fn get_kv(msg: &Tb, key: &str) -> Option<String> {
    msg.t(2)
        .tv(2)
        .iter()
        .find(|t| t.string(0).as_deref() == Some(key))
        .and_then(|t| t.string(1))
}

/// A Schema message from fields and metadata.
pub fn schema_msg(fields: Vec<Tb>, meta: &[(&str, &str)]) -> Msg {
    let mut schema = Tb::default();
    schema.f.insert(1, V::Tv(fields));
    schema
        .f
        .insert(2, V::Tv(meta.iter().map(|(k, v)| kv(k, v)).collect()));
    let mut m = Tb::default();
    m.set_int(0, 2, 4);
    m.set_int(1, 1, 1);
    m.f.insert(2, V::T(schema));
    Msg {
        meta: write_tree(&m),
        body: Vec::new(),
    }
}

/// A RecordBatch message.
pub fn batch_msg(length: i64, nodes: &[(i64, i64)], bufs: &[(i64, i64)], body: Vec<u8>) -> Msg {
    let mut rb = Tb::default();
    if length != 0 {
        rb.set_int(0, 8, length);
    }
    rb.set_pairs(1, nodes);
    rb.set_pairs(2, bufs);
    let mut m = Tb::default();
    m.set_int(0, 2, 4);
    m.set_int(1, 1, 3);
    m.f.insert(2, V::T(rb));
    m.set_int(3, 8, body.len() as i64);
    Msg {
        meta: write_tree(&m),
        body,
    }
}

/// A body under construction: buffers at offsets aligned to `align`, each declared with its
/// length rounded up to `pad` (B1: 64 and 64 for grid batches, 8 and 1 for the others).
#[derive(Debug)]
pub struct Body {
    pub body: Vec<u8>,
    pub nodes: Vec<(i64, i64)>,
    pub bufs: Vec<(i64, i64)>,
    align: usize,
    pad: usize,
}

impl Body {
    pub fn new(align: usize, pad: usize) -> Self {
        Self {
            body: Vec::new(),
            nodes: Vec::new(),
            bufs: Vec::new(),
            align,
            pad,
        }
    }
    pub fn buf(&mut self, bytes: &[u8]) {
        let off = round_up(self.body.len(), self.align);
        self.body.resize(off, 0);
        let len = if bytes.is_empty() {
            0
        } else {
            round_up(bytes.len(), self.pad)
        };
        self.body.extend_from_slice(bytes);
        self.body.resize(off + len, 0);
        self.bufs.push((off as i64, len as i64));
    }
    /// The validity buffer for `present` (empty when `None`).
    pub fn validity(&mut self, present: Option<&[bool]>) {
        match present {
            None => self.buf(&[]),
            Some(p) => {
                let mut b = vec![0u8; p.len().div_ceil(8)];
                for (i, on) in p.iter().enumerate() {
                    if *on {
                        b[i / 8] |= 1 << (i % 8);
                    }
                }
                self.buf(&b);
            }
        }
    }
    pub fn node(&mut self, len: usize, nulls: usize) {
        self.nodes.push((len as i64, nulls as i64));
    }
    /// A non-null fixed-width column.
    pub fn fixed(&mut self, data: &[u8], len: usize) {
        self.node(len, 0);
        self.buf(&[]);
        self.buf(data);
    }
    /// A Utf8 column; `always_validity` writes an all-ones bitmap when nothing is null.
    pub fn utf8(&mut self, vals: &[Option<&[u8]>], always_validity: bool) {
        let nulls = vals.iter().filter(|v| v.is_none()).count();
        self.node(vals.len(), nulls);
        let present: Vec<bool> = vals.iter().map(Option::is_some).collect();
        self.validity((nulls > 0 || always_validity).then_some(&present[..]));
        let mut offs = vec![0u8; 4];
        let mut data = Vec::new();
        for v in vals {
            data.extend_from_slice(v.unwrap_or_default());
            offs.extend_from_slice(&(data.len() as i32).to_le_bytes());
        }
        self.buf(&offs);
        self.buf(&data);
    }
    pub fn finish(mut self, length: usize) -> Msg {
        let end = round_up(self.body.len(), 8);
        self.body.resize(end, 0);
        batch_msg(length as i64, &self.nodes, &self.bufs, self.body)
    }
}

/// A `labels/1` row.
pub type LabelRow<'a> = (u32, u64, Option<&'a [u8]>, Option<&'a [u8]>);

/// A `labels/1` batch laid out like B1's (8-aligned buffers).
pub fn labels_msg(rows: &[LabelRow<'_>], always_validity: bool) -> Msg {
    let mut b = Body::new(8, 1);
    let ids: Vec<u8> = rows.iter().flat_map(|r| r.0.to_le_bytes()).collect();
    let keys: Vec<u8> = rows.iter().flat_map(|r| r.1.to_le_bytes()).collect();
    b.fixed(&ids, rows.len());
    b.fixed(&keys, rows.len());
    let k: Vec<Option<&[u8]>> = rows.iter().map(|r| r.2).collect();
    let v: Vec<Option<&[u8]>> = rows.iter().map(|r| r.3).collect();
    b.utf8(&k, always_validity);
    b.utf8(&v, always_validity);
    b.finish(rows.len())
}

/// The canonical null slot (B1 §3.1).
pub const NULL_BITS: u64 = 0x7FF8_0000_0000_0000;

/// A `metric_matrix.grid/1` batch laid out like B1's (every buffer 64-aligned, 64-padded);
/// each slot is `(present, bits)`.
pub fn grid_msg(rows: &[(u32, Vec<(bool, u64)>)]) -> Msg {
    let mut b = Body::new(64, 64);
    let ids: Vec<u8> = rows.iter().flat_map(|r| r.0.to_le_bytes()).collect();
    b.fixed(&ids, rows.len());
    b.node(rows.len(), 0);
    b.buf(&[]);
    let slots: Vec<(bool, u64)> = rows.iter().flat_map(|r| r.1.iter().copied()).collect();
    let nulls = slots.iter().filter(|s| !s.0).count();
    b.node(slots.len(), nulls);
    let present: Vec<bool> = slots.iter().map(|s| s.0).collect();
    b.validity((nulls > 0).then_some(&present[..]));
    let data: Vec<u8> = slots.iter().flat_map(|s| s.1.to_le_bytes()).collect();
    b.buf(&data);
    b.finish(rows.len())
}

/// Appends a column (its nodes and buffers, 8-aligned after the body) to a batch message.
pub fn append_column(msg: &Msg, nodes: &[(i64, i64)], bufs: &[&[u8]]) -> Msg {
    let mut t = msg.tree();
    let mut body = msg.body.clone();
    let rb = t.t_mut(2);
    let mut all_nodes = rb.pairs(1);
    all_nodes.extend_from_slice(nodes);
    let mut all_bufs = rb.pairs(2);
    for b in bufs {
        let off = round_up(body.len(), 8);
        body.resize(off, 0);
        body.extend_from_slice(b);
        all_bufs.push((off as i64, b.len() as i64));
    }
    body.resize(round_up(body.len(), 8), 0);
    rb.set_pairs(1, &all_nodes);
    rb.set_pairs(2, &all_bufs);
    t.set_int(3, 8, body.len() as i64);
    Msg {
        meta: write_tree(&t),
        body,
    }
}

/// The non-null Utf8 column buffers `(validity, offsets, data)` for `vals`.
pub fn utf8_bufs(vals: &[&[u8]]) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let mut offs = 0i32.to_le_bytes().to_vec();
    let mut data = Vec::new();
    for v in vals {
        data.extend_from_slice(v);
        offs.extend_from_slice(&(data.len() as i32).to_le_bytes());
    }
    (Vec::new(), offs, data)
}

// ---------------------------------------------------------------------------------------------
// Locating bytes in a body (for in-place, single-byte mutations)

/// Message `i` of frame `fi` in a body: (metadata start, L, body start).
pub fn locate(body: &[u8], fi: usize, i: usize) -> (usize, usize, usize) {
    let p = frame_offsets(body)[fi] + 16;
    let len = u32_at(body, p - 8) as usize;
    let mut at = 0;
    let mut k = 0;
    while at < len {
        let l = i32_at(body, p + at + 4) as usize;
        if l == 0 {
            at += 8;
            continue;
        }
        let meta = &body[p + at + 8..p + at + 8 + l];
        let bl = read_tree(meta).0.int(3) as usize;
        if k == i {
            return (p + at + 8, l, p + at + 8 + l);
        }
        k += 1;
        at += 8 + l + bl;
    }
    panic!("frame {fi} has no message {i}");
}

/// Body offset of the struct-vector data of `RecordBatch` field `id` (1 nodes, 2 buffers) in
/// message `i` of frame `fi`.
pub fn struct_vec_at(body: &[u8], fi: usize, i: usize, id: u16) -> usize {
    let (meta_at, l, _) = locate(body, fi, i);
    let meta = &body[meta_at..meta_at + l];
    let root = u32_at(meta, 0) as usize;
    let hdr = field_target(meta, root, 2);
    meta_at + field_target(meta, hdr, id) + 4
}

/// The target of the `uoffset` field `id` of the table at `pos`.
pub fn field_target(meta: &[u8], pos: usize, id: u16) -> usize {
    let fp = field_pos(meta, pos, id).unwrap_or_else(|| panic!("field {id} absent"));
    fp + u32_at(meta, fp) as usize
}

/// The position of field `id` of the table at `pos`, if present.
pub fn field_pos(meta: &[u8], pos: usize, id: u16) -> Option<usize> {
    let vt = (pos as i64 - i64::from(i32_at(meta, pos))) as usize;
    let vl = u16_at(meta, vt) as usize;
    let e = 4 + 2 * id as usize;
    if e + 2 > vl {
        return None;
    }
    let o = u16_at(meta, vt + e) as usize;
    (o != 0).then_some(pos + o)
}

/// The buffers `(offset, length)` of message `i` of frame `fi`.
pub fn buffers_of(body: &[u8], fi: usize, i: usize) -> Vec<(i64, i64)> {
    let (meta_at, l, _) = locate(body, fi, i);
    read_tree(&body[meta_at..meta_at + l]).0.t(2).pairs(2)
}

/// The nodes `(length, null_count)` of message `i` of frame `fi`.
pub fn nodes_of(body: &[u8], fi: usize, i: usize) -> Vec<(i64, i64)> {
    let (meta_at, l, _) = locate(body, fi, i);
    read_tree(&body[meta_at..meta_at + l]).0.t(2).pairs(1)
}

/// Index of the `n`-th frame (0-based) with this type and part.
pub fn find_frame(frames: &[F], kind: u8, part: u32, n: usize) -> usize {
    frames
        .iter()
        .enumerate()
        .filter(|(_, f)| f.kind == kind && f.part == part)
        .nth(n)
        .map(|(i, _)| i)
        .unwrap_or_else(|| panic!("no frame {n} of type {kind} on part {part}"))
}

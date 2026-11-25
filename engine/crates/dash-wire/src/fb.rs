//! A bounds-checked flatbuffers reader for the Arrow `Message.fbs`/`Schema.fbs` tables the
//! engine reads (plan #68 B2 §3.3, T04-010).
#![deny(clippy::indexing_slicing)]

use crate::ipc::IpcError;

/// A table's accepted fields: `(vtable index, width in bytes)`; references are 4 bytes.
pub(crate) type Spec = &'static [(u16, usize)];

/// The most tables in one message.
pub(crate) const MAX_TABLES: usize = 512;

/// One flatbuffer being verified: the bytes and the extents of every visited object.
#[derive(Debug)]
pub(crate) struct Fb<'a> {
    buf: &'a [u8],
}

impl<'a> Fb<'a> {
    pub(crate) fn new(buf: &'a [u8]) -> Self {
        Self { buf }
    }

    /// The root table (the `uoffset` at byte 0).
    pub(crate) fn root(&self, _spec: Spec) -> Result<Table<'_>, IpcError> {
        let _ = self.buf;
        Err(IpcError::Flatbuffer)
    }

    /// After every object was visited: rejects overlapping extents; returns the high-water mark.
    pub(crate) fn finish(&self) -> Result<usize, IpcError> {
        Err(IpcError::Flatbuffer)
    }
}

/// A verified table.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Table<'a> {
    fb: &'a Fb<'a>,
}

impl<'a> Table<'a> {
    pub(crate) fn u8(&self, _id: u16, _default: u8) -> Result<u8, IpcError> {
        let _ = self.fb;
        Err(IpcError::Flatbuffer)
    }
    pub(crate) fn i16(&self, _id: u16, _default: i16) -> Result<i16, IpcError> {
        Err(IpcError::Flatbuffer)
    }
    pub(crate) fn i32(&self, _id: u16, _default: i32) -> Result<i32, IpcError> {
        Err(IpcError::Flatbuffer)
    }
    pub(crate) fn i64(&self, _id: u16, _default: i64) -> Result<i64, IpcError> {
        Err(IpcError::Flatbuffer)
    }
    pub(crate) fn bool(&self, _id: u16, _default: bool) -> Result<bool, IpcError> {
        Err(IpcError::Flatbuffer)
    }
    pub(crate) fn table(&self, _id: u16, _spec: Spec) -> Result<Option<Table<'a>>, IpcError> {
        Err(IpcError::Flatbuffer)
    }
    pub(crate) fn str(&self, _id: u16) -> Result<Option<&'a str>, IpcError> {
        Err(IpcError::Flatbuffer)
    }
    pub(crate) fn tables(
        &self,
        _id: u16,
        _max: usize,
        _spec: Spec,
    ) -> Result<Vec<Table<'a>>, IpcError> {
        Err(IpcError::Flatbuffer)
    }
    pub(crate) fn structs(
        &self,
        _id: u16,
        _size: usize,
        _max: usize,
    ) -> Result<&'a [u8], IpcError> {
        Err(IpcError::Flatbuffer)
    }
}

#[cfg(test)]
mod tests {
    //! unit:fb-reader (plan #68 B2 §5; T04-010): hand-built buffers and single mutations of
    //! B1 messages. Every rejection is an error, never a panic, and comes before any event.
    use super::*;
    use crate::bytes::SharedBytes;
    use crate::dsf::DsfError;
    use crate::ipc::{self, MESSAGE};
    use crate::testkit::{self as kit, F, Msg, Piece, Tb, V};
    use crate::{BodyDecoder, Event, FrameSplitter, PartError};

    /// The payload offset of a body's first frame.
    const P: usize = 16;

    fn read(m: &Msg) -> Result<(), IpcError> {
        let payload = kit::encode_pieces(&[Piece::M(m.clone())], P);
        ipc::read_message(&SharedBytes::copy_from(&payload, P), P as u64, 0).map(|_| ())
    }

    fn run(body: &[u8]) -> Vec<Event> {
        let mut s = FrameSplitter::new();
        let mut d = BodyDecoder::new(1);
        let mut ev = Vec::new();
        if s.push(SharedBytes::copy_from(body, 0)).is_ok() {
            loop {
                match s.next() {
                    Ok(Some(f)) => ev.extend(d.frame(f)),
                    Ok(None) => break,
                    Err(e) => {
                        ev.extend(d.fail_stream(e));
                        break;
                    }
                }
            }
        }
        if let Err(e) = s.finish() {
            ev.extend(d.fail_stream(e));
        }
        ev.extend(d.finish());
        ev
    }

    fn failure(ev: &[Event], part: u32) -> Option<PartError> {
        ev.iter().find_map(|e| match e {
            Event::Failed { part: p, reason } if *p == part => Some(reason.clone()),
            _ => None,
        })
    }

    fn counter() -> Vec<F> {
        kit::parse(&kit::fixture("promql-range-counter"))
    }

    /// The counter's labels SCHEMA message, rewritten by the kit (one vtable per table).
    fn labels_schema() -> Msg {
        let m = counter()[0].msg(0).clone();
        m.with_tree(&m.tree())
    }

    fn vt_of(meta: &[u8], pos: usize) -> usize {
        (pos as i64 - i64::from(kit::i32_at(meta, pos))) as usize
    }

    /// The `i`-th `Field` table of a Schema message.
    fn field_table(meta: &[u8], i: usize) -> usize {
        let root = kit::u32_at(meta, 0) as usize;
        let schema = kit::field_target(meta, root, 2);
        let fields = kit::field_target(meta, schema, 1);
        let e = fields + 4 + 4 * i;
        e + kit::u32_at(meta, e) as usize
    }

    fn patched(m: &Msg, f: impl FnOnce(&mut Vec<u8>)) -> Msg {
        let mut meta = m.meta.clone();
        f(&mut meta);
        Msg {
            meta,
            body: m.body.clone(),
        }
    }

    /// Root offset, one vtable at 4 with `entries`, the root table at `pos` with `obj_len`,
    /// in `len` zero bytes.
    fn raw(pos: usize, obj_len: u16, entries: &[u16], len: usize) -> Vec<u8> {
        let mut b = vec![0u8; len];
        kit::put_u32(&mut b, 0, pos as u32);
        kit::put_u16(&mut b, 4, (4 + 2 * entries.len()) as u16);
        kit::put_u16(&mut b, 6, obj_len);
        for (i, e) in entries.iter().enumerate() {
            kit::put_u16(&mut b, 8 + 2 * i, *e);
        }
        kit::put_u32(&mut b, pos, (pos - 4) as u32);
        b
    }

    fn root_err(b: &[u8], spec: Spec) -> Option<IpcError> {
        Fb::new(b).root(spec).err()
    }

    #[test]
    fn absent_fields_take_defaults() {
        let mut t = Tb::default();
        t.set_int(0, 2, 4);
        t.set_int(1, 1, 1);
        let meta = kit::write_tree(&t);
        let fb = Fb::new(&meta);
        let Ok(root) = fb.root(MESSAGE) else {
            panic!("valid root rejected")
        };
        assert_eq!(root.i16(0, 0), Ok(4));
        assert_eq!(root.u8(1, 0), Ok(1));
        assert_eq!(root.i64(3, 7), Ok(7), "id beyond the vtable");
        assert!(matches!(root.table(2, &[]), Ok(None)));
        assert!(fb.finish().is_ok());
        // A 0 entry inside the vtable.
        t.set_int(3, 8, 9);
        let meta = kit::write_tree(&t);
        let fb = Fb::new(&meta);
        let Ok(root) = fb.root(MESSAGE) else {
            panic!("valid root rejected")
        };
        assert!(matches!(root.table(2, &[]), Ok(None)));
        assert_eq!(root.i64(3, 0), Ok(9));
    }

    #[test]
    fn table_structure_is_checked() {
        const I32: Spec = &[(0, 4)];
        let ok = raw(16, 8, &[4], 32);
        let fb = Fb::new(&ok);
        assert!(matches!(fb.root(I32).map(|t| t.i32(0, 1)), Ok(Ok(0))));
        let flat = Some(IpcError::Flatbuffer);
        let mut b = ok.clone();
        kit::put_u32(&mut b, 16, 1000);
        assert_eq!(root_err(&b, I32), flat, "soffset before the buffer");
        kit::put_u32(&mut b, 16, (-100i32) as u32);
        assert_eq!(root_err(&b, I32), flat, "soffset past the end");
        let mut b = ok.clone();
        kit::put_u16(&mut b, 4, 7);
        assert_eq!(root_err(&b, I32), flat, "vt_len odd");
        kit::put_u16(&mut b, 4, 2);
        assert_eq!(root_err(&b, I32), flat, "vt_len 2");
        kit::put_u16(&mut b, 4, 1000);
        assert_eq!(root_err(&b, I32), flat, "vtable past the end");
        let mut b = ok.clone();
        kit::put_u16(&mut b, 6, 2);
        assert_eq!(root_err(&b, I32), flat, "obj_len 2");
        kit::put_u16(&mut b, 6, 100);
        assert_eq!(root_err(&b, I32), flat, "object past the end");
        kit::put_u16(&mut b, 6, 6);
        assert_eq!(root_err(&b, I32), flat, "field end beyond obj_len");
        assert_eq!(
            root_err(&raw(16, 8, &[2], 32), &[(0, 1)]),
            flat,
            "field inside the soffset header"
        );
        assert_eq!(
            root_err(&raw(16, 8, &[4, 5], 32), &[(0, 2), (1, 1)]),
            flat,
            "overlapping fields"
        );
        assert_eq!(
            root_err(&raw(18, 8, &[4], 32), I32),
            flat,
            "table at % 4 == 2"
        );
        assert_eq!(
            root_err(&raw(16, 16, &[4], 40), &[(0, 8)]),
            flat,
            "i64 at % 8 == 4"
        );
        assert_eq!(
            root_err(&raw(16, 8, &[5], 32), &[(0, 2)]),
            flat,
            "i16 at an odd position"
        );
        assert_eq!(
            root_err(&raw(16, 8, &[4, 4], 32), I32),
            Some(IpcError::Unsupported("field")),
            "a non-zero entry outside the spec"
        );
        let mut b = raw(16, 8, &[4], 32);
        kit::put_u32(&mut b, 0, 1000);
        assert_eq!(root_err(&b, I32), flat, "root past the end");
        assert_eq!(root_err(&[0, 0], I32), flat, "no root");
    }

    #[test]
    fn strings_are_bounded_terminated_and_utf8() {
        const STR: Spec = &[(0, 4)];
        let mut ok = raw(16, 8, &[4], 32);
        kit::put_u32(&mut ok, 20, 4); // → 24
        kit::put_u32(&mut ok, 24, 3);
        ok[28..31].copy_from_slice(b"abc");
        let fb = Fb::new(&ok);
        assert!(matches!(
            fb.root(STR).map(|t| t.str(0)),
            Ok(Ok(Some("abc")))
        ));
        assert_eq!(fb.finish(), Ok(32));
        let str_err = |b: &[u8]| match Fb::new(b).root(STR) {
            Ok(t) => t.str(0).err(),
            Err(e) => Some(e),
        };
        let flat = Some(IpcError::Flatbuffer);
        let mut b = ok.clone();
        b[31] = 1;
        assert_eq!(str_err(&b), flat, "terminator 1");
        assert_eq!(str_err(&ok[..31]), flat, "no NUL");
        let mut b = ok.clone();
        kit::put_u32(&mut b, 24, 1000);
        assert_eq!(str_err(&b), flat, "length past the end");
        let mut b = ok.clone();
        kit::put_u32(&mut b, 20, 0);
        assert_eq!(str_err(&b), flat, "zero uoffset (its own position)");
        let mut b = ok.clone();
        kit::put_u32(&mut b, 20, 1000);
        assert_eq!(str_err(&b), flat, "target past the end");
        let mut b = ok.clone();
        kit::put_u32(&mut b, 20, 6);
        assert_eq!(str_err(&b), flat, "length prefix at % 4 == 2");
        let mut b = ok.clone();
        b[28] = 0xFF;
        assert_eq!(str_err(&b), Some(IpcError::Utf8));
    }

    #[test]
    fn vectors_are_bounded_and_aligned() {
        const VEC: Spec = &[(0, 4)];
        // Struct vector: prefix at 28, data at 32 (≡ 0 mod 8), one 16-byte struct.
        let mut ok = raw(16, 8, &[4], 48);
        kit::put_u32(&mut ok, 20, 8); // → 28
        kit::put_u32(&mut ok, 28, 1);
        let s_err = |b: &[u8], max: usize| match Fb::new(b).root(VEC) {
            Ok(t) => t.structs(0, 16, max).err(),
            Err(e) => Some(e),
        };
        assert_eq!(s_err(&ok, 4), None);
        let flat = Some(IpcError::Flatbuffer);
        assert_eq!(s_err(&ok, 0), flat, "more than max elements");
        let mut b = ok.clone();
        kit::put_u32(&mut b, 28, 100);
        assert_eq!(s_err(&b, 128), flat, "forward target, length past the end");
        let mut b = raw(16, 8, &[4], 48);
        kit::put_u32(&mut b, 20, 4); // prefix at 24, data at 28 (≡ 4 mod 8)
        kit::put_u32(&mut b, 24, 1);
        assert_eq!(s_err(&b, 4), flat, "struct data at % 8 == 4");
        let mut b = ok.clone();
        kit::put_u32(&mut b, 20, 0);
        assert_eq!(s_err(&b, 4), flat, "zero uoffset");
        // Table vector with its prefix at % 4 == 2.
        let mut b = raw(16, 8, &[4], 48);
        kit::put_u32(&mut b, 20, 6);
        let t_err = match Fb::new(&b).root(VEC) {
            Ok(t) => t.tables(0, 4, &[]).err(),
            Err(e) => Some(e),
        };
        assert_eq!(t_err, flat, "vector prefix at % 4 == 2");
    }

    /// A root table with field 0 = a vector of `n` empty tables sharing one vtable.
    fn many_tables(n: usize) -> Vec<u8> {
        // [0 root=16][4 vt_empty: 4,4][8 vt_root: 6,8,4][16 root: soffset 8, uoffset → 24]
        // [24 vector: n, n offsets][tables, 4 bytes each, soffset → 4]
        let vec_at = 24;
        let first = vec_at + 4 + 4 * n;
        let mut b = vec![0u8; first + 4 * n];
        kit::put_u32(&mut b, 0, 16);
        kit::put_u16(&mut b, 4, 4);
        kit::put_u16(&mut b, 6, 4);
        kit::put_u16(&mut b, 8, 6);
        kit::put_u16(&mut b, 10, 8);
        kit::put_u16(&mut b, 12, 4);
        kit::put_u32(&mut b, 16, 8);
        kit::put_u32(&mut b, 20, 4);
        kit::put_u32(&mut b, vec_at, n as u32);
        for i in 0..n {
            let e = vec_at + 4 + 4 * i;
            let t = first + 4 * i;
            kit::put_u32(&mut b, e, (t - e) as u32);
            kit::put_u32(&mut b, t, (t - 4) as u32);
        }
        b
    }

    #[test]
    fn at_most_512_tables() {
        let count = |n: usize| {
            let b = many_tables(n);
            let fb = Fb::new(&b);
            let r = fb
                .root(&[(0, 4)])
                .and_then(|t| t.tables(0, 1000, &[]))
                .map(|v| v.len());
            (r, fb.finish().is_ok())
        };
        assert_eq!(count(511), (Ok(511), true), "root + 511 = 512 tables");
        assert_eq!(count(512).0, Err(IpcError::Flatbuffer), "513 tables");
    }

    #[test]
    fn objects_never_alias() {
        // (a) A table's obj_len reaching into the next table.
        // [0 root=16][4 vt_sub: 4,4][8 vt_root: 6,8,4][16 root: soffset 8, uoffset → 24]
        // [24 sub: soffset 20]
        let mut ok = vec![0u8; 32];
        kit::put_u32(&mut ok, 0, 16);
        kit::put_u16(&mut ok, 4, 4);
        kit::put_u16(&mut ok, 6, 4);
        kit::put_u16(&mut ok, 8, 6);
        kit::put_u16(&mut ok, 10, 8);
        kit::put_u16(&mut ok, 12, 4);
        kit::put_u32(&mut ok, 16, 8);
        kit::put_u32(&mut ok, 20, 4);
        kit::put_u32(&mut ok, 24, 20);
        let sub = |b: &[u8]| {
            let fb = Fb::new(b);
            let r = fb.root(&[(0, 4)]).and_then(|t| t.table(0, &[]).map(|_| ()));
            r.and_then(|()| fb.finish().map(|_| ()))
        };
        assert_eq!(sub(&ok), Ok(()));
        let mut b = ok.clone();
        kit::put_u16(&mut b, 10, 12);
        assert_eq!(
            sub(&b),
            Err(IpcError::Flatbuffer),
            "table into the next table"
        );

        // (b) A struct vector enlarged over the following string.
        let mut ok = raw(16, 12, &[4, 8], 72);
        kit::put_u32(&mut ok, 20, 8); // vector prefix at 28, data 32..48
        kit::put_u32(&mut ok, 28, 1);
        kit::put_u32(&mut ok, 24, 24); // string at 48
        kit::put_u32(&mut ok, 48, 2);
        ok[52..54].copy_from_slice(b"hi");
        let both = |b: &[u8]| {
            let fb = Fb::new(b);
            let r = fb.root(&[(0, 4), (1, 4)]).and_then(|t| {
                t.structs(0, 16, 4)?;
                t.str(1).map(|_| ())
            });
            r.and_then(|()| fb.finish().map(|_| ()))
        };
        assert_eq!(both(&ok), Ok(()));
        let mut b = ok.clone();
        kit::put_u32(&mut b, 28, 2);
        assert_eq!(both(&b), Err(IpcError::Flatbuffer), "vector over a string");

        // (c) A string whose uoffset lands inside a vtable (vtable after its table).
        // [0 root=8][8 table: soffset -8, uoffset → 20][16 vtable: 6, 8, 4][20: "4 bytes"]
        let mut b = vec![0u8; 32];
        kit::put_u32(&mut b, 0, 8);
        kit::put_u32(&mut b, 8, (-8i32) as u32);
        kit::put_u32(&mut b, 12, 8);
        kit::put_u16(&mut b, 16, 6);
        kit::put_u16(&mut b, 18, 8);
        kit::put_u16(&mut b, 20, 4);
        let fb = Fb::new(&b);
        let r = fb.root(&[(0, 4)]).and_then(|t| t.str(0).map(|_| ()));
        assert_eq!(
            r.and_then(|()| fb.finish().map(|_| ())),
            Err(IpcError::Flatbuffer),
            "string inside a vtable"
        );

        // The counter's data SCHEMA message: its Field tables share vtables, and it passes.
        let frames = counter();
        let i = kit::find_frame(&frames, kit::SCHEMA, 2, 0);
        assert_eq!(read(frames[i].msg(0)), Ok(()));
    }

    #[test]
    fn references_are_non_zero_and_forward() {
        let m = labels_schema();
        assert_eq!(read(&m), Ok(()));
        let root = kit::u32_at(&m.meta, 0) as usize;
        let header = |meta: &mut Vec<u8>| {
            let fp = kit::field_pos(meta, root, 2).unwrap_or_default();
            kit::put_u32(meta, fp, 0);
        };
        assert_eq!(
            read(&patched(&m, header)),
            Err(IpcError::Flatbuffer),
            "header"
        );
        let name = |meta: &mut Vec<u8>| {
            let f = field_table(meta, 0);
            let fp = kit::field_pos(meta, f, 0).unwrap_or_default();
            kit::put_u32(meta, fp, 0);
        };
        assert_eq!(
            read(&patched(&m, name)),
            Err(IpcError::Flatbuffer),
            "string"
        );
        let fields = |meta: &mut Vec<u8>| {
            let schema = kit::field_target(meta, root, 2);
            let fp = kit::field_pos(meta, schema, 1).unwrap_or_default();
            kit::put_u32(meta, fp, 0);
        };
        assert_eq!(
            read(&patched(&m, fields)),
            Err(IpcError::Flatbuffer),
            "vector"
        );
        // A vector length running past the end.
        let long = |meta: &mut Vec<u8>| {
            let schema = kit::field_target(meta, root, 2);
            let v = kit::field_target(meta, schema, 1);
            kit::put_u32(meta, v, 1000);
        };
        assert_eq!(
            read(&patched(&m, long)),
            Err(IpcError::Flatbuffer),
            "vector length"
        );
    }

    /// Sets to 0 the `uoffset` that targets `target`'s length prefix.
    fn zero_ref_to(meta: &mut [u8], target: usize) {
        let fp = (0..target)
            .step_by(4)
            .find(|fp| *fp + kit::u32_at(meta, *fp) as usize == target)
            .unwrap_or_else(|| panic!("no reference to {target}"));
        kit::put_u32(meta, fp, 0);
    }

    fn find(meta: &[u8], s: &[u8]) -> usize {
        meta.windows(s.len())
            .position(|w| w == s)
            .unwrap_or_else(|| panic!("{s:?} not found"))
    }

    #[test]
    fn the_field_set_is_closed() {
        let m = labels_schema();
        let uns = |m: &Msg| read(m).err().map(|e| matches!(e, IpcError::Unsupported(_)));
        let with_md = m.edit(|t| {
            t.f.insert(4, V::Tv(vec![kit::kv("a", "b")]));
        });
        assert_eq!(uns(&with_md), Some(true), "Message.custom_metadata");
        let root = kit::u32_at(&with_md.meta, 0) as usize;
        let past = patched(&with_md, |meta| {
            let fp = kit::field_pos(meta, root, 4).unwrap_or_default();
            kit::put_u32(meta, fp, 0x7FFF_0000);
        });
        assert_eq!(
            uns(&past),
            Some(true),
            "an offset past the end, never followed"
        );
        let features = m.edit(|t| {
            t.t_mut(2)
                .f
                .insert(3, V::Sv(8, 1i64.to_le_bytes().to_vec()));
        });
        assert_eq!(uns(&features), Some(true), "Schema.features");
        let field_md = m.edit(|t| {
            t.t_mut(2).tv_mut(1)[0]
                .f
                .insert(6, V::Tv(vec![kit::kv("zzzz", "v")]));
        });
        let zero_key = patched(&field_md, |meta| {
            let s = find(meta, b"zzzz") - 4;
            zero_ref_to(meta, s);
        });
        assert_eq!(
            uns(&zero_key),
            Some(true),
            "Field.custom_metadata, not followed"
        );
        let dict = m.edit(|t| {
            let mut d = Tb::default();
            d.set_int(0, 8, 1);
            t.t_mut(2).tv_mut(1)[2].f.insert(4, V::T(d));
        });
        assert_eq!(uns(&dict), Some(true), "Field.dictionary");
        let unknown = m.edit(|t| {
            t.f.insert(7, V::S(vec![0]));
        });
        assert_eq!(uns(&unknown), Some(true), "unknown vtable entry");
    }

    #[test]
    fn bools_and_key_values() {
        let m = labels_schema();
        let nullable2 = m.edit(|t| t.t_mut(2).tv_mut(1)[2].set_int(1, 1, 2));
        assert_eq!(read(&nullable2), Err(IpcError::Flatbuffer));
        let signed = m.edit(|t| t.t_mut(2).tv_mut(1)[0].t_mut(3).set_int(1, 1, 255));
        assert_eq!(read(&signed), Err(IpcError::Flatbuffer));
        let no_value = m.edit(|t| {
            t.t_mut(2).tv_mut(2)[0].f.remove(&1);
        });
        assert_eq!(read(&no_value), Err(IpcError::Flatbuffer));
        let no_key = m.edit(|t| {
            t.t_mut(2).tv_mut(2)[0].f.remove(&0);
        });
        assert_eq!(read(&no_key), Err(IpcError::Flatbuffer));
    }

    #[test]
    fn nesting_depth_at_most_4() {
        let nest = |depth: usize| {
            let mut f = kit::field("item", false, 5, Tb::default(), Vec::new());
            for _ in 1..depth {
                f = kit::field("item", false, 12, Tb::default(), vec![f]);
            }
            read(&kit::schema_msg(vec![f], &[]))
        };
        assert_eq!(nest(4), Ok(()));
        assert_eq!(nest(5), Err(IpcError::Flatbuffer));
    }

    #[test]
    fn message_table_structure() {
        let m = labels_schema();
        let flat = Err(IpcError::Flatbuffer);
        let root = kit::u32_at(&m.meta, 0) as usize;
        let rvt = vt_of(&m.meta, root);
        let in_header = patched(&m, |meta| {
            let f = field_table(meta, 2);
            let vt = vt_of(meta, f);
            kit::put_u16(meta, vt + 4 + 2, 2);
        });
        assert_eq!(read(&in_header), flat, "Field.nullable at offset 2");
        assert_eq!(
            read(&patched(&m, |b| kit::put_u16(b, rvt, 2))),
            flat,
            "vt_len 2"
        );
        assert_eq!(
            read(&patched(&m, |b| kit::put_u16(b, rvt, 0x7FFE))),
            flat,
            "vtable past the buffer"
        );
        assert_eq!(
            read(&patched(&m, |b| kit::put_u16(b, rvt + 2, 2))),
            flat,
            "obj_len 2"
        );
        let short = patched(&m, |b| {
            let n = (kit::u16_at(b, rvt) as usize - 4) / 2;
            let ends = (0..n.min(4) as u16)
                .filter_map(|i| {
                    let o = kit::u16_at(b, rvt + 4 + 2 * i as usize);
                    let w = [2u16, 1, 4, 8][i as usize];
                    (o != 0).then_some(o + w)
                })
                .max()
                .unwrap_or_default();
            kit::put_u16(b, rvt + 2, ends - 1);
        });
        assert_eq!(read(&short), flat, "a field past obj_len");
        let overlap = patched(&m, |b| {
            let v = kit::u16_at(b, rvt + 4);
            kit::put_u16(b, rvt + 6, v + 1);
        });
        assert_eq!(read(&overlap), flat, "version and header_type overlap");
    }

    #[test]
    fn schema_metadata_keys_are_exact() {
        let decode_with = |edit: &dyn Fn(&mut Tb)| {
            let mut frames = counter();
            let m = frames[0].msg(0).edit(edit);
            *frames[0].msg_mut(0) = m;
            let ev = run(&kit::encode(&frames));
            (failure(&ev, 1), ev)
        };
        let (f, ev) = decode_with(&|_| {});
        assert_eq!(f, None, "{ev:?}");
        let (f, ev) = decode_with(&|t| kit::set_kv(t, "x.unknown", "1"));
        assert!(
            matches!(f, Some(PartError::Schema(_))),
            "unknown key: {ev:?}"
        );
        let (f, ev) = decode_with(&|t| {
            t.t_mut(2)
                .tv_mut(2)
                .push(kit::kv("dash.schema", "labels/1"))
        });
        assert!(
            matches!(f, Some(PartError::Schema(_))),
            "duplicate key: {ev:?}"
        );
        let (f, ev) = decode_with(&|t| {
            t.t_mut(2)
                .tv_mut(2)
                .retain(|kv| kv.string(0).as_deref() != Some("dash.time_unit"));
        });
        assert!(
            matches!(f, Some(PartError::Schema(_))),
            "missing key: {ev:?}"
        );
        let (f, _) = decode_with(&|t| {
            t.t_mut(2).tv_mut(2)[0].f.remove(&1);
        });
        assert_eq!(f, Some(PartError::Ipc(IpcError::Flatbuffer)), "no value");
    }

    #[test]
    fn frame_and_body_lengths() {
        // The labels SCHEMA with bodyLength 64 and 64 zero body bytes.
        let mut frames = counter();
        let m = frames[0].msg(0).with_body(vec![0; 64]);
        *frames[0].msg_mut(0) = m;
        let ev = run(&kit::encode(&frames));
        assert_eq!(
            failure(&ev, 1),
            Some(PartError::Ipc(IpcError::Layout("body length")))
        );
        assert!(
            !ev.iter()
                .any(|e| matches!(e, Event::Grid { .. } | Event::Chunk { .. }))
        );
        // The planned META: its batch bodyLength and payload_len each + 1, one zero byte added.
        let body = kit::fixture("promql-range-counter");
        let frames = kit::parse(&body);
        let fi = kit::find_frame(&frames, kit::META, 2, 0);
        let start = kit::frame_offsets(&body)[fi];
        let (meta_at, l, _) = kit::locate(&body, fi, 1);
        let meta = &body[meta_at..meta_at + l];
        let root = kit::u32_at(meta, 0) as usize;
        let bl_at = meta_at + kit::field_pos(meta, root, 3).unwrap_or_default();
        let mut payload = body[start + 16..kit::frame_offsets(&body)[fi + 1]].to_vec();
        let rel = bl_at - (start + 16);
        let bl = kit::i64_at(&payload, rel);
        // The batch is followed by EOS: grow the batch body by one zero byte before it.
        kit::put_i64(&mut payload, rel, bl + 1);
        let eos = payload.len() - 8;
        payload.insert(eos, 0);
        let mut frames = frames;
        frames[fi] = F::raw(kit::META, 0, 2, 0, payload);
        let ev = run(&kit::encode(&frames));
        assert_eq!(
            failure(&ev, 1),
            Some(PartError::Stream(DsfError::Malformed("frame length")))
        );
        assert!(!ev.iter().any(|e| matches!(
            e,
            Event::Grid { .. } | Event::Chunk { .. } | Event::Coverage { .. }
        )));
    }

    #[test]
    fn the_fixtures_pass_the_length_rules() {
        let mut messages = 0;
        for name in kit::FIXTURES {
            let body = kit::fixture(name);
            for at in kit::frame_offsets(&body) {
                assert_eq!(kit::u32_at(&body, at + 8) % 8, 0, "{name}: payload length");
            }
            for f in kit::parse(&body) {
                for p in &f.pieces {
                    if let Piece::M(m) = p {
                        messages += 1;
                        if m.tree().int(1) == 1 {
                            assert!(m.body.is_empty(), "{name}: schema body");
                        }
                        assert_eq!(m.body.len() % 8, 0, "{name}: batch body");
                    }
                }
            }
            let ev = run(&body);
            assert!(
                !ev.iter().any(|e| matches!(e, Event::Failed { .. })),
                "{name}: {ev:?}"
            );
            assert_eq!(
                ev.last(),
                Some(&Event::Verdict(crate::Verdict::Complete)),
                "{name}"
            );
        }
        assert_eq!(messages, 62);
    }
}

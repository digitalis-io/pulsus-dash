#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `metric_matrix.grid/1` encode, slab and zero-copy decode (T04-002, T04-010, T04-015): plan #24
//! tests 4, 5, 5b and 6.

use std::sync::Arc;

use arrow_ipc::writer::{IpcWriteOptions, StreamWriter};
use arrow_schema::{DataType, Field, Metadata, Schema};
use dash_wire::{
    GridDecoder, GridEncoder, GridMeta, Slab, WireError, check_message, grid_schema, hostile_cases,
    series_per_batch,
};

fn meta(len: u32) -> GridMeta {
    GridMeta {
        start_ms: 1_700_000_000_000,
        step_ms: 10_000,
        len,
        result: "metric".into(),
        source: "synth".into(),
        unit: "s".into(),
    }
}

/// Row `r`: `k·(r + 1) + 0.5`, NULL at 5 and 6, NaN at 7, +Inf at 8, −Inf at 9.
fn row(r: u32, len: usize) -> (Vec<f64>, Vec<bool>) {
    let mut v: Vec<f64> = (0..len)
        .map(|k| k as f64 * f64::from(r + 1) + 0.5)
        .collect();
    let mut ok = vec![true; len];
    ok[5] = false;
    ok[6] = false;
    v[5] = 0.0;
    v[6] = 0.0;
    v[7] = f64::NAN;
    v[8] = f64::INFINITY;
    v[9] = f64::NEG_INFINITY;
    (v, ok)
}

fn encode(m: &GridMeta, rows: &[(Vec<f64>, Vec<bool>)]) -> (Vec<u8>, Vec<u8>) {
    let (mut enc, schema) = GridEncoder::new(m).unwrap();
    let refs: Vec<(&[f64], &[bool])> = rows.iter().map(|(v, b)| (&v[..], &b[..])).collect();
    let batch = enc.batch(0, &refs).unwrap();
    (schema, batch)
}

#[test]
fn grid_roundtrip_zero_copy() {
    let m = meta(1_000);
    let rows: Vec<_> = (0..3).map(|r| row(r, 1_000)).collect();
    let (schema, batch) = encode(&m, &rows);
    let dec = GridDecoder::new(&Slab::copy_from(&schema).unwrap()).unwrap();
    assert_eq!(dec.meta(), &m);
    let slab = Slab::copy_from(&batch).unwrap();
    let got = dec.decode(&slab).unwrap();
    assert_eq!(got.len(), 3);
    let range = slab.range();
    for (r, s) in got.iter().enumerate() {
        assert_eq!(s.series_id, r as u32);
        let (v, ok) = &rows[r];
        let bits: Vec<u64> = s.values.iter().map(|x| x.to_bits()).collect();
        let want: Vec<u64> = v.iter().map(|x| x.to_bits()).collect();
        for k in 0..1_000 {
            assert_eq!(s.is_valid(k), ok[k], "row {r} k {k}");
            if ok[k] {
                assert_eq!(bits[k], want[k], "row {r} k {k}");
            }
        }
        let start = s.values.as_ptr() as usize;
        let end = start + 8 * s.values.len();
        assert!(
            range.start <= start && end <= range.end,
            "row {r}: values outside the slab"
        );
    }
}

/// The schema message of an arbitrary Arrow schema (without the end-of-stream marker).
fn schema_message(s: Schema) -> Vec<u8> {
    let opts = IpcWriteOptions::try_new(64, false, arrow_ipc::MetadataVersion::V5).unwrap();
    let mut w = StreamWriter::try_new_with_options(Vec::new(), &s, opts).unwrap();
    std::mem::take(w.get_mut())
}

fn with_metadata(m: &GridMeta, edit: impl FnOnce(&mut Metadata)) -> Vec<u8> {
    let s = grid_schema(m);
    let mut md = s.metadata().clone();
    edit(&mut md);
    schema_message(s.with_metadata(md))
}

fn new_err(bytes: &[u8]) -> WireError {
    GridDecoder::new(&Slab::copy_from(bytes).unwrap()).unwrap_err()
}

#[test]
fn grid_rejects_bad_input() {
    let m = meta(100);
    let major2 = with_metadata(&m, |md| {
        md.insert("dash.schema", "metric_matrix.grid/2");
    });
    assert_eq!(
        new_err(&major2),
        WireError::UnknownSchema("metric_matrix.grid/2".into())
    );
    let no_step = with_metadata(&m, |md| {
        md.remove("dash.grid.step_ms");
    });
    assert_eq!(new_err(&no_step), WireError::Metadata("dash.grid.step_ms"));
    let step0 = with_metadata(&m, |md| {
        md.insert("dash.grid.step_ms", "0");
    });
    assert_eq!(new_err(&step0), WireError::Metadata("dash.grid.step_ms"));
    let s = grid_schema(&m);
    let f32_values = Schema::new(vec![
        s.field(0).clone(),
        Field::new(
            "values",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), 100),
            false,
        ),
    ])
    .with_metadata(s.metadata().clone());
    assert_eq!(
        new_err(&schema_message(f32_values)),
        WireError::Schema("values")
    );

    let rows: Vec<_> = (0..2).map(|r| row(r, 100)).collect();
    let (schema, batch) = encode(&m, &rows);
    let dec = GridDecoder::new(&Slab::copy_from(&schema).unwrap()).unwrap();
    let decode = |b: &[u8]| dec.decode(&Slab::copy_from(b).unwrap()).unwrap_err();
    let truncated = WireError::Ipc("truncated message".into());
    assert_eq!(decode(&batch[..6]), truncated);
    assert_eq!(decode(&batch[..20]), truncated);
    assert_eq!(decode(&batch[..batch.len() - 8]), truncated);
    let mut longer = batch.clone();
    longer.extend_from_slice(&[0; 8]);
    assert_eq!(
        decode(&longer),
        WireError::Ipc("message length mismatch".into())
    );
    assert_eq!(new_err(&batch), WireError::NoSchema);
    assert_eq!(
        dec.decode(&Slab::copy_from(&batch).unwrap()).unwrap().len(),
        2
    );
}

#[test]
fn grid_rejects_bad_time_unit_and_nullable_parents() {
    let m = meta(100);
    let bad_unit = with_metadata(&m, |md| {
        md.insert("dash.time_unit", "s");
    });
    assert_eq!(new_err(&bad_unit), WireError::Metadata("dash.time_unit"));
    let no_unit = with_metadata(&m, |md| {
        md.remove("dash.time_unit");
    });
    assert_eq!(new_err(&no_unit), WireError::Metadata("dash.time_unit"));
    let s = grid_schema(&m);
    let nullable = |i: usize| {
        let fields: Vec<Field> = (0..2)
            .map(|j| {
                let f = s.field(j).clone();
                if i == j { f.with_nullable(true) } else { f }
            })
            .collect();
        schema_message(Schema::new(fields).with_metadata(s.metadata().clone()))
    };
    assert_eq!(new_err(&nullable(0)), WireError::Schema("series_id"));
    assert_eq!(new_err(&nullable(1)), WireError::Schema("values"));
}

/// A batch message of `m`'s grid whose row 1 has a null `series_id` (`id_null`) or a null
/// `values` list, written with nullable parent fields.
fn null_parent_batch(m: &GridMeta, id_null: bool) -> Vec<u8> {
    use arrow_array::{FixedSizeListArray, Float64Array, RecordBatch, UInt32Array};
    let s = grid_schema(m);
    let fields: Vec<Field> = (0..2)
        .map(|j| s.field(j).clone().with_nullable(true))
        .collect();
    let schema = Arc::new(Schema::new(fields).with_metadata(s.metadata().clone()));
    let ids = if id_null {
        UInt32Array::from(vec![Some(0), None])
    } else {
        UInt32Array::from(vec![Some(0), Some(1)])
    };
    let item = Arc::new(Field::new("item", DataType::Float64, true));
    let child = Float64Array::from(vec![1.0; 2 * m.len as usize]);
    let lists = FixedSizeListArray::try_new(
        item,
        m.len as i32,
        Arc::new(child),
        (!id_null).then(|| arrow_buffer::NullBuffer::from(vec![true, false])),
    )
    .unwrap();
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(ids), Arc::new(lists)]).unwrap();
    let opts = IpcWriteOptions::try_new(64, false, arrow_ipc::MetadataVersion::V5).unwrap();
    let mut w = StreamWriter::try_new_with_options(Vec::new(), &schema, opts).unwrap();
    std::mem::take(w.get_mut());
    w.write(&batch).unwrap();
    std::mem::take(w.get_mut())
}

#[test]
fn grid_rejects_null_parents() {
    let m = meta(100);
    let (schema, _) = encode(&m, &[row(0, 100)]);
    let dec = GridDecoder::new(&Slab::copy_from(&schema).unwrap()).unwrap();
    for (id_null, field) in [(true, "series_id"), (false, "values")] {
        let err = dec
            .decode(&Slab::copy_from(&null_parent_batch(&m, id_null)).unwrap())
            .unwrap_err();
        // The decoder's schema is always non-nullable (nullable parents fail `GridDecoder::new`),
        // so Arrow's validation rejects the batch before any row is extracted.
        assert!(
            matches!(&err, WireError::Ipc(e) if e.contains(&format!("'{field}' is declared as non-nullable"))),
            "{field}: {err:?}"
        );
    }
}

#[test]
fn check_message_hostile() {
    let cases = hostile_cases();
    let names: Vec<&str> = cases.iter().map(|c| c.0).collect();
    assert_eq!(names.len(), 4, "{names:?}");
    let truncated = format!("{:?}", WireError::Ipc("truncated message".into()));
    let mismatch = format!("{:?}", WireError::Ipc("message length mismatch".into()));
    let expected: Vec<&str> = cases.iter().map(|c| c.2.as_str()).collect();
    assert_eq!(
        expected,
        vec![
            &truncated[..],
            &truncated[..],
            &truncated[..],
            &mismatch[..]
        ]
    );
    for (name, bytes, want) in &cases {
        let got = check_message(bytes).unwrap_err();
        assert_eq!(&format!("{got:?}"), want, "{name}");
    }
    assert_eq!(cases[0].1.len(), 16);
    assert_eq!(cases[1].1.len(), 16);
}

#[test]
fn slab_aligned() {
    let s = Slab::copy_from(&[1, 2, 3]).unwrap();
    assert_eq!(s.range().start % 64, 0);
    assert_eq!(s.range().len(), 3);
    assert_eq!(s.buffer().as_slice(), &[1, 2, 3]);
    assert_eq!(series_per_batch(100_000), 1);
    assert_eq!(series_per_batch(20_000), 6);
    assert_eq!(series_per_batch(1_000), 64);
}

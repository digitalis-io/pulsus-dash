//! unit:chunk-id-spaces (plan #68 C1 §3.4, §5; the Part D seam): stream ids `0..2⁶³` (the decoder),
//! local ids `2⁶³..2⁶⁴` (the render worker's own chunks); an allocator never leaves its space.
mod common;
mod support;

use common::fixture;
use dash_wire::{ChunkError, ChunkId, Event, IdAlloc, IdSpace, PartError};
use support::{failure, run};

const LOCAL0: u64 = 1 << 63;

fn chunk_ids(ev: &[Event]) -> Vec<u64> {
    ev.iter()
        .filter_map(|e| match e {
            Event::Chunk { chunk, .. } => Some(chunk.id.0),
            _ => None,
        })
        .collect()
}

#[test]
fn allocators_stay_in_their_space() {
    let mut local = IdAlloc::new(IdSpace::Local);
    assert_eq!(local.next(), Some(ChunkId(LOCAL0)));
    assert_eq!(local.next(), Some(ChunkId(LOCAL0 + 1)));
    let mut stream = IdAlloc::new(IdSpace::Stream);
    assert_eq!(stream.next(), Some(ChunkId(0)));

    let last_local = IdAlloc::starting_at(IdSpace::Local, u64::MAX);
    let Ok(mut last_local) = last_local else {
        panic!("(Local, u64::MAX): {last_local:?}")
    };
    assert_eq!(last_local.next(), Some(ChunkId(u64::MAX)));
    assert_eq!(last_local.next(), None);
    assert_eq!(last_local.next(), None);

    let last_stream = IdAlloc::starting_at(IdSpace::Stream, LOCAL0 - 1);
    let Ok(mut last_stream) = last_stream else {
        panic!("(Stream, 2^63 - 1): {last_stream:?}")
    };
    assert_eq!(last_stream.next(), Some(ChunkId(LOCAL0 - 1)));
    assert_eq!(last_stream.next(), None);

    assert_eq!(
        IdAlloc::starting_at(IdSpace::Stream, LOCAL0).err(),
        Some(ChunkError::Ids)
    );
    assert_eq!(
        IdAlloc::starting_at(IdSpace::Local, LOCAL0 - 1).err(),
        Some(ChunkError::Ids)
    );
}

#[test]
fn the_decoder_allocates_stream_ids_only() {
    // A first id outside the stream space: the first chunk fails with `ids`.
    let e = run(&fixture("promql-range-counter"), LOCAL0);
    assert_eq!(chunk_ids(&e), Vec::<u64>::new(), "{e:?}");
    let reason = failure(&e, 2);
    assert_eq!(
        reason.as_ref().map(ToString::to_string).as_deref(),
        Some("ids")
    );
    // The last stream id is used once; the next chunk fails with `ids` and never reaches 2⁶³.
    let e = run(&fixture("promql-range-counter"), LOCAL0 - 1);
    assert_eq!(chunk_ids(&e), [LOCAL0 - 1]);
    assert_eq!(failure(&e, 2), Some(PartError::Chunk(ChunkError::Ids)));
}

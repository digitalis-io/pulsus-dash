//! DSF frames (T04 §5.1, T04-009; plan #68 B2 §3.2): the 16-byte header and a pull splitter.

use crate::bytes::SharedBytes;

pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 16;
pub const MAX_PAYLOAD: u32 = 64 << 20;

/// The frame type (T04 §5.1 order).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameType {
    Schema = 1,
    Batch,
    Meta,
    End,
    Error,
    Progress,
    Event,
    Ping,
}

/// A parsed frame header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameHeader {
    pub kind: FrameType,
    pub flags: u16,
    pub part_id: u32,
    pub payload_len: u32,
    pub rank: u16,
}

/// Why the byte stream cannot be read further.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum DsfError {
    #[error("unsupported DSF version {0}")]
    Version(u8),
    #[error("reserved header field {0} is not 0")]
    Reserved(u16),
    #[error("frame type {0} not accepted")]
    FrameType(u8),
    #[error("payload of {0} bytes exceeds the maximum")]
    PayloadTooLarge(u32),
    #[error("unknown flag bits {0:#06x}")]
    Flags(u16),
    #[error("malformed frame: {0}")]
    Malformed(&'static str),
    #[error("input ended inside a frame or without END")]
    Truncated,
    #[error("frame after END")]
    AfterEnd,
    #[error("previous chunk not drained")]
    Busy,
    #[error("limit: {0}")]
    Limit(&'static str),
}

impl FrameHeader {
    pub const LAST: u16 = 1;
    pub const VOLATILE: u16 = 2;
    pub const CACHED: u16 = 4;

    /// Parses the first `HEADER_LEN` bytes of `b`.
    pub fn parse(_b: &[u8]) -> Result<Self, DsfError> {
        Err(DsfError::Malformed("not implemented"))
    }
}

/// One frame. `payload_offset` = the response-body offset of the payload's first byte (frame
/// start + 16).
#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub header: FrameHeader,
    pub payload: SharedBytes,
    pub payload_offset: u64,
}

/// Pull splitter: `push` stores one chunk, `next` yields one frame at a time.
#[derive(Debug, Default)]
pub struct FrameSplitter {}

impl FrameSplitter {
    pub fn new() -> Self {
        Self {}
    }

    pub fn push(&mut self, _chunk: SharedBytes) -> Result<(), DsfError> {
        Ok(())
    }

    pub fn next(&mut self) -> Result<Option<Frame>, DsfError> {
        Ok(None)
    }

    pub fn finish(&self) -> Result<(), DsfError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    //! unit:dsf-header, Rust side (plan #68 B2 §5; T04-009), plus the splitter basics.
    use super::*;

    const BYTES: [u8; 16] = [1, 2, 3, 0, 4, 3, 2, 1, 0x10, 0, 0, 0, 6, 5, 0, 0];

    #[test]
    fn parses_the_b1_header() {
        assert_eq!(
            FrameHeader::parse(&BYTES),
            Ok(FrameHeader {
                kind: FrameType::Batch,
                flags: 3,
                part_id: 0x0102_0304,
                payload_len: 16,
                rank: 0x0506,
            })
        );
    }

    #[test]
    fn rejects_bad_headers() {
        let with = |at: usize, v: u8| {
            let mut b = BYTES;
            b[at] = v;
            FrameHeader::parse(&b)
        };
        assert_eq!(with(0, 2), Err(DsfError::Version(2)));
        assert_eq!(with(15, 1), Err(DsfError::Reserved(0x0100)));
        assert_eq!(with(1, 0), Err(DsfError::FrameType(0)));
        assert_eq!(with(1, 9), Err(DsfError::FrameType(9)));
        assert_eq!(with(2, 8 | 1), Err(DsfError::Flags(9)));
        let mut b = BYTES;
        b[8..12].copy_from_slice(&(MAX_PAYLOAD + 1).to_le_bytes());
        assert_eq!(
            FrameHeader::parse(&b),
            Err(DsfError::PayloadTooLarge(MAX_PAYLOAD + 1))
        );
        b[8..12].copy_from_slice(&MAX_PAYLOAD.to_le_bytes());
        assert!(FrameHeader::parse(&b).is_ok());
        assert_eq!(FrameHeader::parse(&BYTES[..15]), Err(DsfError::Truncated));
    }

    fn frame_bytes(kind: u8, part: u32, payload: &[u8]) -> Vec<u8> {
        let mut b = vec![1, kind, 0, 0];
        b.extend_from_slice(&part.to_le_bytes());
        b.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        b.extend_from_slice(&[0, 0, 0, 0]);
        b.extend_from_slice(payload);
        b
    }

    #[test]
    fn splitter_slices_and_copies_only_spanning_payloads() {
        let mut body = frame_bytes(8, 0, &[]);
        body.extend(frame_bytes(2, 7, &[9; 24]));
        body.extend(frame_bytes(4, 0, &[]));
        // Split inside the second frame's payload.
        let (a, b) = body.split_at(16 + 16 + 5);
        let mut s = FrameSplitter::new();
        assert_eq!(s.push(SharedBytes::copy_from(a, 0)), Ok(()));
        let ping = s.next();
        assert!(
            matches!(&ping, Ok(Some(f)) if f.header.kind == FrameType::Ping && f.payload_offset == 16)
        );
        assert_eq!(s.next(), Ok(None));
        assert_eq!(s.finish(), Err(DsfError::Truncated));
        let second = SharedBytes::copy_from(b, a.len() % 64);
        assert_eq!(s.push(second.clone()), Ok(()));
        // Busy until drained.
        assert_eq!(s.push(second.clone()), Err(DsfError::Busy));
        let Ok(Some(f)) = s.next() else {
            panic!("no batch frame")
        };
        assert_eq!(f.header.part_id, 7);
        assert_eq!(f.payload.as_bytes(), &[9; 24]);
        assert_eq!(f.payload_offset, 32);
        // The copy keeps the payload's body position mod 64.
        assert_eq!(f.payload.as_bytes().as_ptr() as usize % 64, 32);
        let Ok(Some(end)) = s.next() else {
            panic!("no END")
        };
        assert_eq!(end.header.kind, FrameType::End);
        assert_eq!(s.next(), Ok(None));
        assert_eq!(s.finish(), Ok(()));
        drop((f, end));
        assert_eq!(second.strong_count(), 1, "nothing pinned");
    }
}

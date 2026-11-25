//! DSF frames (T04 §5.1, T04-009; plan #68 B2 §3.2): the 16-byte header and a pull splitter.

use crate::bytes::{PayloadBuf, SharedBytes};

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
    /// The flag bits wire v1 defines.
    pub const KNOWN_FLAGS: u16 = Self::LAST | Self::VOLATILE | Self::CACHED;

    /// Parses the first `HEADER_LEN` bytes of `b` (T04-009): version 1, a known type, known
    /// flag bits only, a zero reserved field and a payload of at most `MAX_PAYLOAD`.
    pub fn parse(b: &[u8]) -> Result<Self, DsfError> {
        let h: &[u8; HEADER_LEN] = b
            .get(..HEADER_LEN)
            .and_then(|h| h.try_into().ok())
            .ok_or(DsfError::Truncated)?;
        let [
            version,
            kind,
            f0,
            f1,
            p0,
            p1,
            p2,
            p3,
            l0,
            l1,
            l2,
            l3,
            r0,
            r1,
            z0,
            z1,
        ] = *h;
        if version != VERSION {
            return Err(DsfError::Version(version));
        }
        let reserved = u16::from_le_bytes([z0, z1]);
        if reserved != 0 {
            return Err(DsfError::Reserved(reserved));
        }
        let kind = match kind {
            1 => FrameType::Schema,
            2 => FrameType::Batch,
            3 => FrameType::Meta,
            4 => FrameType::End,
            5 => FrameType::Error,
            6 => FrameType::Progress,
            7 => FrameType::Event,
            8 => FrameType::Ping,
            other => return Err(DsfError::FrameType(other)),
        };
        let flags = u16::from_le_bytes([f0, f1]);
        if flags & !Self::KNOWN_FLAGS != 0 {
            return Err(DsfError::Flags(flags));
        }
        let payload_len = u32::from_le_bytes([l0, l1, l2, l3]);
        if payload_len > MAX_PAYLOAD {
            return Err(DsfError::PayloadTooLarge(payload_len));
        }
        Ok(Self {
            kind,
            flags,
            part_id: u32::from_le_bytes([p0, p1, p2, p3]),
            payload_len,
            rank: u16::from_le_bytes([r0, r1]),
        })
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

/// A frame whose header is known and whose payload spans chunks.
#[derive(Debug)]
struct Pending {
    header: FrameHeader,
    payload_offset: u64,
    buf: PayloadBuf,
}

/// Pull API: `push` stores one chunk (`Err(Busy)` unless the previous one is drained to at most
/// a partial frame); `next` yields one frame at a time, so no frame list is ever queued.
///
/// A frame inside one chunk is a slice (no copy). A frame spanning chunks: only its payload is
/// copied, once, into a buffer that keeps the payload's response-body position mod 64
/// (T04-015 as amended). The pending state is at most `HEADER_LEN + MAX_PAYLOAD` bytes.
/// After a header error every later call returns the same error: the stream cannot be
/// resynchronised.
#[derive(Debug, Default)]
pub struct FrameSplitter {
    /// Response-body offset of `cur[pos]` (or of the next byte to arrive).
    offset: u64,
    cur: Option<SharedBytes>,
    pos: usize,
    /// A header split across chunks.
    head: [u8; HEADER_LEN],
    head_len: usize,
    pending: Option<Pending>,
    failed: Option<DsfError>,
}

impl FrameSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    fn remaining(&self) -> usize {
        self.cur
            .as_ref()
            .map_or(0, |c| c.len().saturating_sub(self.pos))
    }

    pub fn push(&mut self, chunk: SharedBytes) -> Result<(), DsfError> {
        if let Some(e) = &self.failed {
            return Err(e.clone());
        }
        if self.remaining() > 0 {
            return Err(DsfError::Busy);
        }
        self.cur = Some(chunk);
        self.pos = 0;
        Ok(())
    }

    /// Takes up to `n` bytes of the current chunk.
    fn take(&mut self, n: usize) -> &[u8] {
        let n = n.min(self.remaining());
        let start = self.pos;
        self.pos += n;
        self.offset += n as u64;
        self.cur
            .as_ref()
            .and_then(|c| c.as_bytes().get(start..start + n))
            .unwrap_or_default()
    }

    fn fail(&mut self, e: DsfError) -> Result<Option<Frame>, DsfError> {
        self.failed = Some(e.clone());
        self.cur = None;
        self.pending = None;
        Err(e)
    }

    /// The next whole frame, or `None` until more bytes are pushed.
    #[allow(clippy::should_implement_trait)] // fallible pull, not an Iterator (plan §3.2)
    pub fn next(&mut self) -> Result<Option<Frame>, DsfError> {
        if let Some(e) = &self.failed {
            return Err(e.clone());
        }
        // A payload being filled across chunks.
        if let Some(mut p) = self.pending.take() {
            let missing = p.buf.missing();
            let src = self.take(missing);
            p.buf.extend(src);
            if p.buf.missing() == 0 {
                return Ok(Some(Frame {
                    header: p.header,
                    payload: p.buf.freeze(),
                    payload_offset: p.payload_offset,
                }));
            }
            self.pending = Some(p);
            self.cur = None;
            return Ok(None);
        }
        // The header, possibly split across chunks.
        let header = if self.head_len > 0 || self.remaining() < HEADER_LEN {
            let want = HEADER_LEN - self.head_len;
            let got = self.take(want).to_vec();
            let end = self.head_len + got.len();
            if let Some(dst) = self.head.get_mut(self.head_len..end) {
                dst.copy_from_slice(&got);
            }
            self.head_len = end;
            if self.head_len < HEADER_LEN {
                self.cur = None;
                return Ok(None);
            }
            self.head_len = 0;
            FrameHeader::parse(&self.head)
        } else {
            FrameHeader::parse(self.take(HEADER_LEN))
        };
        let header = match header {
            Ok(h) => h,
            Err(e) => return self.fail(e),
        };
        let len = header.payload_len as usize;
        let payload_offset = self.offset;
        if self.remaining() >= len {
            let start = self.pos;
            self.pos += len;
            self.offset += len as u64;
            let payload = self.cur.as_ref().and_then(|c| c.slice(start, len));
            return match payload {
                Some(payload) => Ok(Some(Frame {
                    header,
                    payload,
                    payload_offset,
                })),
                None => self.fail(DsfError::Malformed("splitter")),
            };
        }
        // The payload spans chunks: one copy, at its body position mod 64.
        let lead = (payload_offset % 64) as usize;
        let mut buf = PayloadBuf::new(len, lead);
        let src = self.take(len);
        buf.extend(src);
        self.pending = Some(Pending {
            header,
            payload_offset,
            buf,
        });
        self.cur = None;
        Ok(None)
    }

    /// End of input: `Truncated` if any byte of an unfinished frame remains.
    pub fn finish(&self) -> Result<(), DsfError> {
        if let Some(e) = &self.failed {
            return Err(e.clone());
        }
        if self.head_len > 0 || self.pending.is_some() || self.remaining() > 0 {
            return Err(DsfError::Truncated);
        }
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

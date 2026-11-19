// Input capture (T03 §5.4, T03-019, T03-020): canvas DOM events → records → the input ring
// (Full mode) or one transferred batch buffer (ST mode), through a bounded queue (plan §4.4).
import { RING_BYTES, OFF_INPUT_HEAD, OFF_INPUT_TAIL, OFF_INPUT_OVERFLOW, OFF_INPUT_DATA } from "./layout.gen.js";

// BACKLOG_MAX: discrete records (kinds other than Move 0x02, Wheel 0x05) held while the sink is
// full. FLUSH_PER_EVENT: queued writes per handler, before its own records. FLUSH_PER_RAF: queued
// writes per main rAF callback. COALESCED_MAX: Move records per pointermove. BATCH_BYTES:
// FLUSH_PER_RAF x 40, the one ST buffer.
export const BACKLOG_MAX = 1024, FLUSH_PER_EVENT = 32, FLUSH_PER_RAF = 256, COALESCED_MAX = 16, BATCH_BYTES = 10240;

// Fields per kind: [record field, DataView setter, byte offset] (T03 §5.4), header first; the
// setters are resolved once so encoding is a flat loop of calls.
const fields = (list) => [["kind", "Uint8", 0], ["flags", "Uint8", 1], ["size", "Uint16", 2], ["seq", "Uint32", 4], ["tMs", "Float64", 8], ...list].map(([k, t, o]) => [k, DataView.prototype["set" + t], o]);
const P = fields([["x", "Float32", 16], ["y", "Float32", 20], ["pointer_id", "Uint32", 24], ["mods", "Uint16", 28], ["buttons", "Uint16", 30], ["button", "Int8", 32], ["ptype", "Uint8", 33], ["pressure", "Uint8", 34], ["width", "Uint8", 36], ["height", "Uint8", 37], ["tilt_x", "Int8", 38], ["tilt_y", "Int8", 39]]);
const FIELDS = { 1: P, 2: P, 3: P, 4: P, 5: fields([["x", "Float32", 16], ["y", "Float32", 20], ["dx", "Float32", 24], ["dy", "Float32", 28], ["mods", "Uint16", 32], ["mode", "Uint8", 34]]), 32: fields([["css_w", "Float32", 16], ["css_h", "Float32", 20], ["dpr", "Float32", 24], ["device_w", "Uint32", 28], ["device_h", "Uint32", 32]]), 33: fields([["state", "Uint8", 16]]) };
const size = (r) => (r.kind === 0x21 ? 24 : 40);
const encode = (r, dv, at) => {
  for (const [k, set, o] of FIELDS[r.kind]) set.call(dv, at + o, k === "size" ? size(r) : (r[k] ?? 0), true);
};

// Bounded queue: Move/Wheel coalesce into one slot each; discrete records wait in a FIFO backlog
// of BACKLOG_MAX (then are dropped and counted); entries leave in seq order.
export function makeQueue(sink) {
  const backlog = [];
  let move = null, wheel = null, lost = false, pending = 0;
  const count = () => backlog.length + (move ? 1 : 0) + (wheel ? 1 : 0);
  const older = (a, b) => (b && (!a || b.seq < a.seq) ? b : a);
  const next = () => older(older(backlog[0] ?? null, move), wheel);
  const take = (r) => (r === move ? (move = null) : r === wheel ? (wheel = null) : backlog.shift());
  const flush = (limit) => {
    for (let n = 0, r = next(); n < limit && r && sink.write(r); r = next(), n++) take(r);
  };
  const tick = () => ((pending = 0), flush(FLUSH_PER_RAF), sink.end(), count() && (pending = requestAnimationFrame(tick)));
  function put(r) {
    const discrete = r.kind !== 2 && r.kind !== 5;
    if (discrete && backlog.length >= BACKLOG_MAX) return void (sink.drop(), (lost = true));
    if (discrete && lost) (r.flags |= 8), (lost = false);
    if (sink.eager && !count() && sink.write(r)) return;
    if (r.kind === 2) move = move ? { ...r, flags: r.flags | 1 } : r;
    else if (r.kind === 5) wheel = wheel ? { ...r, dx: wheel.dx + r.dx, dy: wheel.dy + r.dy, flags: r.flags | 1 } : r;
    else backlog.push(r);
    pending ||= requestAnimationFrame(tick);
  }
  return { eager: sink.eager, put, flush, size: count, lost: () => lost };
}

const mods = (e) => e.shiftKey | (e.ctrlKey << 1) | (e.altKey << 2) | (e.metaKey << 3) | (e.getModifierState?.("AltGraph") << 4) | (e.getModifierState?.("CapsLock") << 5);

export function handlers(queue) {
  let seq = 0;
  const rec = (kind, t, flags = 0) => ({ kind, flags, seq: seq++, tMs: t });
  const ptr = (kind, e, flags) => ({ ...rec(kind, e.timeStamp, flags), x: e.offsetX, y: e.offsetY, pointer_id: e.pointerId, mods: mods(e), buttons: e.buttons, button: e.button, ptype: Math.max(0, ["mouse", "pen", "touch"].indexOf(e.pointerType)), pressure: Math.round(e.pressure * 255), width: Math.min(255, Math.round(e.width)), height: Math.min(255, Math.round(e.height)), tilt_x: e.tiltX, tilt_y: e.tiltY });
  const run = (records) => (queue.eager && queue.flush(FLUSH_PER_EVENT), records.forEach(queue.put));
  const pick = (c, n) => (n > COALESCED_MAX ? Array.from({ length: COALESCED_MAX }, (_, i) => c[Math.round((i * (n - 1)) / (COALESCED_MAX - 1))]) : c);
  return {
    pointerdown: (e) => (run([ptr(1, e)]), e.target?.setPointerCapture(e.pointerId)),
    pointermove(e) {
      const c = e.getCoalescedEvents?.() ?? [];
      if (!e.buttons) return run([ptr(2, e, c.length >= 2 ? 1 : 0)]);
      run((c.length ? pick(c, c.length) : [e]).map((x) => ptr(2, x, c.length > COALESCED_MAX ? 1 : 0)));
    },
    pointerup: (e) => run([ptr(3, e)]),
    pointercancel: (e) => run([ptr(4, e)]),
    wheel: (e) => (e.preventDefault(), run([{ ...rec(5, e.timeStamp), x: e.offsetX, y: e.offsetY, dx: e.deltaX, dy: e.deltaY, mods: mods(e), mode: e.deltaMode }])),
    resize: (entries) => run(entries.map((en) => {
      const css = en.contentBoxSize?.[0] ?? { inlineSize: en.contentRect.width, blockSize: en.contentRect.height };
      const dev = en.devicePixelContentBoxSize?.[0], dpr = devicePixelRatio;
      return { ...rec(0x20, performance.now()), css_w: css.inlineSize, css_h: css.blockSize, dpr, device_w: dev ? dev.inlineSize : Math.round(css.inlineSize * dpr), device_h: dev ? dev.blockSize : Math.round(css.blockSize * dpr) };
    })),
    visibility: (e) => run([{ ...rec(0x21, e?.timeStamp ?? performance.now()), state: document.hidden ? 2 : 3 }]),
  };
}

export function installInput(canvas, sink) {
  const h = handlers(makeQueue(sink));
  for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) canvas.addEventListener(t, h[t]);
  canvas.addEventListener("wheel", h.wheel, { passive: false });
  new ResizeObserver(h.resize).observe(canvas);
  document.addEventListener("visibilitychange", h.visibility);
}

// Full mode: the SPSC producer of T03-006 (payload, then a release store of the head).
export function ringSink(memory, cb) {
  const i32 = new Int32Array(memory.buffer, cb, 64);
  const dv = new DataView(memory.buffer, cb + OFF_INPUT_DATA, RING_BYTES);
  const [H, T, O] = [OFF_INPUT_HEAD, OFF_INPUT_TAIL, OFF_INPUT_OVERFLOW].map((o) => o / 4);
  const write = (r) => {
    const n = size(r), head = Atomics.load(i32, H) >>> 0, pos = head % RING_BYTES, end = RING_BYTES - pos;
    const need = n + (end < n ? end : 0);
    if (need > RING_BYTES - ((head - Atomics.load(i32, T)) >>> 0)) return false;
    if (end < n) dv.setUint8(pos, 0);
    encode(r, dv, end < n ? 0 : pos);
    Atomics.store(i32, H, (head + need) | 0);
    return true;
  };
  return { eager: true, write, drop: () => Atomics.add(i32, O, 1), end() {} };
}

// ST mode: one BATCH_BYTES buffer, posted once per main rAF and returned by the worker's ack;
// at most one batch is unacknowledged.
export function postSink(worker) {
  let buf = new ArrayBuffer(BATCH_BYTES), len = 0, dropped = 0, idle = true;
  worker.addEventListener("message", (e) => e.data.t === "ack" && ((buf = e.data.buf), (idle = true)));
  const write = (r) => (idle && len + size(r) <= BATCH_BYTES ? (encode(r, new DataView(buf), len), (len += size(r)), true) : false);
  const end = () => idle && (len || dropped) && (worker.postMessage({ t: "input", buf, len, dropped }, [buf]), (len = dropped = 0), (idle = false));
  return { eager: false, write, drop: () => dropped++, end };
}

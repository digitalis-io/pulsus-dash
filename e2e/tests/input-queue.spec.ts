// The input.js queue and sinks (T03-020, T03-022) and the T03-003 per-event cost (plan §4.4).
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const TRACES = path.join(__dirname, "..", "test-results", "traces");

/** Page globals: record builders, a fake eager sink, a fake worker, and timing wrappers. */
function prelude() {
  const w = window as any;
  const base = { flags: 0, pointer_id: 1, mods: 0, buttons: 0, button: 0, ptype: 0, pressure: 0, width: 1, height: 1, tilt_x: 0, tilt_y: 0 };
  w.__rec = {
    mv: (seq: number, x: number, y: number) => ({ ...base, kind: 2, seq, tMs: seq, x, y }),
    down: (seq: number) => ({ ...base, kind: 1, seq, tMs: seq, x: 1, y: 1 }),
    up: (seq: number) => ({ ...base, kind: 3, seq, tMs: seq, x: 1, y: 1 }),
    wheel: (seq: number, dy: number) => ({ kind: 5, flags: 0, seq, tMs: seq, x: 0, y: 0, dx: 0, dy, mods: 0, mode: 0 }),
  };
  /** Eager sink: the first `cap` writes succeed. */
  w.__fakeSink = (cap: number) => ({
    eager: true, cap, out: [] as any[], drops: 0,
    write(r: any) { if (this.cap <= 0) return false; this.cap--; this.out.push({ ...r }); return true; },
    drop() { this.drops++; },
    end() {},
  });
  /** Fake worker for postSink: records messages; acks a microtask later while `acking`. */
  w.__fakeWorker = (acking: boolean) => {
    const fw: any = { acking, posted: [] as any[], pending: [] as any[], listeners: [] as any[] };
    fw.ack = (buf: ArrayBuffer) => fw.listeners.forEach((l: any) => l({ data: { t: "ack", buf } }));
    fw.addEventListener = (t: string, l: any) => { if (t === "message") fw.listeners.push(l); };
    fw.postMessage = (msg: any, transfer: any[]) => {
      fw.posted.push({ len: msg.len, dropped: msg.dropped, buf: msg.buf, transfer, bytes: new Uint8Array(msg.buf.slice(0, msg.len)) });
      if (fw.acking) queueMicrotask(() => fw.ack(msg.buf)); else fw.pending.push(msg.buf);
    };
    return fw;
  };
  w.__decode = (bytes: Uint8Array) => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    for (let o = 0; o < bytes.length; o += dv.getUint16(o + 2, true)) {
      out.push({ kind: dv.getUint8(o), flags: dv.getUint8(o + 1), seq: dv.getUint32(o + 4, true), x: dv.getFloat32(o + 16, true) });
    }
    return out;
  };
  w.__frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
  // Timing wrappers (test 68, 66c): listeners on #timed and rAF callbacks, untimed ring reads.
  w.__cost = {} as Record<string, number[]>;
  w.__adv = [] as number[];
  w.__rafs = [] as { ms: number; adv: number }[];
  const head = () => (w.__ring ? Atomics.load(w.__ring, 32) : 0);
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: any, type: string, fn: any, opts?: any) {
    if (this instanceof HTMLCanvasElement && this.id === "timed" && typeof fn === "function") {
      const inner = fn;
      fn = function (this: any, e: Event) {
        const h0 = head();
        const t0 = performance.now();
        try {
          return inner.call(this, e);
        } finally {
          const dt = performance.now() - t0;
          (w.__cost[type] ??= []).push(dt);
          w.__adv.push(Math.floor(((head() - h0) >>> 0) / 40));
        }
      };
    }
    return add.call(this, type, fn, opts);
  } as any;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback) =>
    raf((t) => {
      const h0 = head();
      const t0 = performance.now();
      cb(t);
      w.__rafs.push({ ms: performance.now() - t0, adv: Math.floor(((head() - h0) >>> 0) / 40) });
    });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(prelude);
  await page.goto("/");
});

test("@webgpu queue_direct_when_empty", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const w = window as any;
    const { makeQueue } = await import("/shim/input.js" as string);
    const sink = w.__fakeSink(10);
    const q = makeQueue(sink);
    for (let s = 0; s < 3; s++) q.put(w.__rec.mv(s, s, s));
    return { seqs: sink.out.map((r: any) => r.seq), flags: sink.out.map((r: any) => r.flags), size: q.size() };
  });
  expect(r).toEqual({ seqs: [0, 1, 2], flags: [0, 0, 0], size: 0 });
});

test("@webgpu queue_mixed_order_after_overflow", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const w = window as any;
    const { makeQueue } = await import("/shim/input.js" as string);
    const { mv, down, up, wheel } = w.__rec;
    const sink = w.__fakeSink(0);
    const q = makeQueue(sink);
    [mv(0, 1, 1), down(1), mv(2, 2, 2), wheel(3, 1), up(4), wheel(5, 2)].forEach((x) => q.put(x));
    sink.cap = Infinity;
    q.flush(Infinity);
    return { out: sink.out.map((r: any) => [r.kind, r.seq, r.flags & 1, r.x ?? null, r.dy ?? null]), drops: sink.drops };
  });
  expect(r.out).toEqual([
    [1, 1, 0, 1, null],
    [2, 2, 1, 2, null],
    [3, 4, 0, 1, null],
    [5, 5, 1, 0, 3],
  ]);
  expect(r.drops).toBe(0);
});

test("@webgpu queue_backlog_holds_1024_discrete_amid_moves", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const w = window as any;
    const { makeQueue } = await import("/shim/input.js" as string);
    const { mv, down, up, wheel } = w.__rec;
    const sink = w.__fakeSink(0);
    const q = makeQueue(sink);
    let s = 0;
    const discrete: number[] = [];
    for (let i = 0; i < 2000; i++) {
      q.put(mv(s++, i, i));
      discrete.push(s);
      q.put(i % 2 === 0 ? down(s++) : up(s++));
      if (i % 40 === 0) q.put(wheel(s++, 0.5));
    }
    discrete.push(s);
    q.put(up(s++));
    const size = q.size();
    const drops = sink.drops;
    sink.cap = Infinity;
    q.flush(Infinity);
    const out = sink.out.slice();
    q.put(down(s++));
    q.put(up(s++));
    const tail = sink.out.slice(-2);
    return { size, drops, out, discrete: discrete.slice(0, 1024), tail };
  });
  expect(r.size).toBe(1026);
  expect(r.drops).toBe(977);
  expect(r.out.length).toBe(1026);
  for (let i = 1; i < r.out.length; i++) expect(r.out[i].seq).toBeGreaterThan(r.out[i - 1].seq);
  const disc = r.out.filter((x: any) => x.kind === 1 || x.kind === 3).map((x: any) => x.seq);
  expect(disc).toEqual(r.discrete);
  const moves = r.out.filter((x: any) => x.kind === 2);
  expect(moves.length).toBe(1);
  expect(moves[0].x).toBe(1999);
  expect(r.out.at(-1).kind).toBe(2);
  const wheels = r.out.filter((x: any) => x.kind === 5);
  expect(wheels.length).toBe(1);
  expect(wheels[0].dy).toBe(25);
  expect(r.tail[0].kind).toBe(1);
  expect(r.tail[0].flags & 8).toBe(8);
  expect(r.tail[1].flags & 8).toBe(0);
});

test("@webgpu queue_partial_and_bounded_flush", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const w = window as any;
    const { makeQueue, handlers } = await import("/shim/input.js" as string);
    const { mv, down, up } = w.__rec;
    const a = w.__fakeSink(0);
    const qa = makeQueue(a);
    [down(0), mv(1, 1, 1), up(2)].forEach((x) => qa.put(x));
    a.cap = 2;
    qa.flush(Infinity);
    const first = a.out.map((x: any) => x.seq);
    a.cap = 0;
    qa.put(mv(3, 3, 3));
    a.cap = Infinity;
    qa.flush(Infinity);
    const second = a.out.map((x: any) => x.seq);

    const b = w.__fakeSink(0);
    const qb = makeQueue(b);
    for (let s = -200; s < 0; s++) qb.put(down(s));
    b.cap = Infinity;
    handlers(qb).pointerup(new PointerEvent("pointerup", { pointerId: 1, clientX: 5, clientY: 5 }));
    const written = b.out.length;
    const size = qb.size();
    qb.flush(Infinity);
    return { first, second, written, size, seqs: b.out.map((x: any) => x.seq) };
  });
  expect(r.first).toEqual([0, 1]);
  expect(r.second).toEqual([0, 1, 2, 3]);
  expect(r.written).toBe(32);
  expect(r.size).toBe(169);
  expect(r.seqs.length).toBe(201);
  for (let i = 1; i < r.seqs.length; i++) expect(r.seqs[i]).toBeGreaterThan(r.seqs[i - 1]);
});

test("@webgpu raf_flush_bounded_max_backlog", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const w = window as any;
    const { makeQueue, ringSink } = await import("/shim/input.js" as string);
    const { mv, down, up, wheel } = w.__rec;
    const mem = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const i32 = new Int32Array(mem.buffer, 0, 64);
    Atomics.store(i32, 32, 65536); // full: head = tail + RING_BYTES
    w.__ring = i32;
    const q = makeQueue(ringSink(mem, 0));
    let s = 0;
    for (let i = 0; i < 2000; i++) {
      q.put(mv(s++, i, i));
      q.put(i % 2 === 0 ? down(s++) : up(s++));
      if (i % 40 === 0) q.put(wheel(s++, 0.5));
    }
    q.put(up(s++));
    const size = q.size();
    w.__rafs.length = 0;
    Atomics.store(i32, 48, Atomics.load(i32, 32));
    for (let k = 0; k < 8; k++) await w.__frame();
    // Decode the ring between the old tail and the new head.
    const bytes = new Uint8Array(mem.buffer, 0x10000, 65536);
    const tail = 65536 % 65536;
    const head = Atomics.load(i32, 32) % 65536;
    const seqs: number[] = [];
    for (let o = tail; o !== head; ) {
      if (bytes[o] === 0) { o = 0; continue; }
      const dv = new DataView(mem.buffer, 0x10000 + o, 8);
      seqs.push(dv.getUint32(4, true));
      o = (o + dv.getUint16(2, true)) % 65536;
    }
    return { size, rafs: w.__rafs.filter((x: any) => x.adv > 0), seqs };
  });
  expect(r.size).toBe(1026);
  expect(r.rafs.map((x: any) => x.adv)).toEqual([256, 256, 256, 256, 2]);
  for (const x of r.rafs) expect(x.ms).toBeLessThanOrEqual(2);
  expect(r.seqs.length).toBe(1026);
  for (let i = 1; i < r.seqs.length; i++) expect(r.seqs[i]).toBeGreaterThan(r.seqs[i - 1]);
});

test("@webgpu post_sink_batches_and_counts_drops", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const w = window as any;
    const { makeQueue, postSink } = await import("/shim/input.js" as string);
    const fw = w.__fakeWorker(true);
    const q = makeQueue(postSink(fw));
    for (let s = 0; s < 1030; s++) q.put(w.__rec.down(s));
    const perFrame: number[] = [];
    for (let k = 0; k < 5; k++) {
      await w.__frame();
      await Promise.resolve();
      perFrame.push(fw.posted.length);
    }
    const bufs = new Set(fw.posted.map((p: any) => p.buf));
    const seqs = fw.posted.flatMap((p: any) => w.__decode(p.bytes).map((d: any) => d.seq));
    return {
      perFrame,
      lens: fw.posted.map((p: any) => p.len),
      dropped: fw.posted.map((p: any) => p.dropped),
      oneBuffer: bufs.size === 1,
      transferOk: fw.posted.every((p: any) => p.transfer.length === 1 && p.transfer[0] === p.buf),
      seqs,
    };
  });
  expect(r.perFrame).toEqual([1, 2, 3, 4, 4]);
  expect(r.lens).toEqual([10240, 10240, 10240, 10240]);
  expect(r.dropped).toEqual([6, 0, 0, 0]);
  expect(r.oneBuffer).toBe(true);
  expect(r.transferOk).toBe(true);
  expect(r.seqs).toEqual(Array.from({ length: 1024 }, (_, i) => i));
  expect(r.seqs.length + 6).toBe(1030);
});

test("@webgpu post_sink_stalled_worker_bounded", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const w = window as any;
    const { makeQueue, postSink } = await import("/shim/input.js" as string);
    const { mv, down } = w.__rec;
    const fw = w.__fakeWorker(false);
    const q = makeQueue(postSink(fw));
    let s = 0;
    for (; s < 1030; ) q.put(down(s++));
    await w.__frame();
    const stalled = fw.posted.map((p: any) => [p.len, p.dropped]);
    let x = 0;
    for (let k = 0; k < 10; k++) {
      for (let j = 0; j < 100; j++) {
        q.put(down(s++));
        q.put(mv(s++, x, x));
        x++;
      }
      await w.__frame();
    }
    const sizeStalled = q.size();
    const postedStalled = fw.posted.length;
    fw.acking = true;
    fw.ack(fw.pending.shift());
    for (let k = 0; k < 8; k++) {
      await w.__frame();
      await Promise.resolve();
    }
    const msgs = fw.posted.map((p: any) => ({ len: p.len, dropped: p.dropped, recs: w.__decode(p.bytes) }));
    return { stalled, sizeStalled, postedStalled, msgs, total: s };
  });
  expect(r.stalled).toEqual([[10240, 6]]);
  expect(r.postedStalled).toBe(1);
  expect(r.sizeStalled).toBe(1025);
  const resumed = r.msgs.slice(1);
  expect(resumed.map((m: any) => m.len)).toEqual([10240, 10240, 10240, 10240, 40]);
  expect(resumed.map((m: any) => m.dropped)).toEqual([744, 0, 0, 0, 0]);
  const last = resumed[4].recs[0];
  expect([last.kind, last.x, last.flags & 1]).toEqual([2, 999, 1]);
  const seqs = r.msgs.flatMap((m: any) => m.recs.map((d: any) => d.seq));
  for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  const discrete = r.msgs.flatMap((m: any) => m.recs).filter((d: any) => d.kind === 1).length;
  const dropped = r.msgs.reduce((a: number, m: any) => a + m.dropped, 0);
  expect(discrete).toBe(1280);
  expect(discrete + dropped).toBe(2030);
});

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p99: pct(xs, 99), max: Math.max(...xs) });

/** Dispatches one synthetic workload on #timed; returns every timed call and its ring advance. */
async function workload(page: Page, kind: "N" | "B", warm: number, timed: number) {
  return page.evaluate(
    ({ kind, warm, timed }) => {
      const w = window as any;
      const c = document.getElementById("timed") as HTMLCanvasElement;
      const i32: Int32Array = w.__ring;
      const coalesced = (n: number) =>
        Array.from({ length: n }, (_, i) => new PointerEvent("pointermove", { pointerId: 1, buttons: 1, clientX: 10 + (i % 200), clientY: 20 }));
      const mk = [
        ...Array.from({ length: 5 }, () => () => new PointerEvent("pointermove", { pointerId: 1, buttons: 1, clientX: 50, clientY: 50, coalescedEvents: coalesced(16) } as any)),
        () => new PointerEvent("pointermove", { pointerId: 1, buttons: 1, clientX: 60, clientY: 60, coalescedEvents: coalesced(64) } as any),
        () => new PointerEvent("pointermove", { pointerId: 1, buttons: 0, clientX: 70, clientY: 70 }),
        () => new PointerEvent("pointerdown", { pointerId: 1, buttons: 1, clientX: 80, clientY: 80 }),
        () => new PointerEvent("pointerup", { pointerId: 1, buttons: 0, clientX: 80, clientY: 80 }),
        () => new WheelEvent("wheel", { deltaY: 1, clientX: 90, clientY: 90, cancelable: true }),
      ];
      const events = mk.map((f) => f());
      for (let n = 0; n < warm + timed; n++) {
        if (n === warm) {
          for (const k of Object.keys(w.__cost)) w.__cost[k].length = 0;
          w.__adv.length = 0;
        }
        if (kind === "N" || n % 8000 === 0) Atomics.store(i32, 48, Atomics.load(i32, 32));
        c.dispatchEvent(events[n % 10]);
      }
      return { costs: Object.values(w.__cost).flat() as number[], adv: w.__adv.slice(), overflow: Atomics.load(i32, 49) };
    },
    { kind, warm, timed },
  );
}

test("@webgpu shim_input_cost_p99", async ({ page }) => {
  test.setTimeout(300_000);
  const pre = await page.evaluate(async () => {
    const w = window as any;
    const { installInput, ringSink } = await import("/shim/input.js" as string);
    const c = document.createElement("canvas");
    c.id = "timed";
    c.width = c.height = 300;
    c.style.cssText = "position:fixed;left:0;top:0;width:300px;height:300px;z-index:10;border:0;padding:0";
    document.body.append(c);
    const mem = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    w.__ring = new Int32Array(mem.buffer, 0, 64);
    installInput(c, ringSink(mem, 0));
    const a = new PointerEvent("pointermove", { pointerId: 1 });
    const b = new PointerEvent("pointermove", { pointerId: 1 });
    const probe = new PointerEvent("pointermove", { pointerId: 1, coalescedEvents: [a, b] } as any);
    return { isolated: self.crossOriginIsolated, coalesced: probe.getCoalescedEvents().length };
  });
  expect(pre).toEqual({ isolated: true, coalesced: 2 });
  await page.mouse.move(150, 150);
  await page.mouse.down();
  expect(await page.evaluate(() => (document.getElementById("timed") as HTMLCanvasElement).hasPointerCapture(1))).toBe(true);

  const result: Record<string, any> = {};
  for (const kind of ["N", "B"] as const) {
    const runs = [];
    for (let k = 0; k < 3; k++) {
      const r = await workload(page, kind, 2_000, kind === "N" ? 20_000 : 24_000);
      expect(Math.max(...r.adv), `${kind}: records per call`).toBeLessThanOrEqual(48);
      if (kind === "B") {
        expect(r.overflow, "B overflows the ring").toBeGreaterThan(0);
        expect(Math.max(...r.adv), "B flushes 32 queued entries").toBeGreaterThanOrEqual(33);
      }
      runs.push(stats(r.costs));
    }
    const p99s = runs.map((x) => x.p99).sort((a, b) => a - b);
    result[kind] = { runs, medianP99: p99s[1] };
  }
  await page.mouse.up();

  await page.evaluate(() => {
    const w = window as any;
    for (const k of Object.keys(w.__cost)) w.__cost[k].length = 0;
    w.__adv.length = 0;
    w.__drain = setInterval(() => Atomics.store(w.__ring, 48, Atomics.load(w.__ring, 32)), 4);
  });
  for (let i = 0; i < 300; i++) {
    await page.mouse.move(100 + (i % 50), 100);
    await page.mouse.down();
    await page.mouse.move(180 + (i % 50), 160, { steps: 8 });
    await page.mouse.up();
  }
  const rr = await page.evaluate(() => {
    const w = window as any;
    clearInterval(w.__drain);
    return { costs: Object.values(w.__cost).flat() as number[], adv: w.__adv.slice() };
  });
  expect(Math.max(...rr.adv), "R: records per call").toBeLessThanOrEqual(48);
  result.R = stats(rr.costs);

  fs.mkdirSync(TRACES, { recursive: true });
  fs.writeFileSync(path.join(TRACES, "shim-cost.json"), JSON.stringify(result, null, 2));
  expect(result.N.medianP99, "N median p99 (ms)").toBeLessThanOrEqual(0.05);
  expect(result.B.medianP99, "B median p99 (ms)").toBeLessThanOrEqual(0.05);
  expect(result.R.p99, "R p99 (ms)").toBeLessThanOrEqual(0.05);
});

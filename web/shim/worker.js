// Worker entry (T03 §5.2): instantiate the core from the boot handshake, dispatch by role; the
// render role runs the frame loop on the worker's rAF (setTimeout where absent, T03 Q3).
import { STATUS_TIER_T1, STATUS_TIER_T2 } from "./layout.gen.js";

const raf = self.requestAnimationFrame ? (f) => self.requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 16);
let g;

self.addEventListener("message", async ({ data: m }) => {
  if (m.t === "input") {
    g.render_input(new Uint8Array(m.buf, 0, m.len), m.dropped);
    self.postMessage({ t: "ack", buf: m.buf }, [m.buf]);
    return;
  }
  g = m.mode === "st" ? await import("./gen/dash-core-st/dash_core_st.js") : await import("./gen/dash-core-mt/dash_core_mt.js");
  const w = await g.default({ module_or_path: m.module, memory: m.memory });
  if (m.role === "data") return g.data_start(m.index, m.query);
  if (m.role !== "render") throw new Error(`unknown worker role ${m.role}`);
  const status = await g.render_start(m.canvas, m.caps, m.main_time_origin, m.query);
  const memory = m.mode === "mt" ? w.memory : null;
  self.postMessage({ t: "status", status, layout: g.layout_version(), cb: g.control_block(), memory });
  if (status !== STATUS_TIER_T1 && status !== STATUS_TIER_T2) return;
  const tick = (t) => (g.render_frame(t) ? raf(tick) : self.postMessage({ t: "status", status: g.render_status() }));
  raf(tick);
});

// Boot (T03 §4.2, §9.1): capability probe, mode, compile the core once, spawn the render worker
// (and data-0 in mt mode), report the runtime status on <html data-dash-status>.
import * as L from "./layout.gen.js";
import { installInput, ringSink, postSink } from "./input.js";

const html = document.documentElement;
const q = new URLSearchParams(location.search);
const has = (ok, bit) => (ok ? bit : 0);
const caps =
  has(self.crossOriginIsolated && typeof SharedArrayBuffer === "function", L.CAP_ISOLATED) |
  has("transferControlToOffscreen" in HTMLCanvasElement.prototype, L.CAP_OFFSCREEN) |
  has("gpu" in navigator, L.CAP_WEBGPU) |
  has(typeof Atomics.waitAsync === "function", L.CAP_WAIT_ASYNC) |
  has(self.ResizeObserverEntry && "devicePixelContentBoxSize" in ResizeObserverEntry.prototype, L.CAP_DPCB);
const mode = !(caps & L.CAP_ISOLATED) || q.get("mode") === "st" ? "st" : "mt";
html.dataset.dashMode = mode;
const setStatus = (s) => {
  html.dataset.dashStatus = String(s);
};
const workers = [];
let canvas = document.getElementById("dash-canvas");
let retried = false;
let module;

function spawn(name, msg, transfer = []) {
  const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module", name });
  w.addEventListener("error", () => setStatus(L.STATUS_FAILED));
  w.addEventListener("messageerror", () => setStatus(L.STATUS_FAILED));
  w.postMessage({ mode, index: 0, module, main_time_origin: performance.timeOrigin, caps, query: location.search, ...msg }, transfer);
  workers.push(w);
  return w;
}

function startRender(query) {
  const off = canvas.transferControlToOffscreen();
  const w = spawn("render", { role: "render", canvas: off, query }, [off]);
  w.addEventListener("message", (e) => onStatus(w, e.data));
}

function onStatus(w, m) {
  if (m.t === "coverage") return void (html.dataset.dashCoverage = m.reasons);
  if (m.t !== "status") return;
  if (m.layout !== undefined && m.layout !== L.LAYOUT_VERSION) {
    setStatus(L.STATUS_STALE);
    workers.forEach((x) => x.terminate());
    return;
  }
  if (m.status === L.RETRY_T2) {
    if (retried) return setStatus(L.STATUS_FAILED);
    retried = true;
    w.terminate();
    const c2 = canvas.cloneNode(false);
    canvas.replaceWith(c2);
    canvas = c2;
    return startRender("?mode=t2");
  }
  setStatus(m.status);
  if (m.cb === undefined || (m.status !== L.STATUS_TIER_T1 && m.status !== L.STATUS_TIER_T2)) return;
  installInput(canvas, mode === "mt" ? ringSink(m.memory, m.cb) : postSink(w));
  if (mode === "mt") spawn("data-0", { role: "data", memory: m.memory });
}

if (!(caps & L.CAP_OFFSCREEN)) {
  setStatus(L.STATUS_STATIC);
} else {
  setTimeout(() => html.dataset.dashStatus === String(L.STATUS_BOOTING) && setStatus(L.STATUS_FAILED), L.BOOT_TIMEOUT_MS);
  const url = mode === "mt" ? new URL("./gen/dash-core-mt/dash_core_mt_bg.wasm", import.meta.url) : new URL("./gen/dash-core-st/dash_core_st_bg.wasm", import.meta.url);
  WebAssembly.compileStreaming(fetch(url)).then(
    (m) => {
      module = m;
      startRender(location.search);
    },
    () => setStatus(L.STATUS_FAILED),
  );
}

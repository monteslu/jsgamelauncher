// worker-module-bootstrap.mjs — bootstrap for a module Worker spawned by the
// realm's GameWorker (e.g. an emscripten wasm pthread, box2d3 deluxe).
//
// This runs in a real worker_threads worker. The SECURITY boundary is the MAIN
// realm thread: there, game code runs in a browser sandbox with no process/fs
// reachable. This worker just RUNS the emscripten module — emscripten's own
// Node-worker path wires everything correctly with the real
// `worker_threads.parentPort` (it sets parentPort<->onmessage and
// self/postMessage itself; see the `if (ENVIRONMENT_IS_NODE)` block in its
// worker branch). So we deliberately do NOT shim a browser surface here — doing
// so only confused emscripten's environment detection. Import the module and get
// out of the way. The worker runs trusted, bundled game/wasm code and cannot
// reach or weaken the main realm's sandbox.
//
// IMPORTANT: the worker is launched with `workerData === 'em-pthread'` (the
// string emscripten checks for `ENVIRONMENT_IS_PTHREAD`), so the module URL +
// name come via env (JSG_WORKER_MODULE / JSG_WORKER_NAME) instead.
import { parentPort } from 'node:worker_threads';

const moduleUrl = process.env.JSG_WORKER_MODULE;
// emscripten also checks self.name?.startsWith('em-pthread'); set it.
try { globalThis.name = process.env.JSG_WORKER_NAME || 'em-pthread'; } catch {}

import(moduleUrl).catch((e) => {
  try { parentPort.postMessage({ cmd: '__jsg_worker_error', message: String((e && e.stack) || e) }); } catch {}
});

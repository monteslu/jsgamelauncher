// realm.js — run the game in an isolated vm context (a BROWSER sandbox) instead
// of the main Node global scope. Game code sees only browser globals (window/
// document/canvas/WebGL/audio/Image/fetch/localStorage/FontFace/rAF/navigator/
// Worker/SharedArrayBuffer) and NO process/require/fs/global/__dirname. So a
// game cannot reach the filesystem or run shell commands — same as a browser tab.
//
// This is the jsgame-libretro security model ported to jsgamelauncher. The host
// shims (SDL canvas, webgl-node, webaudio-node, gamepad-node) are created in the
// main realm and passed in as host intrinsics; the SDL window + frame loop +
// hotkeys stay in the main realm and drive the context's rAF / display canvas.
//
// Requires Node started with --experimental-vm-modules (cli.js handles that).
import vm from 'node:vm';
import { Worker as NodeWorker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize as pnormalize } from 'node:path';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} opts
 * @param {object} opts.globals  browser globals to expose in the realm context
 *   (HTMLCanvasElement, ImageData, OffscreenCanvas, Audio, Video, WebSocket,
 *    document, screen, AudioContext, AudioDestinationNode, OscillatorNode,
 *    GainNode, AudioBuffer, WebGLRenderingContext, WebGL2RenderingContext,
 *    requestAnimationFrame, cancelAnimationFrame, loadImage, Image, fetch,
 *    XMLHttpRequest, localStorage, FontFace, navigator, innerWidth, innerHeight,
 *    sdl, MutationObserver, URL extensions, Worker, …)
 * @param {string} opts.gameRoot absolute dir of the game (for module resolution)
 */
export function createRealm({ globals, gameRoot }) {
  // ── Worker: a real browser-style module Worker (NOT web-worker, which runs
  // unsandboxed in the main scope and doesn't complete emscripten's pthread
  // handshake). Used by game-authored workers AND emscripten wasm pthreads
  // (box2d3 deluxe). The game sees only the Web Worker API; under the hood a
  // worker_threads worker runs the module via worker-module-bootstrap.mjs. The
  // worker_threads plumbing is invisible to game code. (Same impl as
  // jsgame-libretro.)
  function resolveWorkerModule(scriptUrl) {
    let s = String(scriptUrl && scriptUrl.href ? scriptUrl.href : scriptUrl);
    if (s.startsWith('file://')) return fileURLToPath(s);
    let rel = s.replace(/^\.?\//, '');
    return join(gameRoot, rel);
  }
  class GameWorker {
    constructor(scriptUrl, options) {
      this._listeners = { message: [], error: [], messageerror: [] };
      let moduleUrl;
      try {
        moduleUrl = pathToFileURL(resolveWorkerModule(scriptUrl)).href;
      } catch (e) {
        setTimeout(() => this._emit('error', { message: e.message }), 0);
        return;
      }
      const name = (options && options.name) || 'worker';
      // workerData MUST be the string 'em-pthread' (emscripten's pthread check);
      // module URL + name go via env. env is NOT process.env — a minimal set, so
      // the worker doesn't inherit host secrets unnecessarily.
      this._worker = new NodeWorker(join(THIS_DIR, 'worker-module-bootstrap.mjs'), {
        workerData: 'em-pthread',
        env: { JSG_WORKER_MODULE: moduleUrl, JSG_WORKER_NAME: name },
        execArgv: ['--experimental-vm-modules', '--no-warnings'],
      });
      this._worker.on('message', (data) => {
        if (data && data.cmd === '__jsg_worker_error') { this._emit('error', { message: data.message }); return; }
        this._emit('message', { data });
      });
      this._worker.on('error', (err) => this._emit('error', { message: err.message, error: err }));
    }
    postMessage(data, transfer) { if (this._worker) this._worker.postMessage(data, transfer); }
    terminate() { if (this._worker) this._worker.terminate(); }
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { if (this._listeners[t]) this._listeners[t] = this._listeners[t].filter((f) => f !== fn); }
    _emit(t, ev) {
      ev.type = t;
      const on = this['on' + t]; if (typeof on === 'function') { try { on(ev); } catch {} }
      for (const fn of (this._listeners[t] || [])) { try { fn(ev); } catch {} }
    }
  }

  // The sandbox: browser globals only. NO process / require / fs / global /
  // __dirname / Buffer-as-node. Host intrinsics (URL, TextEncoder, etc.) are
  // safe to share.
  const sandbox = {
    // self-references
    console,
    // host intrinsics (pure / data types — safe to share, like jsgame-libretro)
    URL: globalThis.URL, URLSearchParams, TextEncoder, TextDecoder,
    Blob: globalThis.Blob, Response: globalThis.Response, Request: globalThis.Request, Headers: globalThis.Headers,
    structuredClone, btoa: globalThis.btoa, atob: globalThis.atob,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, setImmediate,
    performance: globalThis.performance,
    WebAssembly,
    SharedArrayBuffer, Atomics,
    // standard web event classes (emscripten + libs reference them)
    Event: globalThis.Event, EventTarget: globalThis.EventTarget,
    CustomEvent: globalThis.CustomEvent, MessageEvent: globalThis.MessageEvent,
    ErrorEvent: globalThis.ErrorEvent, AbortController, AbortSignal,
    // the browser surface jsgamelauncher provides (passed in)
    ...globals,
    // Override the passed-in Worker (web-worker) with our sandboxed module
    // Worker — runs game/wasm workers in worker_threads with no process/fs leak.
    Worker: GameWorker,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  // NOTE: deliberately NO sandbox.global / process / require / __dirname.

  const context = vm.createContext(sandbox, { name: 'jsgame' });

  // ── ESM loader: relative specifiers resolved against the game dir on disk.
  // Bare specifiers are a hard error (browser-parity; bundle your game). The
  // game is a real built bundle on disk, so import.meta.url is a real file://
  // (emscripten wasm pthread worker URLs resolve against it).
  const moduleCache = new Map();
  // A require scoped to the game dir, used ONLY to RESOLVE module paths (bare
  // specifiers → node_modules), never handed to game code. Resolving a path and
  // loading that file into the sandboxed vm context does NOT give the game
  // fs/process — the resolved library runs in the same no-process/fs context.
  // So node_modules works (unbundled `import 'three'` in dev) AND the sandbox
  // holds. `node:` builtins stay blocked (those WOULD be a Node escape).
  function resolveSpec(spec, fromPath) {
    if (spec.startsWith('node:')) {
      throw new Error(`node builtin "${spec}" is not available in the game realm (it's a browser sandbox)`);
    }
    // relative / absolute / file:// — resolve directly
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:')) {
      let p = spec.startsWith('file:') ? fileURLToPath(spec) : spec;
      if (p.startsWith('.')) p = join(dirname(fromPath), p);
      return pnormalize(p);
    }
    // bare specifier — resolve against the game's node_modules (works in dev,
    // no build step). A specifier that resolves to a node builtin (a lib doing
    // `import 'fs'`) throws the same "not available" error a browser would give.
    try {
      const fromRequire = createRequire(fromPath);
      const resolved = fromRequire.resolve(spec);
      if (!resolved.includes('/') && !resolved.includes('\\')) {
        // node builtin (e.g. 'fs') resolves to its bare name
        throw new Error(`node builtin "${spec}" is not available in the game realm`);
      }
      return pnormalize(resolved);
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        throw new Error(`module "${spec}" not found in the game's node_modules (run npm install, or bundle your game)`);
      }
      throw e;
    }
  }
  function loadModule(absPath) {
    if (moduleCache.has(absPath)) return moduleCache.get(absPath);
    const src = readFileSync(absPath, 'utf8');
    const mod = new vm.SourceTextModule(src, {
      context,
      identifier: pathToFileURL(absPath).href,
      initializeImportMeta(meta) { meta.url = pathToFileURL(absPath).href; },
      importModuleDynamically: async (spec) => {
        const m = loadModule(resolveSpec(spec, absPath));
        await link(m);
        return m;
      },
    });
    mod._absPath = absPath;
    moduleCache.set(absPath, mod);
    return mod;
  }
  async function link(mod) {
    if (mod.status === 'unlinked') {
      await mod.link((spec, ref) => loadModule(resolveSpec(spec, ref._absPath ?? mod._absPath)));
    }
    if (mod.status === 'linked') await mod.evaluate();
  }

  return {
    context,
    sandbox,
    /** Run the game entry (a file:// URL or absolute path) in the realm. */
    async runEntry(entry) {
      const absPath = entry.startsWith('file:') ? fileURLToPath(entry) : entry;
      const mod = loadModule(absPath);
      await link(mod);
      return mod;
    },
  };
}

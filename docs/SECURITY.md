# jsgamelauncher security model

> Status: implemented on branch `vm-realm-sandbox`. On `main` (≤ v0.9.0) the
> model is the OPPOSITE — see "History" at the bottom.

## The model: games run in a BROWSER sandbox

jsgamelauncher games are **browser games** — a browser gives them ZERO filesystem
or OS access and they run fine. So the launcher runs each game inside an isolated
`node:vm` realm (`realm.js`) whose globals are **only** the browser surface
(window / document / canvas / WebGL / WebAudio / Image / fetch / localStorage /
FontFace / gamepad-via-navigator / requestAnimationFrame / Worker /
SharedArrayBuffer / Atomics). It is **NOT** the main Node global scope.

**Game code sees NONE of these:** `process`, `require`, `global`, `__dirname`,
`fs`, `child_process`, `Buffer`-as-node, or any Node builtin. By any path:
- `require('fs')` — `require` is `undefined`.
- `import('fs')` / `import 'fs'` — the realm's ESM loader rejects bare and `node:`
  specifiers with a hard error.
- There is no `vm`-escape via a leaked global, because the dangerous globals were
  never put in the context (this is removal, not a wrapper/Proxy you must keep
  airtight).

A hostile game's `require('fs').rmSync('/home/...')` fails at `require` itself; an
`import('child_process')` rejects. **Same boundary a browser tab gives.**

## How threading still works (without leaking Node)

emscripten-compiled wasm (e.g. box2d3 deluxe) threads via `new Worker(url,
{type:'module'})` + `SharedArrayBuffer`. Because the realm has NO `process`,
emscripten takes its **browser** code path (`ENVIRONMENT_IS_NODE` is false) and
uses `Worker`. The realm's `Worker` (`GameWorker` in `realm.js`) is a real
worker_threads worker under the hood, running `worker-module-bootstrap.mjs` — but
that `worker_threads` plumbing is **entirely inside the runtime**, never exposed
to game code. The worker runs the (trusted, bundled) wasm module; it cannot reach
or weaken the main realm's sandbox. SharedArrayBuffer/Atomics (how a pthread
shares memory) are browser-standard and safe to expose.

## DON'T re-break it — the failure modes

These changes would silently destroy the sandbox; reviewers must reject them:
1. **Putting the game back in the main scope** (`await import(gameFile)` instead
   of `realm.runEntry(...)`). The whole boundary is the vm context; bypassing it =
   full Node again.
2. **Exposing `process`/`require`/`fs`/`global`/`__dirname`** in the realm sandbox
   (even a "minimal stub"). A real `process` gives `process.env` (secrets),
   `process.binding`, `process.exit`. A real `fs` is game-over. (An earlier
   jsgame-libretro attempt did exactly this with a "neutered fs + real process" —
   it leaked. The fix was to expose NOTHING and let emscripten use its browser
   path. Do the same here.)
3. **Letting the realm's ESM loader resolve bare/node specifiers** "for
   convenience." That re-opens `import('fs')`.
4. **Replacing `GameWorker` with `web-worker`** (the npm package). It runs the
   worker in a context with real Node and doesn't complete emscripten's pthread
   handshake — both wrong.

## Verify (adversarial test)

Drop a game whose `main` is:
```js
console.log('process='+typeof process, 'require='+typeof require,
            'global='+typeof global, '__dirname='+typeof __dirname);
(async()=>{ try{await import('fs')}catch{console.log('fs blocked')} })();
```
Expected: `process=undefined require=undefined global=undefined __dirname=undefined`
+ `fs blocked`. And `typeof Worker === 'function'`, `typeof SharedArrayBuffer ===
'function'` (so threads still work).

## Behavior changes — NOT breaking for real games

No real browser game uses `fs`/`process`/Node builtins, so removing them breaks
nothing that should exist. The notes below are the only differences:

- **The realm requires `--experimental-vm-modules`.** The sandbox uses
  `vm.SourceTextModule`, which lives behind that flag. `cli.js` sets it
  automatically by re-execing node; an app that embeds `launch()` must start node
  with it (`launch()` throws a clear error otherwise). This is the same flag Jest
  requires for ESM tests — production-stable, just not yet un-flagged in Node.
- **`node_modules` resolves.** Unbundled `import 'three'` works in dev with no
  build step: the realm resolves bare specifiers against the game's
  `node_modules`. Bundled `.jsgame` games use relative imports only.
- **Node builtins are blocked.** `import 'fs'` / `import 'child_process'` (and the
  globals `process`/`require`/`fs`) hard-error. The only "casualty" is a
  non-portable hack like `process.exit()` — which never worked in a browser
  either, so it's a correctness fix, not a regression. (A correctly-guarded
  `typeof process !== 'undefined'` check just no-ops, as it should.)

## Threat model

With the realm: **untrusted games are sandboxed to browser-level capability.** A
downloaded/shared `.jsgame`-style game cannot read your files, run shell commands,
or read env secrets. (Still not a hardened multi-tenant boundary — vm is
isolation, not a security VM — but it removes the file/shell/process RCE surface,
which is the thing that mattered.)

## History (pre-`vm-realm-sandbox`, ≤ v0.9.0)

The game ran in the **main Node global scope** via `await import(gameFile)` with
real `process`/`require`/`fs`/`child_process` ambient, PLUS auto-`npm install` of
the game's deps on first launch (running arbitrary `postinstall` scripts). So
merely launching an untrusted game directory was arbitrary code execution. That is
the model the `vm-realm-sandbox` branch replaces. If you are on `main` and running
untrusted content: **don't** — it has full Node privileges.

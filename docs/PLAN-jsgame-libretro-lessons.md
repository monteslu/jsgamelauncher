# jsgamelauncher — update plan from jsgame-libretro lessons

Status: proposal (2026-06-17). Audit of jsgamelauncher (`rungame` v0.9.0) against
everything learned building its sibling **jsgame-libretro** (the libretro-core
runtime for the same web games).

## TL;DR

jsgamelauncher and jsgame-libretro do the same job — run web games in Node, no
browser — but with **different host layers**: jsgamelauncher uses
`@kmamal/sdl` + `@napi-rs/canvas` + `webgl-node` + `web-worker` and runs games in
the **main Node global scope**; jsgame-libretro is a libretro core with a
`vm`-realm soft sandbox, Skia/ANGLE, and a synthetic frame clock. So **most of
jsgame-libretro's hard-won gotchas do NOT transfer** — and several would be
*regressions* if ported. The audit deliberately separates "real gap" from "looks
similar but is correctly different."

**The whole project bet (`llms.txt`):** games run on $50 handhelds AND in
browsers, unchanged. That north star drives the priorities below.

### What's already RIGHT (do not touch — verified)
- **Audio is wall-clock / Web-Audio (SDL queue drained on its own 10ms timer).**
  This IS the gold-standard model jsgame-libretro had to *manufacture*. Porting
  the libretro per-frame audio sync would re-introduce the exact bug it spent
  days removing.
- **WebGL2 detection** (`WebGL2RenderingContext` is a real named global, distinct
  from `WebGLRenderingContext`, `experimental-webgl` falls through) — correct, and
  more robust than the realm version (no sandbox indirection). `launcher.js:148-152`,
  `canvas.js:35`.
- **Gamepad: `mapping:'standard'`, exact W3C button order (0-16), `{pressed,value}`
  buttons, 4 axes** — fully agrees with the `getInput()` contract games use, via
  the `gamepad-node` package. Its positional (south/east/west/north) mapping is
  actually *better* than a naive RetroPad map.
- **Emscripten wasm threads (box2d3 deluxe) already work** — because it's plain
  Node with a real `process`/`require`; emscripten detects Node and uses
  `worker_threads` directly. This is the reference impl jsgame-libretro matched.
  Note: the `web-worker` global is NOT what makes threads work; the real `process`
  is. Don't remove real-`process` exposure thinking `web-worker` covers it.

### Lessons that do NOT transfer (flagged so nobody "fixes" them)
- Shader dialect translation (`#version 300 es`→`330 core`, `highp`→`lowp`,
  `skia_gl_standard`): jsgamelauncher targets **real GLES** (handheld Mali / EGL),
  not RetroArch's desktop-GL-core. Native dialect — no translation. Importing it
  would be wrong.
- Per-frame default-FBO re-query: jsgamelauncher owns a **stable** window surface
  + an explicit `gameFBO`; RetroArch's rotating-FBO hazard is structurally absent.
- GPU-Skia/Ganesh composite + `gl_blit` fallback (the `drawImage(webglCanvas)`
  case-B machinery): jsgamelauncher has no separate-3D-scene-onto-2D-HUD case (a
  WebGL game's canvas *is* the display, presented as a GL FBO). The whole §9
  apparatus is moot.

---

## Prioritized work

### P0 — Frame-rate cap (the one real pacing gap)

**Problem.** `launcher.js:694-753` `launcherLoop` ends in `setImmediate(launcherLoop)`
with **no cap, no sleep, no vsync** (vsync is explicitly disabled,
`launcher.js:356/390`). On a fast box a light 2D game spins at hundreds–thousands
of fps. Two harms:
1. Burns a full CPU core — *especially bad on the $50 handhelds that are the whole
   point* (battery, heat, thermal throttling).
2. The rAF clock here is **real** `performance.now()` (`launcher.js:748`), so
   per-frame-movement games (`ship.x += 6.5`) run at **warp speed**, and
   per-frame-allocating games over-spawn → the jsgame-libretro §2 freeze.

**Why safe to fix here (and not a copy-paste of the core's pacer).** A frame cap is
safe *because audio is wall-clock* (capping video does not change audio rate) —
that precondition is already true. But:
- Node has no `nanosleep`. Use a hybrid: `setTimeout` to ~1ms before the next
  16.667ms deadline, then a short `setImmediate` busy-trim to hit it. Naive
  `setTimeout`-to-deadline lands long (kernel ~1-4ms granularity) → the §2-C
  over-sleep → locks to 30fps.
- Keep vsync OFF and make the software cap the **single** clock. If a pacer is
  added AND the compositor re-imposes vsync on `swapBuffers`, they stack to 30fps
  (§2-B double-pacing). One clock only.

**Plan.**
- Add a target-fps pacer to `launcherLoop` (default 60). Measure the
  callback+draw cost, sleep the remainder with the hybrid timer, re-loop.
- Make it configurable: `--fps <n>` (and `0`/`uncapped` to opt out — some handheld
  fbdev setups may genuinely want uncapped for latency; expose the choice, default
  capped).
- Incidental win: hotkey edge-latches (`can*` booleans) currently debounce on
  frame *count*; a stable 60fps makes hotkey timing consistent.

### P0 — Crash guards in the hotkey loop

**Problem.** `launcher.js:709` does `btns[16].pressed` unguarded. A gamepad with
<17 buttons (some bare joysticks via DB mapping) throws *every frame* and kills the
loop. Same shape for `btns[9/12/13/14]`.

**Plan.** `btns[16]?.pressed`, etc. One-line defensive change; cheap insurance.

### P1 — Keyboard can't drive the launcher's own hotkeys

**Problem.** The launcher's exit / fullscreen / FPS / integer-scaling hotkeys are
read **only** from `navigator.getGamepads()[0]` + `btns[16]` (Guide). The keyboard
is normalized into a gamepad *only inside the game's* `getInput()` (utils.js) — it
is never a gamepad object — so **keyboard-only users cannot exit or toggle anything**.
On a desktop/dev machine that's a real usability hole. `launcher.js:705-742`.

**Plan.** Also consult `events.js` key state for the launcher hotkeys (the SDL
keydown/keyup listeners already exist). E.g. Esc → exit, a chosen combo → fullscreen.
Pure launcher change; doesn't touch the game-facing contract.

### P1 — `.jsgame` ZIP support (the headline package-contract divergence)

**Problem.** jsgame-libretro's distribution format is the **`.jsgame` ZIP**.
jsgamelauncher has **zero** zip handling (`launcher.js:198` takes
`path.dirname(romFile)` — directories only). **A `.jsgame` built for the core will
not run in jsgamelauncher today.** Since the explicit goal is "same games run on
handhelds AND in browsers," a shippable artifact that runs in one sibling but not
the other is a real seam.

**Plan.** Add a `.jsgame`/`.zip` path: detect the extension, unzip to a
content-addressed temp dir (reuse jsgame-libretro's `runtime/content.js`
`zipContent` — including its **zip-slip guard** and the single-top-level-folder
tolerance), set `romDir` to the extracted root, then proceed through the existing
directory path unchanged. This also gives a real `file://` `import.meta.url` (which
emscripten pthread worker URLs need — same reason the core extracts).
*Decision needed:* is jsgamelauncher meant to be a **peer runtime for the same
artifact** (then do this) or **dev-mode / directory-only** with `.jsgame` as the
ship format (then document the split explicitly)? Recommend peer-runtime.

### P2 — Security posture: document it, and `--ignore-scripts` for archives

**Problem.** Games run with **full unsandboxed Node** (real `fs`, `child_process`,
network), and on first run jsgamelauncher **auto-`npm install`s** the game's deps
(`launcher.js:206-216`, `stdio:'inherit'`) then adds its `node_modules` to
`Module.globalPaths`. So *launching* an untrusted folder runs arbitrary npm
lifecycle scripts (`postinstall`) + unsandboxed code = RCE surface. Notably the
sandboxed sibling (jsgame-libretro) is the one targeting a distributable artifact;
the two projects made **opposite trust assumptions for the same format.**

**Plan.**
- For a **developer running their own game** (today's primary use), this is fine —
  but **document it**: "jsgamelauncher runs games with full Node privileges and may
  `npm install`; run only trusted content."
- If/when `.jsgame` archives from untrusted sources are ingested (P1), gate that
  path: at minimum `npm install --ignore-scripts`, and consider whether archived
  games should be required to be **self-contained / bundled** (the jsgame-libretro
  rule) rather than npm-installed at all. Don't auto-install untrusted archives.

### P2 — `Module._load` no-op-Proxy debuggability footgun

**Problem.** `launcher.js:44-53` turns **any** `MODULE_NOT_FOUND` `require` into a
permissive no-op Proxy (to stub optional CJS deps behind `try{require}catch`). It's
narrowly scoped (re-throws all other errors), but it masks *genuine* missing-dep
bugs (typo, failed install, unbuilt native addon) as a silent object that explodes
later as a confusing `undefined is not a function`.

**Plan.** Keep the behavior (it's load-bearing for some bundles) but
`console.warn('stubbed missing module:', request)` so swallowed stubs are visible
in the log. Cheap; turns silent into traceable.

### P3 — Dead-code cleanup (correctness hygiene, not behavior)

**Problem.** The 17KB root `gamepads.js` is **dead** — nothing imports it;
`launcher.js:9` uses the `gamepad-node` npm package (which was extracted *from* it).
The root `controllers/` dir (`db.json`, `*.cfg`, ~750KB) is a stale duplicate of
what's now inside `gamepad-node`. The `package.json` `create-controller-db` script
points at the dead `controllers/create_db.js`. Keeping these invites the exact
"edit the wrong file" failure mode I hit repeatedly on jsgame-libretro.

**Plan.** Delete `gamepads.js` and the duplicated root `controllers/`; remove or
repoint the `create-controller-db` script. (Verify nothing in the installers/
`systems/` trees references them first.)

### P3 — Bare-joystick D-pad-via-hat regression (in gamepad-node)

**Problem.** The dead `gamepads.js:494-524` translated SDL `hatMotion` → buttons
12-15. `gamepad-node` (the live pkg) has **no POV-hat path**, so a bare joystick
whose D-pad is a hat *and* which has no `db.json` entry loses its D-pad. Most pads
register as SDL *controllers* (dpad buttons handled), so this only bites bare
hat-joysticks — but it's a genuine regression from the in-repo version.

**Plan.** Port the `hatMotion`→buttons[12-15] block into `gamepad-node`'s joystick
converter. (This is an upstream change in the `gamepad-node` repo, not
jsgamelauncher itself.)

### P3 — `drawImage(webglCanvas)` is silently unhandled (low severity here)

**Problem.** `canvas.js:57-65`'s 2D `drawImage` only special-cases raster
`_imgImpl`; a WebGL canvas passed in (`_isWebGL`) hits Skia's native drawImage and
draws nothing/garbage. In jsgame-libretro this was a black-screen-of-death (case B);
here it is **low severity** because a WebGL game's canvas reaches the screen as a GL
FBO directly — it never needs its pixels pulled into a 2D canvas to display.

**Plan.** Optional browser-API completeness: in `canvas.js:57`, detect `_isWebGL`
and do `readPixels`+row-flip+`putImageData` (the exact readback code already exists
at `launcher.js:651-670`). Only matters for off-screen / render-to-2D / screenshot
uses. Add a comment even if not implemented (the absence is currently silent). Also
fix the latent `if (image)`-with-no-else that silently swallows a falsy image.

---

## Non-goals / explicitly NOT doing
- No synthetic frame clock (keep real `performance.now()` — web-correct; the
  synthetic clock is a libretro fast-forward/pause feature jsgamelauncher has no
  use for, and faking it would break wall-clock games).
- No shader translation, no Ganesh/GPU-Skia composite, no per-frame FBO re-query
  (all RetroArch-host-specific; absent here).
- No change to the audio engine (it's already the reference model).
- No `dt`-clamping on the game's behalf (the launcher can't know the game's units;
  it's game-author guidance — though the P0 frame cap mitigates the worst).

## Cross-project portability rule (worth putting in both READMEs)
- **Bundled** games (deps bundled, self-contained) run in BOTH.
- **Unbundled** games relying on `node_modules` resolution run **only** in
  jsgamelauncher (jsgame-libretro hard-errors on bare specifiers).
- **`.jsgame` archives** run **only** in jsgame-libretro until P1 lands.
- Entry resolution (`package.json` main → main.js/src/main.js/index.js/…) is
  already identical in both.

## Suggested sequencing
1. P0 crash guards + P0 frame cap (small, high-value, handheld-critical).
2. P1 keyboard hotkeys (usability) + P1 `.jsgame` support (the format seam) — the
   latter pending the peer-runtime-vs-dev-mode decision.
3. P2 security doc + `--ignore-scripts`-on-archives; P2 `_load` warn.
4. P3 cleanup, hat-dpad (upstream gamepad-node), drawImage(glCanvas).

---

## UPDATE 2026-06-17: vm-realm sandbox PORTED (branch `vm-realm-sandbox`)

The P2 security item (full Node = RCE surface) is addressed: jsgamelauncher now
runs games in a `node:vm` realm (a browser sandbox), the same model as
jsgame-libretro. Game code sees NO process/require/fs/global/__dirname — verified
adversarially (`process=undefined require=undefined`, `import('fs')`/`child_process`
blocked). 2D games (tetris-ai, adventure-ai, space-invaders-ai) run clean;
threaded wasm (box2d3 deluxe) works — spawns real worker_threads pthreads via a
sandboxed module Worker.

Files: `realm.js` (the vm realm + ESM loader + sandboxed module Worker),
`worker-module-bootstrap.mjs` (ported from jsgame-libretro), `launcher.js`
(runs the game via `realm.runEntry` instead of `import()`), `cli.js` (re-execs
with `--experimental-vm-modules`, which `vm.SourceTextModule` requires).

### Costs / behavior changes (decide before merging to main)
- **`--experimental-vm-modules` required** — cli.js re-execs node with it.
- **Bare specifiers are now a HARD ERROR** in games (browser parity). A game that
  relied on jsgamelauncher resolving an UNBUNDLED `import 'three'` from
  node_modules will now fail — it must be bundled. (All the vite-built games are
  fine.) This also makes the auto-npm-install + `Module.globalPaths` machinery
  mostly moot for game code; revisit it.
- **`Module._load` no-op-Proxy stub** still applies to the MAIN realm (launcher +
  its deps), not game code — game code can't `require` at all now.
- Per-game `node_modules` resolution for game code is gone (intended).

### Still to verify on real hardware
- GL games (three.js / Phaser) — couldn't fully render here (headless EGL fails);
  they LOAD in the realm but need a real GPU/display to confirm the present path.
- The frame-cap (P0) is independent and still recommended.

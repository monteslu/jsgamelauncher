// Pure re-export — importing this package has NO side effects (no argv parse,
// no host globals installed, no SDL window). Call launch(gamePath, opts) to run
// a game standalone (opens an SDL window + runs its own loop), or
// createHostSession(gamePath, opts) for a headless, host-stepped session (no
// window/loop — the caller steps frames + reads the offscreen canvas). Both
// require node started with --experimental-vm-modules (see launch()).
export { launch, createHostSession, default } from './launcher.js';

// Pure re-export — importing this package has NO side effects (no argv parse,
// no host globals installed, no SDL window). Call launch(gamePath, opts) to run
// a game. Requires node started with --experimental-vm-modules (see launch()).
export { launch, default } from './launcher.js';

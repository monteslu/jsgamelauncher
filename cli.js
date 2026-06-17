#!/usr/bin/env node
// The game runs in a vm realm (realm.js), which needs vm.SourceTextModule —
// only available with --experimental-vm-modules. If we weren't started with it,
// re-exec node with the flag, then continue. (Must happen BEFORE importing the
// launcher, since that pulls in the vm-modules code path.)
import { spawnSync } from 'node:child_process';

const HAS_VM_MODULES = process.execArgv.includes('--experimental-vm-modules')
  || (process.env.NODE_OPTIONS || '').includes('--experimental-vm-modules');

if (!HAS_VM_MODULES) {
  const res = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', '--no-warnings', ...process.argv.slice(1)],
    { stdio: 'inherit' },
  );
  process.exit(res.status ?? 1);
}

const inspector = await import('node:inspector');

// Parse command line arguments
const args = process.argv.slice(2);
const debugMode = args.includes('--debug') || args.includes('-d');

// Enable inspector if debug mode is on
if (debugMode) {
  inspector.default.open(9229, 'localhost', true);
}

const { default: launcher } = await import('./launcher.js');

// Launch the game
launcher();

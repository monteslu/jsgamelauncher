#!/usr/bin/env node
import inspector from 'node:inspector';
import launcher from './launcher.js';

// Parse command line arguments
const args = process.argv.slice(2);
const debugMode = args.includes('--debug') || args.includes('-d');

// Enable inspector if debug mode is on
if (debugMode) {
    inspector.open(9229, 'localhost', true);
}

// Launch the game
launcher();

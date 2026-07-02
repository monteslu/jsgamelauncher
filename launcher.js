import sdl from '@kmamal/sdl';
import path from 'path';
import Module from 'module';
import fs from 'fs';
import nrsc, { ImageData } from '@napi-rs/canvas';
import Worker from 'web-worker';
import WebSocket from 'ws';
import getOptions from './options.js';
import { installNavigatorShim, loadAdditionalControllerConfig } from 'gamepad-node';
import { createCanvas, OffscreenCanvas, setDisplayContext, onWebGLCanvas } from './canvas.js';
import { createWebGL2Context, WebGL2RenderingContext } from 'webgl-node';
import { createImageClass, createLoadImage } from './image.js';
import createLocalStorage from './localstorage.js';
import initializeEvents from './events.js';
import {
  AudioContext, OfflineAudioContext, AudioDestinationNode, AudioBuffer,
  AudioNode, AudioParam, PeriodicWave,
  OscillatorNode, GainNode, BiquadFilterNode, DelayNode, StereoPannerNode,
  PannerNode, ConstantSourceNode, ChannelSplitterNode, ChannelMergerNode,
  AnalyserNode, DynamicsCompressorNode, WaveShaperNode, IIRFilterNode,
  ConvolverNode, AudioBufferSourceNode,
  setSdl as setAudioSdl,
} from 'webaudio-node';
import createFetch from './fetch.js';
import createXMLHttpRequest from './xhr.js';
import { createObjectURL, revokeObjectURL, fetchBlobFromUrl } from './blob.js';
import { Audio } from './audio.js';
import { Video } from './video.js';
import initializeFontFace from './fontface.js';
import { createRealm } from './realm.js';

// NOTE: This module must have NO side effects at import time — importing it
// (e.g. from index.js) must not parse argv, install the host globals, or open
// an SDL window. All of that happens inside launch(). The uncaughtException
// handler and the host-global installation are done once, lazily, the first
// time launch() runs (see installHostGlobals()).

// Extract a .jsgame/.zip archive to a real on-disk dir and return its path.
// Content-addressed (a hash of the zip) so re-runs reuse it; pruned to a few
// most-recently-used so a temp dir doesn't grow unbounded. A real on-disk root
// is needed so the realm can load modules + emscripten wasm pthread worker URLs
// resolve. (Same approach as jsgame-libretro's content.js.)
async function extractGameArchive(archivePath) {
  const os = await import('node:os');
  const crypto = await import('node:crypto');
  const { unzipSync } = await import('fflate');
  const raw = fs.readFileSync(archivePath);
  const files = unzipSync(raw);
  // tolerate a single top-level folder wrapping the game tree
  const names = Object.keys(files).filter((n) => !n.endsWith('/'));
  let prefix = '';
  if (names.length > 0) {
    const first = names[0].split('/')[0] + '/';
    if (names.every((n) => n.startsWith(first))) prefix = first;
  }
  const PREFIX = 'jsgamelauncher-content-';
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), PREFIX + hash);
  const stamp = path.join(dir, '.extracted');
  if (!fs.existsSync(stamp)) {
    // prune old extractions (keep ~6 most-recently-used)
    try {
      const KEEP = 6;
      const dirs = fs.readdirSync(os.tmpdir())
        .filter((n) => n.startsWith(PREFIX))
        .map((n) => { const p = path.join(os.tmpdir(), n); let mt = 0; try { mt = fs.statSync(p).mtimeMs; } catch {} return { p, mt }; })
        .sort((a, b) => b.mt - a.mt);
      for (const { p } of dirs.slice(KEEP)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
    } catch {}
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith('/')) continue;
      const rel = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
      if (!rel) continue;
      const dst = path.join(dir, rel);
      if (!path.resolve(dst).startsWith(path.resolve(dir))) continue; // zip-slip guard
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    }
    fs.writeFileSync(stamp, '');
  } else {
    try { fs.utimesSync(dir, new Date(), new Date()); } catch {}
  }
  console.log('extracted', archivePath, '->', dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Module-scoped runtime state.
//
// These used to be initialized inline at module top-level (from the argv-parsed
// options), which meant importing this module launched a game. They are now
// plain declarations set by launch() before it calls main(). resize(), drawFPS()
// and main() read them exactly as before.
// ---------------------------------------------------------------------------
let canvas;
let stretchToWindow = false;

// Per-run inputs, populated by launch():
let options = {};                // CLI-shaped options object (see buildOptions)
let romFile;                     // the path the user pointed us at
let romDir;                      // resolved game root directory
let gameFile;                    // resolved entry file inside romDir

// rAF plumbing (installed on globalThis by installHostGlobals):
let rafCallbackId = 1;
let currentRafCallback;

function requestAnimationFrame(callback) {
  rafCallbackId++;
  currentRafCallback = {
    id: rafCallbackId,
    callback,
  };
  return rafCallbackId;
};

function cancelAnimationFrame(id) {
  if (currentRafCallback?.id === id) {
    currentRafCallback = null;
  }
};

const DEFAULT_GAME_WIDTH = 640;
const DEFAULT_GAME_HEIGHT = 480;
let backCanvas;
let appWindow;
let integerScaling = false;
let canToggleIntegerScaling = true;
let callResizeEvents;
let fullscreen = false;
let canToggleFullscreen = true;
let showFPS = false;
let canToggleFPS = true;
let setCanvasSizeToWindow = false;
let canvasAutoResize = false;
let canCanvasAutoResize = true;
let frameCount = 0;               // Frame counter
let fps = 0;                      // Current FPS value
let fpsInterval = 1000;           // Update FPS every second
let lastTime; // Track the last frame's time
let windowRatio = 1;
let useBackCanvas = false;
let aspectRatioDifference = 0;

// ts uses this class
class MutationObserver {
  constructor() {
  }
  observe() {
  }
}

// The fake DOM document games see. References module-scoped `canvas`/`appWindow`,
// which are set up during main(); building it here (not inside a function) keeps
// the same single object identity the original code relied on.
const document = {
  set title(newTitle) {
    appWindow.setTitle(newTitle);
  },
  getElementById: (id) => {
    // console.log('document.getElementById', id, canvas);
    return canvas;
  },
  querySelectorAll: (selector) => {
    // console.log('document.querySelectorAll', selector);
    return [];
  },
  createElement: (name, ...args) => {
    console.log('DOCUMENT.createElement', name, args);
    if (name === 'canvas') {
      return createCanvas(300, 150);
    }
    if (name === 'image' && globalThis.Image) {
      return new globalThis.Image();
    }
    if (name === 'video' && globalThis.Video) {
      return new globalThis.Video();
    }
    if (name === 'audio' && globalThis.Audio) {
      return new globalThis.Audio();
    }
    return {};
  },
  hasFocus: () => {
    return true;
  },
  createTextNode: (text) => {
    return {
      nodeValue: text,
    };
  },
  createElementNS: (ns, name) => {
    return {
      tagName: name,
    };
  },
  body: {
    appendChild: () => {},
    getBoundingClientRect: () => {
      return {
        left: 0,
        top: 0,
        width: canvas?.width,
        height: canvas?.height,
        right: canvas?.width,
        bottom: canvas?.height,
      };
    },
  },
  documentElement: {},
  readyState: 'complete',
  currentScript: {
    src: '',
  },
  fonts: {
    add: (font) => {
      console.log('document.fonts.add', font);
    },
  },
};

// WebGLRenderingContext must be distinct from WebGL2RenderingContext
// so Three.js instanceof checks correctly detect WebGL2
class WebGLRenderingContext {}

// ---------------------------------------------------------------------------
// installHostGlobals(): install the host/browser shim globals onto globalThis.
// This has real side effects (patches Module._load, mutates globalThis, installs
// an uncaughtException handler) so it must NOT run on import — it runs once, the
// first time launch() is called. Guarded so repeated launch() calls are cheap.
// ---------------------------------------------------------------------------
let hostGlobalsInstalled = false;
function installHostGlobals() {
  if (hostGlobalsInstalled) return;
  hostGlobalsInstalled = true;

  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err, err.code);
    if (err.code === 'EPIPE') {
      // console.log('EPIPE');
      // process.exit(0);
      return;
    } else if (err.message.includes('SDL_JoystickPathForIndex')) {
      // console.log('ECONNRESET');
      // process.exit(0);
      return;
    }
    // Perform cleanup or logging here
    process.exit(1); // Optional: Exit the process gracefully
  });

  globalThis.global = globalThis;
  globalThis.self = globalThis;
  console.log('LAUNCHING....');
  // Stub missing optional CJS modules so libraries with webpack guards don't crash.
  // Returns a Proxy that handles any property access/construction gracefully.
  const _origLoad = Module._load;
  const _noopProxy = new Proxy(function(){}, {
    get: (_, prop) => prop === 'prototype' ? {} : _noopProxy,
    construct: () => new Proxy({}, { get: (_, p) => p === 'add' ? () => {} : _noopProxy }),
    apply: () => _noopProxy,
  });
  Module._load = function(request, ...args) {
    try { return _origLoad.call(this, request, ...args); }
    catch (e) { if (e.code === 'MODULE_NOT_FOUND') return _noopProxy; throw e; }
  };

  globalThis.window = globalThis;
  globalThis._jsg = { controllers: [], joysticks: [], sdl, nrsc };
  globalThis.HTMLCanvasElement = nrsc.Canvas;
  globalThis.ImageData = ImageData;
  globalThis.OffscreenCanvas = OffscreenCanvas;
  globalThis.Audio = Audio;
  globalThis.Video = Video;
  globalThis.Worker = Worker;
  globalThis.WebSocket = WebSocket;

  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  URL.fetchBlobFromUrl = fetchBlobFromUrl;
  globalThis.MutationObserver = MutationObserver;
  globalThis.document = document;
  globalThis.screen = {};
  // web audio
  globalThis.AudioContext = AudioContext;
  globalThis.AudioDestinationNode = AudioDestinationNode;
  globalThis.WebGLRenderingContext = WebGLRenderingContext;
  globalThis.WebGL2RenderingContext = WebGL2RenderingContext;
  // Full WebAudio graph surface (webaudio-node exports ~20 classes; expose them
  // all so games can reach filters/analysers/reverb/spatial/compression, not just
  // the basic oscillator+gain path).
  globalThis.OfflineAudioContext = OfflineAudioContext;
  globalThis.AudioNode = AudioNode;
  globalThis.AudioParam = AudioParam;
  globalThis.PeriodicWave = PeriodicWave;
  globalThis.OscillatorNode = OscillatorNode;
  globalThis.GainNode = GainNode;
  globalThis.AudioBuffer = AudioBuffer;
  globalThis.AudioBufferSourceNode = AudioBufferSourceNode;
  globalThis.BiquadFilterNode = BiquadFilterNode;
  globalThis.DelayNode = DelayNode;
  globalThis.StereoPannerNode = StereoPannerNode;
  globalThis.PannerNode = PannerNode;
  globalThis.ConstantSourceNode = ConstantSourceNode;
  globalThis.ChannelSplitterNode = ChannelSplitterNode;
  globalThis.ChannelMergerNode = ChannelMergerNode;
  globalThis.AnalyserNode = AnalyserNode;
  globalThis.DynamicsCompressorNode = DynamicsCompressorNode;
  globalThis.WaveShaperNode = WaveShaperNode;
  globalThis.IIRFilterNode = IIRFilterNode;
  globalThis.ConvolverNode = ConvolverNode;

  globalThis.sdl = sdl;
  setAudioSdl(sdl);

  globalThis.requestAnimationFrame = requestAnimationFrame;
  globalThis.cancelAnimationFrame = cancelAnimationFrame;
}

// Standard-mapping gamepad button order (W3C Gamepad "standard" layout). Used by the
// host-session synthetic navigator to expose injected input by button name.
const STANDARD_BUTTON_ORDER = [
  'a', 'b', 'x', 'y', 'l1', 'r1', 'l2', 'r2', 'select', 'start',
  'l3', 'r3', 'up', 'down', 'left', 'right', 'home',
];

// The browser-realm intrinsics both main() and createHostSession() hand to the game
// realm. Reads globalThis.* references installed by installHostGlobals(); the caller
// (window loop OR host session) drives the same canvas/rAF/navigator the realm sees.
function buildRealmGlobals() {
  return {
    HTMLCanvasElement: globalThis.HTMLCanvasElement,
    ImageData, OffscreenCanvas,
    Audio: globalThis.Audio, Video: globalThis.Video,
    Worker: globalThis.Worker, WebSocket: globalThis.WebSocket,
    MutationObserver: globalThis.MutationObserver,
    document: globalThis.document, screen: globalThis.screen,
    AudioContext: globalThis.AudioContext, OfflineAudioContext: globalThis.OfflineAudioContext,
    AudioDestinationNode: globalThis.AudioDestinationNode, AudioBuffer: globalThis.AudioBuffer,
    AudioNode: globalThis.AudioNode, AudioParam: globalThis.AudioParam, PeriodicWave: globalThis.PeriodicWave,
    OscillatorNode: globalThis.OscillatorNode, GainNode: globalThis.GainNode,
    AudioBufferSourceNode: globalThis.AudioBufferSourceNode, BiquadFilterNode: globalThis.BiquadFilterNode,
    DelayNode: globalThis.DelayNode, StereoPannerNode: globalThis.StereoPannerNode, PannerNode: globalThis.PannerNode,
    ConstantSourceNode: globalThis.ConstantSourceNode,
    ChannelSplitterNode: globalThis.ChannelSplitterNode, ChannelMergerNode: globalThis.ChannelMergerNode,
    AnalyserNode: globalThis.AnalyserNode, DynamicsCompressorNode: globalThis.DynamicsCompressorNode,
    WaveShaperNode: globalThis.WaveShaperNode, IIRFilterNode: globalThis.IIRFilterNode,
    ConvolverNode: globalThis.ConvolverNode,
    WebGLRenderingContext: globalThis.WebGLRenderingContext, WebGL2RenderingContext: globalThis.WebGL2RenderingContext,
    requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame,
    requestIdleCallback: (cb) => setTimeout(() => cb({ timeRemaining: () => 10 }), 0),
    cancelIdleCallback: clearTimeout,
    loadImage: globalThis.loadImage, Image: globalThis.Image,
    fetch: globalThis.fetch, XMLHttpRequest: globalThis.XMLHttpRequest,
    localStorage: globalThis.localStorage, FontFace: globalThis.FontFace,
    navigator: globalThis.navigator,
    innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight,
    devicePixelRatio: 1,
    sdl: globalThis.sdl,
    alert: (msg) => console.log('alert:', msg),
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    dispatchEvent: globalThis.dispatchEvent || (() => true),
    close: globalThis.close || (() => {}),
  };
}

// ---------------------------------------------------------------------------
// resolveGame(): the argv-independent version of the old top-level resolution
// block. Given a game path (directory / .jsg marker / .jsgame|.zip archive),
// resolve the game root + entry file, run auto npm-install, and install the
// game-specific globals (loadImage/Image/fetch/localStorage/FontFace, etc).
// Populates the module-scoped romFile/romDir/gameFile.
// ---------------------------------------------------------------------------
async function resolveGame(gamePath) {
  romFile = gamePath;
  if (!romFile) {
    throw new Error('rom file not found: no game path provided');
  }
  if (!fs.existsSync(romFile)) {
    romFile = path.join(process.cwd(), romFile);
  }
  if (!fs.existsSync(romFile)) {
    throw new Error(`rom file not found: ${gamePath}`);
  }
  // Accept THREE forms: a game directory, a marker file inside it (e.g. game.jsg),
  // or a .jsgame/.zip archive (extracted to a temp dir, like jsgame-libretro).
  const lc = romFile.toLowerCase();
  if (fs.statSync(romFile).isDirectory()) {
    romDir = romFile;
  } else if (lc.endsWith('.jsgame') || lc.endsWith('.zip')) {
    romDir = await extractGameArchive(romFile);
  } else {
    // a file inside the game dir (the .jsg marker, or any entry) → its dir
    romDir = path.dirname(romFile);
  }
  console.log('romFile', romFile, 'romDir', romDir);
  gameFile = undefined;

  // Issue #9: Check package.json main FIRST
  if (fs.existsSync(path.join(romDir, 'package.json'))) {
    const packjson = JSON.parse(fs.readFileSync(path.join(romDir, 'package.json'), 'utf8'));

    // Issue #31: Auto npm install if dependencies exist but node_modules missing
    if (packjson.dependencies && !fs.existsSync(path.join(romDir, 'node_modules'))) {
      console.log('Dependencies found but node_modules missing, running npm install...');
      const { execSync } = await import('child_process');
      try {
        execSync('npm install', { cwd: romDir, stdio: 'inherit' });
        console.log('npm install completed');
      } catch (err) {
        console.error('npm install failed:', err.message);
      }
    }

    if (packjson.main) {
      gameFile = path.join(romDir, packjson.main);
      if (!fs.existsSync(gameFile)) {
        throw new Error(`${gameFile} package.json main file not found`);
      }
    }
  }

  // Fallback to file order if no package.json main
  if (!gameFile) {
    const tryOrder = [
      ['main.js'],
      ['src', 'main.js'],
      ['index.js'],
      ['src', 'index.js'],
      ['game.js'],
      ['src', 'game.js'],
    ]
    for (const order of tryOrder) {
      const tryGameFile = path.join(romDir, ...order);
      if (fs.existsSync(tryGameFile)) {
        gameFile = tryGameFile;
        break;
      }
    }
  }

  if (!gameFile) {
    throw new Error('game file not found');
  }

  const romName = path.basename(romDir);
  globalThis._jsg.rom = {
    romName,
    romDir,
    gameFile,
  };
  console.log('globalThis._jsg.rom', globalThis._jsg.rom);
  globalThis.HTMLCanvasElement = nrsc.Canvas;
  if (fs.existsSync(path.join(romDir, 'node_modules'))) {
    Module.globalPaths.push(path.join(romDir, 'node_modules'));
    // console.log(Module.globalPaths);
  }
  console.log('creating rom specific globals', romDir);
  globalThis.loadImage = createLoadImage(romDir);
  globalThis.Image = createImageClass(romDir);
  globalThis.fetch = createFetch(romDir);
  globalThis.XMLHttpRequest = createXMLHttpRequest(romDir);
  globalThis.localStorage = await createLocalStorage(romName);
  globalThis.FontFace = initializeFontFace(romDir);
}

const resize = () => {
  const { pixelWidth, pixelHeight } = appWindow;
  let backCanvasWidth = pixelWidth;
  let backCanvasHeight = pixelHeight;
  windowRatio = pixelWidth / pixelHeight;
  backCanvas = createCanvas(backCanvasWidth, backCanvasHeight);
  if (canvas) {
    const canvasRatio = canvas.width / canvas.height;
    aspectRatioDifference = Math.abs(windowRatio - canvasRatio);
    if (canvasAutoResize) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
  }
  globalThis.innerWidth = pixelWidth;
  globalThis.innerHeight = pixelHeight;
  const backCtx = backCanvas.getContext('2d');
  backCtx.imageSmoothingEnabled = false;
  backCtx.fillStyle = 'white';
  const fontSize = backCanvasHeight / 25;
  backCtx.font = `${fontSize}px Arial`;
  backCtx.fillText('Loading...', pixelWidth / 2 - fontSize * 5, pixelHeight / 2);
  try {
    appWindow.render(backCanvasWidth, backCanvasHeight, backCanvasWidth * 4, 'rgba32', Buffer.from(backCanvas.data().buffer));
  } catch (e) {
    // appWindow.render may not be available with opengl: true
  }
  console.log('resize', pixelWidth, pixelHeight, backCanvasWidth, backCanvasHeight);
  backCanvas.name = 'backCanvas';
}

const drawFPS = (ctx) => {
  const size = ctx.canvas.width / 30;
  ctx.save();
  ctx.fillStyle = 'yellow';
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 1;
  ctx.font = `bold ${size}px Arial`;
  ctx.fillText('FPS: ' + fps, size / 2, size * 1.5);
  ctx.strokeText('FPS: ' + fps, size / 2, size * 1.5);
  ctx.restore();
};
async function main() {
  console.log('fullscreen', fullscreen, 'showFPS', showFPS, 'integerScaling', integerScaling);

  // Set up GL display context for zero-copy rendering
  let displayGl = null;
  let displaySwapBuffers = null;
  let displayMakeCurrent = null;
  let blitProgram = null;
  let blitVAO = null;
  let blitTexture = null;
  let flipYLoc = null;

  // Try fbdev window surface BEFORE creating SDL window (order matters on Mali fbdev)
  try {
    console.log('Trying EGL: fbdev window surface');
    const displayResult = createWebGL2Context(DEFAULT_GAME_WIDTH, DEFAULT_GAME_HEIGHT, { windowSurface: true });
    displayGl = displayResult.gl;
    displaySwapBuffers = displayResult.swapBuffers;
    if (displayResult.setSwapInterval) {
      displayResult.setSwapInterval(0);
      console.log('Vsync disabled (swap interval 0)');
    }
    displayMakeCurrent = displayResult.makeCurrent;
    setDisplayContext(displayGl, displaySwapBuffers);
    console.log('EGL context created via fbdev window surface');
  } catch (e) {
    console.log('EGL fbdev failed:', e.message);
    displayGl = null;
    displaySwapBuffers = null;
  }

  // Create SDL window (after EGL on fbdev, so EGL owns the display)
  appWindow = sdl.video.createWindow({ width: DEFAULT_GAME_WIDTH, height: DEFAULT_GAME_HEIGHT, resizable: true, fullscreen });
  console.log('appWindow CREATED', appWindow.pixelWidth, appWindow.pixelHeight);

  // Re-assert EGL context after SDL init (SDL may disturb it)
  if (displayMakeCurrent) {
    displayMakeCurrent();
    console.log('EGL context re-asserted after SDL window');
  }

  // If fbdev failed, try native window handle (desktop X11/Wayland)
  if (!displayGl) {
    try {
      appWindow.destroy();
      appWindow = sdl.video.createWindow({ width: DEFAULT_GAME_WIDTH, height: DEFAULT_GAME_HEIGHT, resizable: true, fullscreen, opengl: true });
      const nativeGL = appWindow.native?.gl;
      if (nativeGL) {
        console.log('Trying EGL: native window handle');
        const displayResult = createWebGL2Context(appWindow.pixelWidth, appWindow.pixelHeight, { nativeWindow: nativeGL });
        displayGl = displayResult.gl;
        displaySwapBuffers = displayResult.swapBuffers;
        if (displayResult.setSwapInterval) {
          displayResult.setSwapInterval(0);
          console.log('Vsync disabled (swap interval 0)');
        }
        displayMakeCurrent = displayResult.makeCurrent;
        setDisplayContext(displayGl, displaySwapBuffers);
        console.log('EGL context created via native window handle');
      }
    } catch (e2) {
      console.log('EGL native handle failed:', e2.message);
      displayGl = null;
      displaySwapBuffers = null;
      try { appWindow.destroy(); } catch (_) {}
      appWindow = sdl.video.createWindow({ width: DEFAULT_GAME_WIDTH, height: DEFAULT_GAME_HEIGHT, resizable: true, fullscreen });
    }
  }

  await new Promise((resolve) => {
    setTimeout(() => {
      appWindow.setTitle('canvas game');
      appWindow.setFullscreen(fullscreen);
      console.log('calling resize', appWindow.pixelWidth, appWindow.pixelHeight);
      resize();
      resolve();
    }, 100);
  });
  console.log('appWindow RESIZED', appWindow.pixelWidth, appWindow.pixelHeight);

  if (displayGl) {
    // Set up blit shader for 2D canvas and FBO blit
    const vs = `#version 300 es
    in vec2 a_pos;
    out vec2 v_uv;
    uniform float u_flipY;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      if (u_flipY > 0.5) v_uv.y = 1.0 - v_uv.y;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }`;
    const fs = `#version 300 es
    precision mediump float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    void main() {
      fragColor = texture(u_tex, v_uv);
    }`;

    const vShader = displayGl.createShader(displayGl.VERTEX_SHADER);
    displayGl.shaderSource(vShader, vs);
    displayGl.compileShader(vShader);
    const fShader = displayGl.createShader(displayGl.FRAGMENT_SHADER);
    displayGl.shaderSource(fShader, fs);
    displayGl.compileShader(fShader);
    blitProgram = displayGl.createProgram();
    displayGl.attachShader(blitProgram, vShader);
    displayGl.attachShader(blitProgram, fShader);
    displayGl.linkProgram(blitProgram);
    flipYLoc = displayGl.getUniformLocation(blitProgram, 'u_flipY');
    const texLoc = displayGl.getUniformLocation(blitProgram, 'u_tex');
    displayGl.useProgram(blitProgram);
    displayGl.uniform1i(texLoc, 0);

    // Fullscreen quad
    blitVAO = displayGl.createVertexArray();
    displayGl.bindVertexArray(blitVAO);
    const quadBuf = displayGl.createBuffer();
    displayGl.bindBuffer(displayGl.ARRAY_BUFFER, quadBuf);
    displayGl.bufferData(displayGl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), displayGl.STATIC_DRAW);
    const posLoc = displayGl.getAttribLocation(blitProgram, 'a_pos');
    displayGl.enableVertexAttribArray(posLoc);
    displayGl.vertexAttribPointer(posLoc, 2, displayGl.FLOAT, false, 0, 0);

    // Blit texture for 2D canvas uploads
    blitTexture = displayGl.createTexture();
    displayGl.bindTexture(displayGl.TEXTURE_2D, blitTexture);
    displayGl.texParameteri(displayGl.TEXTURE_2D, displayGl.TEXTURE_MIN_FILTER, displayGl.NEAREST);
    displayGl.texParameteri(displayGl.TEXTURE_2D, displayGl.TEXTURE_MAG_FILTER, displayGl.NEAREST);
    displayGl.texParameteri(displayGl.TEXTURE_2D, displayGl.TEXTURE_WRAP_S, displayGl.CLAMP_TO_EDGE);
    displayGl.texParameteri(displayGl.TEXTURE_2D, displayGl.TEXTURE_WRAP_T, displayGl.CLAMP_TO_EDGE);

    console.log('GL blit pipeline ready');
  } else {
    console.log('All EGL attempts failed, using SDL render fallback');
  }

  // FBO for WebGL game rendering (created after canvas, set up below)
  let gameFBO = null;
  let gameFBOTexture = null;

  const eventHandlers = initializeEvents(appWindow);
  callResizeEvents = eventHandlers.callResizeEvents;
  if (setCanvasSizeToWindow) {
    canvas = createCanvas(appWindow.pixelWidth, appWindow.pixelHeight);
  } else {
    canvas = createCanvas(DEFAULT_GAME_WIDTH, DEFAULT_GAME_HEIGHT);
  }
  globalThis.innerWidth = appWindow.pixelWidth;
  globalThis.innerHeight = appWindow.pixelHeight;
  console.log('canvas', canvas.width, canvas.height);
  if (!canvas.getBoundingClientRect) {
    canvas.getBoundingClientRect = () => {
      return {
        x: 0,
        y: 0,
        width: canvas.width,
        height: canvas.height,
      };
    };
  }
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  canvas.name = 'game canvas';
  // FBO redirect for WebGL games: needed when game resolution != display resolution
  // (for letterboxing). When they match, game renders directly to default FB — no blit overhead.
  if (displayGl) {
    gameFBOTexture = displayGl.createTexture();
    displayGl.bindTexture(displayGl.TEXTURE_2D, gameFBOTexture);
    displayGl.texImage2D(displayGl.TEXTURE_2D, 0, displayGl.RGBA, canvas.width, canvas.height, 0, displayGl.RGBA, displayGl.UNSIGNED_BYTE, null);
    displayGl.texParameteri(displayGl.TEXTURE_2D, displayGl.TEXTURE_MIN_FILTER, displayGl.NEAREST);
    displayGl.texParameteri(displayGl.TEXTURE_2D, displayGl.TEXTURE_MAG_FILTER, displayGl.NEAREST);
    displayGl.texParameteri(displayGl.TEXTURE_2D, displayGl.TEXTURE_WRAP_S, displayGl.CLAMP_TO_EDGE);
    displayGl.texParameteri(displayGl.TEXTURE_2D, displayGl.TEXTURE_WRAP_T, displayGl.CLAMP_TO_EDGE);

    gameFBO = displayGl.createFramebuffer();
    displayGl.bindFramebuffer(displayGl.FRAMEBUFFER, gameFBO);
    displayGl.framebufferTexture2D(displayGl.FRAMEBUFFER, displayGl.COLOR_ATTACHMENT0, displayGl.TEXTURE_2D, gameFBOTexture, 0);

    const gameDepthRB = displayGl.createRenderbuffer();
    displayGl.bindRenderbuffer(displayGl.RENDERBUFFER, gameDepthRB);
    displayGl.renderbufferStorage(displayGl.RENDERBUFFER, displayGl.DEPTH24_STENCIL8, canvas.width, canvas.height);
    displayGl.framebufferRenderbuffer(displayGl.FRAMEBUFFER, displayGl.DEPTH_STENCIL_ATTACHMENT, displayGl.RENDERBUFFER, gameDepthRB);

    const status = displayGl.checkFramebufferStatus(displayGl.FRAMEBUFFER);
    if (status !== displayGl.FRAMEBUFFER_COMPLETE) {
      console.error('Game FBO incomplete:', status);
    } else {
      console.log('Game FBO created:', canvas.width, 'x', canvas.height);
    }

    const origBindFramebuffer = displayGl.bindFramebuffer.bind(displayGl);
    displayGl.bindFramebuffer = (target, fb) => {
      if (fb === null || fb === undefined) {
        origBindFramebuffer(target, gameFBO);
      } else {
        origBindFramebuffer(target, fb);
      }
    };
    displayGl._origBindFramebuffer = origBindFramebuffer;
    displayGl._width = canvas.width;
    displayGl._height = canvas.height;
    origBindFramebuffer(displayGl.FRAMEBUFFER, gameFBO);
    displayGl.viewport(0, 0, canvas.width, canvas.height);
  }

  // Track when a game-created canvas gets a WebGL context (e.g. Phaser.AUTO)
  onWebGLCanvas((glCanvas) => {
    if (glCanvas !== canvas) {
      console.log('Game created WebGL canvas:', glCanvas.width, 'x', glCanvas.height);
      canvas = glCanvas;
    }
  });

  if (options.Addconcfg) {
    await loadAdditionalControllerConfig(options.Addconcfg);
  }
  installNavigatorShim({ sdl });

  console.log('Pre-import gameWidth', canvas.width , 'gameHeight', canvas.height);
  //added file:// to fix issue with windows, tested on windows 10, macos, and linux/knulli
  let fullGamefile = 'file://' + gameFile;
  if (romFile.startsWith('.') || romFile.startsWith('..')) {
    fullGamefile = 'file://' + path.join(process.cwd(), gameFile);
  }
  console.log('fullGamefile path', fullGamefile);

  // Run the game in an isolated BROWSER realm (no process/require/fs reachable by
  // game code) instead of the main Node scope. The shims above are passed in as
  // host intrinsics; the SDL window + this frame loop stay in the main realm and
  // drive the realm's display canvas / rAF / gamepad (they read the same
  // globalThis.* references). See realm.js.
  const realmGlobals = buildRealmGlobals();
  const realm = createRealm({ globals: realmGlobals, gameRoot: romDir });
  await realm.runEntry(fullGamefile);
  resize();
  eventHandlers.callLoadingEvents();

  let callCount = 0;
  let imageDrawTime = 0;
  let callbackTime = 0;
  let windowRenderTime = 0;


  lastTime = performance.now(); // Track the last frame's time

  async function launcherDraw() {
    const canvasRatio = canvas.width / canvas.height;
    let drawX, drawY, drawWidth, drawHeight;
    const winW = appWindow.pixelWidth;
    const winH = appWindow.pixelHeight;

    if (stretchToWindow) {
      drawX = 0;
      drawY = 0;
      drawWidth = winW;
      drawHeight = winH;
    } else if (windowRatio > canvasRatio) {
      drawHeight = winH;
      drawWidth = Math.round(drawHeight * canvasRatio);
      drawX = Math.round((winW - drawWidth) / 2);
      drawY = 0;
    } else {
      drawWidth = winW;
      drawHeight = Math.round(drawWidth / canvasRatio);
      drawX = 0;
      drawY = Math.round((winH - drawHeight) / 2);
    }

    const startImageDrawTime = performance.now();

    if (canvas._isWebGL && canvas._swapBuffers && gameFBO) {
      // WebGL game rendered to FBO — blit to window with letterboxing
      const gl = displayGl;
      while (gl.getError() !== 0) {}
      gl._origBindFramebuffer(gl.READ_FRAMEBUFFER, gameFBO);
      gl._origBindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blitFramebuffer(
        0, 0, canvas.width, canvas.height,
        drawX, winH - drawY - drawHeight, drawX + drawWidth, winH - drawY,
        gl.COLOR_BUFFER_BIT, gl.LINEAR
      );
      imageDrawTime += (performance.now() - startImageDrawTime);
      const startWindowRenderTime = performance.now();
      canvas._swapBuffers();
      windowRenderTime += (performance.now() - startWindowRenderTime);
      gl._origBindFramebuffer(gl.FRAMEBUFFER, gameFBO);
      gl.viewport(0, 0, canvas.width, canvas.height);
      return;
    }

    if (displaySwapBuffers) {
      // 2D canvas game — blit via GL
      if (showFPS) {
        drawFPS(ctx);
      }
      const pixels = canvas.data();
      const bindFB = displayGl._origBindFramebuffer || displayGl.bindFramebuffer.bind(displayGl);
      bindFB(displayGl.FRAMEBUFFER, null);
      displayGl.viewport(0, 0, winW, winH);
      displayGl.clearColor(0, 0, 0, 1);
      displayGl.clear(displayGl.COLOR_BUFFER_BIT);
      displayGl.viewport(drawX, winH - drawY - drawHeight, drawWidth, drawHeight);
      displayGl.useProgram(blitProgram);
      displayGl.uniform1f(flipYLoc, 1.0); // Canvas pixels are top-down, flip Y
      displayGl.bindVertexArray(blitVAO);
      displayGl.activeTexture(displayGl.TEXTURE0);
      displayGl.bindTexture(displayGl.TEXTURE_2D, blitTexture);
      displayGl.texImage2D(displayGl.TEXTURE_2D, 0, displayGl.RGBA, canvas.width, canvas.height, 0, displayGl.RGBA, displayGl.UNSIGNED_BYTE, pixels);
      displayGl.drawArrays(displayGl.TRIANGLE_STRIP, 0, 4);
      imageDrawTime += (performance.now() - startImageDrawTime);
      const startWindowRenderTime = performance.now();
      displaySwapBuffers();
      windowRenderTime += (performance.now() - startWindowRenderTime);
      return;
    }

    // SDL fallback (no native GL handle — e.g. Knulli fbdev)
    let buffer;
    if (canvas._isWebGL) {
      const gl = canvas._glCtx;
      const w = canvas.width;
      const h = canvas.height;
      const pixels = new Uint8Array(w * h * 4);
      gl.makeCurrent?.();
      gl.finish();
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const rowSize = w * 4;
      const halfH = h >> 1;
      for (let y = 0; y < halfH; y++) {
        const topOff = y * rowSize;
        const botOff = (h - 1 - y) * rowSize;
        for (let i = 0; i < rowSize; i++) {
          const tmp = pixels[topOff + i];
          pixels[topOff + i] = pixels[botOff + i];
          pixels[botOff + i] = tmp;
        }
      }
      buffer = Buffer.from(pixels.buffer);
    } else {
      if (showFPS) {
        drawFPS(ctx);
      }
      buffer = Buffer.from(canvas.data().buffer);
    }
    imageDrawTime += (performance.now() - startImageDrawTime);

    const startWindowRenderTime = performance.now();
    await appWindow.render(canvas.width, canvas.height, canvas.width * 4, 'rgba32', buffer, {
      scaling: 'nearest',
      dstRect: { x: drawX, y: drawY, width: drawWidth, height: drawHeight },
    });
    windowRenderTime += (performance.now() - startWindowRenderTime);
  }

  appWindow.on('close', () => {
    console.log('window closed');
    process.exit(0);
  });

  appWindow.on('resize', resize);
  
  function launcherLoop() {
    callCount++;
    const currentTime = performance.now();       // Get current time
    frameCount++;                                // Increment frame count

    // Check if one second has passed
    if (currentTime - lastTime >= fpsInterval) {
      fps = frameCount;                          // Set FPS to the frame count
      frameCount = 0;                            // Reset the frame counter
      lastTime = currentTime;                    // Reset the timer
    }
    const [gp] = globalThis.navigator.getGamepads();
    if (gp) {
      const btns = gp.buttons;
      // handle hotkey input
      if (btns[16].pressed) {
        if (btns[9].pressed) {
          console.log('EXITING');
          process.exit(0);
        }

        if (btns[12].pressed && canToggleFullscreen) {
          fullscreen = !fullscreen;
          appWindow.setFullscreen(fullscreen);
          resize();
          canToggleFullscreen = false;
        } else if (!btns[12].pressed) {
          canToggleFullscreen = true;
        }

        if (btns[13].pressed && canToggleFPS) {
          showFPS = !showFPS;
          console.log('showFPS', showFPS);
          canToggleFPS = false;
          resize();
        } else if (!btns[13].pressed) {
          canToggleFPS = true;
        }

        if (btns[14].pressed && canToggleIntegerScaling) {
          integerScaling = !integerScaling;
          console.log('integerScaling', integerScaling);
          canToggleIntegerScaling = false;
          resize();
        } else if (!btns[14].pressed) {
          canToggleIntegerScaling = true;
        }
      }
    }

    const callbackStartTime = performance.now();
    if (currentRafCallback) {
      let thisCallback = currentRafCallback;
      currentRafCallback = null;
      thisCallback.callback(performance.now());
    }
    callbackTime+= (performance.now() - callbackStartTime);

    launcherDraw();
    setImmediate(launcherLoop);
  }
  
  launcherLoop();

  // Log the FPS (frames per second)
  setInterval(() => {
    // sometimes console.log throws an error ¯\_(ツ)_/¯
    try {
      console.log(fps, 'FPS',
        'backCanvas.WxH', backCanvas.width, backCanvas.height,
        'window.WxH', appWindow.pixelWidth, appWindow.pixelHeight,
        'canvas.WxH', canvas.width, canvas.height,
        'drawImage', Number(imageDrawTime / callCount).toFixed(5),
        'game.callback', Number(callbackTime / callCount).toFixed(5),
        'window.render', Number(windowRenderTime / callCount).toFixed(5),
        'useBackCanvas', useBackCanvas,
        'aspectRatioDifference', Number(aspectRatioDifference).toFixed(5),
      );
    } catch (e) {
      console.error(e);
    }
    // Reset the counters
    callCount = 0;
    imageDrawTime = 0;
    callbackTime = 0;
    windowRenderTime = 0;
  }, 5000);
}

/**
 * Map a friendly programmatic `opts` object onto the CLI-shaped options object
 * that main()/resolveGame() read (the same shape options.js/commander produces).
 * Accepts either the friendly names (fullscreen, showFps, integerScaling, …) or
 * the raw CLI-cased names (Fullscreen, Showfps, Integerscaling, …) so cli.js can
 * pass the commander opts through directly.
 *
 * @param {object} [opts]
 * @returns {object} CLI-shaped options (Fullscreen, Showfps, Integerscaling, …)
 */
function buildOptions(opts = {}) {
  const pick = (...names) => {
    for (const n of names) {
      if (opts[n] !== undefined) return opts[n];
    }
    return undefined;
  };
  return {
    Fullscreen: !!pick('fullscreen', 'Fullscreen'),
    Stretch: !!pick('stretch', 'Stretch'),
    Showfps: !!pick('showFps', 'showFPS', 'Showfps'),
    Integerscaling: !!pick('integerScaling', 'Integerscaling'),
    Antialiasing: !!pick('antialiasing', 'antialias', 'Antialiasing'),
    Addconcfg: pick('addconcfg', 'Addconcfg'),
    Gameinfoxml: pick('gameinfoxml', 'Gameinfoxml'),
    P1index: pick('p1index', 'P1index'),
    P2index: pick('p2index', 'P2index'),
    P3index: pick('p3index', 'P3index'),
    P4index: pick('p4index', 'P4index'),
    P1name: pick('p1name', 'P1name'),
    P2name: pick('p2name', 'P2name'),
    P3name: pick('p3name', 'P3name'),
    P4name: pick('p4name', 'P4name'),
    P1guid: pick('p1guid', 'P1guid'),
    P2guid: pick('p2guid', 'P2guid'),
    P3guid: pick('p3guid', 'P3guid'),
    P4guid: pick('p4guid', 'P4guid'),
  };
}

/**
 * Launch a jsgame programmatically. This is the embedding entry point — it does
 * NOT read process.argv and importing this module does not launch anything.
 *
 * The game runs in an isolated `node:vm` realm (see realm.js) that sees only a
 * browser surface (no process/require/fs). This requires node to be started with
 * **`--experimental-vm-modules`** (vm.SourceTextModule lives behind that flag).
 * The `rungame` CLI (cli.js) sets it automatically by re-exec'ing; an app that
 * embeds `launch()` in its own process must start node with the flag itself (we
 * do not — and cannot — re-exec the embedder's process from here). launch()
 * throws a clear error if the flag is missing.
 *
 * Calling launch() has real, one-time side effects: it installs the browser/host
 * shim globals onto globalThis and opens an SDL window. It runs the game loop
 * for the lifetime of the process (the window's `close` event calls
 * process.exit). Intended to be called once per process.
 *
 * @param {string} gamePath
 *   Path to the game: a game **directory**, a marker file inside it (e.g.
 *   `game.jsg`), or a `.jsgame`/`.zip` archive (extracted to a temp dir).
 * @param {object} [opts]
 * @param {boolean} [opts.fullscreen=false]      Start fullscreen.
 * @param {boolean} [opts.stretch=false]         Ignore aspect ratio (implies fullscreen).
 * @param {boolean} [opts.showFps=false]         Overlay an FPS counter.
 * @param {boolean} [opts.integerScaling=false]  Only scale by integer factors.
 * @param {string}  [opts.addconcfg]             Path to an es_input.cfg for extra controller config.
 * @param {string}  [opts.gameinfoxml]           Path to an EmulationStation gameinfo xml.
 * @param {string}  [opts.p1index] [opts.p2index] [opts.p3index] [opts.p4index]  Player controller indices.
 * @param {string}  [opts.p1name]  [opts.p2name]  [opts.p3name]  [opts.p4name]   Player controller names.
 * @param {string}  [opts.p1guid]  [opts.p2guid]  [opts.p3guid]  [opts.p4guid]   Player controller guids.
 *   (CLI-cased keys — Fullscreen, Showfps, Integerscaling, … — are also accepted,
 *   so cli.js can pass its commander opts straight through.)
 * @returns {Promise<void>} Resolves once the game has booted and the loop is running.
 */
/**
 * Host-controlled (headless) session — the embedding mode for a harness that wants
 * to DRIVE the game frame-by-frame and read its output, instead of the standalone
 * window+loop. NO SDL window is created and NO internal loop runs; the game renders
 * into an offscreen canvas that the caller steps and reads back.
 *
 * This is fully optional and parallel to launch()/main() — the standalone `rungame`
 * path is unchanged. Returns a session handle:
 *
 *   const s = await createHostSession('/path/to/game.jsgame', { width, height });
 *   s.setInput([{ a: true, dpad: {right:true} }]);   // inject controller state
 *   s.stepFrame();                                    // pump one requestAnimationFrame
 *   const { data, width, height } = s.readFrame();    // RGBA Uint8ClampedArray
 *   s.destroy();
 *
 * @param {string} gamePath  dir / .jsg / .jsgame entry (same as launch()).
 * @param {object} [opts]
 * @param {number} [opts.width=640]   offscreen canvas width
 * @param {number} [opts.height=480]  offscreen canvas height
 * @param {number} [opts.stepMs=1000/60]  virtual ms advanced per stepFrame (deterministic clock)
 * @returns {Promise<{stepFrame, readFrame, setInput, canvas, destroy}>}
 */
export async function createHostSession(gamePath, opts = {}) {
  const vm = await import('node:vm');
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error(
      'jsgamelauncher: vm.SourceTextModule is unavailable. Start node with ' +
      '--experimental-vm-modules. (createHostSession, like launch(), needs it.)',
    );
  }

  const width = opts.width || DEFAULT_GAME_WIDTH;
  const height = opts.height || DEFAULT_GAME_HEIGHT;
  const stepMs = opts.stepMs || (1000 / 60);

  // An embedder (e.g. retroemu) can pass its OWN @kmamal/sdl instance so gamepad-node +
  // webaudio-node inside this realm use the SAME native SDL the host already pumps —
  // instead of a possibly-different duplicate copy from the module tree (which would leave
  // the game reading a dead controller / silent audio). Must run before installHostGlobals
  // (which wires webaudio's SDL) and before any getGamepads read.
  if (opts.sdl) {
    try { installNavigatorShim({ sdl: opts.sdl }); } catch { /* no setSdl support */ }
    try { setAudioSdl(opts.sdl); } catch { /* no setSdl support */ }
  }

  installHostGlobals();
  options = buildOptions(opts);

  // Offscreen canvas the game draws into (document.getElementById returns it).
  canvas = createCanvas(width, height);
  canvas.name = 'game canvas';
  if (!canvas.getBoundingClientRect) {
    canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      width: canvas.width, height: canvas.height, right: canvas.width, bottom: canvas.height });
  }
  globalThis.innerWidth = width;
  globalThis.innerHeight = height;

  // Install window/document event listeners (addEventListener etc.). Normally wired
  // to SDL keyboard via the real appWindow; a host session has no window, so pass a
  // stub whose .on() is a no-op — games get a working addEventListener, and input
  // arrives via the injected gamepads instead of keyboard events.
  initializeEvents({ on: () => {} });

  // Synthetic gamepad state the host injects (instead of physical SDL controllers).
  // navigator.getGamepads() returns these so the game reads host-driven input.
  const hostPads = [];
  const makeGamepad = (pad, index) => ({
    index, id: 'romdev-host-pad', connected: true, mapping: 'standard',
    // Standard-mapping 17-button + 4-axis layout; map common names.
    buttons: STANDARD_BUTTON_ORDER.map((name) => ({
      pressed: !!pad[name], touched: !!pad[name], value: pad[name] ? 1 : 0,
    })),
    axes: [pad.lx || 0, pad.ly || 0, pad.rx || 0, pad.ry || 0],
    timestamp: 0,
  });
  // Override getGamepads on the EXISTING navigator (it's a getter-only global, so we
  // can't reassign navigator itself — mutate the object it returns).
  const nav = globalThis.navigator;
  if (nav) {
    try {
      nav.getGamepads = () => hostPads.map((p, i) => (p ? makeGamepad(p, i) : null));
    } catch {
      Object.defineProperty(nav, 'getGamepads', {
        configurable: true,
        value: () => hostPads.map((p, i) => (p ? makeGamepad(p, i) : null)),
      });
    }
  }

  await resolveGame(gamePath);
  // NOTE: the physical installNavigatorShim({sdl}) is intentionally NOT called here —
  // the host session injects synthetic pads via the getGamepads override above.

  let fullGamefile = 'file://' + gameFile;
  if (romFile.startsWith('.') || romFile.startsWith('..')) {
    fullGamefile = 'file://' + path.join(process.cwd(), gameFile);
  }

  const realmGlobals = buildRealmGlobals();
  const realm = createRealm({ globals: realmGlobals, gameRoot: romDir });
  await realm.runEntry(fullGamefile); // game registers its first requestAnimationFrame

  // Let the game's INITIAL async setup settle (image/asset decodes resolve on real
  // timers, not just microtasks — without this the first frames render blank while
  // sprites are still loading). A short real-time wait covers typical asset loads;
  // override with opts.settleMs.
  const settleMs = opts.settleMs != null ? opts.settleMs : 200;
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));

  let virtualTime = 0;

  return {
    canvas,
    /**
     * Advance exactly one frame: fire the game's pending rAF with a deterministic
     * timestamp, then YIELD to the event loop so async work the frame kicked off
     * (image/asset loads, fetch, decoded audio, promise chains) can settle before
     * the next frame — otherwise early frames render blank while assets are still
     * loading. Await it: `await session.stepFrame()`.
     */
    async stepFrame() {
      virtualTime += stepMs;
      if (currentRafCallback) {
        const cb = currentRafCallback;
        currentRafCallback = null;
        cb.callback(virtualTime);
      }
      // Let microtasks + immediate/timer callbacks (async asset loads) run.
      await new Promise((resolve) => setImmediate(resolve));
      return virtualTime;
    },
    /**
     * Read the offscreen canvas back as RGBA. Uses the napi-rs canvas's raw pixel
     * buffer (canvas.data()) — the same readback main()'s window path uses — rather
     * than a separate 2d context's getImageData (which wouldn't see the game's draws
     * on WebGL canvases or a different context instance). @returns {{data,width,height}}
     */
    readFrame() {
      const raw = canvas.data(); // Uint8ClampedArray-like, RGBA, width*height*4
      return { data: new Uint8ClampedArray(raw.buffer.slice(0)), width: canvas.width, height: canvas.height };
    },
    /** Inject controller state. @param {Array<object>} pads per-index pad objects. */
    setInput(pads) {
      hostPads.length = 0;
      (pads || []).forEach((p, i) => { hostPads[i] = p || null; });
    },
    destroy() {
      try { realm?.dispose?.(); } catch { /* ignore */ }
      currentRafCallback = null;
    },
  };
}

export async function launch(gamePath, opts = {}) {
  // The game realm (realm.js) uses vm.SourceTextModule, which is only available
  // when node was started with --experimental-vm-modules. Fail loud + early with
  // a clear message rather than crashing deep in realm.js with an opaque
  // "SourceTextModule is not a constructor". The `rungame` CLI sets the flag
  // automatically (cli.js re-execs); an embedder must start node with it.
  const vm = await import('node:vm');
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error(
      'jsgamelauncher: vm.SourceTextModule is unavailable. Start node with ' +
      '--experimental-vm-modules (e.g. `node --experimental-vm-modules your-app.js`). ' +
      'The rungame CLI does this for you; an app embedding launch() must pass the flag.',
    );
  }

  installHostGlobals();

  options = buildOptions(opts);
  console.log('\n----------OPTIONS----------:\n', { Rom: gamePath, ...options }, '\n');

  integerScaling = !!options.Integerscaling;
  fullscreen = !!options.Fullscreen || !!options.Stretch;
  showFPS = !!options.Showfps;

  await resolveGame(gamePath);
  await main();
}

/**
 * CLI-compatible default entry: parse argv via options.js (commander), then
 * launch. Kept so `rungame` (cli.js) behaves exactly as before the refactor.
 * @returns {Promise<void>}
 */
export default async function cliMain() {
  const options = getOptions();
  const { Rom, ...rest } = options;
  return launch(Rom, rest);
}

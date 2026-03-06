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
import { AudioContext, AudioDestinationNode, OscillatorNode, GainNode, AudioBuffer, setSdl as setAudioSdl } from 'webaudio-node';
import createFetch from './fetch.js';
import createXMLHttpRequest from './xhr.js';
import { createObjectURL, revokeObjectURL, fetchBlobFromUrl } from './blob.js';
import { Audio } from './audio.js';
import { Video } from './video.js';
import initializeFontFace from './fontface.js';


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

let canvas;
let stretchToWindow = false;
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
// ts uses this class
class MutationObserver {
  constructor() {
  }
  observe() {
  }
}
globalThis.MutationObserver = MutationObserver;
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
globalThis.document = document;
globalThis.screen = {};
// web audio
globalThis.AudioContext = AudioContext;
globalThis.AudioDestinationNode = AudioDestinationNode;
// WebGLRenderingContext must be distinct from WebGL2RenderingContext
// so Three.js instanceof checks correctly detect WebGL2
class WebGLRenderingContext {}
globalThis.WebGLRenderingContext = WebGLRenderingContext;
globalThis.WebGL2RenderingContext = WebGL2RenderingContext;
globalThis.OscillatorNode = OscillatorNode;
globalThis.GainNode = GainNode;
globalThis.AudioBuffer = AudioBuffer;

globalThis.sdl = sdl;
setAudioSdl(sdl);

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

globalThis.requestAnimationFrame = requestAnimationFrame;
globalThis.cancelAnimationFrame = cancelAnimationFrame;
// console.log('getting options...');

const options = getOptions();

console.log('\n----------OPTIONS----------:\n', options, '\n');

let romFile = options.Rom;
if (!romFile) {
  console.error('rom file not found');
  process.exit(1);
}
if (!fs.existsSync(romFile)) {
  romFile = path.join(process.cwd(), romFile);
}
if (!fs.existsSync(romFile)) {
  console.error('rom file not found', romFile);
  process.exit(1);
}
const romDir = path.dirname(romFile);
console.log('romFile', romFile, 'romDir', romDir);
let gameFile;

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
      console.error(gameFile, 'package.json main file not found');
      process.exit(1);
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
  console.error('game file not found');
  process.exit(1);
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


const DEFAULT_GAME_WIDTH = 640;
const DEFAULT_GAME_HEIGHT = 480;
let backCanvas;
let appWindow;
let integerScaling = !!options.Integerscaling;
let canToggleIntegerScaling = true;
let callResizeEvents;
let fullscreen = !!options.Fullscreen || !!options.Stretch;
let canToggleFullscreen = true;
let showFPS = !!options.Showfps;
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
  await import(fullGamefile);
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

export default main;

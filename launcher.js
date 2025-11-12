import sdl from '@kmamal/sdl';
import path from 'path';
import Module from 'module';
import fs from 'fs';
import nrsc, { ImageData } from '@napi-rs/canvas';
import Worker from 'web-worker';
import WebSocket from 'ws';
import getOptions from './options.js';
import { installNavigatorShim } from 'gamepad-node';
import { createCanvas, OffscreenCanvas } from './canvas.js';
import { createImageClass, createLoadImage } from './image.js';
import createLocalStorage from './localstorage.js';
import initializeEvents from './events.js';
import { AudioContext, OfflineAudioContext, AudioBuffer } from 'webaudio-node';
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

const internalLog = console.log.bind(console);
const internalError = console.error.bind(console);
console.log = (...args) => {
  try {
    internalLog(...args);
  } catch (e) {
    // do nothing
  }
}
console.error = (...args) => {
  try {
    internalError(...args);
  } catch (e) {
    // do nothing
  }
}

globalThis.global = globalThis;
globalThis.self = globalThis;
console.log('LAUNCHING....');
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
globalThis.OfflineAudioContext = OfflineAudioContext;
globalThis.AudioBuffer = AudioBuffer;

globalThis.sdl = sdl;

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
if (!gameFile) {
  // no game file found, try package.json
  if (fs.existsSync(path.join(romDir, 'package.json'))) {
    const packjson = JSON.parse(fs.readFileSync(path.join(romDir, 'package.json'), 'utf8'));
    // console.log('packjson', packjson);
    if (packjson.main) {
      gameFile = path.join(romDir, packjson.main);
      if (!fs.existsSync(gameFile)) {
        console.error(gameFile, 'package.json main file not found');
        process.exit(1);
      } 
    } else {
      console.error('no main entry in package.json');
      process.exit(1);
    }
  } else {
    console.error('game file not found');
    process.exit(1);
  }
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
let fullscreen = !!options.Fullscreen;
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
      // Only resize if dimensions actually changed (setting width/height clears canvas!)
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
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
  appWindow.render(backCanvasWidth, backCanvasHeight, backCanvasWidth * 4, 'rgba32', Buffer.from(backCanvas.data().buffer));
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
  appWindow = sdl.video.createWindow({ resizable: true, fullscreen });
  console.log('appWindow CREATED', appWindow.pixelWidth, appWindow.pixelHeight);

  // Initialize gamepad support
  installNavigatorShim();
  console.log('starting launcher loop', navigator);
  
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
  if (!canvas.addEventListener) {
    canvas.addEventListener = (a) => {
      console.log('canvas.addEventListener', a);
    };
  }
  if (!canvas.removeEventListener) {
    canvas.removeEventListener = (a) => {
      console.log('canvas.removeEventListener', a);
    };
  }
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
    // Sync WebGL framebuffer if game is using WebGL
    if (canvas._isWebGL && canvas._syncGL) {
      canvas._syncGL();
    }

    const canvasRatio = canvas.width / canvas.height;
    let drawX,drawY,drawWidth,drawHeight;

    if (windowRatio > canvasRatio) {
      // window is wider than canvas
      // stretch to window while maintaining aspect ratio
      drawHeight = appWindow.pixelHeight;
      drawWidth = Math.round(drawHeight * canvasRatio);
      drawX = Math.round((appWindow.pixelWidth - drawWidth) / 2);
      drawY = 0;
    } else {
      // canvas is taller than window
      // stretch to window while maintaining aspect ratio
      drawWidth = appWindow.pixelWidth;
      drawHeight = Math.round(drawWidth / canvasRatio);
      drawX = 0;
      drawY = Math.round((appWindow.pixelHeight - drawHeight) / 2);
    }


    const startImageDrawTime = performance.now();
    if (showFPS) {
      drawFPS(ctx);
    }
    const buffer = Buffer.from(canvas.data().buffer);
    imageDrawTime+= (performance.now() - startImageDrawTime);

    const startWindowRenderTime = performance.now();
    if (stretchToWindow) {
      await appWindow.render(canvas.width, canvas.height, canvas.width * 4, 'rgba32', buffer);
    } else {
      await appWindow.render(canvas.width, canvas.height, canvas.width * 4, 'rgba32', buffer, {
        scaling: 'nearest',
        dstRect: {
          x: drawX,
          y: drawY,
          width: drawWidth,
          height: drawHeight,
        },
      });
    }
    windowRenderTime+= (performance.now() - startWindowRenderTime);
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
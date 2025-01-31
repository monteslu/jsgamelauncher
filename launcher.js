import sdl from '@kmamal/sdl';
import path from 'path';
import Module from 'module';
import fs from 'fs';
import nrsc, { ImageData } from '@napi-rs/canvas';
import Worker from 'web-worker';
import WebSocket from 'ws';
import getOptions from './options.js';
import { initGamepads } from './gamepads.js';
import { createCanvas, OffscreenCanvas } from './canvas.js';
import { createImageClass, createLoadImage } from './image.js';
import createLocalStorage from './localstorage.js';
import initializeEvents from './events.js';
import { AudioContext, AudioDestinationNode, OscillatorNode, GainNode, AudioBuffer } from 'webaudio-node';
import createFetch from './fetch.js';
import createXMLHttpRequest from './xhr.js';
import { createObjectURL, revokeObjectURL, fetchBlobFromUrl } from './blob.js';
import { Audio } from './audio.js';
import { Video } from './video.js';
import initializeFontFace from './fontface.js';

// console.log('ARGS', process.argv);
// console.log('ENV', JSON.stringify(process.env));

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  if (err.code === 'EPIPE') {
    // console.log('EPIPE');
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
const document = {
  getElementById: (id) => {
    // console.log('document.getElementById', id, canvas);
    return canvas;
  },
  createElement: (name) => {
    console.log('DCOUMENT.createElement', name);
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
globalThis.OscillatorNode = OscillatorNode;
globalThis.GainNode = GainNode;
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
  console.error('game.js file not found');
  process.exit(1);
}


console.log('gameFile', gameFile);
const romName = path.basename(romDir);
console.log('gameFile', gameFile, 'romDir', romDir, 'romName', romName);

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


let gameWidth = 640; // default width
let gameHeight = 480; // default height
let prevGameWidth = gameWidth;
let prevGameHeight = gameHeight;
let stride = 0;
let gameScale = 1;
let backCanvas;
let appWindow;
let scaledGameWidth = 0;
let scaledGameHeight = 0;
let integerScaling = !!options.Integerscaling;
let canToggleIntegerScaling = true;
let callResizeEvents;
let fullscreen = !!options.Fullscreen;
let canToggleFullscreen = true;
let showFPS = !!options.Showfps;
let canToggleFPS = true;
let fpsFontSize = 0;
let setCanvasSizeToWindow = false;
let canvasAutoResize = false;
let canCanvasAutoResize = true;
let frameCount = 0;               // Frame counter
let fps = 0;                      // Current FPS value
let fpsInterval = 1000;           // Update FPS every second
let lastTime; // Track the last frame's time

const resize = () => {
  const { pixelWidth, pixelHeight } = appWindow;
  // const error = new Error(`resize function ${pixelWidth}x${pixelHeight}`);
  // console.log(error.stack);
  stride = pixelWidth * 4;
  backCanvas = createCanvas(pixelWidth, pixelHeight);
  if (canvasAutoResize && canvas) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  globalThis.innerWidth = pixelWidth;
  globalThis.innerHeight = pixelHeight;
  const backCtx = backCanvas.getContext('2d');
  backCtx.imageSmoothingEnabled = false;
  backCtx.fillStyle = 'white';
  const fontSize = pixelWidth / 25;
  backCtx.font = `${fontSize}px Arial`;
  backCtx.fillText('Loading...', pixelWidth / 2 - fontSize * 5, pixelHeight / 2);
  appWindow.render(pixelWidth, pixelHeight, stride, 'rgba32', Buffer.from(backCanvas.data().buffer));
  // backCanvas = new Canvas(pixelWidth, pixelHeight);
  console.log('resize', pixelWidth, pixelHeight);
  backCanvas.name = 'backCanvas';
  scaledGameWidth = null;
  scaledGameHeight = null;
  fpsFontSize = pixelHeight / 25;
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
  fpsFontSize = appWindow.pixelHeight / 25;

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
    canvas = createCanvas(gameWidth, gameHeight);
  }
  gameWidth = canvas.width;
  gameHeight = canvas.height;
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
  console.log('Pre-import gameWidth', canvas.width , 'gameHeight', canvas.height, 'prevGameWidth', prevGameWidth, 'prevGameHeight', prevGameHeight);
  //added file:// to fix issue with windows, tested on windows 10, macos, and linux/knulli
  let fullGamefile = 'file://' + gameFile;
  if (romFile.startsWith('.') || romFile.startsWith('..')) {
    fullGamefile = 'file://' + path.join(process.cwd(), gameFile);
  }
  console.log('fullGamefile path', fullGamefile);
  await import(fullGamefile);
  resize();
  // console.log('Post-import gameWidth', canvas.width, 'gameHeight', canvas.height, 'prevGameWidth', prevGameWidth, 'prevGameHeight', prevGameHeight);
  eventHandlers.callLoadingEvents();

  let paintPosX = 0;
  let paintPosY = 0;
  let callCount = 0;
  let imageDrawTime = 0;
  let callbackTime = 0;
  let windowRenderTime = 0;


  lastTime = performance.now(); // Track the last frame's time

  async function launcherDraw() {
    gameWidth = canvas.width;
    gameHeight = canvas.height;
  
    const { pixelWidth: windowWidth, pixelHeight: windowHeight } = appWindow;
    if (!backCanvas) {
      stride = windowWidth * 4;
      console.log('windowWidth', windowWidth, 'windowWidth', windowWidth);
      backCanvas = createCanvas(windowWidth, windowWidth);
    }
    const backCtx = backCanvas.getContext('2d');
    backCtx.imageSmoothingEnabled = false;
    // console.log('gameWidth', gameWidth, 'gameHeight', gameHeight, 'prevGameWidth', prevGameWidth, 'prevGameHeight', prevGameHeight);
    
    if (((windowWidth < gameWidth) || (windowHeight < gameHeight)) && integerScaling) {
      console.log('NOT rednering to window', windowWidth, windowHeight);
      return;
    }

    if (!scaledGameWidth || (prevGameWidth !== gameWidth) || (prevGameHeight !== gameHeight)) {
      prevGameWidth = gameWidth;
      prevGameHeight = gameHeight;
      let xScale = 1;
      let yScale = 1;
      if ((windowWidth >= gameWidth ) && (windowHeight >= gameHeight) && integerScaling) {
        // find max multiple of width and height that fits in window
        xScale = Math.floor(windowWidth / canvas.width);
        yScale = Math.floor(windowHeight / canvas.height);
      } else {
        xScale = windowWidth / canvas.width;
        yScale = windowHeight / canvas.height;
        
      }
      gameScale = Math.min(xScale, yScale);
      scaledGameWidth = gameWidth * gameScale;
      scaledGameHeight = gameHeight * gameScale;
      paintPosX = (windowWidth - scaledGameWidth) / 2;
      paintPosY = (windowHeight - scaledGameHeight) / 2;
      backCtx.strokeStyle = 'white';
      backCtx.lineWidth = 1;
      backCtx.imageSmoothingEnabled = false;
      backCtx.strokeRect(paintPosX, paintPosY, scaledGameWidth, scaledGameHeight);
      console.log('SCALING scaledGameWidth', scaledGameWidth, 'scaledGameHeight', scaledGameHeight, 'paintPosX', paintPosX, 'paintPosY', paintPosY, 'gameWidth', gameWidth, 'gameHeight', gameHeight);
    }
    
    const startImageDrawTime = performance.now();
    // window same size as canvas is the fastest
    if ((appWindow.pixelWidth === canvas.width) && (appWindow.pixelHeight === canvas.height)) {
      if (showFPS) {
        drawFPS(ctx);
      }
    } else {
      if (showFPS) {
        // const imgData = new ImageData(canvas.width, canvas.height);
        // imgData.data = canvas.data();
        // backCtx.putImageData(imgData, paintPosX, paintPosY, scaledGameWidth, scaledGameHeight);
        backCtx.clearRect(0, 0, backCanvas.width, backCanvas.height);
        backCtx.drawImage(canvas, paintPosX, paintPosY, scaledGameWidth, scaledGameHeight);
        drawFPS(backCtx);
      } else {
        backCtx.drawImage(canvas, paintPosX, paintPosY, scaledGameWidth, scaledGameHeight);
      }
    }
    imageDrawTime+= (performance.now() - startImageDrawTime);
    
    
    let buffer;
    if (appWindow.pixelWidth === canvas.width && appWindow.pixelHeight === canvas.height) {
      buffer = Buffer.from(canvas.data().buffer);
    } else {
      buffer = Buffer.from(backCanvas.data().buffer);
    }
    
    const startWindowRenderTime = performance.now();
    await appWindow.render(backCanvas.width, backCanvas.height, stride, 'rgba32', buffer);
    windowRenderTime+= (performance.now() - startWindowRenderTime);
  }

  appWindow.on('close', () => {
    console.log('window closed');
    process.exit(0);
  });

  appWindow.on('resize', () => {
    // const error = new Error('resize called');
    // console.log(error.stack); // Print the stack trace
    resize();
  });
  
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
  
  await initGamepads(options.Addconcfg);
  launcherLoop();

  // Log the FPS (frames per second)
  setInterval(() => {
    // sometimes console.log throws an error ¯\_(ツ)_/¯
    try {
      console.log(fps, 'FPS',
        'window.WxH', backCanvas.width, backCanvas.height,
        'canvas.WxH', canvas.width, canvas.height,
        'drawImage', Number(imageDrawTime / callCount).toFixed(5),
        'game stretched', scaledGameWidth, scaledGameHeight,
        'game.callback', Number(callbackTime / callCount).toFixed(5),
        'game.scale', gameScale,
        'window.render', Number(windowRenderTime / callCount).toFixed(5),
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
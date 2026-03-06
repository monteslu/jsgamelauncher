import { createCanvas as npcc } from '@napi-rs/canvas';
import { createWebGL2Context } from 'webgl-node';

// Shared display GL context set by launcher
let _displayGl = null;
let _displaySwapBuffers = null;
let _onWebGLCanvas = null;
export function setDisplayContext(gl, swapBuffers) {
  _displayGl = gl;
  _displaySwapBuffers = swapBuffers;
}
export function onWebGLCanvas(cb) {
  _onWebGLCanvas = cb;
}

export function createCanvas(width, height) {
  const canvas = npcc(width, height);
  const baseGetContext = canvas.getContext.bind(canvas);
  let ctx;
  let glCtx;
  canvas.style = {};
  if (!canvas.addEventListener) {
    const _listeners = {};
    canvas.addEventListener = (type, fn, opts) => {
      console.log('canvas.addEventListener', type, Object.keys(opts || {}));
      (_listeners[type] = _listeners[type] || []).push(fn);
    };
    canvas.removeEventListener = (type, fn) => {
      if (_listeners[type]) _listeners[type] = _listeners[type].filter(f => f !== fn);
    };
  }
  canvas._isWebGL = false;
  canvas._swapBuffers = null;
  canvas.getContext = function getContext(type, attrs) {
    if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
      if (!glCtx) {
        if (_displayGl) {
          // Reuse the display GL context (window surface — zero copy)
          glCtx = _displayGl;
          canvas._swapBuffers = _displaySwapBuffers;
        } else {
          // Fallback: create a pbuffer context (headless/CI)
          const result = createWebGL2Context(width, height, attrs);
          glCtx = result.gl;
        }
        glCtx.canvas = canvas;
        canvas._isWebGL = true;
        canvas._glCtx = glCtx;
        if (_onWebGLCanvas) _onWebGLCanvas(canvas);
      }
      return glCtx;
    }
    if (!ctx) {
      ctx = baseGetContext(type);
      const baseDrawImage = ctx.drawImage.bind(ctx);
      const baseCreatePattern = ctx.createPattern.bind(ctx);
      ctx.drawImage = (image, ...args) => {
        if (image) {
          if (image._imgImpl) {
            baseDrawImage(image._imgImpl, ...args);
          } else {
            baseDrawImage(image, ...args);
          }
        }
      };
      ctx.createPattern = (image, type) => {
        if (image) {
          if (image._imgImpl) {
            return baseCreatePattern(image._imgImpl, type);
          } else {
            return baseCreatePattern(image, type);
          }
        }
      };
    }

    return ctx;
  }
  canvas.getBoundingClientRect = () => {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: canvas.width,
      bottom: canvas.height,
      width: canvas.width,
      height: canvas.height,
    };
  }
  canvas.parent = globalThis.document.body;
  globalThis.document.body._canvas = canvas;
  
  return canvas;
}

export class OffscreenCanvas {
  constructor(width, height) {
    return createCanvas(width, height);
  }
}

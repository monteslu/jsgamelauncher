import { createCanvas as npcc } from '@napi-rs/canvas';
import gl from '@kmamal/gl';

export function createCanvas(width, height) {
  const canvas = npcc(width, height);
  const baseGetContext = canvas.getContext.bind(canvas);
  let ctx2d;
  let ctxWebGL;
  canvas.style = {};
  canvas.getContext = function getContext(type, options) {
    // Handle WebGL contexts
    if (type === 'webgl' || type === 'webgl2') {
      if (type === 'webgl2') {
        console.warn('WebGL 2.0 requested but only WebGL 1.0 is supported. Falling back to WebGL 1.0');
      }

      if (!ctxWebGL) {
        // Create headless GL context (no options for headless mode)
        const glContext = gl(width, height);

        // Link context back to canvas (required by Three.js)
        glContext.canvas = canvas;

        // IMPORTANT: Use the SAME 2D context that the launcher uses
        // If 2D context was already created, reuse it; otherwise create it now
        if (!ctx2d) {
          ctx2d = baseGetContext('2d');
          const baseDrawImage = ctx2d.drawImage.bind(ctx2d);
          const baseCreatePattern = ctx2d.createPattern.bind(ctx2d);
          ctx2d.drawImage = (image, ...args) => {
            if (image) {
              if (image._imgImpl) {
                baseDrawImage(image._imgImpl, ...args);
              } else {
                baseDrawImage(image, ...args);
              }
            }
          };
          ctx2d.createPattern = (image, type) => {
            if (image) {
              if (image._imgImpl) {
                return baseCreatePattern(image._imgImpl, type);
              } else {
                return baseCreatePattern(image, type);
              }
            }
          };
        }
        const imageData = ctx2d.createImageData(width, height);
        // Create a separate Uint8Array buffer for readPixels (ImageData.data is Uint8ClampedArray)
        const pixelBuffer = new Uint8Array(width * height * 4);

        // Add method to sync GL framebuffer to canvas
        canvas._syncGL = () => {
          // Read GL pixels into Uint8Array buffer
          glContext.readPixels(0, 0, width, height, glContext.RGBA, glContext.UNSIGNED_BYTE, pixelBuffer);

          // Flip Y coordinate (GL origin is bottom-left, Canvas origin is top-left)
          const rowBytes = width * 4;
          for (let y = 0; y < height; y++) {
            const srcOffset = y * rowBytes;
            const dstOffset = (height - 1 - y) * rowBytes;
            for (let x = 0; x < rowBytes; x++) {
              imageData.data[dstOffset + x] = pixelBuffer[srcOffset + x];
            }
          }

          ctx2d.putImageData(imageData, 0, 0);
        };

        canvas._isWebGL = true;
        ctxWebGL = glContext;
      }

      return ctxWebGL;
    }

    // Handle 2D context
    if (!ctx2d) {
      ctx2d = baseGetContext(type);
      const baseDrawImage = ctx2d.drawImage.bind(ctx2d);
      const baseCreatePattern = ctx2d.createPattern.bind(ctx2d);
      ctx2d.drawImage = (image, ...args) => {
        if (image) {
          if (image._imgImpl) {
            baseDrawImage(image._imgImpl, ...args);
          } else {
            baseDrawImage(image, ...args);
          }
        }
      };
      ctx2d.createPattern = (image, type) => {
        if (image) {
          if (image._imgImpl) {
            return baseCreatePattern(image._imgImpl, type);
          } else {
            return baseCreatePattern(image, type);
          }
        }
      };
    }

    return ctx2d;
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

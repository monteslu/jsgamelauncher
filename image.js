import path from 'path';
import fs from 'fs';
import os from 'os';
import { loadImage as canvasLoadImage, Image } from '@napi-rs/canvas';
import { randomUUID } from 'node:crypto';

async function blobToDataURL(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const base64 = buffer.toString('base64');
  const type = blob.type || 'image/png';
  return `data:${type};base64,${base64}`;
}

function getFinalUrl(gamePath, url) {
  let finalUrl;
  let testUrl = url.toLowerCase();
  if (testUrl.startsWith('http://')
    || testUrl.startsWith('https://')
    || testUrl.startsWith('data:')
    || testUrl.startsWith('blob:')
    || testUrl.startsWith('//')) {
    finalUrl = url;
  } else {
    finalUrl = path.join(gamePath, url);
  }
  // console.log('getFinalUrl:', url, 'finalUrl:', finalUrl);
  return finalUrl;
}

export function createLoadImage(gamePath) {
  // check if gamePath has a public/ folder in it
  let publicDir = path.join(gamePath, 'public');
  if (fs.existsSync(publicDir)) {
    gamePath = publicDir;
  } else {
    // check parent directory for public folder (for projects with src/ structure)
    publicDir = path.join(gamePath, '..', 'public');
    if (fs.existsSync(publicDir)) {
      gamePath = publicDir;
    }
  }

  return (url, force) => {
    // console.log('loadImage...', gamePath, url, force);
    let finalUrl = url;
    if (!force) {
      finalUrl = getFinalUrl(gamePath, url);
    }
    return canvasLoadImage(finalUrl);
  };
}

export function createImageClass(gamePath) {
  // check if gamePath has a public/ folder in it
  let publicDir = path.join(gamePath, 'public');
  if (fs.existsSync(publicDir)) {
    gamePath = publicDir;
  } else {
    // check parent directory for public folder (for projects with src/ structure)
    publicDir = path.join(gamePath, '..', 'public');
    if (fs.existsSync(publicDir)) {
      gamePath = publicDir;
    }
  }
  class Image {
    constructor(width, height) {
      this._width = width || 0;
      this._height = height || 0;
      this._src = '';
    }
    set src(url) {
      let finalUrl = getFinalUrl(gamePath, url);
      this._src = finalUrl;
      let tempBlobFile;
      const load = async () => {
        if (finalUrl.startsWith('blob:')) {
          // phaser likes blobs.
          const blob = URL.fetchBlobFromUrl(finalUrl);
          if (blob.arrayBuffer) {
            finalUrl = await blobToDataURL(blob);
          } else {
            const blobDir = path.join(os.homedir(), '.jsgamelauncher', 'temp');
            if (!fs.existsSync(blobDir)) {
              fs.mkdirSync(blobDir, { recursive: true });
            }
            tempBlobFile = path.join(blobDir, randomUUID() + '.png');
            fs.writeFileSync(tempBlobFile, blob);
            finalUrl = tempBlobFile;
          }
        }
        try {
          const image = await canvasLoadImage(finalUrl);
          if (tempBlobFile) {
            fs.rmSync(tempBlobFile);
          }
          this._width = image.width;
          this._height = image.height;
          this._imgImpl = image;
          if (this.onload) {
            // console.log('image onload', finalUrl);
            this.onload(this);
          }
        } catch (error) {
          console.error('Error loading image:', error);
          if (this.onerror) {
            this.onerror(error);
          }
        }
      }
      load();
    }
    get src() {
      return this._src;
    }
    get width() {
      if (this._imgImpl) {
        return this._imgImpl.width;
      }
      return this._width;
    }
    get height() {
      if (this._imgImpl) {
        return this._imgImpl.height;
      }
      return this._height;
    }
    get complete() {
      return !!this._imgImpl;
    }
  }

  return Image;
}


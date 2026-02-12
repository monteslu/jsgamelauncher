import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import mime from 'mime-types';

globalThis.oldFetch = fetch;

export default function createFetch(gameDir) {
  let resourcePath = gameDir;
  // Check if gameDir has a public/ folder in it
  let publicDir = path.join(gameDir, 'public');
  if (fs.existsSync(publicDir)) {
    resourcePath = publicDir;
  } else {
    // check parent directory for public folder (for projects with src/ structure)
    publicDir = path.join(gameDir, '..', 'public');
    if (fs.existsSync(publicDir)) {
      resourcePath = publicDir;
    }
  }

  // console.log('resourcePath', resourcePath);

  async function localFetch(url, options = {}) {
    // console.log('localFetch', url, options);
    const { method } = options;
    const lcUrl = String(url).toLowerCase();

    // For non-local files or non-GET methods, fall back to global fetch
    if (lcUrl.startsWith('http') || lcUrl.startsWith('//') || (method && (method !== 'GET'))) {
      return globalThis.oldFetch(url, options);
    }

    // Construct the file path
    const filePath = path.join(resourcePath, url);
    // const resp = new Response();
    try {
      // Read the file content
      const fileBuffer = await fsPromises.readFile(filePath);

      // Guess the MIME type based on file extension
      const mimeType = mime.lookup(filePath) || 'application/octet-stream';
      console.log('MIME TYPE', mimeType, filePath);
      const resp = new Response(fileBuffer, {
        status: 200,
        statusText: 'OK',
        headers: {
          'Content-Type': mimeType,
        },
      });
      resp.headers.set('Content-Type', mimeType);
      return resp;
    } catch (err) {
      // Handle file not found or other errors
      console.error('Error fetching file', filePath);
      const resp = new Response(null, {
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });
      return resp;
    }
  }

  return localFetch;
}

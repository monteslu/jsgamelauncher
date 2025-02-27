import fs from 'fs';
import path from 'path';
import XHRShim from 'xhr-shim'; // Install xhr-shim: npm install xhr-shim
import mime from 'mime-types';

export default function createXMLHttpRequest(gameDir) {
  const resourcePath = fs.existsSync(path.join(gameDir, 'public')) 
    ? path.join(gameDir, 'public') 
    : gameDir;

  return class LocalXMLHttpRequest extends XHRShim {
    constructor(...args) {
      super(...args);
      this.isFSFilePath = false;
      this.localFilePath = '';
      // console.log('LocalXMLHttpRequest constructor', args);
    }

    open(method, url, async = true, user = null, password = null) {
      const lcUrl = String(url).toLowerCase();
      // Determine if it's a local file
      if (!lcUrl.startsWith('http') && !lcUrl.startsWith('//')) {
        this.isFSFilePath = true;
        const decodedUrl = decodeURIComponent(url);
        this.localFilePath = path.join(resourcePath, decodedUrl);
      } else {
        this.isFSFilePath = false;
      }
      // console.log('XHR open', method, url, async, this.isFSFilePath);

      super.open(method, url, async, user, password); // Call the parent class's open method
    }
    get responseText() {
      return this._responseText;
    }

    send(data = null) {
      // console.log('XHR send', data, this.isFSFilePath);
      if (this.isFSFilePath) {
        // Handle local file requests
        fs.readFile(this.localFilePath, (err, fileContent) => {
          if (err) {
            this.status = 404;
            this.statusText = 'Not Found';
            this.readyState = 4;
            this.onreadystatechange && this.onreadystatechange();
            return;
          }

          // Set up response headers and content
          this.status = 200;
          this.statusText = 'OK';
          this._responseText = fileContent;
          this.responseType = 'text';
          this.response = fileContent.buffer.slice(
            fileContent.byteOffset, 
            fileContent.byteOffset + fileContent.byteLength
          );
          this.readyState = 4;
          this.getAllResponseHeaders = () =>
            `Content-Type: ${mime.lookup(this.localFilePath) || 'application/octet-stream'}`;

          this.onreadystatechange && this.onreadystatechange(this, {});
          this.onload && this.onload(this, {});
          this.onLoad && this.onLoad(this, {});
        });
      } else {
        // Fall back to the parent class's send method for web requests
        super.send(data);
      }
    }
  };
}

import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const profileRoot = path.dirname(fileURLToPath(import.meta.url));
const routes = new Map([
  ['/', ['preview.html', 'text/html; charset=utf-8']],
  ['/preview.html', ['preview.html', 'text/html; charset=utf-8']],
  ['/assets/profile-dark.svg', ['assets/profile-dark.svg', 'image/svg+xml; charset=utf-8']],
  ['/assets/profile-light.svg', ['assets/profile-light.svg', 'image/svg+xml; charset=utf-8']],
]);

export function createPreviewServer({ rootDir = profileRoot } = {}) {
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }
    try {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      const route = routes.get(pathname);
      if (!route) { response.writeHead(404); response.end('Not found'); return; }
      const [relativePath, contentType] = route;
      const canonicalRoot = await realpath(rootDir);
      const targetPath = path.join(canonicalRoot, relativePath);
      // Only the named generated files may be served; symlinks do not expand this boundary.
      if (await realpath(targetPath) !== targetPath) { response.writeHead(404); response.end('Not found'); return; }
      const body = await readFile(targetPath);
      response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      response.writeHead(['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404 : 500);
      response.end('Preview unavailable');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer from 1 to 65535'); process.exitCode = 1;
  } else {
    const server = createPreviewServer();
    server.on('error', (error) => { console.error(`Preview server failed: ${error.message}`); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Profile preview: http://127.0.0.1:${port}`));
  }
}

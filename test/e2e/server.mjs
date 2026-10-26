import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = process.cwd();
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// A 1x1 transparent PNG.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

/**
 * Endpoints the browser tests use to get real network timing, real statuses and
 * real resources, without leaving the local machine:
 *   /__rum/json?delay=<ms>&size=<bytes>&status=<code>  JSON after a delay
 *   /__rum/echo                                         the request headers, as JSON
 *   /__rum/script.js, /__rum/style.css, /__rum/pixel.png
 */
async function handleTestEndpoint(request, response, url) {
  const common = { 'cache-control': 'no-store', 'timing-allow-origin': '*' };
  switch (url.pathname) {
    case '/__rum/json': {
      await sleep(Number(url.searchParams.get('delay') ?? 0));
      const size = Number(url.searchParams.get('size') ?? 0);
      const body = JSON.stringify({ ok: true, padding: 'x'.repeat(size) });
      response.writeHead(Number(url.searchParams.get('status') ?? 200), {
        ...common,
        'content-type': mimeTypes['.json'],
      });
      response.end(body);
      return true;
    }
    case '/__rum/echo':
      response.writeHead(200, { ...common, 'content-type': mimeTypes['.json'] });
      response.end(JSON.stringify(request.headers));
      return true;
    case '/__rum/script.js':
      await sleep(Number(url.searchParams.get('delay') ?? 0));
      response.writeHead(200, { ...common, 'content-type': mimeTypes['.js'] });
      response.end('window.__rumScriptLoaded = true;');
      return true;
    case '/__rum/style.css':
      response.writeHead(200, { ...common, 'content-type': mimeTypes['.css'] });
      response.end('.rum-styled { color: rgb(1, 2, 3); }');
      return true;
    case '/__rum/pixel.png':
      response.writeHead(200, { ...common, 'content-type': 'image/png' });
      response.end(PIXEL);
      return true;
    default:
      return false;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  if (pathname.startsWith('/__rum/') && (await handleTestEndpoint(request, response, url))) return;

  const relative = pathname === '/' ? '/test/e2e/fixture.html' : pathname;
  const file =
    relative === '/fixture.html'
      ? resolve(root, 'test/e2e/fixture.html')
      : resolve(root, `.${relative}`);
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'content-type': mimeTypes[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(4173, '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

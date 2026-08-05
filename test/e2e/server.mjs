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

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
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

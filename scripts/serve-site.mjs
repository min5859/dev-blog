import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.cwd(), 'public');
const port = Number(process.env.PORT || 4321);

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] || '/');
  const normalized = decoded === '/' ? '/index.html' : decoded;
  const resolved = path.resolve(root, `.${normalized}`);
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

async function resolveFile(urlPath) {
  const requested = safePath(urlPath);
  if (!requested) return null;

  try {
    const info = await stat(requested);
    if (info.isDirectory()) return path.join(requested, 'index.html');
    return requested;
  } catch {
    if (!path.extname(requested)) {
      const htmlPath = `${requested}.html`;
      try {
        await stat(htmlPath);
        return htmlPath;
      } catch {
        return null;
      }
    }
    return null;
  }
}

const server = createServer(async (req, res) => {
  const file = await resolveFile(req.url || '/');
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': contentTypes.get(ext) || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

server.listen(port, () => {
  console.log(`Dev Blog local server: http://localhost:${port}`);
  console.log(`Serving: ${root}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

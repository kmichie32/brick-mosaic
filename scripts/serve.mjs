/**
 * Tiny static dev server. Node-only, no dependencies.
 *
 * Exists for one reason: `python3 -m http.server` sends no cache headers, and
 * browsers then cache ES modules aggressively. Editing src/*.js and reloading
 * would keep running the old module — which is a genuinely nasty way to test,
 * because the page looks updated while the logic is stale.
 *
 *   node scripts/serve.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || process.env.PORT || 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    // normalize + the prefix check below keep `..` from escaping the project.
    let path = resolve(join(ROOT, normalize(decodeURIComponent(url.pathname))));
    if (!path.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, 'index.html');

    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
      // The whole point. Without this an edited module keeps serving stale.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
    });
    res.end(body);
  } catch (err) {
    const code = err.code === 'ENOENT' ? 404 : 500;
    res.writeHead(code, { 'Content-Type': 'text/plain' }).end(code === 404 ? 'Not found' : 'Server error');
  }
}).listen(PORT, () => {
  console.log(`serving ${ROOT} on http://localhost:${PORT} (no-cache)`);
});

// Local server for trying the game with accounts, without Netlify.
// Serves public/ and the /api/* routes, keeping data in memory.
//   npm run dev   (then open http://localhost:8888)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createApi } from "../netlify/lib/api-core.mjs";

const PORT = Number(process.env.PORT) || 8888;
const ROOT = new URL("../public/", import.meta.url).pathname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function memoryStore() {
  const data = new Map();
  return {
    get: async (k) => (data.has(k) ? structuredClone(data.get(k)) : null),
    set: async (k, v) => { data.set(k, structuredClone(v)); },
    del: async (k) => { data.delete(k); },
    keys: async () => [...data.keys()],
  };
}

const handle = createApi({ users: memoryStore(), sessions: memoryStore(), saves: memoryStore() });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const response = await handle(new Request(url, {
      method: req.method,
      headers: req.headers,
      body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
    return;
  }
  const path = normalize(join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const file = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(PORT, () => console.log(`Cookie Clicker dev server: http://localhost:${PORT}`));

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createHmac, randomBytes } from "node:crypto";
import { findResponse } from "../lib/finds.mjs";
import { mirrorResponse, redisStore } from "../lib/mirror.mjs";

const { headers } = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const security = Object.fromEntries(headers[0].headers.map(({ key, value }) => [key, value]));
const mime = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml",
  webp: "image/webp", txt: "text/plain; charset=utf-8",
};
const sessions = new Map();
const sessionSecret = randomBytes(32);
const localStore = {
  owner(remote) {
    return createHmac("sha256", sessionSecret).update("hydoabi:mirror-owner\0" + remote).digest("hex");
  },
  async limit() { return true; },
  async create(id, writer, reader, owner) {
    const now = Date.now();
    for (const [key, room] of sessions) if (room.expires <= now) sessions.delete(key);
    if (sessions.has(id) || sessions.size >= 100) return false;
    sessions.set(id, { writer, reader, owner, expires: now + 3600000, state: null });
    return true;
  },
  async read(id) {
    const room = sessions.get(id);
    return room?.expires > Date.now() ? room : null;
  },
  async write(id, writer, owner, state) {
    const room = sessions.get(id);
    if (room?.writer !== writer || room?.owner !== owner || room.expires <= Date.now()) return false;
    room.state = state;
    return true;
  },
};

export async function handlePreview(request, clientAddress) {
  const url = new URL(request.url);
  if (url.pathname === "/api/finds") return findResponse();
  if (url.pathname === "/api/mirror" || url.pathname.startsWith("/api/mirror/")) {
    const id = url.pathname === "/api/mirror" ? undefined : url.pathname.slice(12);
    return mirrorResponse(request, redisStore() ?? localStore, id, clientAddress);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const contentType = mime[name.split(".").at(-1)];
  if (!/^[\w.-]+$/.test(name) || !contentType) return new Response(null, { status: 404 });
  try {
    const body = await readFile(new URL("../public/" + name, import.meta.url));
    return new Response(request.method === "HEAD" ? null : body, {
      headers: { ...security, "Content-Type": contentType },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

if (!process.env.HYDO_PREVIEW_IMPORT) {
  const port = Number(process.env.PORT || 8787);
  createServer(async (incoming, outgoing) => {
    try {
      const options = { method: incoming.method, headers: incoming.headers };
      if (!["GET", "HEAD"].includes(incoming.method)) {
        options.body = Readable.toWeb(incoming);
        options.duplex = "half";
      }
      const result = await handlePreview(new Request("http://" + incoming.headers.host + incoming.url, options), incoming.socket.remoteAddress);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) Readable.fromWeb(result.body).pipe(outgoing);
      else outgoing.end();
    } catch {
      outgoing.writeHead(500).end("Preview request failed");
    }
  }).listen(port, "127.0.0.1", () => console.log("HydoABITool http://127.0.0.1:" + port + "/"));
}

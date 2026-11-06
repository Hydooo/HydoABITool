const SESSION_SECONDS = 3600;
const TOKEN = /^[a-f0-9]{32}$/;
const LIMIT = 24000;
const token = () => crypto.randomUUID().replaceAll("-", "");
const json = (value, status = 200) => Response.json(value, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const optional = (value, min, max) => value == null || integer(value, min, max);
const label = value => typeof value === "string" && /^[a-z-]{2,24}$/.test(value);

function sanitizeRecord(record) {
  if (record == null) return null;
  const scope = record.scope ?? {};
  if (!record || typeof record !== "object" || !/^\d{1,2}$/.test(record.id) ||
    !(record.score == null || (Number.isFinite(record.score) && record.score >= 0 && record.score <= 1)) ||
    !optional(scope.cargo, 1, 999999) || !optional(scope.asking, 1, 999999999) ||
    !optional(scope.width, 1, 9) || !optional(scope.height, 1, 24)) throw new Error("Invalid match");
  return {
    id: String(record.id), score: record.score ?? null,
    scope: { cargo: scope.cargo ?? null, asking: scope.asking ?? null, width: scope.width ?? null, height: scope.height ?? null },
  };
}

function sanitizeBoard(board) {
  if (board == null) return null;
  if (!integer(board.rows, 1, 24) || !Array.isArray(board.slots) || board.slots.length > board.rows * 9 ||
    !optional(board.price, 1, 999999999)) throw new Error("Invalid grid");
  const occupied = new Set();
  const slots = board.slots.map(({ id, col, row, w, h, record }) => {
    if (!integer(col, 0, 8) || !integer(row, 0, board.rows - 1) || !integer(w, 1, 9 - col) ||
      !integer(h, 1, board.rows - row) || id !== col + ":" + row) throw new Error("Invalid grid slot");
    for (let y = row; y < row + h; y++) {
      for (let x = col; x < col + w; x++) {
        const coordinate = x + ":" + y;
        if (occupied.has(coordinate)) throw new Error("Overlapping grid slots");
        occupied.add(coordinate);
      }
    }
    return { id, col, row, w, h, record: sanitizeRecord(record) };
  });
  const active = slots.some(slot => slot.id === board.active) ? board.active : null;
  return { rows: board.rows, slots, active, price: board.price ?? null };
}

export function sanitizeMirrorState(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid state");
  const { map, mode, cargo, asking, record, board } = value;
  if (!label(map) || !label(mode) || !optional(cargo, 1, 999999) || !optional(asking, 1, 999999999)) {
    throw new Error("Invalid raid");
  }
  return { map, mode, cargo: cargo ?? null, asking: asking ?? null,
    record: sanitizeRecord(record), board: sanitizeBoard(board) };
}

const redisWrite = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local room = cjson.decode(raw)
if room.writer ~= ARGV[1] then return 0 end
return redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL', 'XX') and 1 or 0
`;

export function redisStore(env = process.env) {
  const endpoint = env.HYDO_REDIS_REST_URL;
  const key = env.HYDO_REDIS_REST_TOKEN;
  if (!endpoint || !key) return null;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password) return null;
  async function command(args) {
    const response = await fetch(url, {
      method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(args), signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) throw new Error("Mirror storage unavailable");
    const payload = await response.json();
    if (payload.error) throw new Error("Mirror storage command failed");
    return payload.result;
  }
  return {
    async limit(remote) {
      const bucket = "hydoabi:limit:" + await digest(key + "/" + remote);
      const script = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n";
      return Number(await command(["EVAL", script, 1, bucket])) <= 8;
    },
    async create(id, writer) {
      return await command(["SET", "hydoabi:room:" + id, JSON.stringify({ writer, state: null }),
        "EX", SESSION_SECONDS, "NX"]) === "OK";
    },
    async read(id) {
      const value = await command(["GET", "hydoabi:room:" + id]);
      return value ? JSON.parse(value) : null;
    },
    async write(id, writer, state) {
      return Number(await command(["EVAL", redisWrite, 1, "hydoabi:room:" + id,
        writer, JSON.stringify({ writer, state })])) === 1;
    },
  };
}

export async function mirrorResponse(request, store, id) {
  if (!store) return json({ error: "Live phone relay is unavailable" }, 503);
  const origin = new URL(request.url).origin;
  if (request.method !== "GET" && request.headers.get("Origin") !== origin) {
    return json({ error: "Origin is not allowed" }, 403);
  }
  try {
    if (id === undefined && request.method === "POST") {
      const remote = request.headers.get("x-vercel-forwarded-for") ?? "local";
      if (!await store.limit(remote)) return json({ error: "Too many mirror requests" }, 429);
      const id = token();
      const writer = token();
      if (!await store.create(id, await digest(writer))) return json({ error: "Could not create link" }, 503);
      return json({ id, writer, expires: Date.now() + SESSION_SECONDS * 1000 }, 201);
    }
    if (!id || !TOKEN.test(id)) return json({ error: "Not found" }, 404);
    if (request.method === "GET") {
      const room = await store.read(id);
      return room ? json(room.state ?? {}) : json({ error: "Link expired or unavailable" }, 404);
    }
    if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
    const authorization = request.headers.get("Authorization") ?? "";
    const writer = authorization.slice(7);
    if (!authorization.startsWith("Bearer ") || !TOKEN.test(writer)) return json({ error: "Invalid write token" }, 403);
    if (Number(request.headers.get("Content-Length") || 0) > LIMIT) return json({ error: "State is too large" }, 413);
    const raw = await request.text();
    if (raw.length > LIMIT) return json({ error: "State is too large" }, 413);
    let state;
    try { state = sanitizeMirrorState(JSON.parse(raw)); }
    catch { return json({ error: "Invalid state" }, 400); }
    return await store.write(id, await digest(writer), state) ? json({ ok: true }) :
      json({ error: "Link expired or invalid" }, 403);
  } catch {
    return json({ error: "Live phone relay is unavailable" }, 503);
  }
}

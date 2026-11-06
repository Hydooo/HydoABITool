let cache;
let pending;

async function readSnapshot() {
  const response = await fetch("https://abiear.ru/api/finds/stream", {
    headers: { Accept: "text/event-stream" }, signal: AbortSignal.timeout(6500),
  });
  if (!response.ok || !response.body) throw new Error("Finds feed unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (buffer.length < 400000) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const line = /^data:\s*(\{[^\n]+\})\r?\n/m.exec(buffer);
      if (!line) continue;
      const data = JSON.parse(line[1]);
      if (!Array.isArray(data.list)) throw new Error("Unexpected finds format");
      const items = data.list.slice(0, 12).filter(item =>
        typeof item.name === "string" && Number.isFinite(item.price)).map(item => ({
        name: item.name.slice(0, 160), price: item.price, t: Number(item.t) || null,
      }));
      return { items, captured: Number(data.now) || Date.now(), fetched: Date.now() };
    }
    throw new Error("Finds feed did not provide a snapshot");
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function findResponse() {
  try {
    if (!cache || Date.now() - cache.fetched > 45000) {
      pending ??= readSnapshot().finally(() => { pending = undefined; });
      cache = await pending;
    }
    return Response.json(cache, {
      headers: { "Cache-Control": "public, s-maxage=45, stale-while-revalidate=180" },
    });
  } catch {
    return Response.json({ error: "Finds feed unavailable" }, { status: 503 });
  }
}

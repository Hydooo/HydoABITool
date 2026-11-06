import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mirrorResponse } from "../lib/mirror.mjs";

const origin = "https://hydo.example";
const desktopIp = "192.0.2.10";
const otherIp = "198.51.100.20";
const state = { map: "farm", mode: "lockdown", cargo: null, asking: null, record: null, board: null };

function storeFixture() {
  const rooms = new Map();
  return {
    rooms,
    owner: ip => createHmac("sha256", "test-secret").update(ip).digest("hex"),
    limit: async () => true,
    async create(id, writer, reader, owner) {
      if (rooms.has(id)) return false;
      rooms.set(id, { writer, reader, owner, state: null });
      return true;
    },
    read: async id => rooms.get(id),
    async write(id, writer, owner, state) {
      const room = rooms.get(id);
      if (room?.writer !== writer || room?.owner !== owner) return false;
      room.state = state;
      return true;
    },
  };
}

function request(method, id, key, value, extra = {}) {
  return new Request(origin + "/api/mirror" + (id ? "/" + id : ""), {
    method,
    headers: {
      Origin: origin,
      ...(key ? { Authorization: "Bearer " + key } : {}),
      ...extra,
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
}

async function create(store, ip = desktopIp) {
  const response = await mirrorResponse(request("POST"), store, undefined, ip);
  assert.equal(response.status, 201);
  return response.json();
}

test("two users at different IPs receive separate rooms and private read keys", async () => {
  const store = storeFixture();
  const alice = await create(store);
  const bob = await create(store, otherIp);
  assert.notEqual(alice.id, bob.id);
  assert.notEqual(alice.reader, bob.reader);
  assert.notEqual(store.rooms.get(alice.id).owner, store.rooms.get(bob.id).owner);
  const written = await mirrorResponse(request("PUT", alice.id, alice.writer, state), store, alice.id, desktopIp);
  assert.equal(written.status, 200);
  const wrongReader = await mirrorResponse(request("GET", alice.id, bob.reader), store, alice.id, otherIp);
  assert.equal(wrongReader.status, 404);
  const untouched = await mirrorResponse(request("GET", bob.id, bob.reader), store, bob.id, otherIp);
  assert.deepEqual(await untouched.json(), {});
});

test("people sharing the same public IP still have isolated results", async () => {
  const store = storeFixture();
  const alice = await create(store);
  const bob = await create(store);
  assert.notEqual(alice.id, bob.id);
  assert.notEqual(alice.writer, bob.writer);
  assert.notEqual(alice.reader, bob.reader);
  const write = await mirrorResponse(request("PUT", alice.id, bob.writer, state), store, alice.id, desktopIp);
  assert.equal(write.status, 403);
  const read = await mirrorResponse(request("GET", alice.id, bob.reader), store, alice.id, desktopIp);
  assert.equal(read.status, 404);
});

test("the paired phone can read over mobile data with its QR key", async () => {
  const store = storeFixture();
  const room = await create(store);
  const initial = await mirrorResponse(request("GET", room.id, room.reader), store, room.id, otherIp);
  assert.deepEqual(await initial.json(), {});
  await mirrorResponse(request("PUT", room.id, room.writer, state), store, room.id, desktopIp);
  const phone = await mirrorResponse(request("GET", room.id, room.reader), store, room.id, otherIp);
  assert.equal(phone.status, 200);
  assert.deepEqual(await phone.json(), state);
  assert.equal(phone.headers.get("Cache-Control"), "no-store");
});

test("a room ID, the desktop write key, and expired legacy links cannot read private results", async () => {
  const store = storeFixture();
  const room = await create(store);
  assert.equal((await mirrorResponse(request("GET", room.id), store, room.id)).status, 403);
  assert.equal((await mirrorResponse(request("GET", room.id, room.writer), store, room.id)).status, 404);
  delete store.rooms.get(room.id).reader;
  assert.equal((await mirrorResponse(request("GET", room.id, room.reader), store, room.id)).status, 404);
  store.rooms.delete(room.id);
  assert.equal((await mirrorResponse(request("GET", room.id, room.reader), store, room.id)).status, 404);
});

test("desktop writes are bound to the original IP and ignore untrusted forwarded headers in preview", async () => {
  const store = storeFixture();
  const room = await create(store);
  const changedIp = await mirrorResponse(request("PUT", room.id, room.writer, state, {
    "x-vercel-forwarded-for": desktopIp,
  }), store, room.id, otherIp);
  assert.equal(changedIp.status, 403);
  assert.equal(store.rooms.get(room.id).state, null);
  const originalIp = await mirrorResponse(request("PUT", room.id, room.writer, state), store, room.id, desktopIp);
  assert.equal(originalIp.status, 200);
  const readerWrite = await mirrorResponse(request("PUT", room.id, room.reader, state), store, room.id, desktopIp);
  assert.equal(readerWrite.status, 403);
  const newRoom = await create(store, otherIp);
  assert.notEqual(newRoom.id, room.id);
  assert.equal((await mirrorResponse(request("PUT", newRoom.id, newRoom.writer, state), store, newRoom.id, otherIp)).status, 200);
});

test("missing IPs fail closed and equivalent IPv6 forms share the same owner binding", async () => {
  const store = storeFixture();
  assert.equal((await mirrorResponse(request("POST"), store)).status, 503);
  const room = await create(store, "2001:db8::1");
  const response = await mirrorResponse(request("PUT", room.id, room.writer, state), store, room.id, "2001:0db8:0:0:0:0:0:1");
  assert.equal(response.status, 200);
  assert(!JSON.stringify(store.rooms.get(room.id)).includes("2001:db8"));
});

test("production uses Vercel's trusted IP header and refuses a missing header", async () => {
  const previous = process.env.VERCEL;
  process.env.VERCEL = "1";
  try {
    const store = storeFixture();
    const response = await mirrorResponse(request("POST", undefined, undefined, undefined, {
      "x-vercel-forwarded-for": desktopIp,
    }), store, undefined, otherIp);
    assert.equal(response.status, 201);
    const room = await response.json();
    assert.equal(store.rooms.get(room.id).owner, store.owner(desktopIp));
    const missing = await mirrorResponse(request("POST"), store, undefined, desktopIp);
    assert.equal(missing.status, 503);
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});

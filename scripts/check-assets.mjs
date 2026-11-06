import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const publicDir = new URL("../public/", import.meta.url);
const read = name => readFile(new URL(name, publicDir), "utf8");
const [html, catalog, art, fingerprints] = await Promise.all([
  read("index.html"), read("catalog.json").then(JSON.parse), read("item-art.json").then(JSON.parse),
  read("reference-fingerprints.json").then(JSON.parse),
]);
const itemIds = new Set(catalog.groups.flatMap(group => group.items.map(item => String(item.id))));
assert.equal(Object.keys(art).length, itemIds.size);
for (const id of itemIds) {
  assert.equal(art[id], "https://hexaov91.github.io/abi-assets/image/Normal/" + id + ".png");
}
for (const group of catalog.groups) {
  assert.equal(fingerprints.filter(reference => reference.id === String(group.id)).length, 2);
}
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  assert.match(match[1], /^[\w.-]+$/);
  assert((await readFile(new URL(match[1], publicDir))).length > 0);
}
for (const name of await readdir(publicDir)) {
  if (/\.(js|mjs)$/.test(name)) execFileSync(process.execPath, ["--check", fileURLToPath(new URL(name, publicDir))]);
}
console.log(`Verified ${itemIds.size} artwork references and ${fingerprints.length} sound fingerprints.`);

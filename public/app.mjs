import { maps, guides, modeLabels } from "./guides.mjs";
import { estimateCargo } from "./estimate.mjs";
import { captureGame, liveDetector, recognizeFile } from "./audio.mjs";
import { createMerchantSession } from "./merchant-session.mjs";
import { Dropdown } from "./dropdown.mjs";

const $ = id => document.getElementById(id);
const storage = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem("hydoabi:" + key)) ?? fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("hydoabi:" + key, JSON.stringify(value)); }
    catch { /* Local state is optional when storage is restricted. */ }
  },
};
const words = Object.fromEntries([...document.querySelectorAll("[data-i18n]")].map(element =>
  [element.dataset.i18n, element.textContent]));
Object.assign(words, {
  stop: "Stop listening", ready: "Ready", connecting: "Connecting", listening: "Listening",
  analyzing: "Analyzing", sharingEnded: "Audio sharing ended.",
  unsupported: "Open this page in desktop Chrome or Edge to capture game audio.",
  "no-audio": "No audio was shared. Pick the game window and turn on audio sharing.",
  "large-file": "Choose an audio file under 30 MB.",
  fileError: "The recording could not be decoded. Try WAV, OGG, or MP3.",
  noMatch: "No matching cargo sound. Try a short recording with less background noise.",
  noCandidates: "No candidates in this raid",
  noCandidatesBody: "Check the map and mode. Hover the cargo again and wait for its tooltip.",
  redChance: "Red chance", expectedValue: "Expected value", expectedNet: "Expected payback",
  match: "Audio similarity", candidate: "Possible item", rarity: "Rarity", size: "Size",
  odds: "Chance", contact: "Contact value", red: "Red", gold: "Gold", purple: "Purple", blue: "Blue",
  group: "Sound", manualResult: "Manual selection", noHistory: "No scans yet.",
  noFinds: "The public feed is unavailable.", snapshot: "Public feed snapshot",
  useMap: "Use for raid", browseEmpty: "No matching sounds.",
  playUp: "Play pickup sound", playDown: "Play drop sound",
  previewError: "The reference sound could not be loaded.",
  confirmClear: "Clear scan history on this device?",
  overlayError: "The over-game window requires a supported version of Chrome or Edge.",
  phoneHelp: "Scan this code to open a snapshot of the current result on your phone.",
  phoneEmpty: "Scan or select a cargo sound first.",
  phoneLocal: "Open the hosted page to share results with another device.",
  phoneCopied: "Link copied.", phoneCopyError: "Select and copy the link.",
  phoneInvalid: "This link does not contain a valid result.", cancel: "Window selection canceled.",
  estimateNote: "Estimate from public loot tables. Multiple items can share a sound.",
  netNote: "Payback uses contact value minus the cargo price.",
  gridWaiting: "Looking for merchant", gridReady: "Grid detected", gridOff: "Capture off",
  gridEmptyTitle: "The merchant grid will appear here",
  gridEmptyBody: "Start listening and open the merchant. Move the cursor off the grid for a moment so the scanner can see the slots.",
  hoverTitle: "Hover a cargo until its price appears", hoverBody: "Then drag and drop it once in the game.",
  gridDrag: "Drag the cargo once", gridMatched: "Cargo matched", unknownCargo: "Cargo",
  visibleSlots: "Visible slots", priceRead: "Read from game",
  priceUnknown: "Price not read yet",
  unassigned: "Sound matched. Hover over a cargo before dragging it to reveal the item in its slot.",
  clipResult: "Sound test result",
});
const t = key => words[key] ?? key;
const local = data => data?.en ?? "";
const format = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format;
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format;
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const icon = id => '<svg aria-hidden="true"><use href="#i-' + id + '"/></svg>';

let catalog;
let templates;
let publicFinds;
let itemArt;
try {
  const fetchAsset = async name => {
    const response = await fetch(new URL(name, document.baseURI));
    if (!response.ok) throw new Error(name);
    return response.json();
  };
  const data = globalThis.CARGO_ASSETS ?? await Promise.all([
    fetchAsset("catalog.json"),
    fetchAsset("reference-fingerprints.json"),
    fetchAsset("finds.json").catch(() => null),
    fetchAsset("item-art.json"),
  ]).then(([catalog, templates, finds, itemArt]) => ({ catalog, templates, finds, itemArt }));
  ({ catalog, templates, finds: publicFinds, itemArt } = data);
} catch {
  $("status").textContent = "Unavailable";
  $("scanner-message").textContent = "The reference library could not load. Reload this page to try again.";
  for (const id of ["listen", "upload", "manual", "phone", "overlay"]) $(id).disabled = true;
  throw new Error("Unable to load HydoABITool reference data");
}

const groups = new Map(catalog.groups.map(group => [String(group.id), group]));
const knownRarities = { 3: "blue", 4: "purple", 5: "gold", 6: "red" };
const bars = Array.from({ length: 49 }, (_, index) => {
  const bar = document.createElement("i");
  bar.style.setProperty("--amp", 5 + (Math.sin(index * 1.1) ** 2 * 7) + "%");
  $("bars").append(bar);
  return bar;
});
const preferences = storage.get("raid", {});
let selectedMap = maps.find(map => map.id === preferences.map) ?? maps[0];
let viewedMap = selectedMap;
let history = storage.get("history", []);
if (!Array.isArray(history)) history = [];
let result = null;
let capture;
let paused = false;
let merchantSession;
let merchantView;
let hovered;
let hoverHint;
let revealed = new Map();
let overlayWindow;
let playing;
let status = "ready";
let message = "";
let lastPaint = 0;
const mapDropdown = new Dropdown($("map"), mapId => {
  selectedMap = maps.find(map => map.id === mapId) ?? maps[0];
  renderModes();
  contextChanged();
});
const modeDropdown = new Dropdown($("mode"), contextChanged);

function setStatus(next) {
  status = next;
  $("status").textContent = t(status);
  $("status").parentElement.dataset.active = String(status === "listening");
  renderGrid();
}

function setMessage(next) {
  message = next;
  $("scanner-message").textContent = next ? t(next) : "";
}

function renderModes(preferred) {
  modeDropdown.setOptions(selectedMap.modes.map(mode => ({ value: mode, label: local(modeLabels[mode]) })), preferred);
}

function renderSetup(preferredMode) {
  mapDropdown.setOptions(maps.map(map => ({ value: map.id, label: local(map.name) })), selectedMap.id);
  renderModes(preferredMode);
}

function raid() {
  return { map: selectedMap.id, mode: modeDropdown.value };
}

function context(record = result) {
  return { ...raid(), cargo: record?.scope?.cargo ?? null, asking: record?.scope?.asking ?? null,
    width: record?.scope?.width ?? null, height: record?.scope?.height ?? null };
}

function priceOptions() {
  const { map, mode } = raid();
  const profile = catalog.profiles.find(profile => profile.maps.some(entry => entry.mapId === map && entry.modeId === mode));
  const pools = catalog.pools.filter(pool => pool.profile === profile?.id);
  const prices = [...new Set(pools.map(pool => pool.price))];
  return { prices, cargoTypes: catalog.cargoTypes };
}

function emptyCard(title, body) {
  return '<div class="empty"><span class="empty-icon">' + icon("box") + '</span><h3>' +
    escapeHtml(t(title)) + "</h3><p>" + escapeHtml(t(body)) + "</p></div>";
}

function resultMarkup(record, raid) {
  if (!record || !groups.has(record.id)) return emptyCard("emptyTitle", "emptyBody");
  const group = groups.get(record.id);
  const estimate = estimateCargo(catalog, raid, group);
  if (!estimate?.items.length) return emptyCard("noCandidates", "noCandidatesBody");
  const metric = (key, value) => '<div class="metric"><span>' + escapeHtml(t(key)) + '</span><b>' + value + "</b></div>";
  const isPaidPrice = estimate.expectedNet !== null;
  const similarity = record.score == null ? "—" : percent(record.score);
  const rows = estimate.items.map(item => '<tr><td><span class="item-cell">' +
    lootImage(item, "item-art") + escapeHtml(item.name) + '</span>' +
    '</td><td><span class="tier" data-rarity="' + item.rarity + '">' +
    escapeHtml(knownRarities[item.rarity] ? t(knownRarities[item.rarity]) : item.rarity) + '</span></td><td>' +
    item.width + " × " + item.height + '</td><td>' + percent(item.probability) +
    '</td><td>' + format(item.price) + "</td></tr>").join("");
  const headings = ["candidate", "rarity", "size", "odds", "contact"].map(key => "<th scope='col'>" + escapeHtml(t(key)) + "</th>").join("");
  return (raid.asking ? '<p class="result-note"><strong>' + escapeHtml(t("priceRead")) + '</strong> · ' +
    format(raid.asking) + ' Koen</p>' : "") + '<div class="summary">' + metric("redChance", percent(estimate.redChance)) +
    metric(isPaidPrice ? "expectedNet" : "expectedValue", format(isPaidPrice ? estimate.expectedNet : estimate.expectedValue)) +
    metric("match", similarity) + '</div><div class="table-scroll"><table class="table"><thead><tr>' +
    headings + "</tr></thead><tbody>" + rows + '</tbody></table></div><p class="result-note">' +
    escapeHtml(t("estimateNote")) + (isPaidPrice ? " " + escapeHtml(t("netNote")) : "") + "</p>";
}

const tileKey = target => target.view + "/" + target.slot.id;

function lootImage(item, className) {
  const src = itemArt?.[item.id];
  return src ? '<img alt="" decoding="async" class="' + className + '" src="' + escapeHtml(src) + '">' : "";
}

function compactRecord(record) {
  if (!record) return null;
  const scope = record.scope ?? {};
  return { id: record.id, score: record.score, scope: { cargo: scope.cargo ?? null,
    asking: scope.asking ?? null, width: scope.width ?? null, height: scope.height ?? null } };
}

function boardState() {
  if (!merchantView) return null;
  const { key, grid } = merchantView;
  return { rows: grid.rows, active: hovered?.view === key ? hovered.slot.id : null,
    price: hoverHint?.asking ?? null, slots: grid.slots.map(({ id, col, row, w, h }) =>
      ({ id, col, row, w, h, record: compactRecord(revealed.get(key + "/" + id)) })) };
}

function gridMarkup(board = boardState(), activeRaid = raid(), selected = result?.slotId, image) {
  if (!board) return emptyCard("gridEmptyTitle", "gridEmptyBody");
  const tiles = board.slots.map(slot => {
    const group = slot.record && groups.get(slot.record.id);
    const active = board.active === slot.id;
    const estimate = group ? estimateCargo(catalog, { ...activeRaid, ...slot.record.scope }, group) : null;
    const item = estimate?.items[0];
    const title = item ? item.name : t("unknownCargo");
    const number = (slot.row + 1) + "·" + (slot.col + 1);
    const state = item ? " revealed" : "";
    const current = slot.record && slot.id === selected;
    const candidateCount = estimate?.items.length ?? 0;
    const badge = candidateCount > 1 ? '<span class="slot-count" title="Possible items">+' + (candidateCount - 1) + "</span>" : "";
    const artwork = item ? lootImage(item, "slot-art") : "";
    const name = item ? '<span class="slot-name">' + escapeHtml(title) + "</span>" :
      !image ? '<span class="slot-placeholder">' + escapeHtml(t("unknownCargo")) + "</span>" : "";
    return '<button type="button" class="cargo-slot' + state + (active ? " hovering" : "") +
      (current ? " current" : "") + '" data-slot="' + escapeHtml(slot.id) + '" aria-label="' + escapeHtml(title + " " + number) +
      '" data-rarity="' + (item?.rarity ?? "") + '" title="' + escapeHtml(title + " · row " + (slot.row + 1) + ", column " + (slot.col + 1) +
        (candidateCount > 1 ? " · " + candidateCount + " possible items" : "")) +
      '" style="grid-column:' + (slot.col + 1) + ' / span ' + slot.w + ';grid-row:' + (slot.row + 1) +
      ' / span ' + slot.h + '"><span class="slot-coord">' + number + '</span>' + artwork + name + badge + '</button>';
  }).join("");
  return '<div class="board-shell" style="--board-rows:' + board.rows + '"><div class="cargo-board' + (image ? " captured" : "") + '" style="--rows:' + board.rows + '" aria-label="' + escapeHtml(t("merchantGrid")) + '">' +
    (image ? '<img class="captured-grid" src="' + image + '" alt="" aria-hidden="true">' : "") + tiles + '</div>' +
    '<div class="grid-footer"><span>' + board.slots.length + " " + escapeHtml(t("visibleSlots")) + '</span><span>' +
    escapeHtml(board.price ? t("priceRead") + " · " + format(board.price) + " Koen" :
      board.active ? t("priceUnknown") : t("hoverBody")) + "</span></div></div>";
}

function gridStatus() {
  if (!capture) return "gridOff";
  if (paused) return "Paused";
  if (!merchantView) return "gridWaiting";
  if (hovered) return "gridDrag";
  return "gridReady";
}

function renderGrid() {
  $("merchant-grid").innerHTML = gridMarkup(undefined, undefined, undefined, merchantView?.image);
  $("reset-grid").disabled = revealed.size === 0;
  const pause = $("pause-grid");
  pause.disabled = !capture;
  pause.setAttribute("aria-pressed", String(paused));
  pause.setAttribute("aria-label", paused ? "Resume scanning" : "Pause scanning");
  pause.title = paused ? "Resume scanning" : "Pause scanning";
  pause.innerHTML = icon(paused ? "play" : "pause");
  $("grid-status").textContent = t(gridStatus());
  $("grid-caption").textContent = t(merchantView ? "hoverTitle" : "gridCaption");
}

function chooseSlot(event) {
  const button = event.target.closest("[data-slot]");
  if (!button || !merchantView) return;
  const record = revealed.get(merchantView.key + "/" + button.dataset.slot);
  if (!record) return;
  result = record;
  renderResult();
}

function renderOverlay() {
  if (!overlayWindow || overlayWindow.closed) return;
  const doc = overlayWindow.document;
  const board = doc.getElementById("overlay-grid");
  const label = doc.getElementById("overlay-status");
  const content = doc.getElementById("overlay-result");
  if (board) board.innerHTML = gridMarkup(undefined, undefined, undefined, merchantView?.image);
  if (label) label.textContent = t(gridStatus());
  const pause = doc.getElementById("overlay-pause");
  if (pause) {
    pause.disabled = !capture;
    pause.setAttribute("aria-pressed", String(paused));
    pause.innerHTML = icon(paused ? "play" : "pause") + (paused ? "Resume" : "Pause");
  }
  const reset = doc.getElementById("overlay-reset");
  if (reset) reset.disabled = revealed.size === 0;
  const setup = doc.getElementById("overlay-raid");
  if (setup) setup.textContent = local(selectedMap.name) + " · " + local(modeLabels[modeDropdown.value]);
  if (content) {
    const estimate = result ? estimateCargo(catalog, context(), groups.get(result.id)) : null;
    const item = estimate?.items[0];
    content.innerHTML = item ? '<div class="overlay-item">' + lootImage(item, "overlay-art") +
      '<div><strong>' + escapeHtml(item.name) + '</strong><p>' +
      (estimate.items.length === 1 ? "1 possible item" : estimate.items.length + " possible items") +
      (result?.slotId ? " · Slot " + result.slotId.split(":").map(n => Number(n) + 1).reverse().join("·") : "") +
      '</p></div></div><div class="overlay-metrics"><span>Red chance <b>' + percent(estimate.redChance) +
      '</b></span><span>' + (estimate.expectedNet !== null ? "Payback" : "Contact value") + " <b>" +
      format(estimate.expectedNet ?? estimate.expectedValue) + '</b></span></div>' :
      '<p class="overlay-tip">' + (capture ? "Hover until a price appears, then drag the cargo once." : "Start listening from the main window.") + "</p>";
  }
}

function renderResult() {
  $("result").hidden = !result;
  $("result").innerHTML = result ? '<h3 class="cargo-result-title">' +
    escapeHtml(t(result.slotId ? "gridMatched" : "clipResult")) + " · " + escapeHtml(t("group")) + " " + escapeHtml(result.id) +
    "</h3>" + resultMarkup(result, context()) : "";
  renderGrid();
  renderOverlay();
  publishMirror();
}

function selectResult(match, target) {
  if (!groups.has(String(match.id))) return;
  result = { id: String(match.id), score: match.score ?? null, time: Date.now(),
    slotId: target?.slot.id, view: target?.view, scope: {
      asking: target?.hint?.asking ?? null, cargo: Number(target?.hint?.cargo) || null,
      width: target?.slot.w ?? null, height: target?.slot.h ?? null,
    } };
  if (target) revealed.set(tileKey(target), result);
  history = [{ ...result, raid: context(), time: Date.now() }, ...history].slice(0, 30);
  storage.set("history", history);
  renderResult();
  renderHistory();
}

function selectLiveResult(match) {
  if (paused) return;
  const target = merchantSession?.target();
  if (!target) {
    if (merchantView) setMessage("unassigned");
    return;
  }
  setMessage("");
  selectResult(match, target);
}

function handleGrid(view) {
  merchantView = view;
  hovered = undefined;
  hoverHint = undefined;
  renderGrid();
  renderOverlay();
  void publishMirror();
}

function handleHover(target) {
  hovered = target;
  hoverHint = target ? merchantSession?.target()?.hint : null;
  renderGrid();
  renderOverlay();
  void publishMirror();
}

function handleHint(target, hint) {
  const key = tileKey(target);
  if (hovered && tileKey(hovered) === key) hoverHint = hint;
  const record = revealed.get(key);
  if (record) {
    record.scope.asking = hint.asking;
    record.scope.cargo = Number(hint.cargo) || null;
    const entry = history.find(scan => scan.slotId === record.slotId && scan.view === record.view && scan.id === record.id);
    if (entry) {
      entry.raid.asking = record.scope.asking;
      entry.raid.cargo = record.scope.cargo;
      storage.set("history", history);
    }
  }
  renderResult();
  renderHistory();
}

function renderHistory() {
  $("clear-history").disabled = !history.length;
  if (!history.length) {
    $("history-list").innerHTML = '<p class="muted-note">' + escapeHtml(t("noHistory")) + "</p>";
    return;
  }
  $("history-list").replaceChildren(...history.slice(0, 5).map(record => {
    const group = groups.get(record.id);
    const estimate = group ? estimateCargo(catalog, record.raid, group) : null;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mini-row";
    const name = estimate?.items[0]?.name ?? t("group") + " " + record.id;
    const time = new Date(record.time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    button.innerHTML = "<span>" + escapeHtml(name) + "</span><span>" + escapeHtml(time) + "</span>";
    button.addEventListener("click", () => {
      selectedMap = maps.find(map => map.id === record.raid.map) ?? maps[0];
      renderSetup(record.raid.mode);
      result = { ...record, scope: record.scope ?? record.raid };
      contextChanged();
      $("result-title").scrollIntoView({ block: "nearest" });
    });
    return button;
  }));
}

function renderFinds() {
  const data = publicFinds?.items?.slice(0, 5) ?? [];
  $("finds-caption").textContent = publicFinds?.live ? t("findsCaption") :
    t("snapshot") + (publicFinds?.captured ? " · " + new Date(publicFinds.captured).toLocaleDateString("en-US") : "");
  $("finds-list").innerHTML = data.length ? data.map(item =>
    '<div class="mini-row"><span>' + escapeHtml(item.name) + "</span><span>" +
    format(item.price) + "</span></div>").join("") : '<p class="muted-note">' + escapeHtml(t("noFinds")) + "</p>";
}

function renderMaps() {
  $("map-list").replaceChildren(...maps.map(map => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "map-option";
    button.setAttribute("aria-pressed", String(viewedMap === map));
    button.textContent = local(map.name);
    button.addEventListener("click", () => { viewedMap = map; renderMaps(); });
    return button;
  }));
  const map = viewedMap;
  const { width, height, points, caption } = map.locations;
  const image = globalThis.CARGO_MAPS?.[map.id] ?? "map-" + map.id + ".webp";
  $("map-detail").innerHTML = "<h2>" + escapeHtml(local(map.name)) +
    '</h2><div class="map-chips">' + map.modes.map(mode =>
      '<span class="tier">' + escapeHtml(local(modeLabels[mode])) + "</span>").join("") +
    '</div><figure class="map-image"><img alt="' + escapeHtml(local(map.name)) + '" width="' + width +
    '" height="' + height + '" src="' + escapeHtml(image) + '">' + points.map(([x, y], index) =>
      '<span class="map-marker" style="left:' + x + "%;top:" + y + '%">' + (index + 1) + "</span>").join("") +
    "</figure><p class='muted-note'>" + escapeHtml(local(caption)) + "</p><div class='map-actions'>" +
    '<button class="button primary" type="button" id="use-viewed-map">' + escapeHtml(t("useMap")) + "</button></div>";
  $("use-viewed-map").addEventListener("click", () => {
    selectedMap = viewedMap;
    renderSetup();
    contextChanged();
    location.hash = "workspace";
  });
}

function renderGuides() {
  $("guide-list").innerHTML = guides.map(guide =>
    '<details class="card"><summary>' + escapeHtml(local(guide.title)) + "</summary><p>" +
    escapeHtml(local(guide.summary)) + "</p>" + guide.sections.map(section => "<h3>" +
      escapeHtml(local(section.title)) + "</h3><p>" + escapeHtml(local(section.body)) + "</p>").join("") +
    "</details>").join("");
}

function initialize() {
  $("listen").lastElementChild.textContent = t(capture ? "stop" : "listen");
  setStatus(status);
  setMessage(message);
  renderSetup(preferences.mode);
  renderHistory();
  renderResult();
  renderFinds();
  renderMaps();
  renderGuides();
  renderRoute();
}

function contextChanged() {
  storage.set("raid", raid());
  renderResult();
}

function onLevel(rms, peaks) {
  if (performance.now() - lastPaint < 50) return;
  lastPaint = performance.now();
  bars.forEach((bar, index) => {
    const amplitude = peaks[Math.floor(index * peaks.length / bars.length)] ?? 0;
    bar.style.setProperty("--amp", Math.max(4, Math.min(100, 4 + Math.sqrt(amplitude) * 132)) + "%");
  });
  $("db-level").textContent = rms > 1e-5 ? Math.round(20 * Math.log10(rms)) + " dBFS" : "−∞ dBFS";
}

function stopListening(ended) {
  capture?.stop();
  merchantSession?.close();
  merchantSession = undefined;
  capture = undefined;
  paused = false;
  $("listen").lastElementChild.textContent = t("listen");
  $("db-level").textContent = "— dBFS";
  bars.forEach(bar => bar.style.setProperty("--amp", "4%"));
  setStatus("ready");
  setMessage(ended ? "sharingEnded" : "");
  renderOverlay();
}

async function listen() {
  if (capture) { stopListening(false); return; }
  playing?.pause();
  setStatus("connecting");
  setMessage("");
  $("listen").disabled = true;
  const detectAudio = liveDetector(templates, onLevel, selectLiveResult);
  const pendingCapture = captureGame((samples, rate) => {
    merchantSession?.sample();
    detectAudio(samples, rate);
  }, () => stopListening(true));
  const pendingOverlay = $("auto-overlay").checked && (!overlayWindow || overlayWindow.closed) ? openOverlay(false) : null;
  try {
    capture = await pendingCapture;
    revealed = new Map();
    result = null;
    merchantView = undefined;
    merchantSession = createMerchantSession(capture.stream, {
      onGrid: handleGrid, onHover: handleHover, onHint: handleHint, priceOptions,
    });
    $("listen").lastElementChild.textContent = t("stop");
    setStatus("listening");
    renderResult();
  } catch (error) {
    setStatus("ready");
    setMessage(error.name === "NotAllowedError" || error.name === "AbortError" ? "cancel" :
      ["unsupported", "no-audio"].includes(error.message) ? error.message : "unsupported");
    if (pendingOverlay) {
      await pendingOverlay;
      overlayWindow?.close();
    }
  } finally {
    $("listen").disabled = false;
  }
}

async function analyzeUpload(file) {
  if (!file) return;
  $("upload").disabled = true;
  setMessage("");
  setStatus("analyzing");
  try {
    const match = await recognizeFile(file, templates);
    if (match) { selectResult(match); location.hash = "workspace"; }
    else setMessage("noMatch");
  } catch (error) {
    setMessage(["unsupported", "large-file"].includes(error.message) ? error.message : "fileError");
  } finally {
    setStatus(capture ? "listening" : "ready");
    $("upload").disabled = false;
    $("clip-file").value = "";
  }
}

function renderSounds() {
  const term = $("sound-search").value.trim().toLocaleLowerCase();
  const visible = [...groups].filter(([id, group]) =>
    !term || id.includes(term) || group.items.some(item => item.name.toLocaleLowerCase().includes(term)));
  $("sound-list").innerHTML = visible.length ? visible.map(([id, group]) =>
    '<div class="sound-row"><button class="sound-choose" data-group="' + id + '"><strong>' +
    escapeHtml(t("group")) + " " + id + '</strong><span>' + escapeHtml(group.items.map(item => item.name).join(", ")) +
    '</span></button><button class="icon-button" data-play="pickupUrl" data-id="' + id +
    '" title="' + escapeHtml(t("playUp")) + '" aria-label="' + escapeHtml(t("playUp")) + '">' + icon("play") +
    '</button><button class="icon-button" data-play="dropUrl" data-id="' + id +
    '" title="' + escapeHtml(t("playDown")) + '" aria-label="' + escapeHtml(t("playDown")) + '">' + icon("play") +
    "</button></div>").join("") : '<p class="muted-note">' + escapeHtml(t("browseEmpty")) + "</p>";
}

async function openOverlay(showError = true) {
  if (overlayWindow && !overlayWindow.closed) {
    overlayWindow.close();
    return;
  }
  try {
    if (!window.documentPictureInPicture) throw new Error("unsupported");
    const lastSize = storage.get("overlay-size", {});
    const width = Math.max(340, Math.min(900, Number(lastSize.width) || 420));
    const height = Math.max(340, Math.min(900, Number(lastSize.height) || 640));
    overlayWindow = await window.documentPictureInPicture.requestWindow({ width, height });
    const overlay = overlayWindow.document;
    overlay.title = "HydoABITool";
    overlay.documentElement.lang = "en";
    const style = overlay.createElement("style");
    style.textContent = document.querySelector("link[rel=stylesheet]") ? await fetch(new URL("style.css", document.baseURI)).then(res => res.text()) :
      document.querySelector("style")?.textContent;
    overlay.head.append(style);
    overlay.body.append(document.querySelector(".symbols").cloneNode(true));
    const panel = overlay.createElement("main");
    panel.className = "card results overlay-panel";
    panel.innerHTML = '<header class="overlay-heading"><div class="overlay-brand"><img src="' +
      new URL("hydo.svg", document.baseURI).href + '" alt="" width="27" height="27"><div><h1>HydoABITool</h1>' +
      '<p id="overlay-raid"></p></div></div><button id="overlay-close" type="button" class="icon-button" aria-label="Close overlay" title="Close overlay">' +
      icon("close") + '</button></header><div class="overlay-toolbar"><span id="overlay-status" class="status-pill"></span>' +
      '<div><button id="overlay-pause" class="button outline" type="button" aria-pressed="false">Pause</button>' +
      '<button id="overlay-reset" type="button" class="icon-button" aria-label="Clear revealed slots" title="Clear revealed slots">' +
      icon("reset") + '</button></div></div><div id="overlay-grid"></div><div id="overlay-result" class="overlay-result"></div>';
    overlay.body.append(panel);
    panel.addEventListener("click", chooseSlot);
    overlay.getElementById("overlay-pause").addEventListener("click", togglePause);
    overlay.getElementById("overlay-reset").addEventListener("click", resetGrid);
    overlay.getElementById("overlay-close").addEventListener("click", () => overlayWindow.close());
    const windowHandle = overlayWindow;
    overlayWindow.addEventListener("pagehide", () => {
      storage.set("overlay-size", { width: windowHandle.innerWidth, height: windowHandle.innerHeight });
      if (overlayWindow === windowHandle) overlayWindow = undefined;
    }, { once: true });
    renderOverlay();
  } catch {
    overlayWindow?.close();
    if (showError) setMessage("overlayError");
  }
}

function resetGrid() {
  revealed = new Map();
  result = null;
  renderResult();
}

function togglePause() {
  if (!capture) return;
  paused = !paused;
  merchantSession?.setPaused(paused);
  hovered = undefined;
  hoverHint = undefined;
  renderGrid();
  renderOverlay();
}

let mirrorSession;
let mirrorTimer;
let mirrorState;
let mirrorSlot;
let lastMirrorBody = "";
let mirrorSending = false;
async function publishMirror() {
  if (!mirrorSession || mirrorSending) return;
  const session = mirrorSession;
  mirrorSending = true;
  try {
    while (mirrorSession === session) {
      const { map, mode, cargo, asking } = context();
      const record = compactRecord(result);
      const body = JSON.stringify({ map, mode, cargo, asking, record, board: boardState() });
      if (body === lastMirrorBody) break;
      const response = await fetch("/api/mirror/" + session.id, {
        method: "PUT", body, headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.writer },
      });
      if (!response.ok) break;
      if (mirrorSession === session) lastMirrorBody = body;
    }
  } catch {
    // A later result or a newly opened phone dialog can retry.
  } finally {
    mirrorSending = false;
    if (mirrorSession !== session) void publishMirror();
  }
}

function renderPhoneGrid() {
  if (!mirrorState) return;
  const { board, record } = mirrorState;
  $("mirror-status").textContent = board ? "Live" : "Waiting for grid";
  $("mirror-grid").innerHTML = board ? gridMarkup(board, mirrorState, mirrorSlot) :
    emptyCard("gridEmptyTitle", "gridEmptyBody");
  const chosen = board?.slots.find(slot => slot.id === mirrorSlot)?.record ?? record;
  $("mirror-result").innerHTML = chosen ? resultMarkup(chosen, { ...mirrorState, ...chosen.scope }) : "";
}

function renderRoute() {
  const [page, query = ""] = location.hash.slice(1).split("?", 2);
  const active = ["maps", "guides", "mirror"].includes(page) ? page : "workspace";
  for (const section of document.querySelectorAll("[data-page]")) section.hidden = section.id !== active;
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (link.dataset.nav === active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  clearInterval(mirrorTimer);
  mirrorState = null;
  mirrorSlot = null;
  if (active !== "mirror") return;
  $("mirror-status").textContent = "Connecting";
  $("mirror-grid").replaceChildren();
  $("mirror-result").replaceChildren();
  const params = new URLSearchParams(query);
  const id = params.get("id");
  if (id && /^[a-z0-9]{32}$/i.test(id)) {
    const update = async () => {
      try {
        const response = await fetch("/api/mirror/" + id, { cache: "no-store" });
        if (!response.ok) throw Error("Mirror unavailable");
        if (location.hash !== "#mirror?" + query) return;
        mirrorState = await response.json();
        renderPhoneGrid();
      } catch {
        $("mirror-status").textContent = "Disconnected";
        $("mirror-result").textContent = t("phoneInvalid");
      }
    };
    void update();
    mirrorTimer = setInterval(update, 1600);
    return;
  }
  const record = { id: params.get("sound"), score: params.has("similarity") ? Number(params.get("similarity")) : null };
  const raid = { map: params.get("map"), mode: params.get("mode"), cargo: Number(params.get("cargo")) || null, asking: Number(params.get("asking")) || null };
  $("mirror-status").textContent = "Snapshot";
  $("mirror-result").innerHTML = groups.has(record.id) ? resultMarkup(record, raid) : escapeHtml(t("phoneInvalid"));
}

async function openPhone() {
  $("phone-dialog").showModal();
  $("phone-status").textContent = "";
  $("phone-qr").replaceChildren();
  $("phone-url").value = "";
  $("copy-phone").disabled = true;
  $("phone-help").textContent = t("phoneHelp");
  if (location.protocol === "file:") { $("phone-help").textContent = t("phoneLocal"); return; }
  const base = new URL(location.href);
  const params = new URLSearchParams();
  try {
    if (!mirrorSession || mirrorSession.expires <= Date.now()) {
      const response = await fetch("/api/mirror", { method: "POST" });
      if (!response.ok) throw Error("Mirror unavailable");
      mirrorSession = await response.json();
      lastMirrorBody = "";
    }
    if (!mirrorSession?.id) throw Error("Mirror unavailable");
    params.set("id", mirrorSession.id);
    $("phone-help").textContent = "Scan the code for the live merchant grid. The link expires after one hour.";
    publishMirror();
  } catch {
    if (!result) { $("phone-help").textContent = t("phoneEmpty"); return; }
    params.set("sound", result.id);
    if (result.score !== null) params.set("similarity", result.score.toFixed(3));
    for (const [key, value] of Object.entries(context())) if (value) params.set(key, String(value));
  }
  base.hash = "mirror?" + params.toString();
  $("phone-url").value = base.href;
  $("copy-phone").disabled = false;
  if (globalThis.QRCode) {
    const qr = document.createElement("canvas");
    $("phone-qr").append(qr);
    try { await globalThis.QRCode.toCanvas(qr, base.href, { width: 184, margin: 2 }); }
    catch { qr.remove(); }
  }
}

$("merchant-grid").addEventListener("click", chooseSlot);
$("reset-grid").addEventListener("click", resetGrid);
$("pause-grid").addEventListener("click", togglePause);
$("mirror-grid").addEventListener("click", event => {
  const button = event.target.closest("[data-slot]");
  if (button && mirrorState?.board?.slots.find(slot => slot.id === button.dataset.slot)?.record) {
    mirrorSlot = button.dataset.slot;
    renderPhoneGrid();
  }
});
$("auto-overlay").checked = Boolean(storage.get("auto-overlay", false));
$("auto-overlay").addEventListener("change", () => storage.set("auto-overlay", $("auto-overlay").checked));
$("listen").addEventListener("click", listen);
$("upload").addEventListener("click", () => $("clip-file").click());
$("clip-file").addEventListener("change", () => analyzeUpload($("clip-file").files[0]));
$("overlay").addEventListener("click", () => openOverlay());
$("phone").addEventListener("click", openPhone);
$("copy-phone").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("phone-url").value);
    $("phone-status").textContent = t("phoneCopied");
  } catch {
    $("phone-url").select();
    $("phone-status").textContent = t("phoneCopyError");
  }
});
$("manual").addEventListener("click", () => {
  $("sound-search").value = "";
  renderSounds();
  $("sound-dialog").showModal();
});
$("sound-search").addEventListener("input", renderSounds);
$("sound-list").addEventListener("click", event => {
  const button = event.target.closest("button");
  if (button?.dataset.group) {
    selectResult({ id: button.dataset.group });
    $("sound-dialog").close();
    location.hash = "workspace";
  } else if (button?.dataset.play) {
    playing?.pause();
    playing = new Audio(groups.get(button.dataset.id)[button.dataset.play]);
    playing.play().catch(() => setMessage("previewError"));
  }
});
$("sound-dialog").addEventListener("close", () => playing?.pause());
$("clear-history").addEventListener("click", () => {
  if (!confirm(t("confirmClear"))) return;
  history = [];
  storage.set("history", history);
  renderHistory();
});
window.addEventListener("hashchange", renderRoute);
window.addEventListener("pagehide", () => { capture?.stop(); merchantSession?.close(); });
initialize();
if (location.protocol !== "file:") {
  const updateFinds = () => fetch("/api/finds", { cache: "no-store" }).then(response => {
    if (!response.ok) throw Error("Finds unavailable");
    return response.json();
  }).then(data => { publicFinds = { ...data, live: true }; renderFinds(); }).catch(() => {});
  void updateFinds();
  setInterval(updateFinds, 60000);
}

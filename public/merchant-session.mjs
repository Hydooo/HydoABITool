import { detectMerchantGrid, detectHoveredSlot } from "./merchant-grid.mjs";
import { createTooltipReader } from "./tooltip-reader.mjs";

const FRAME_WIDTH = 960;
const FRAME_INTERVAL = 180;
const TARGET_LIFETIME = 3700;

function layoutKey(grid) {
  return grid.rows + ":" + grid.slots.map(({ col, row, w, h }) => [col, row, w, h].join(",")).join("|");
}

function viewportKey(grid) {
  const scroll = Number.isFinite(grid.scrollFraction) ? Math.round(grid.scrollFraction * 20) : "";
  return scroll + ":" + layoutKey(grid);
}

function sameViewport(left, right) {
  const scrollChanged = Number.isFinite(left.scrollFraction) && Number.isFinite(right.scrollFraction) &&
    Math.abs(left.scrollFraction - right.scrollFraction) > .07;
  if (scrollChanged || left.rows !== right.rows || Math.abs(left.x - right.x) > left.pitch * .4 ||
      Math.abs(left.y - right.y) > left.pitch * .4 || Math.abs(left.pitch - right.pitch) > left.pitch * .1) return false;
  const shapes = new Set(left.slots.map(({ col, row, w, h }) => [col, row, w, h].join(",")));
  const shared = right.slots.filter(({ col, row, w, h }) => shapes.has([col, row, w, h].join(","))).length;
  return shared >= .72 * Math.max(left.slots.length, right.slots.length);
}

export function createMerchantSession(stream, { onGrid, onHover, onHint, priceOptions }) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  void video.play().catch(() => {});
  const canvas = document.createElement("canvas");
  const surface = canvas.getContext("2d", { willReadFrequently: true });
  let reader;
  let frame;
  let grid;
  let stable;
  let failures = 0;
  let proposedKey = "";
  let proposedCount = 0;
  let hoverCandidate;
  let latestTarget;
  let stopped = false;
  let activeRead = false;
  let lastSample = -Infinity;
  let lastVideoTime = -Infinity;
  const hints = new Map();
  const readTimes = new Map();

  async function readTooltip(pixels, hit, target) {
    const key = target.view + "/" + target.slot.id;
    const lastTime = readTimes.get(key) ?? -Infinity;
    if (activeRead || hints.has(key) || performance.now() - lastTime < 1800) return;
    const anchor = hit.anchor ?? hit.point ?? {
      x: grid.x + (target.slot.col + target.slot.w / 2) * grid.pitch,
      y: grid.y + (target.slot.row + target.slot.h / 2) * grid.pitch,
    };
    activeRead = true;
    readTimes.set(key, performance.now());
    try {
      reader ??= await createTooltipReader();
      if (stopped) { await reader.close(); return; }
      const region = hit.region ?? hit.tooltip;
      const hint = await reader.read(pixels, region ? { ...anchor, ...region } : anchor, priceOptions());
      if (stopped || !hint?.asking) return;
      hints.set(key, hint);
      onHint(target, hint);
    } catch {
      // A blocked OCR dependency or unreadable tooltip leaves the price unknown.
    } finally {
      activeRead = false;
    }
  }

  function sample() {
    if (stopped || video.readyState < 2 || !surface || !video.videoWidth || !video.videoHeight) return;
    const now = performance.now();
    if (now - lastSample < FRAME_INTERVAL - 15 || lastVideoTime === video.currentTime) return;
    lastSample = now;
    lastVideoTime = video.currentTime;
    const scale = Math.min(1, FRAME_WIDTH / video.videoWidth);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    surface.drawImage(video, 0, 0, width, height);
    const nextFrame = surface.getImageData(0, 0, width, height);
    const previousFrame = frame;
    frame = nextFrame;
    const observed = detectMerchantGrid(frame, grid);
    if (!observed) {
      if (++failures >= 5 && stable) {
        stable = undefined;
        grid = undefined;
        hoverCandidate = undefined;
        latestTarget = undefined;
        proposedKey = "";
        proposedCount = 0;
        onGrid(null);
        onHover(null);
      }
      return;
    }
    failures = 0;
    grid = observed;
    const candidateKey = viewportKey(grid);
    const key = stable && sameViewport(stable.grid, grid) ? stable.key : candidateKey;
    proposedCount = proposedKey === key ? proposedCount + 1 : 1;
    proposedKey = key;
    if (proposedCount < 2) return;
    if (stable?.key !== key) {
      stable = { key, grid };
      hoverCandidate = undefined;
      latestTarget = undefined;
      onGrid(stable);
      onHover(null);
    }
    const hit = detectHoveredSlot(frame, grid, previousFrame);
    const observedSlot = hit && (hit.slot ?? grid.slots.find(candidate => candidate.id === (hit.id ?? hit.slotId)));
    const slot = observedSlot && stable.grid.slots.find(candidate =>
      observedSlot.col >= candidate.col && observedSlot.col < candidate.col + candidate.w &&
      observedSlot.row >= candidate.row && observedSlot.row < candidate.row + candidate.h);
    if (!slot) {
      if (hoverCandidate) onHover(null);
      hoverCandidate = undefined;
      return;
    }
    if (hoverCandidate?.id !== slot.id) {
      hoverCandidate = { id: slot.id, since: now };
      return;
    }
    const target = { view: key, slot, time: now };
    const changed = latestTarget?.slot.id !== slot.id;
    latestTarget = target;
    if (changed) onHover(target);
    if (now - hoverCandidate.since >= 160) void readTooltip(frame, hit, target);
  }

  const timer = setInterval(sample, FRAME_INTERVAL);
  return {
    sample,
    target() {
      if (!latestTarget || performance.now() - latestTarget.time > TARGET_LIFETIME) return null;
      const key = latestTarget.view + "/" + latestTarget.slot.id;
      return { ...latestTarget, hint: hints.get(key) ?? null };
    },
    close() {
      stopped = true;
      clearInterval(timer);
      video.pause();
      video.srcObject = null;
      if (reader) void reader.close();
    },
  };
}

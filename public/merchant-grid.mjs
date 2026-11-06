const COLUMNS = 9;
const VIEWPORT_TOP = 0.168;
const VIEWPORT_BOTTOM = 0.823;

function pixels(frame) {
  const { width, height, data } = frame ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 360 || height < 210 ||
      data?.length !== width * height * 4) return null;
  const luma = new Uint8Array(width * height);
  // Only the merchant panel and its possible tooltip need to be sampled.
  for (let i = Math.floor(height * 0.12) * width; i < Math.ceil(height * 0.99) * width; i++) {
    const p = i * 4;
    luma[i] = (54 * data[p] + 183 * data[p + 1] + 19 * data[p + 2]) >> 8;
  }
  return { width, height, luma };
}

function ridge(luma, offset, delta) {
  return Math.max(0, luma[offset] - Math.max(luma[offset - delta], luma[offset + delta]));
}

function axisProfile({ width, height, luma }, vertical, from, to) {
  const length = vertical ? width : height;
  const profile = new Float32Array(length);
  const margin = Math.max(2, Math.round(width / 460));
  const start = Math.floor(length * (vertical ? 0.53 : 0.145));
  const end = Math.min(length - margin, Math.ceil(length * (vertical ? 0.985 : 0.85)));
  const samples = Math.ceil((to - from) / 2);
  const cross = vertical ? margin : margin * width;
  const tangent = vertical ? 3 * width : 3;
  for (let axis = start; axis < end; axis++) {
    let sum = 0;
    for (let along = from; along < to; along += 2) {
      const offset = vertical ? along * width + axis : axis * width + along;
      const strength = ridge(luma, offset, cross);
      if (strength < 2 || luma[offset] > 115 ||
          Math.min(ridge(luma, offset - tangent, cross), ridge(luma, offset + tangent, cross)) < 2) continue;
      sum += Math.min(32, strength);
    }
    profile[axis] = sum / samples;
  }
  return profile;
}

function localPeak(profile, at, radius = 1) {
  const center = Math.round(at);
  let best = center;
  for (let i = center - radius; i <= center + radius; i++) {
    if ((profile[i] ?? 0) > (profile[best] ?? 0)) best = i;
  }
  return best;
}

function lineContrast(profile, at, pitch, radius = 1) {
  const peak = profile[localPeak(profile, at, radius)] ?? 0;
  const left = profile[Math.round(at - pitch * 0.29)] ?? 0;
  const right = profile[Math.round(at + pitch * 0.29)] ?? 0;
  return peak - (left + right) / 2;
}

function refineLattice(profile, start, pitch, count) {
  let points = 0;
  let indices = 0;
  let squaredIndices = 0;
  let positions = 0;
  let products = 0;
  for (let i = 0; i < count; i++) {
    const expected = start + i * pitch;
    if (lineContrast(profile, expected, pitch, 2) < 1.6) continue;
    const observed = localPeak(profile, expected, 2);
    points++;
    indices += i;
    squaredIndices += i * i;
    positions += observed;
    products += i * observed;
  }
  if (points < 4) return { start, pitch };
  const step = (points * products - indices * positions) /
    (points * squaredIndices - indices ** 2);
  if (Math.abs(step - pitch) > 1.5) return { start, pitch };
  return { start: (positions - step * indices) / points, pitch: step };
}

function findHorizontalAxis(image, previous) {
  const { width, height } = image;
  const profile = axisProfile(image, true, Math.round(height * 0.24), Math.round(height * 0.812));
  const nominal = Math.min(width * 0.0334, height * 0.0593);
  let best;
  for (let pitch = nominal * 0.76; pitch <= nominal * 1.21; pitch += 0.23) {
    for (let x = Math.round(width * 0.54); x <= width * 0.735 && x + pitch * COLUMNS < width * 0.98; x++) {
      let sum = 0;
      let support = 0;
      for (let col = 0; col <= COLUMNS; col++) {
        const contrast = lineContrast(profile, x + col * pitch, pitch);
        sum += Math.min(14, contrast);
        if (contrast >= 1.7) support++;
      }
      if (support < 6) continue;
      const tracking = previous && Math.abs(previous.x - x) < 3 && Math.abs(previous.pitch - pitch) < 1 ? 1 : 0;
      const positionPrior = Math.max(0, Math.abs(x / width - 0.653) - 0.012) * 90;
      const score = sum / (COLUMNS + 1) + support * 0.36 + tracking * 0.5 - positionPrior;
      if (!best || score > best.score) best = { x, pitch, score };
    }
  }
  if (!best || best.score < 4.6) return null;
  const fit = refineLattice(profile, best.x, best.pitch, COLUMNS + 1);
  return { ...best, x: fit.start, pitch: fit.pitch };
}

function findVerticalAxis(image, { x, pitch }) {
  const { height } = image;
  const profile = axisProfile(image, false, Math.ceil(x + 2), Math.floor(x + COLUMNS * pitch - 2));
  const top = Math.round(height * VIEWPORT_TOP);
  const bottom = Math.round(height * VIEWPORT_BOTTOM);
  let best;
  for (let y = top - Math.round(pitch * 0.14); y < top + pitch * 0.86; y++) {
    let support = 0;
    let sum = 0;
    let count = 0;
    for (let line = y; line <= bottom + 2; line += pitch) {
      const contrast = lineContrast(profile, line, pitch);
      if (contrast >= 1.4) support++;
      sum += Math.min(14, contrast);
      count++;
    }
    if (support < Math.max(5, count * 0.55)) continue;
    const score = sum / count + support * 0.27;
    if (!best || score > best.score) best = { y, count, score };
  }
  if (!best || best.score < 4.1) return null;
  const fit = refineLattice(profile, best.y, pitch, best.count);
  let y = Math.abs(fit.pitch - pitch) < 0.65 ? fit.start : best.y;
  if (y < top && lineContrast(profile, y, pitch, 2) < 1.6) y += pitch;
  const rows = Math.floor((bottom + pitch * 0.16 - y) / pitch);
  return rows >= 4 ? { y, rows, score: best.score } : null;
}

function brightTextRows(image, x, y, pitch, from, to) {
  const { luma, width } = image;
  let best = 0;
  for (let row = y + Math.round(pitch * from); row <= y + pitch * to; row++) {
    let bright = 0;
    for (let col = x + Math.round(pitch * 0.23); col < x + pitch * 1.7; col++) {
      if (luma[row * width + col] > 72) bright++;
    }
    best = Math.max(best, bright);
  }
  return best;
}

function findTooltip(image, grid) {
  const { luma, width, height } = image;
  const { x: gridX, y: gridY, pitch, rows } = grid;
  const offset = Math.max(2, Math.round(pitch * 0.075));
  const pad = Math.max(2, Math.round(pitch * 0.11));
  const fromX = Math.round(gridX - pitch * 0.15);
  const toX = Math.min(width - pitch * 1.8, gridX + pitch * COLUMNS);
  const toY = Math.min(height - pitch * 1.5, gridY + rows * pitch + pitch * 0.3);
  let best;
  for (let y = Math.round(gridY); y < toY; y++) {
    for (let x = fromX; x < toX; x++) {
      const corner = y * width + x + pad;
      const top = (luma[corner - 1] + luma[corner] + luma[corner + 1]) / 3;
      if (top < 28 || luma[corner + width * pad] > 13) continue;

      let darkness = 0;
      let contrast = 0;
      for (let sample = 1; sample <= 6; sample++) {
        const at = (y + Math.round(pitch * sample * 0.185)) * width + x;
        const inside = luma[at + pad];
        if (inside < 13) darkness++;
        contrast += luma[at - offset] - inside;
      }
      if (darkness < 5 || contrast < 45) continue;

      let bottom = 0;
      let bottomY = 0;
      for (let row = y + Math.round(pitch * 1.2); row <= y + pitch * 1.52; row++) {
        const index = row * width + x + pad;
        const value = (luma[index - 1] + luma[index] + luma[index + 1]) / 3;
        if (value > bottom) {
          bottom = value;
          bottomY = row;
        }
      }
      if (bottom < 29) continue;
      const title = brightTextRows(image, x, y, pitch, 0.19, 0.38);
      const price = brightTextRows(image, x, y, pitch, 0.50, 0.78);
      const action = brightTextRows(image, x, y, pitch, 0.91, 1.2);
      if (Math.min(title, price, action) < Math.max(3, pitch * 0.17)) continue;
      const score = Math.min(100, top) + Math.min(100, bottom) + Math.min(125, contrast) * 0.4 +
        (title + price + action) * 2 + darkness * 5;
      if (!best || score > best.score) best = { x, y, bottomY, score };
    }
  }
  if (!best || best.score < (pitch >= 29 ? 366 : 317)) return null;

  // Corner brackets on the far edge give the OCR crop its width.
  let far = Math.min(width - 1, Math.round(best.x + pitch * 4.8));
  let farScore = 0;
  for (let x = best.x + Math.round(pitch * 2); x < Math.min(width - 2, best.x + pitch * 6.8); x++) {
    const start = best.y * width + x;
    const end = best.bottomY * width + x;
    const upper = Math.max(luma[start - width], luma[start], luma[start + width]);
    const lower = Math.max(luma[end - width], luma[end], luma[end + width]);
    const inside = luma[start + pad * width] + luma[end - pad * width];
    const score = Math.min(upper, lower) - inside;
    if (score > farScore && upper > 27 && lower > 27) {
      farScore = score;
      far = x;
    }
  }
  const box = { x: best.x, y: best.y, width: far - best.x, height: best.bottomY - best.y + 1 };
  return {
    ...box,
    anchor: { x: best.x - 1, y: best.y },
    price: {
      x: best.x + Math.round(pitch * 0.2),
      y: best.y + Math.round(pitch * 0.47),
      width: box.width - Math.round(pitch * 0.32),
      height: Math.round(pitch * 0.4),
    },
    confidence: Math.min(0.99, best.score / 440),
  };
}

function containsPoint(rect, x, y) {
  return rect && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function cellAppearance(image, x, y, pitch, tooltip) {
  const { luma, width } = image;
  const values = [];
  let occluded = 0;
  for (let row = Math.ceil(y + pitch * 0.16); row < y + pitch * 0.84; row += 2) {
    for (let col = Math.ceil(x + pitch * 0.16); col < x + pitch * 0.84; col += 2) {
      if (containsPoint(tooltip, col, row)) occluded++;
      else values.push(luma[row * width + col]);
    }
  }
  values.sort((left, right) => left - right);
  const fill = values[Math.floor(values.length * 0.5)] ?? 0;
  const light = values[Math.floor(values.length * 0.91)] ?? 0;
  return { fill, light, occluded: occluded > values.length };
}

function seamStrength(image, x, y, pitch, vertical, tooltip) {
  const { luma, width } = image;
  const across = vertical ? 1 : width;
  const margin = Math.max(2, Math.round(pitch / 12));
  const support = new Uint8Array(5);
  let count = 0;
  for (let t = Math.round(pitch * 0.18); t < pitch * 0.83; t += 2) {
    const col = Math.round(x) + (vertical ? 0 : t);
    const row = Math.round(y) + (vertical ? t : 0);
    if (containsPoint(tooltip, col, row)) continue;
    const at = row * width + col;
    const delta = margin * across;
    for (let shift = -2; shift <= 2; shift++) {
      if (ridge(luma, at + shift * across, delta) >= (pitch >= 29 ? 7 : 5)) support[shift + 2]++;
    }
    count++;
  }
  return count >= 3 ? Math.max(...support) / count : 1;
}

function detectSlots(image, grid, tooltip) {
  const { x, y, pitch, rows } = grid;
  const cells = Array.from({ length: rows * COLUMNS }, (_, id) =>
    cellAppearance(image, x + (id % COLUMNS) * pitch, y + Math.floor(id / COLUMNS) * pitch, pitch, tooltip));
  const fills = cells.filter(cell => !cell.occluded).map(cell => cell.fill).sort((a, b) => a - b);
  const background = fills[Math.floor(fills.length * 0.14)] ?? 0;
  const minimumFill = Math.max(3, Math.min(7, background + 3));
  const contents = cells.map(cell => !cell.occluded && cell.fill >= minimumFill && cell.fill < 78 &&
    (cell.light - cell.fill >= 7 || cell.fill >= background + Math.max(4, background * 0.27)));

  const parent = cells.map((_, id) => id);
  const root = id => {
    while (parent[id] !== id) id = parent[id];
    return id;
  };
  const merge = (id, adjacent, col, row, vertical) => {
    const a = cells[id];
    const b = cells[adjacent];
    if (a.fill < minimumFill || b.fill < minimumFill || a.fill > 78 || b.fill > 78 || Math.abs(a.fill - b.fill) > 10) return;
    const seam = seamStrength(image, x + col * pitch, y + row * pitch, pitch, vertical, tooltip);
    if (seam < 0.38) parent[root(adjacent)] = root(id);
  };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      const id = row * COLUMNS + col;
      if (col + 1 < COLUMNS) merge(id, id + 1, col + 1, row, true);
      if (row + 1 < rows) merge(id, id + COLUMNS, col, row + 1, false);
    }
  }

  const components = new Map();
  for (let id = 0; id < cells.length; id++) {
    const key = root(id);
    if (!components.has(key)) components.set(key, []);
    components.get(key).push(id);
  }
  const slots = [];
  for (const ids of components.values()) {
    if (!ids.some(id => contents[id])) continue;
    const columns = ids.map(id => id % COLUMNS);
    const indices = ids.map(id => Math.floor(id / COLUMNS));
    const col = Math.min(...columns);
    const row = Math.min(...indices);
    const w = Math.max(...columns) - col + 1;
    const h = Math.max(...indices) - row + 1;
    // An uncertain seam may create a non-rectangular component. Only offer
    // individual cells with visible cargo evidence in that case.
    if (w > 4 || h > 5 || ids.length !== w * h) {
      for (const id of ids) {
        if (!contents[id]) continue;
        const cellCol = id % COLUMNS;
        const cellRow = Math.floor(id / COLUMNS);
        slots.push({ id: `${cellCol}:${cellRow}`, col: cellCol, row: cellRow, w: 1, h: 1 });
      }
    } else {
      slots.push({ id: `${col}:${row}`, col, row, w, h });
    }
  }
  return slots.sort((left, right) => left.row - right.row || left.col - right.col);
}

function highlightedSlot(image, grid, tooltip, col, row) {
  const { x, y, pitch, rows } = grid;
  if (col < 0 || col >= COLUMNS || row < 0 || row >= rows) return null;
  const origin = row * COLUMNS + col;
  const radius = 3;
  const nearby = new Map();
  for (let r = Math.max(0, row - radius); r < Math.min(rows, row + radius + 1); r++) {
    for (let c = Math.max(0, col - radius); c < Math.min(COLUMNS, col + radius + 1); c++) {
      nearby.set(r * COLUMNS + c, cellAppearance(image, x + c * pitch, y + r * pitch, pitch, tooltip));
    }
  }
  const fill = nearby.get(origin).fill;
  const unmasked = [...nearby.values()].filter(cell => !cell.occluded).map(cell => cell.fill).sort((a, b) => a - b);
  const ordinary = unmasked[Math.floor(unmasked.length / 2)] ?? 0;
  if (fill < 13 || fill < ordinary + 7) return null;

  const region = new Set([origin]);
  for (const cell of region) {
    const c = cell % COLUMNS;
    const adjacent = [cell - COLUMNS, cell + COLUMNS];
    if (c > 0) adjacent.push(cell - 1);
    if (c < COLUMNS - 1) adjacent.push(cell + 1);
    for (const id of adjacent) {
      const candidate = nearby.get(id);
      if (candidate && Math.abs(candidate.fill - fill) <= 4) region.add(id);
    }
  }
  if (region.size < 2) return null;
  const columns = [...region].map(id => id % COLUMNS);
  const rowIndices = [...region].map(id => Math.floor(id / COLUMNS));
  const left = Math.min(...columns);
  const top = Math.min(...rowIndices);
  const w = Math.max(...columns) - left + 1;
  const h = Math.max(...rowIndices) - top + 1;
  if (w > 4 || h > 4 || region.size < w * h * 0.6) return null;
  for (let r = top; r < top + h; r++) {
    for (let c = left; c < left + w; c++) {
      const id = r * COLUMNS + c;
      if (!region.has(id) && !nearby.get(id)?.occluded) return null;
    }
  }
  return { id: `${left}:${top}`, col: left, row: top, w, h };
}

function activeAt(image, grid, tooltip, previous) {
  if (!tooltip) return null;
  const col = Math.floor((tooltip.anchor.x - grid.x) / grid.pitch);
  const row = Math.floor((tooltip.anchor.y - grid.y) / grid.pitch);
  const contains = slot => col >= slot.col && col < slot.col + slot.w &&
    row >= slot.row && row < slot.row + slot.h;
  const stable = previous && Math.abs(previous.x - grid.x) < 2 &&
    Math.abs(previous.y - grid.y) < 2 && Math.abs(previous.pitch - grid.pitch) < 0.5;
  const current = grid.slots?.find(contains);
  const prior = stable ? previous.activeSlot : null;
  const sameHover = prior && contains(prior) && Math.hypot(
    prior.anchor.x - tooltip.anchor.x, prior.anchor.y - tooltip.anchor.y,
  ) < grid.pitch * 0.7;
  const recent = stable && !previous.tooltip ? previous.slots?.find(contains) : null;
  const sameOrigin = current && recent && current.col === recent.col && current.row === recent.row;
  const base = sameHover ? prior : sameOrigin && recent.w * recent.h > current.w * current.h
    ? recent : current ?? recent;
  const highlighted = highlightedSlot(image, grid, tooltip, col, row);
  const slot = highlighted && (!base || highlighted.w * highlighted.h > base.w * base.h) ? highlighted : base;
  return slot ? { ...slot, anchor: tooltip.anchor, tooltip, confidence: tooltip.confidence } : null;
}

/**
 * Detect the nine-column ABI merchant panel in an RGBA video frame. Row IDs
 * are relative to the visible lattice and can change after scrolling.
 */
export function detectMerchantGrid(frame, previous) {
  const image = pixels(frame);
  if (!image) return null;
  const horizontal = findHorizontalAxis(image, previous);
  if (!horizontal) return null;
  const vertical = findVerticalAxis(image, horizontal);
  if (!vertical) return null;
  const grid = {
    x: horizontal.x,
    y: vertical.y,
    pitch: horizontal.pitch,
    columns: COLUMNS,
    rows: vertical.rows,
    confidence: Math.min(0.99, (horizontal.score + vertical.score) / 23),
  };
  grid.tooltip = findTooltip(image, grid);
  grid.slots = detectSlots(image, grid, grid.tooltip);
  grid.activeSlot = activeAt(image, grid, grid.tooltip, previous);
  if (grid.activeSlot && !grid.slots.some(slot => slot.id === grid.activeSlot.id && slot.w === grid.activeSlot.w &&
      slot.h === grid.activeSlot.h)) {
    const { id, col, row, w, h } = grid.activeSlot;
    grid.slots = grid.slots.filter(slot =>
      slot.col + slot.w <= col || slot.col >= col + w || slot.row + slot.h <= row || slot.row >= row + h);
    grid.slots.push({ id, col, row, w, h });
    grid.slots.sort((left, right) => left.row - right.row || left.col - right.col);
  }
  return grid;
}

/** Return the visibly hovered slot and its tooltip crop, when detected. */
export function detectHoveredSlot(frame, grid) {
  if (!grid) return null;
  const image = pixels(frame);
  return image ? activeAt(image, grid, findTooltip(image, grid), grid) : null;
}

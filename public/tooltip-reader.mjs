const cdn = 'https://cdn.jsdelivr.net';
const runtime = `${cdn}/npm/tesseract.js@6.0.1/dist`;
const scriptIntegrity = 'sha384-r1ru3tcf6FhnCFR4B7pIFG+BhFF9LlFtz/P1y4pblWn3AGs9y3lBx5SKLNf4+rED';
const initializeMs = 25_000;
const recognizeMs = 5_000;
const multipliers = [100, 90, 80];

const russianCargoNames = new Map([
  ['Flammables', ['горючие материалы', 'горючие вещества']],
  ['Building Materials', ['стройматериалы', 'строительные материалы']],
  ['Computer Parts', ['детали компьютеров', 'компьютерные детали']],
  ['Energy Items', ['энергетические предметы', 'источники питания']],
  ['Tools', ['инструменты']],
  ['Household Items', ['бытовые предметы', 'бытовые товары']],
  ['Medical Supplies', ['медикаменты', 'медицинские припасы']],
  ['Rare Medical Supplies', ['редкие медикаменты', 'редкие медицинские припасы']],
  ['Collectibles', ['коллекционные предметы']],
  ['Uncommon Collectibles', ['необычные коллекционные предметы']],
  ['Rare Collectibles', ['редкие коллекционные предметы']],
  ['Paper', ['бумага']],
  ['Instruments', ['приборы']],
  ['Military Items', ['военные предметы', 'военные припасы']],
  ['Uncommon Military Items', ['необычные военные предметы', 'необычные военные припасы']],
  ['Electronics', ['электроника']],
  ['Mystery Cargo', ['таинственный груз', 'загадочный груз']],
  ['Uncommon Mystery Cargo', ['необычный таинственный груз', 'необычный загадочный груз']],
  ['Rare Mystery Cargo', ['редкий таинственный груз', 'редкий загадочный груз']],
]);

let runtimePromise;

function loadRuntime() {
  runtimePromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${runtime}/tesseract.min.js`;
    script.integrity = scriptIntegrity;
    script.crossOrigin = 'anonymous';
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error('OCR runtime download timed out.'));
    }, initializeMs);
    script.onload = () => {
      clearTimeout(timer);
      if (globalThis.Tesseract?.createWorker) resolve(globalThis.Tesseract);
      else reject(new Error('OCR runtime did not expose a worker.'));
    };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error('OCR runtime could not be loaded.'));
    };
    document.head.append(script);
  }).catch(error => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

function withDeadline(work, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('OCR exceeded its time budget.')), milliseconds);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function normalized(value) {
  return String(value).normalize('NFKC').toLowerCase().replaceAll('ё', 'е')
    .replace(/[^\p{L}\d]+/gu, ' ').trim();
}

function oneEditApart(left, right) {
  if (Math.min(left.length, right.length) < 5 || Math.abs(left.length - right.length) > 1) return false;
  if (left.length > right.length) [left, right] = [right, left];
  let index = 0;
  while (index < left.length && left[index] === right[index]) index += 1;
  return left.length === right.length
    ? left.slice(index + 1) === right.slice(index + 1)
    : left.slice(index) === right.slice(index + 1);
}

function phraseScore(words, label) {
  for (let start = 0; start <= words.length - label.length; start += 1) {
    let edits = 0;
    let exact = 0;
    for (let offset = 0; offset < label.length; offset += 1) {
      const actual = words[start + offset];
      if (actual === label[offset]) exact += 1;
      else if (oneEditApart(actual, label[offset])) edits += 1;
      else edits += 3;
    }
    if (edits <= 2 && exact > 0) return label.length * 20 + label.join(' ').length - edits * 5;
  }
  return 0;
}

function cargoMatches(lines, cargoTypes) {
  const names = cargoTypes.flatMap(({ id, name, aliases = [] }) => {
    return [name, ...aliases, ...(russianCargoNames.get(name) ?? [])]
      .filter(Boolean).map(label => ({ id, label: normalized(label).split(' ') }));
  });
  return lines.flatMap((line, index) => {
    const words = normalized(line).split(' ');
    const matches = names.map(({ id, label }) => ({ id, score: phraseScore(words, label) }))
      .filter(match => match.score).sort((left, right) => right.score - left.score);
    const best = matches[0];
    if (!best || matches.some(match => match.id !== best.id && match.score === best.score)) return [];
    return [{ id: best.id, index }];
  });
}

function plausiblePrices(prices) {
  const amounts = new Map();
  for (const base of prices) {
    if (!Number.isSafeInteger(base) || base < 1_000) continue;
    for (const multiplier of multipliers) {
      const paid = Math.floor(base * multiplier / 100);
      if (!amounts.has(paid)) amounts.set(paid, new Set());
      amounts.get(paid).add(base);
    }
  }
  return amounts;
}

/** Convert recognized text into a catalog-backed asking price and optional cargo type. */
export function parseTooltipText(value, { prices = [], cargoTypes = [] } = {}) {
  const text = String(value ?? '').trim();
  const allowed = plausiblePrices(prices);
  if (!text || !allowed.size) return null;

  const lines = text.normalize('NFKC').split(/\r?\n/).filter(line => line.trim());
  const names = cargoMatches(lines, cargoTypes);
  const digits = Math.max(...Array.from(allowed.keys(), amount => String(amount).length));
  const groups = Math.max(1, Math.floor((digits - 1) / 3));
  const amounts = new RegExp(`(?<![\\d])(?:\\d{1,3}(?:[ .,‘’'\\u00a0\\u202f]+\\d{3}){1,${groups}}|\\d{4,${digits}})(?!\\d)`, 'gu');
  const cart = /\b(?:add to cart|in cart|buy)\b|(?:в\s*корзину|купить)/iu;
  const currency = /\b(?:price|koen)\b|(?:цен[аыуе]|стоимость|коэн|коен)|[₭₽]/iu;
  const candidates = lines.flatMap((line, lineIndex) => {
    const near = names.filter(name => Math.abs(name.index - lineIndex) <= 2)
      .sort((left, right) => Math.abs(left.index - lineIndex) - Math.abs(right.index - lineIndex));
    const [name, alternate] = near;
    const distance = name ? Math.abs(name.index - lineIndex) : Infinity;
    const ambiguous = alternate && alternate.id !== name.id && Math.abs(alternate.index - lineIndex) === distance;
    const cargo = ambiguous ? null : name?.id ?? null;
    const score = (cargo !== null ? 7 - distance * 2 : 0)
      + (currency.test(line) ? 5 : 0)
      + (cart.test(lines[lineIndex + 1] ?? '') ? 4 : 0)
      + (line.match(/\p{L}/gu)?.length > 4 ? 0 : 2);
    return Array.from(line.matchAll(amounts), match => ({
      asking: Number(match[0].replace(/\D/gu, '')), cargo, lineIndex, score,
    })).filter(candidate => allowed.has(candidate.asking));
  });

  for (const candidate of candidates) {
    const oldPriceVisible = candidates.some(other => other.asking > candidate.asking
      && Math.abs(other.lineIndex - candidate.lineIndex) <= 1
      && other.cargo === candidate.cargo && allowed.get(candidate.asking).has(other.asking));
    if (oldPriceVisible) candidate.score += 4;
  }
  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  if (!best || candidates.some(other => other.score === best.score && other.asking !== best.asking)) return null;
  return { asking: best.asking, cargo: best.cargo, text };
}

function clampRegion(region, width, height) {
  const x = Math.max(0, Math.floor(region.x));
  const y = Math.max(0, Math.floor(region.y));
  const right = Math.min(width, Math.ceil(region.x + region.width));
  const bottom = Math.min(height, Math.ceil(region.y + region.height));
  if (right - x < 20 || bottom - y < 15) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function regionsFor(frame, anchor) {
  const { width, height } = frame;
  if (anchor && Number.isFinite(anchor.width) && Number.isFinite(anchor.height)) {
    return [anchor];
  }
  if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
    const span = width * 0.25;
    const y = anchor.y - height * 0.045;
    const scanHeight = height * 0.20;
    const right = { x: anchor.x - 7, y, width: span, height: scanHeight };
    const left = { x: anchor.x - span + 7, y, width: span, height: scanHeight };
    return width - anchor.x >= width * 0.14 ? [right, left] : [left, right];
  }
  return [{ x: width * 0.55, y: height * 0.19, width: width * 0.44, height: height * 0.66 }];
}

function frameCanvas(frame) {
  if (!frame?.width || !frame?.height) return null;
  if (!frame.data) return frame;
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const pixels = frame instanceof ImageData ? frame : new ImageData(
    new Uint8ClampedArray(frame.data), frame.width, frame.height,
  );
  canvas.getContext('2d').putImageData(pixels, 0, 0);
  return canvas;
}

function snapshot(frame, region) {
  const scale = Math.min(3, 1300 / region.width, 900 / region.height);
  const output = document.createElement('canvas');
  output.width = Math.ceil(region.width * scale) + 16;
  output.height = Math.ceil(region.height * scale) + 16;
  const context = output.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, output.width, output.height);
  context.filter = 'grayscale(1) invert(1)';
  context.drawImage(frame, region.x, region.y, region.width, region.height, 8, 8,
    region.width * scale, region.height * scale);
  return output;
}

/** Create one lazy, local OCR reader per listening session. */
export function createTooltipReader() {
  let worker;
  let pending;
  let busy = false;
  let closed = false;

  function getWorker() {
    if (worker) return Promise.resolve(worker);
    pending ??= (async () => {
      const tesseract = await loadRuntime();
      if (closed) return null;
      const instance = await tesseract.createWorker(['eng', 'rus'], 1, {
        workerPath: `${runtime}/worker.min.js`,
        corePath: `${cdn}/npm/tesseract.js-core@6.0.0`,
        langPath: `${cdn}/gh/tesseract-ocr/tessdata_fast@4.1.0`,
        gzip: false,
        cachePath: 'cargo-signal-fast-4.1.0',
        errorHandler() {},
      });
      if (closed) {
        await instance.terminate();
        return null;
      }
      worker = instance;
      return instance;
    })().finally(() => { pending = undefined; });
    return pending;
  }

  async function close() {
    closed = true;
    const instance = worker;
    worker = undefined;
    if (instance) await instance.terminate();
  }

  async function read(frame, anchor, options = {}) {
    if (closed || busy || !frame?.width || !frame?.height || !options.prices?.length) return null;
    busy = true;
    try {
      const input = frameCanvas(frame);
      const regions = regionsFor(input, options.region ?? anchor);
      const images = regions.map(region => clampRegion(region, input.width, input.height))
        .filter(Boolean).map(region => snapshot(input, region));
      if (!images.length) return null;
      const instance = await withDeadline(getWorker(), initializeMs);
      if (!instance || closed) return null;
      try {
        return await withDeadline((async () => {
          for (const image of images) {
            if (closed) return null;
            const result = await instance.recognize(image, {
              tessedit_pageseg_mode: '11',
              user_defined_dpi: '160',
            });
            if (closed) return null;
            const match = parseTooltipText(result.data.text, options);
            if (match) return match;
          }
          return null;
        })(), recognizeMs);
      } catch (error) {
        if (worker === instance) {
          worker = undefined;
          await instance.terminate();
        }
        throw error;
      }
    } catch (error) {
      if (!closed) options.onError?.(error);
      return null;
    } finally {
      busy = false;
    }
  }

  return { read, close };
}

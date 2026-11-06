const SAMPLE_RATE = 16000;
const WINDOW_SIZE = 512;
const HOP_SIZE = 160;
const BAND_COUNT = 28;
const FRAME_SIZE = BAND_COUNT + 1;
const FEATURE_VERSION = 1;
const MAX_INPUT_SECONDS = 8;
const MAX_FRAMES = 160;
const MIN_SCORE = 0.89;

const hann = Float32Array.from({ length: WINDOW_SIZE }, (_, i) =>
  0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WINDOW_SIZE - 1)));
const cosines = Float32Array.from({ length: WINDOW_SIZE / 2 }, (_, i) =>
  Math.cos(2 * Math.PI * i / WINDOW_SIZE));
const sines = Float32Array.from({ length: WINDOW_SIZE / 2 }, (_, i) =>
  -Math.sin(2 * Math.PI * i / WINDOW_SIZE));
const bitReversed = Uint16Array.from({ length: WINDOW_SIZE }, (_, i) => {
  let index = i;
  let reversed = 0;
  for (let count = WINDOW_SIZE; count > 1; count >>= 1) {
    reversed = (reversed << 1) | (index & 1);
    index >>= 1;
  }
  return reversed;
});

// Adjacent frequency bins contribute smoothly to neighboring perceptual bands.
const bandPositions = Float32Array.from({ length: WINDOW_SIZE / 2 }, (_, i) => {
  const frequency = i * SAMPLE_RATE / WINDOW_SIZE;
  return (BAND_COUNT - 1) * Math.log1p(frequency / 450) /
    Math.log1p(SAMPLE_RATE / 2 / 450);
});

function resample(samples, inputRate) {
  const inputLength = Math.min(samples.length, inputRate * MAX_INPUT_SECONDS);
  const step = inputRate / SAMPLE_RATE;
  const result = new Float32Array(Math.floor(inputLength / step));
  for (let i = 0; i < result.length; i++) {
    const start = i * step;
    const end = Math.min(inputLength, start + step);
    let sum = 0;
    for (let j = Math.floor(start); j < end; j++) {
      const width = Math.min(end, j + 1) - Math.max(start, j);
      sum += width * (Number.isFinite(samples[j]) ? samples[j] : 0);
    }
    result[i] = sum / (end - start);
  }
  return result;
}

function transform(real, imaginary) {
  for (let size = 2; size <= WINDOW_SIZE; size *= 2) {
    const half = size / 2;
    const stride = WINDOW_SIZE / size;
    for (let base = 0; base < WINDOW_SIZE; base += size) {
      for (let k = 0; k < half; k++) {
        const low = base + k;
        const high = low + half;
        const cosine = cosines[k * stride];
        const sine = sines[k * stride];
        const r = real[high] * cosine - imaginary[high] * sine;
        const n = real[high] * sine + imaginary[high] * cosine;
        real[high] = real[low] - r;
        imaginary[high] = imaginary[low] - n;
        real[low] += r;
        imaginary[low] += n;
      }
    }
  }
}

function frameSpectrum(signal, frame, real, imaginary, bands) {
  const offset = frame * HOP_SIZE - WINDOW_SIZE / 2;
  let mean = 0;
  for (let i = 0; i < WINDOW_SIZE; i++) mean += signal[offset + i] ?? 0;
  mean /= WINDOW_SIZE;
  imaginary.fill(0);
  for (let i = 0; i < WINDOW_SIZE; i++) {
    real[bitReversed[i]] = ((signal[offset + i] ?? 0) - mean) * hann[i];
  }
  transform(real, imaginary);

  bands.fill(0);
  for (let i = 2; i < real.length / 2; i++) {
    const position = bandPositions[i];
    const band = Math.floor(position);
    const blend = position - band;
    const power = real[i] ** 2 + imaginary[i] ** 2;
    bands[band] += (1 - blend) * power;
    bands[band + 1] += blend * power;
  }
}

/**
 * Convert a mono clip into a gain-normalized time/frequency signature.
 * Returns a JSON-safe array, or null when the clip has no usable sound.
 */
export function fingerprint(samples, sampleRate) {
  if (!samples || !Number.isFinite(sampleRate) || sampleRate < 4000 ||
      sampleRate > 384000 || samples.length < sampleRate * 0.045) return null;

  const signal = resample(samples, sampleRate);
  const frameCount = Math.ceil(signal.length / HOP_SIZE);
  const levels = new Float32Array(frameCount);
  let peak = 0;
  let peakFrame = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * HOP_SIZE - WINDOW_SIZE / 2;
    let power = 0;
    let mean = 0;
    for (let i = 0; i < WINDOW_SIZE; i++) {
      const value = signal[start + i] ?? 0;
      mean += value;
      power += value * value;
    }
    const level = Math.sqrt(Math.max(0, power / WINDOW_SIZE - (mean / WINDOW_SIZE) ** 2));
    levels[frame] = level;
    if (level > peak) {
      peak = level;
      peakFrame = frame;
    }
  }
  if (peak < 0.0002) return null;

  const sortedLevels = levels.slice().sort();
  const noiseFloor = Math.min(peak * 0.17, sortedLevels[Math.floor(frameCount * 0.2)]);
  const boundary = Math.max(peak * 0.075, noiseFloor * 1.7);
  let start = Math.max(0, peakFrame - 61);
  let end = Math.min(frameCount, start + MAX_FRAMES);
  while (start < peakFrame && levels[start] < boundary) start++;
  while (end > peakFrame + 1 && levels[end - 1] < boundary) end--;
  start = Math.max(0, start - 2);
  end = Math.min(frameCount, end + 2, start + MAX_FRAMES);

  const real = new Float32Array(WINDOW_SIZE);
  const imaginary = new Float32Array(WINDOW_SIZE);
  const bands = new Float32Array(BAND_COUNT);
  const noiseBands = new Float32Array(BAND_COUNT);
  let quietFrames = 0;
  // Estimate a stationary background from quiet frames away from the loudest part.
  for (let frame = 2; frame < frameCount - 2 && quietFrames < 12; frame += 2) {
    if (Math.abs(frame - peakFrame) < 4 || levels[frame] > noiseFloor * 1.25) continue;
    frameSpectrum(signal, frame, real, imaginary, bands);
    for (let band = 0; band < BAND_COUNT; band++) noiseBands[band] += bands[band];
    quietFrames++;
  }
  if (quietFrames) {
    for (let band = 0; band < BAND_COUNT; band++) noiseBands[band] /= quietFrames;
  }

  const features = [FEATURE_VERSION, end - start];
  for (let frame = start; frame < end; frame++) {
    frameSpectrum(signal, frame, real, imaginary, bands);
    let totalPower = 0;
    for (let band = 0; band < BAND_COUNT; band++) {
      bands[band] = Math.max(0, bands[band] - noiseBands[band]);
      totalPower += bands[band];
    }
    const relativeLevel = Math.max(0, (levels[frame] - noiseFloor) / (peak - noiseFloor));
    features.push(Math.round(255 * relativeLevel));
    for (const band of bands) {
      features.push(totalPower ? Math.round(255 * Math.sqrt(band / totalPower)) : 0);
    }
  }
  return features;
}

const preparedFeatures = new WeakMap();

function prepare(features) {
  if (!Array.isArray(features)) return null;
  if (preparedFeatures.has(features)) return preparedFeatures.get(features);
  const [version, frameCount] = features;
  if (version !== FEATURE_VERSION || !Number.isInteger(frameCount) ||
      frameCount < 1 || frameCount > MAX_FRAMES ||
      features.length !== 2 + frameCount * FRAME_SIZE) return null;

  const frames = new Float32Array(frameCount * FRAME_SIZE);
  const centroid = new Float32Array(BAND_COUNT);
  let weight = 0;
  let peakFrame = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * FRAME_SIZE;
    const energy = features[2 + offset] / 255;
    if (!Number.isFinite(energy) || energy < 0 || energy > 1) return null;
    frames[offset] = energy;
    if (energy > frames[peakFrame * FRAME_SIZE]) peakFrame = frame;
    let squaredNorm = 0;
    for (let band = 1; band < FRAME_SIZE; band++) {
      const value = features[2 + offset + band] / 255;
      if (!Number.isFinite(value) || value < 0 || value > 1) return null;
      frames[offset + band] = value;
      squaredNorm += value * value;
    }
    if (squaredNorm === 0) continue;
    const scale = Math.sqrt(energy / squaredNorm);
    for (let band = 1; band < FRAME_SIZE; band++) {
      frames[offset + band] *= scale;
      centroid[band - 1] += frames[offset + band] * Math.sqrt(energy);
    }
    weight += energy;
  }
  if (weight === 0) return null;
  const norm = Math.hypot(...centroid);
  for (let band = 0; band < BAND_COUNT; band++) centroid[band] /= norm;
  const prepared = { frameCount, frames, centroid, peakFrame, weight };
  preparedFeatures.set(features, prepared);
  return prepared;
}

function centroidSimilarity(left, right) {
  let dot = 0;
  for (let band = 0; band < BAND_COUNT; band++) dot += left[band] * right[band];
  return dot;
}

function alignedSimilarity(query, reference) {
  const peakOffset = query.peakFrame - reference.peakFrame;
  const normalization = Math.sqrt(query.weight * reference.weight);
  let best = 0;
  for (let shift = peakOffset - 11; shift <= peakOffset + 11; shift++) {
    const start = Math.max(0, -shift);
    const end = Math.min(reference.frameCount, query.frameCount - shift);
    let dot = 0;
    for (let frame = start; frame < end; frame++) {
      const source = frame * FRAME_SIZE;
      const target = (frame + shift) * FRAME_SIZE;
      for (let band = 1; band < FRAME_SIZE; band++) {
        dot += reference.frames[source + band] * query.frames[target + band];
      }
    }
    best = Math.max(best, dot / normalization);
  }
  return best;
}

/** Match a signature against immutable { id, features } templates. */
export function matchFingerprint(queryFeatures, templates) {
  const query = prepare(queryFeatures);
  if (!query) return null;

  const candidates = [];
  for (const template of templates) {
    const reference = prepare(template?.features);
    if (!reference || typeof template.id !== "string") continue;
    const coarseScore = centroidSimilarity(query.centroid, reference.centroid);
    if (coarseScore >= 0.68) candidates.push({ id: template.id, reference, coarseScore });
  }
  candidates.sort((left, right) => right.coarseScore - left.coarseScore);
  const bestById = new Map();
  for (const { id, reference, coarseScore } of candidates.slice(0, 18)) {
    const score = 0.91 * alignedSimilarity(query, reference) + 0.09 * coarseScore;
    bestById.set(id, Math.max(score, bestById.get(id) ?? 0));
  }
  const [best, second] = [...bestById].sort((left, right) => right[1] - left[1]);
  if (!best || best[1] < MIN_SCORE) return null;
  if (second && best[1] - second[1] < (best[1] >= 0.96 ? 0.008 : 0.022)) return null;
  return { id: best[0], score: Math.min(1, best[1]) };
}

import { fingerprint, matchFingerprint } from "./recognizer.mjs";

const DisplayAudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;

export async function captureGame(onAudio, onEnd) {
  if (!navigator.mediaDevices?.getDisplayMedia || !DisplayAudioContext) {
    throw new Error("unsupported");
  }
  const context = new DisplayAudioContext();
  let stream;
  let processor;
  let source;
  let mute;
  let closed = false;
  function stop() {
    if (closed) return;
    closed = true;
    if (processor) processor.onaudioprocess = null;
    for (const node of [source, processor, mute]) node?.disconnect();
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (context.state !== "closed") void context.close();
  }
  try {
    const starting = context.resume();
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 8, max: 12 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      windowAudio: "window",
      systemAudio: "include",
      selfBrowserSurface: "exclude",
    });
    await starting;
    if (stream.getAudioTracks().length === 0) throw new Error("no-audio");
    for (const track of stream.getTracks()) track.addEventListener("ended", () => {
      stop();
      onEnd();
    }, { once: true });
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(2048, 2, 1);
    mute = context.createGain();
    mute.gain.value = 0;
    processor.onaudioprocess = event => {
      const buffer = event.inputBuffer;
      const left = buffer.getChannelData(0);
      const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
      const mono = Float32Array.from(left, (sample, index) => (sample + right[index]) / 2);
      onAudio(mono, context.sampleRate);
    };
    source.connect(processor).connect(mute).connect(context.destination);
    return { stop, stream };
  } catch (error) {
    stop();
    throw error;
  }
}

export function liveDetector(templates, onLevel, onMatch) {
  let sampleRate;
  let ring;
  let cursor = 0;
  let total = 0;
  let lastCheck = 0;
  let latestGroup;
  let lastMatch = -Infinity;
  return (samples, rate) => {
    if (sampleRate !== rate) {
      sampleRate = rate;
      ring = new Float32Array(Math.ceil(rate * 1.75));
      cursor = total = lastCheck = 0;
    }
    let squared = 0;
    const peaks = new Float32Array(24);
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      ring[cursor] = sample;
      cursor = (cursor + 1) % ring.length;
      squared += sample * sample;
      const bucket = Math.floor(index * peaks.length / samples.length);
      peaks[bucket] = Math.max(peaks[bucket], Math.abs(sample));
    }
    total += samples.length;
    onLevel(Math.sqrt(squared / samples.length), peaks);
    if (total < rate * .2 || total - lastCheck < rate * .19) return;
    lastCheck = total;
    const size = Math.min(ring.length, total);
    const start = (cursor - size + ring.length) % ring.length;
    const clip = new Float32Array(size);
    if (start + size <= ring.length) clip.set(ring.subarray(start, start + size));
    else {
      clip.set(ring.subarray(start));
      clip.set(ring.subarray(0, size - ring.length + start), ring.length - start);
    }
    const match = matchFingerprint(fingerprint(clip, rate), templates);
    if (!match || (match.id === latestGroup && total - lastMatch < rate * 2.5)) return;
    latestGroup = match.id;
    lastMatch = total;
    onMatch(match);
  };
}

export async function recognizeFile(file, templates) {
  if (file.size > 30 * 1024 * 1024) throw new Error("large-file");
  if (!DisplayAudioContext) throw new Error("unsupported");
  const context = new DisplayAudioContext();
  try {
    const audio = await context.decodeAudioData(await file.arrayBuffer());
    const length = Math.min(audio.length, audio.sampleRate * 12);
    const mono = new Float32Array(length);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const data = audio.getChannelData(channel);
      for (let index = 0; index < length; index++) mono[index] += data[index] / audio.numberOfChannels;
    }
    const window = Math.ceil(audio.sampleRate * 1.75);
    const stride = Math.ceil(audio.sampleRate * .5);
    let best = matchFingerprint(fingerprint(mono, audio.sampleRate), templates);
    for (let start = 0; start + window <= length; start += stride) {
      const match = matchFingerprint(fingerprint(mono.subarray(start, start + window), audio.sampleRate), templates);
      if (match && (!best || match.score > best.score)) best = match;
    }
    return best;
  } finally {
    await context.close();
  }
}

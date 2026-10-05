// Minimal PCM WAV reader/writer for the analysis tests (16-bit / 24-bit / 32-bit int and 32-bit float).
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * @param {string} file
 * @returns {{sampleRate:number, channels:number, samples:Float32Array}} samples are downmixed to mono
 */
export function readWav(file) {
  return parseWav(readFileSync(file));
}

/** @param {Uint8Array} bytes */
export function parseWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null;
  let off = 12;
  while (off + 8 <= dv.byteLength) {
    const id = tag(off);
    let size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt');
      if (size === 0xffffffff || body + size > dv.byteLength) size = dv.byteLength - body; // streamed WAVs
      const bytesPer = fmt.bits / 8;
      const frames = Math.floor(size / (bytesPer * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let acc = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const p = body + (i * fmt.channels + c) * bytesPer;
          if (fmt.format === 3) acc += dv.getFloat32(p, true);
          else if (fmt.bits === 16) acc += dv.getInt16(p, true) / 32768;
          else if (fmt.bits === 24) acc += ((dv.getInt8(p + 2) << 16) | (dv.getUint8(p + 1) << 8) | dv.getUint8(p)) / 8388608;
          else if (fmt.bits === 32) acc += dv.getInt32(p, true) / 2147483648;
          else if (fmt.bits === 8) acc += (dv.getUint8(p) - 128) / 128;
        }
        out[i] = acc / fmt.channels;
      }
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples: out };
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

/**
 * 16-bit mono WAV bytes (used to hand synthetic audio to the browser e2e harness).
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {Uint8Array}
 */
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const put = (o, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  put(0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  put(36, 'data');
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return new Uint8Array(buf);
}

export function writeWav(file, samples, sampleRate) {
  writeFileSync(file, encodeWav(samples, sampleRate));
}

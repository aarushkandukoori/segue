// Module Worker: runs analyzeTrack off the main thread.
//   in : { id, pcm: Float32Array (transferred), sampleRate, opts }
//   out: { id, analysis } (waveform + grid-slot buffers transferred)  |  { id, error }
import { analyzeTrack } from './analyze.js';

self.onmessage = (e) => {
  const { id, pcm, sampleRate, opts } = e.data || {};
  try {
    const analysis = analyzeTrack(pcm, sampleRate, opts);
    const w = analysis.wave;
    self.postMessage({ id, analysis }, [w.low.buffer, w.mid.buffer, w.high.buffer, analysis.grid.slots.buffer]);
  } catch (err) {
    // analyzeTrack never throws; this only guards the messaging itself
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};

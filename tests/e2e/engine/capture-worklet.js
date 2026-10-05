// Test-only AudioWorklet: ships the samples flowing through it to the main thread, tagged with the
// frame they belong to. (The engine itself never needs an AudioWorklet.)
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const l = input[0].slice();
      const r = (input[1] || input[0]).slice();
      this.port.postMessage({ frame: currentFrame, l, r }, [l.buffer, r.buffer]);
    }
    return true;
  }
}
registerProcessor('capture', Capture);

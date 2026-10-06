// The clock behind js/util/timers.js: a dedicated worker whose timers post a message when they fire.
// Chrome throttles the timers of a page in a background tab (to once a minute after a while, when the tab
// is silent; measured 2026-10-06, SPEC.md §6.1) but not those of a dedicated worker, and a message from the
// worker reaches the page as an ordinary task.
'use strict';

const live = new Map();

self.onmessage = (e) => {
  const d = e.data || {};
  const id = d.id;
  if (typeof id !== 'number') return;
  const old = live.get(id);
  if (old) {
    clearTimeout(old);
    clearInterval(old);
    live.delete(id);
  }
  const ms = Math.max(0, Math.min(2147483647, Number(d.ms) || 0));
  if (d.op === 'timeout') {
    live.set(
      id,
      setTimeout(() => {
        live.delete(id);
        self.postMessage(id);
      }, ms),
    );
  } else if (d.op === 'interval') {
    live.set(
      id,
      setInterval(() => self.postMessage(id), Math.max(4, ms)),
    );
  }
  // op 'clear': already done above
};

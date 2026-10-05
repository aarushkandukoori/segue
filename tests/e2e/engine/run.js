// Browser side of the engine e2e: exposes the test groups on window.engineTests.
import timing from './t1-timing.js';
import automation from './t2-automation.js';
import fx from './t3-fx.js';
import cancel from './t4-cancel.js';
import bassSwap from './t5-bass-swap.js';
import lifecycle from './t6-lifecycle.js';
import compat from './t7-compat.js';

const groups = { timing, automation, fx, cancel, bassSwap, lifecycle, compat };
// These poke the engine in the middle of an offline render through OfflineAudioContext.suspend(),
// which Firefox does not have. There the driver leaves them out; "compat" stands in for them.
const needsSuspend = ['cancel', 'bassSwap', 'lifecycle'];
const unsupported = typeof OfflineAudioContext.prototype.suspend === 'function' ? [] : needsSuspend;
// Only run when named: they exercise the seam with another area's module, loaded on demand.
const optional = {
  plannerSmoke: async () => (await import('./x-planner-smoke.js')).default(),
};

async function run(name) {
  const fn = groups[name] || optional[name];
  if (!fn) return [{ name: `unknown group ${name}`, ok: false, detail: '' }];
  const started = performance.now();
  try {
    const results = await fn();
    results.push({ name: `(${name} ran in ${Math.round(performance.now() - started)} ms)`, ok: true, detail: '' });
    return results;
  } catch (err) {
    return [{ name: `${name} threw`, ok: false, detail: err && err.stack ? err.stack : String(err) }];
  }
}

window.engineTests = { groups: Object.keys(groups), optional: Object.keys(optional), unsupported, run };

// Manual mode: /tests/e2e/engine-harness.html?run  or  ?run=timing,fx
const q = new URLSearchParams(location.search);
if (q.has('run')) {
  const out = document.getElementById('out');
  out.textContent = '';
  const only = (q.get('run') || '').split(',').filter(Boolean);
  for (const name of only.length ? only : Object.keys(groups).filter((g) => !unsupported.includes(g))) {
    const h = document.createElement('h3');
    h.textContent = name;
    out.append(h);
    for (const r of await run(name)) {
      const line = document.createElement('div');
      line.className = r.ok ? 'ok' : 'bad';
      line.textContent = `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? '  — ' + r.detail : ''}`;
      out.append(line);
    }
  }
}

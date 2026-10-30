// Evaluation harness, loaded into the studio page (dev only): types a request into the agent chat
// like a user, waits for the turn to finish, then grades the stage with programmatic checks.
// Usage from the console: await window.__eval.run(text, { declineCosts: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setTextarea(el, value) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function run(text, { declineCosts = true, timeoutMs = 600_000 } = {}) {
  const box = document.querySelector('.ag-panel .cv-composer textarea');
  if (!box) throw new Error('No agent composer on this page.');
  setTextarea(box, text);
  await sleep(100);
  document.querySelector('.ag-panel .cv-send').click();
  const t0 = performance.now();
  let confirms = 0;
  await sleep(500);
  // Busy while the stop button (a square) is showing.
  while (document.querySelector('.ag-panel .ag-stop')) {
    const pending = [...document.querySelectorAll('.ag-confirm')].find((c) => c.querySelector('.ag-confirm-row'));
    if (pending) {
      confirms++;
      const buttons = pending.querySelectorAll('.ag-confirm-row button');
      (declineCosts ? buttons[1] : buttons[0]).click();
    }
    if (performance.now() - t0 > timeoutMs) { document.querySelector('.ag-panel .cv-send').click(); throw new Error('Timed out'); }
    await sleep(500);
  }
  const reply = [...document.querySelectorAll('.ag-panel .ag-reply')].pop()?.innerText ?? '';
  const stats = document.querySelector('.ag-panel .ag-stats')?.innerText ?? '';
  const errors = [...document.querySelectorAll('.ag-panel .ag-error')].map((e) => e.innerText);
  const tools = [...document.querySelectorAll('.ag-panel .ag-tool-name')].map((e) => e.innerText);
  return { seconds: Math.round((performance.now() - t0) / 100) / 10, stats, confirms, errors, reply };
}

window.__eval = { run };

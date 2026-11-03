// The evaluation runner, loaded into the studio page in dev (app/main.tsx). It drives the agent the way a
// creator does - a fresh World, a request typed into the chat - then scores the stage and the turn.
//
//   __eval.list()                         the tasks
//   __eval.start(['intro', 'walk'], {k})  run them in the background (k runs each); poll __eval.status()
//   __eval.report()                       the scorecard (see eval/METRICS.md)
import { TASKS } from './tasks.js';
import { cjkShare, doc, shotHealth, shotQuality } from './lib.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const t0 = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
};

function setTextarea(el, value) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A new World, opened in this page without a reload so the eval keeps running. */
async function freshWorld(tag) {
  const w = await (await fetch('/api/worlds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })).json();
  history.pushState(null, '', `/canvas/world/${w.id}`);
  dispatchEvent(new Event('director:navigate'));
  await until(() => window.__director?.host.getDoc().id === w.id && document.querySelector('.ag-panel .cv-composer textarea') && window.__stage, 30_000, 'the studio');
  await sleep(1200);
  window.__evalWorlds = [...(window.__evalWorlds ?? []), { id: w.id, tag }];
  return w.id;
}

/** One user turn: type it, wait for the agent to finish (declining any spend), read what it did. */
async function turn(text, { declineCosts = true, timeoutMs = 600_000 } = {}) {
  // An evaluation never spends credits: the agent's spend calls are made and refused (see useAgent's spendMode).
  window.__spendMode = declineCosts ? 'deny' : 'ask';
  const denied0 = window.__spendDenied ?? 0;
  const box = document.querySelector('.ag-panel .cv-composer textarea');
  setTextarea(box, text);
  await sleep(100);
  document.querySelector('.ag-panel .cv-send').click();
  const t0 = performance.now();
  let confirms = 0;
  await sleep(600);
  while (document.querySelector('.ag-panel .ag-stop')) {
    const pending = [...document.querySelectorAll('.ag-confirm')].find((c) => c.querySelector('.ag-confirm-row'));
    if (pending) {
      confirms++;
      const buttons = pending.querySelectorAll('.ag-confirm-row button');
      (declineCosts ? buttons[1] : buttons[0]).click();
    }
    if (performance.now() - t0 > timeoutMs) { document.querySelector('.ag-panel .cv-send').click(); await sleep(500); return { timedOut: true, reply: '', stats: window.__agentLast, confirms: confirms + ((window.__spendDenied ?? 0) - denied0), errors: ['timeout'] }; }
    await sleep(400);
  }
  await sleep(500);
  const reply = [...document.querySelectorAll('.ag-panel .ag-reply')].pop()?.innerText ?? '';
  const errors = [...document.querySelectorAll('.ag-panel .ag-error')].map((e) => e.innerText);
  return { reply, errors, confirms: confirms + ((window.__spendDenied ?? 0) - denied0), stats: JSON.parse(JSON.stringify(window.__agentLast ?? {})) };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Metrics that do not depend on the task: did it finish, stay in budget, and talk like a colleague. */
function generic(task, ctx) {
  const last = ctx.turns[ctx.turns.length - 1];
  const reply = last.reply;
  const calls = ctx.turns.reduce((n, t) => n + (t.stats?.toolCalls ?? 0), 0);
  const errs = ctx.turns.reduce((n, t) => n + (t.stats?.toolErrors ?? 0), 0);
  const tokens = ctx.turns.reduce((n, t) => n + (t.stats?.inputTokens ?? 0) + (t.stats?.outputTokens ?? 0), 0);
  const ms = ctx.turns.reduce((n, t) => n + (t.stats?.ms ?? 0), 0);
  const cjk = cjkShare(reply);
  const comm = {
    replied: reply.trim().length > 0,
    rightLanguage: task.lang === 'zh' ? cjk >= 0.3 : cjk <= 0.05,
    noInternals: !/\b(?:char|shot|clip|move|cut|key)_[a-z0-9]{4,}\b|\[\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?/i.test(reply),
    brief: reply.length <= 700,
  };
  const budget = task.budget;
  return {
    finished: comm.replied && !ctx.turns.some((t) => t.timedOut || t.errors.length),
    spendViolation: ctx.turns.some((t) => t.confirms > 0) && !task.allowsSpend,
    calls, toolErrors: errs, tokens, seconds: Math.round(ms / 100) / 10,
    inBudget: calls <= budget,
    efficiency: +(calls <= budget ? 1 : clamp01(1 - (calls - budget) / budget)).toFixed(2),
    comm, communication: +(Object.values(comm).filter(Boolean).length / 4).toFixed(2),
    reliability: +clamp01(1 - (errs / Math.max(1, calls)) * 2).toFixed(2),
  };
}

async function runTask(task, tag) {
  const id = await freshWorld(`${tag}:${task.id}`);
  const ctx = { turns: [], before: null, task };
  for (let i = 0; i < task.turns.length; i++) {
    if (i === 1 && task.snapshot) ctx.before = await task.snapshot.call(ctx);
    // Turn 0 of a task that revises: snapshot after turn 0 is taken just before turn 1 above.
    ctx.turns.push(await turn(task.turns[i], { declineCosts: task.declineCosts ?? true }));
    if (ctx.turns[i].timedOut) break;
  }
  let graded;
  try { graded = await task.grade.call(ctx); } catch (e) { graded = { checks: { gradingError: false }, detail: { error: String(e?.stack ?? e) } }; }
  const m = generic(task, ctx);
  const names = Object.keys(graded.checks);
  const passed = names.filter((n) => graded.checks[n]);
  const health = shotHealth();
  const checkRate = passed.length / names.length;
  const quality = shotQuality(health);
  const success = checkRate === 1 && m.finished && !m.spendViolation;
  // The headline number: correctness first, then how it looks, how it talks, what it cost.
  const score = Math.round(100 * (0.55 * checkRate + 0.2 * quality + 0.1 * m.communication + 0.1 * m.efficiency + 0.05 * m.reliability) * (m.finished ? 1 : 0.5) * (m.spendViolation ? 0.5 : 1));
  return {
    task: task.id, category: task.category, world: id, success, score, checkRate: +checkRate.toFixed(2), failed: names.filter((n) => !graded.checks[n]),
    quality, ...m, errors: ctx.turns.flatMap((t) => t.errors ?? []), checks: graded.checks, detail: graded.detail, reply: ctx.turns[ctx.turns.length - 1].reply.slice(0, 500), tools: ctx.turns.flatMap((t) => t.stats?.tools ?? []), title: doc().title,
  };
}

const state = { running: false, results: [], current: null, log: [] };

async function start(ids, { k = 1, tag = new Date().toISOString().slice(0, 16) } = {}) {
  if (state.running) throw new Error('already running');
  state.running = true;
  state.results = [];
  const tasks = ids?.length ? ids.map((id) => TASKS.find((t) => t.id === id)).filter(Boolean) : TASKS;
  (async () => {
    try {
      for (let run = 0; run < k; run++) {
        for (const task of tasks) {
          state.current = `${task.id}#${run + 1}`;
          try { state.results.push({ run: run + 1, ...(await runTask(task, tag)) }); } catch (e) { state.results.push({ run: run + 1, task: task.id, success: false, score: 0, error: String(e?.message ?? e) }); }
        }
      }
    } finally { state.running = false; state.current = null; }
  })();
  return tasks.map((t) => t.id);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The scorecard: per task and overall. Pass-rate is over whole tasks (every check), the way a creator sees it. */
function report(results = state.results) {
  const ok = results.filter((r) => !r.error);
  const byTask = {};
  for (const r of results) (byTask[r.task] ??= []).push(r);
  const tasks = Object.entries(byTask).map(([task, rs]) => ({
    task, runs: rs.length, passRate: +mean(rs.map((r) => +!!r.success)).toFixed(2), checkRate: +mean(rs.map((r) => r.checkRate ?? 0)).toFixed(2), score: Math.round(mean(rs.map((r) => r.score))),
    calls: Math.round(mean(rs.map((r) => r.calls ?? 0))), kTokens: Math.round(mean(rs.map((r) => (r.tokens ?? 0) / 1000))), seconds: Math.round(mean(rs.map((r) => r.seconds ?? 0))),
    failed: [...new Set(rs.flatMap((r) => r.failed ?? (r.error ? ['ERROR'] : [])))],
  }));
  const cats = {};
  for (const r of ok) (cats[r.category] ??= []).push(+!!r.success);
  return {
    overall: {
      runs: results.length, taskSuccessRate: +mean(results.map((r) => +!!r.success)).toFixed(3), meanCheckRate: +mean(ok.map((r) => r.checkRate)).toFixed(3), meanScore: Math.round(mean(results.map((r) => r.score))),
      quality: +mean(ok.map((r) => r.quality)).toFixed(3), communication: +mean(ok.map((r) => r.communication)).toFixed(3), finishRate: +mean(ok.map((r) => +r.finished)).toFixed(2),
      spendViolations: ok.filter((r) => r.spendViolation).length, inBudgetRate: +mean(ok.map((r) => +r.inBudget)).toFixed(2), toolErrorRate: +(ok.reduce((n, r) => n + r.toolErrors, 0) / Math.max(1, ok.reduce((n, r) => n + r.calls, 0))).toFixed(3),
      meanCalls: Math.round(mean(ok.map((r) => r.calls))), meanKTokens: Math.round(mean(ok.map((r) => r.tokens / 1000))), meanSeconds: Math.round(mean(ok.map((r) => r.seconds))),
    },
    byCategory: Object.fromEntries(Object.entries(cats).map(([c, v]) => [c, +mean(v).toFixed(2)])),
    tasks,
  };
}

window.__eval = {
  list: () => TASKS.map((t) => ({ id: t.id, category: t.category, title: t.title })),
  start, status: () => ({ running: state.running, current: state.current, done: state.results.length }),
  results: () => state.results, report,
  worlds: () => window.__evalWorlds ?? [],
};

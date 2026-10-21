import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { Limiter } from '../server/llm.mjs';
import { RunStore } from '../server/runs.mjs';
// Модуль интерфейса на TypeScript: Node 24 запускает его напрямую (снятие типов).
import { CEO_SPOTS, CORRIDOR_Y, PERSON_LIFT, cueForEvent, pathToCeo, segmentDurations } from '../src/officeMoves.ts';
import { COFFEE_GOAL } from './fixtures.mjs';

// Столы как в src/App.tsx (initialAgents): центр стола, фигурка стоит на PERSON_LIFT выше.
const DESKS = {
  ceo: { x: 165, y: 250 },
  research: { x: 500, y: 250 },
  product: { x: 835, y: 250 },
  creator: { x: 165, y: 500 },
  sales: { x: 500, y: 500 },
  finance: { x: 835, y: 500 }
};
const home = id => ({ x: DESKS[id].x, y: DESKS[id].y - PERSON_LIFT });

test('cueForEvent: план — бегут за заданием, результат и ошибка — относят CEO, final — отчёт', () => {
  const plan = { type: 'plan', seq: 3, subtasks: [{ agentId: 'research' }, { agentId: 'sales' }, { agentId: 'research' }] };
  assert.deepEqual(cueForEvent(plan), { kind: 'briefing', agentIds: ['research', 'sales'] });
  assert.deepEqual(cueForEvent({ type: 'agent-result', agentId: 'sales' }), { kind: 'deliver', agentId: 'sales', failed: false });
  assert.deepEqual(cueForEvent({ type: 'agent-error', agentId: 'finance' }), { kind: 'deliver', agentId: 'finance', failed: true });
  assert.deepEqual(cueForEvent({ type: 'final', completedAgents: ['research', 'sales'] }), { kind: 'report', agentIds: ['research', 'sales'] });
  for (const type of ['log', 'agent-status', 'agent-start', 'agent-delta', 'review-start', 'done', 'error']) {
    assert.equal(cueForEvent({ type, agentId: 'research' }), null, type);
  }
  // CEO сам к себе не бегает.
  assert.equal(cueForEvent({ type: 'agent-result', agentId: 'ceo' }), null);
  assert.equal(cueForEvent({ type: 'plan', subtasks: [] }), null);
});

test('cueForEvent: история (номер до границы) не запускает пробежки, повтор события — тоже', () => {
  const event = { type: 'agent-result', agentId: 'sales', seq: 5, at: Date.now() };
  assert.equal(cueForEvent(event, { historyUntil: 5 }), null, 'событие было на сервере до открытия страницы');
  assert.ok(cueForEvent({ ...event, seq: 6 }, { historyUntil: 5 }));
  // Часы не участвуют: давнее время, расхождение часов браузера и сервера не важны — важен номер.
  assert.ok(cueForEvent({ ...event, seq: 6, at: 0 }, { historyUntil: 5 }));
  // Без номера события приходят только из прежнего /api/execute, где всё живое.
  assert.ok(cueForEvent({ type: 'agent-result', agentId: 'sales' }, { historyUntil: 100 }));

  const seen = new Set();
  assert.ok(cueForEvent({ ...event, seq: 6 }, { seen, key: 'task:6' }));
  assert.equal(cueForEvent({ ...event, seq: 6 }, { seen, key: 'task:6' }), null, 'переподключение прислало то же событие');
  // Событие без пробежки не занимает ключ.
  cueForEvent({ type: 'log', seq: 7 }, { seen, key: 'task:7' });
  assert.equal(seen.has('task:7'), false);
});

// Прямоугольник стола (столешница и монитор) и фигурки (голова и туловище) — как в OfficeScene.
const deskBox = desk => ({ left: desk.x - 78, right: desk.x + 78, top: desk.y - 12, bottom: desk.y + 86 });
const personBox = p => ({ left: p.x - 13, right: p.x + 13, top: p.y - 4, bottom: p.y + 36 });
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test('pathToCeo: никто не пробегает сквозь чужой стол и не стоит на столе CEO', () => {
  for (const id of Object.keys(CEO_SPOTS)) {
    const start = home(id);
    const path = pathToCeo(start, CEO_SPOTS[id], Object.values(DESKS));
    assert.deepEqual(path.at(-1), CEO_SPOTS[id], `${id}: маршрут заканчивается у CEO`);
    let previous = start;
    for (const point of path) {
      const steps = Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y) / 2);
      for (let i = 0; i <= steps; i++) {
        const at = { x: previous.x + (point.x - previous.x) * i / steps, y: previous.y + (point.y - previous.y) * i / steps };
        for (const [deskId, desk] of Object.entries(DESKS)) {
          if (deskId === id) continue;
          assert.ok(!overlaps(personBox(at), deskBox(desk)), `${id} пробегает сквозь стол ${deskId} в точке ${at.x},${at.y}`);
        }
      }
      previous = point;
    }
  }
});

test('pathToCeo: соседу по ряду — напрямую, через чужой стол — по проходу', () => {
  const desks = Object.values(DESKS);
  const research = pathToCeo(home('research'), CEO_SPOTS.research, desks);
  assert.ok(research.every(point => point.y < CORRIDOR_Y), 'Luma 2 бежит по своему ряду');
  const product = pathToCeo(home('product'), CEO_SPOTS.product, desks);
  assert.ok(product.some(point => point.y === CORRIDOR_Y), 'Luma 3 обходит стол Luma 2 по проходу');
  for (const id of ['creator', 'sales', 'finance']) {
    assert.ok(pathToCeo(home(id), CEO_SPOTS[id], desks).some(point => point.y === CORRIDOR_Y), id);
  }
});

test('segmentDurations: время отрезка пропорционально длине, без нулевых отрезков', () => {
  assert.deepEqual(segmentDurations({ x: 0, y: 0 }, [{ x: 300, y: 0 }, { x: 300, y: 150 }], 300), [1000, 500]);
  assert.deepEqual(segmentDurations({ x: 0, y: 0 }, [{ x: 1, y: 0 }], 300), [60]);
});

// Настоящий журнал задачи: сервер с мок-моделью; `fail` — сотрудник, у которого модель падает.
async function serverRun(goal, { fail, delayMs = 0, midRun } = {}) {
  const config = readConfig({ OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_MODEL: 'mock' });
  const limiter = new Limiter(1);
  async function callModel(messages, opts) {
    await limiter.acquire(opts.signal, 5_000);
    try {
      opts.onStart?.();
      if (fail && opts.label.endsWith(`/${fail}`)) throw new Error('модель недоступна');
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      return { text: `ОТВЕТ ${opts.label.split('/')[1]}`, stats: { outputTokens: 2 } };
    } finally { limiter.release(); }
  }
  const runs = new RunStore();
  const server = createApp({ config, callModel, limiter, runs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal }) })).json();
    const run = runs.get(runId);
    const extra = midRun ? await midRun(base, runId, run) : undefined;
    while (run.status === 'running') await new Promise(r => setTimeout(r, 5));
    return { ...(await (await fetch(`${base}/api/runs/${runId}`)).json()), extra };
  } finally { server.closeAllConnections(); server.close(); }
}

const liveCues = (events, historyUntil = 0, seen = new Set()) =>
  events.map(event => cueForEvent(event, { historyUntil, seen, key: `t:${event.seq}` })).filter(Boolean);

// Поток событий задачи (SSE) с самого начала, как его читает страница; до завершения задачи.
async function readEvents(url) {
  const response = await fetch(url);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let at;
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const data = buffer.slice(0, at).split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      buffer = buffer.slice(at + 2);
      if (data) events.push(JSON.parse(data));
    }
    if (done) return events;
  }
}

test('задача кофейни: все пятеро бегут за заданием, относят результат, собираются на отчёт', async () => {
  const run = await serverRun(COFFEE_GOAL);
  const cues = liveCues(run.events);
  const team = ['research', 'product', 'creator', 'sales', 'finance'];
  assert.deepEqual(cues[0], { kind: 'briefing', agentIds: team });
  const delivered = cues.filter(cue => cue.kind === 'deliver');
  assert.deepEqual(delivered.map(cue => cue.agentId).sort(), [...team].sort());
  assert.ok(delivered.every(cue => !cue.failed));
  assert.equal(cues.at(-1).kind, 'report');
  assert.deepEqual([...cues.at(-1).agentIds].sort(), [...team].sort());
  // Повтор всего журнала после перезагрузки (граница = все события) пробежек не даёт.
  assert.equal(liveCues(run.events, run.events.length).length, 0);
});

test('перезагрузка посреди задачи: случившееся не повторяется, дальнейшее показывается', async () => {
  // Как страница при открытии: число событий из GET /api/runs, затем поток с начала (after=0).
  const run = await serverRun(COFFEE_GOAL, {
    delayMs: 40,
    midRun: async (base, runId, live) => {
      while (!live.events.some(e => e.type === 'agent-result')) await new Promise(r => setTimeout(r, 5));
      const { runs } = await (await fetch(`${base}/api/runs`)).json();
      const historyUntil = runs.find(r => r.id === runId).events;
      return { historyUntil, events: await readEvents(`${base}/api/runs/${runId}/events?after=0`) };
    }
  });
  const { historyUntil, events } = run.extra;
  assert.ok(historyUntil > 0 && historyUntil < events.length, 'страница открылась посреди задачи');
  const cues = liveCues(events, historyUntil);
  const shownBefore = liveCues(events.filter(e => e.seq <= historyUntil));
  assert.ok(shownBefore.some(cue => cue.kind === 'briefing'), 'распределение заданий было до перезагрузки');
  assert.ok(!cues.some(cue => cue.kind === 'briefing'), 'и после перезагрузки не повторяется');
  const deliveredBefore = shownBefore.filter(cue => cue.kind === 'deliver').map(cue => cue.agentId);
  assert.ok(deliveredBefore.length >= 1);
  const deliveredAfter = cues.filter(cue => cue.kind === 'deliver').map(cue => cue.agentId);
  assert.deepEqual([...deliveredBefore, ...deliveredAfter].sort(), ['creator', 'finance', 'product', 'research', 'sales']);
  assert.equal(cues.at(-1).kind, 'report', 'итоговый отчёт после перезагрузки показывается');
});

test('сотрудник с ошибкой сообщает CEO о неудаче и не зовётся на отчёт', async () => {
  const run = await serverRun(COFFEE_GOAL, { fail: 'finance' });
  const cues = liveCues(run.events);
  assert.deepEqual(cues.find(cue => cue.kind === 'deliver' && cue.agentId === 'finance'), { kind: 'deliver', agentId: 'finance', failed: true });
  const report = cues.at(-1);
  assert.equal(report.kind, 'report');
  assert.ok(!report.agentIds.includes('finance'));
  assert.equal(report.agentIds.length, 4);
});

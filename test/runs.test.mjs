import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { Limiter } from '../server/llm.mjs';
import { RunStore } from '../server/runs.mjs';
import { taskFromRun } from '../src/taskEvents.ts';
import { COFFEE_GOAL, COFFEE_ASSIGNMENTS } from './fixtures.mjs';

const config = readConfig({ OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_MODEL: 'mock' });

// Мок-модель: каждый вызов ждёт `delayMs` (или отмены), затем отвечает своим текстом.
function slowModel(delayMs = 30) {
  const limiter = new Limiter(1);
  const calls = [];
  async function callModel(messages, opts = {}) {
    const call = { label: opts.label, signal: opts.signal, started: false };
    calls.push(call);
    await limiter.acquire(opts.signal, 5_000);
    try {
      call.started = true;
      opts.onStart?.();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        opts.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
      const task = messages[1]?.content.match(/ТВОЁ ЗАДАНИЕ:\n(.*)/);
      return { text: `ОТВЕТ ${opts.label.split('/')[1]}: ${task ? task[1] : '—'}`, stats: { outputTokens: 5 } };
    } finally {
      limiter.release();
    }
  }
  return { callModel, limiter, calls };
}

async function startServer(model, runs) {
  const server = createApp({ config, callModel: model.callModel, limiter: model.limiter, runs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { server.closeAllConnections(); server.close(); } };
}

async function createRun(base, goal) {
  const response = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal }) });
  assert.equal(response.status, 202);
  return (await response.json()).runId;
}

/** Читает SSE-поток событий задачи; stopWhen(event) → true обрывает соединение (как закрытие вкладки). */
async function readEvents(url, { stopWhen, headers } = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal, headers });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block.split('\n').find(line => line.startsWith('data:'));
        if (!data) continue;
        const event = JSON.parse(data.slice(5));
        events.push(event);
        if (stopWhen?.(event)) { controller.abort(); return events; }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
  return events;
}

const waitFor = async (check, ms = 3_000) => {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > ms) throw new Error('не дождались');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('задача переживает закрытие вкладки: после переподключения видны все события и итог', async () => {
  const model = slowModel(30);
  const runs = new RunStore();
  const { base, close } = await startServer(model, runs);
  try {
    const runId = await createRun(base, COFFEE_GOAL);
    // «Вкладка» закрывается сразу после первого старта сотрудника.
    const first = await readEvents(`${base}/api/runs/${runId}/events`, { stopWhen: e => e.type === 'agent-start' });
    assert.equal(first.at(-1).type, 'agent-start');
    await waitFor(() => runs.get(runId).status === 'done');
    assert.ok(model.calls.every(c => !c.signal.aborted), 'закрытие вкладки не отменяет модель');
    assert.equal(model.calls.filter(c => c.started).length, 5);

    // «Перезагрузка страницы»: полный повтор с начала.
    const replay = await readEvents(`${base}/api/runs/${runId}/events?after=0`);
    assert.deepEqual(replay.map(e => e.seq), replay.map((_, i) => i + 1), 'seq идут подряд без пропусков');
    const results = replay.filter(e => e.type === 'agent-result');
    assert.deepEqual(results.map(e => e.agentId).sort(), Object.keys(COFFEE_ASSIGNMENTS).sort());
    for (const event of results) assert.equal(event.result, `ОТВЕТ ${event.agentId}: ${COFFEE_ASSIGNMENTS[event.agentId]}`);
    assert.equal(replay.at(-1).type, 'done');
    assert.ok(replay.every(e => typeof e.at === 'number'), 'у событий есть время для журнала');
  } finally { close(); }
});

test('переподключение с ?after и Last-Event-ID отдаёт только новые события', async () => {
  const model = slowModel(5);
  const runs = new RunStore();
  const { base, close } = await startServer(model, runs);
  try {
    const runId = await createRun(base, 'Придумай один слоган для кофейни');
    await waitFor(() => runs.get(runId).status === 'done');
    const total = runs.get(runId).events.length;
    const tail = await readEvents(`${base}/api/runs/${runId}/events?after=3`);
    assert.deepEqual(tail.map(e => e.seq), Array.from({ length: total - 3 }, (_, i) => i + 4));
    const byHeader = await readEvents(`${base}/api/runs/${runId}/events`, { headers: { 'last-event-id': String(total - 1) } });
    assert.deepEqual(byHeader.map(e => e.seq), [total]);
  } finally { close(); }
});

test('кнопка «Остановить»: POST /cancel отменяет модель и завершает задачу', async () => {
  const model = slowModel(5_000);
  const runs = new RunStore();
  const { base, close } = await startServer(model, runs);
  try {
    const runId = await createRun(base, COFFEE_GOAL);
    await waitFor(() => model.calls.some(c => c.started));
    const response = await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST' });
    assert.deepEqual(await response.json(), { status: 'cancelled', cancelled: true });
    await waitFor(() => model.calls.length === 5 && model.calls.every(c => c.signal.aborted));
    assert.equal(model.calls.filter(c => c.started).length, 1, 'после отмены новые вызовы не стартуют');
    const events = await readEvents(`${base}/api/runs/${runId}/events`);
    const last = events.filter(e => e.type === 'error').at(-1);
    assert.equal(last.cancelled, true);
    assert.ok(!events.some(e => e.type === 'agent-result'));
    // Повторная отмена ничего не меняет.
    assert.deepEqual(await (await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST' })).json(), { status: 'cancelled', cancelled: false });
  } finally { close(); }
});

test('история сохраняется на диск и читается после перезапуска сервера', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pixel-office-'));
  try {
    const model = slowModel(5);
    const runs = new RunStore({ dataDir, persistDelayMs: 5 });
    const { base, close } = await startServer(model, runs);
    let runId;
    try {
      runId = await createRun(base, 'Придумай один слоган для кофейни');
      await waitFor(() => runs.get(runId).status === 'done');
    } finally { close(); }
    const saved = JSON.parse(readFileSync(join(dataDir, 'runs', `${runId}.json`), 'utf8'));
    assert.equal(saved.status, 'done');
    assert.equal(saved.events.at(-1).type, 'done');
    assert.deepEqual(readdirSync(join(dataDir, 'runs')).filter(f => f.endsWith('.tmp')), []);

    // «Перезапуск»: новый RunStore из той же папки.
    const restarted = new RunStore({ dataDir });
    const second = await startServer(slowModel(5), restarted);
    try {
      const list = await (await fetch(`${second.base}/api/runs`)).json();
      assert.equal(list.runs[0].id, runId);
      const events = await readEvents(`${second.base}/api/runs/${runId}/events`);
      assert.ok(events.some(e => e.type === 'agent-result' && e.agentId === 'creator'));
      assert.equal(events.at(-1).type, 'done');
    } finally { second.close(); }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('задача, прерванная перезапуском сервера, помечается как прерванная, готовые результаты сохраняются', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pixel-office-'));
  try {
    const store = new RunStore({ dataDir });
    const run = store.create(COFFEE_GOAL);
    store.emit(run, 'agent-result', { agentId: 'research', subtaskId: 'task-research', result: 'группы' });
    store.persistNow(run);
    const restarted = new RunStore({ dataDir });
    const loaded = restarted.get(run.id);
    assert.equal(loaded.status, 'interrupted');
    assert.equal(loaded.events.find(e => e.type === 'agent-result').result, 'группы');
    const last = loaded.events.at(-1);
    assert.equal(last.type, 'error');
    assert.equal(last.interrupted, true);
    assert.match(last.message, /перезапущен/);
    // Повторная загрузка не добавляет вторую пометку.
    assert.equal(new RunStore({ dataDir }).get(run.id).events.filter(e => e.interrupted).length, 1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('перезапуск сервера после готового итога (идёт обсуждение CROSS_TALK): задача завершена, отчёт виден', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pixel-office-'));
  try {
    const store = new RunStore({ dataDir });
    const run = store.create(COFFEE_GOAL);
    store.emit(run, 'agent-result', { agentId: 'research', subtaskId: 'task-research', result: 'группы' });
    store.emit(run, 'final', { result: '## Кто выполнил задачу\n- ✅ Luma 2' });
    store.emit(run, 'agent-status', { agentId: 'research', status: 'thinking', task: 'Пишет коллеге' });
    store.persistNow(run);
    const loaded = new RunStore({ dataDir }).get(run.id);
    assert.equal(loaded.status, 'done');
    assert.ok(!loaded.events.some(e => e.type === 'error'), 'итог не заменяется сообщением о перезапуске');
    assert.equal(loaded.events.at(-1).type, 'done');
    assert.ok(loaded.events.some(e => e.type === 'log' && /перезапуск/.test(e.message)));
    const lastStatus = new Map(loaded.events.filter(e => e.type === 'agent-status').map(e => [e.agentId, e.status]));
    assert.equal(lastStatus.get('research'), 'done');
    const task = taskFromRun({ ...loaded, controller: undefined, subscribers: undefined, timer: undefined });
    assert.equal(task.status, 'done');
    assert.match(task.result, /^## Кто выполнил задачу/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('после перезапуска новые события получают номера больше прежних: переподключение с ?after видит конец задачи', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pixel-office-'));
  try {
    for (const withFinal of [true, false]) {
      const store = new RunStore({ dataDir });
      const run = store.create(COFFEE_GOAL);
      // Черновики сдавшего результат сотрудника на диск не пишутся — событий в файле меньше, чем последний номер.
      for (let i = 0; i < 5; i++) store.emit(run, 'agent-delta', { agentId: 'research', subtaskId: 'task-research', text: 'x' });
      store.emit(run, 'agent-result', { agentId: 'research', subtaskId: 'task-research', result: 'группы' });
      if (withFinal) store.emit(run, 'final', { result: 'отчёт' });
      store.emit(run, 'agent-status', { agentId: 'product', status: 'thinking', task: 'Пишет коллеге' });
      store.persistNow(run);
      const lastSeen = run.events.at(-1).seq;
      const loaded = new RunStore({ dataDir }).get(run.id);
      const seqs = loaded.events.map(e => e.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'номера по возрастанию');
      assert.equal(new Set(seqs).size, seqs.length, 'без повторов');
      const resumed = [];
      store.subscribe(loaded, lastSeen, event => resumed.push(event?.type ?? 'END'));
      assert.deepEqual(resumed.slice(-2), withFinal ? ['done', 'END'] : ['error', 'END']);
      store.flush();
    }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('итог (final) сразу пишется на диск: перезапуск сразу после него не теряет отчёт', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pixel-office-'));
  try {
    const store = new RunStore({ dataDir, persistDelayMs: 60_000 });
    const run = store.create(COFFEE_GOAL);
    store.emit(run, 'agent-result', { agentId: 'research', subtaskId: 'task-research', result: 'группы' });
    store.emit(run, 'final', { result: 'отчёт' });
    const loaded = new RunStore({ dataDir }).get(run.id);
    assert.equal(loaded.status, 'done');
    assert.equal(loaded.events.find(e => e.type === 'final')?.result, 'отчёт');
    store.flush();
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('хранятся только последние N задач, повреждённый файл не ломает запуск', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pixel-office-'));
  try {
    const store = new RunStore({ dataDir, keep: 3 });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const run = store.create(`задача ${i}`);
      run.createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      store.emit(run, 'done', {});
      ids.push(run.id);
    }
    store.prune();
    assert.equal(store.list().length, 3);
    assert.deepEqual(readdirSync(join(dataDir, 'runs')).length, 3);
    writeFileSync(join(dataDir, 'runs', 'broken.json'), '{не json');
    assert.equal(new RunStore({ dataDir, keep: 3 }).list().length, 3);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('неизвестная задача → 404, пустая цель → 400', async () => {
  const { base, close } = await startServer(slowModel(5), new RunStore());
  try {
    assert.equal((await fetch(`${base}/api/runs/nope/events`)).status, 404);
    assert.equal((await fetch(`${base}/api/runs/nope/cancel`, { method: 'POST' })).status, 404);
    const bad = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"goal":"  "}' });
    assert.equal(bad.status, 400);
  } finally { close(); }
});

test('на диск черновики agent-delta пишутся, пока сотрудник не сдал результат', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pixel-office-'));
  try {
    const store = new RunStore({ dataDir });
    const run = store.create(COFFEE_GOAL);
    store.emit(run, 'agent-delta', { agentId: 'creator', subtaskId: 'task-creator', text: 'Сло' });
    store.emit(run, 'agent-delta', { agentId: 'finance', subtaskId: 'task-finance', text: '90' });
    store.emit(run, 'agent-delta', { agentId: 'creator', subtaskId: 'task-creator', text: 'ган' });
    store.emit(run, 'agent-result', { agentId: 'creator', subtaskId: 'task-creator', result: 'Слоган' });
    store.persistNow(run);
    const saved = JSON.parse(readFileSync(join(dataDir, 'runs', `${run.id}.json`), 'utf8'));
    const deltas = saved.events.filter(e => e.type === 'agent-delta');
    assert.deepEqual(deltas.map(e => e.agentId), ['finance'], 'черновик ещё пишущего сотрудника сохраняется');
    assert.equal(saved.events.find(e => e.type === 'agent-result').result, 'Слоган');
    assert.equal(run.events.filter(e => e.type === 'agent-delta').length, 3, 'в памяти журнал полный');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('DELETE /api/runs/:id: завершённая удаляется с диска, идущая — 409', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pixel-office-'));
  try {
    const model = slowModel(5_000);
    const runs = new RunStore({ dataDir });
    const { base, close } = await startServer(model, runs);
    try {
      const runId = await createRun(base, 'Придумай один слоган для кофейни');
      await waitFor(() => model.calls.some(c => c.started));
      assert.equal((await fetch(`${base}/api/runs/${runId}`, { method: 'DELETE' })).status, 409);
      await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST' });
      const response = await fetch(`${base}/api/runs/${runId}`, { method: 'DELETE' });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { deleted: true });
      assert.deepEqual(readdirSync(join(dataDir, 'runs')), []);
      assert.deepEqual((await (await fetch(`${base}/api/runs`)).json()).runs, []);
      assert.equal((await fetch(`${base}/api/runs/${runId}`, { method: 'DELETE' })).status, 404);
    } finally { close(); }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

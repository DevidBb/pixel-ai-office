import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { Limiter } from '../server/llm.mjs';
import { RunStore } from '../server/runs.mjs';
// Модуль интерфейса на TypeScript: Node 24 запускает его напрямую (снятие типов).
import { reduceTask, taskFromRun, mergeHistory, sortTasks, resetTask } from '../src/taskEvents.ts';
import { COFFEE_GOAL, COFFEE_ASSIGNMENTS } from './fixtures.mjs';

const config = readConfig({ OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_MODEL: 'mock' });

function model(delayMs = 5) {
  const limiter = new Limiter(1);
  async function callModel(messages, opts) {
    await limiter.acquire(opts.signal, 5_000);
    try {
      opts.onStart?.();
      const task = messages[1].content.match(/ТВОЁ ЗАДАНИЕ:\n(.*)/);
      const text = `ОТВЕТ ${opts.label.split('/')[1]}: ${task ? task[1] : '—'}`;
      opts.onToken?.(text.slice(0, 5));
      opts.onToken?.(text.slice(5));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        opts.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
      return { text, stats: { outputTokens: 4 } };
    } finally { limiter.release(); }
  }
  return { callModel, limiter };
}

// Настоящий журнал задачи: сервер с мок-моделью → GET /api/runs/:id.
async function serverRun(goal, { cancelAfterStart = false, delayMs = 5 } = {}) {
  const runs = new RunStore();
  const m = model(delayMs);
  const server = createApp({ config, callModel: m.callModel, limiter: m.limiter, runs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal }) })).json();
    const run = runs.get(runId);
    if (cancelAfterStart) {
      while (!run.events.some(e => e.type === 'agent-start')) await new Promise(r => setTimeout(r, 5));
      await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST' });
    }
    while (run.status === 'running') await new Promise(r => setTimeout(r, 5));
    return await (await fetch(`${base}/api/runs/${runId}`)).json();
  } finally { server.closeAllConnections(); server.close(); }
}

test('taskFromRun: задача кофейни собирается из журнала сервера целиком', async () => {
  const run = await serverRun(COFFEE_GOAL);
  const task = taskFromRun(run);
  assert.equal(task.id, `run-${run.id}`);
  assert.equal(task.runId, run.id);
  assert.equal(task.title, COFFEE_GOAL);
  assert.equal(task.status, 'done');
  assert.equal(task.startedAt, run.createdAt);
  assert.match(task.createdAt, /\d{2}\.\d{2}/, 'в истории видна дата');
  assert.equal(task.subtasks.length, 5);
  for (const subtask of task.subtasks) {
    assert.equal(subtask.status, 'done');
    assert.equal(subtask.result, `ОТВЕТ ${subtask.agentId}: ${COFFEE_ASSIGNMENTS[subtask.agentId]}`);
    assert.equal(subtask.draft, undefined, 'черновик заменён результатом');
  }
  assert.match(task.result, /^## Кто выполнил задачу/);
  assert.match(task.planSummary, /CEO назначил: Luma 2/);
  assert.ok(task.logs.length >= 10);
});

test('taskFromRun: остановленная задача — ошибка с понятным текстом', async () => {
  const run = await serverRun(COFFEE_GOAL, { cancelAfterStart: true, delayMs: 5_000 });
  assert.equal(run.status, 'cancelled');
  const task = taskFromRun(run);
  assert.equal(task.status, 'error');
  assert.equal(task.result, 'Выполнение остановлено пользователем.');
});

test('taskFromRun: идущая задача остаётся «в работе» и показывает черновик', () => {
  const task = taskFromRun({
    id: 'r1', goal: 'Luma 4 — слоган', status: 'running', createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:01.000Z',
    events: [
      { seq: 1, at: 0, type: 'plan', summary: 'CEO назначил: Luma 4', subtasks: [{ id: 'task-creator', agentId: 'creator', title: 'слоган', objective: 'слоган', status: 'queued' }] },
      { seq: 2, at: 0, type: 'agent-start', agentId: 'creator', subtaskId: 'task-creator', title: 'слоган' },
      { seq: 3, at: 0, type: 'agent-delta', agentId: 'creator', subtaskId: 'task-creator', text: 'Кофе ' },
      { seq: 4, at: 0, type: 'agent-delta', agentId: 'creator', subtaskId: 'task-creator', text: 'между парами' }
    ]
  });
  assert.equal(task.status, 'working');
  assert.equal(task.subtasks[0].status, 'working');
  assert.equal(task.subtasks[0].draft, 'Кофе между парами');
});

test('taskFromRun: журнал без итогового события у завершённой задачи', () => {
  const task = taskFromRun({ id: 'r2', goal: 'x', status: 'done', createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '', events: [] });
  assert.equal(task.status, 'done');
  assert.match(task.result, /без итогового отчёта/);
});

test('reduceTask и resetTask: повтор событий с начала даёт то же состояние', async () => {
  const run = await serverRun('Придумай один слоган для кофейни');
  const once = run.events.reduce(reduceTask, resetTask({ id: 't', title: 'x', agentId: 'ceo', status: 'done', createdAt: '' }));
  const twice = run.events.reduce(reduceTask, resetTask(once));
  const strip = task => ({ ...task, logs: task.logs.map(({ id, ...rest }) => rest) });
  assert.deepEqual(strip(twice), strip(once));
});

test('mergeHistory: задачи сервера добавляются без дублей, новые сверху, не больше лимита', () => {
  const local = [
    { id: 'a', runId: 'r-a', title: 'A', agentId: 'ceo', status: 'done', createdAt: '', startedAt: '2026-10-18T10:00:00.000Z' },
    { id: 'old', title: 'старая без runId', agentId: 'ceo', status: 'done', createdAt: '' }
  ];
  const restored = [
    { id: 'run-r-a', runId: 'r-a', title: 'A с сервера', agentId: 'ceo', status: 'done', createdAt: '', startedAt: '2026-10-18T10:00:00.000Z' },
    { id: 'run-r-b', runId: 'r-b', title: 'B', agentId: 'ceo', status: 'done', createdAt: '', startedAt: '2026-10-18T12:00:00.000Z' },
    { id: 'run-r-c', runId: 'r-c', title: 'C', agentId: 'ceo', status: 'done', createdAt: '', startedAt: '2026-10-18T08:00:00.000Z' }
  ];
  const merged = mergeHistory(local, restored);
  assert.deepEqual(merged.map(t => t.id), ['run-r-b', 'a', 'run-r-c', 'old']);
  assert.equal(merged.find(t => t.runId === 'r-a').title, 'A', 'копия в браузере главнее');
  assert.equal(mergeHistory(local, restored, 2).length, 2);
  assert.deepEqual(sortTasks([{ id: 'x' }, { id: 'y', startedAt: '2026' }, { id: 'z' }]).map(t => t.id), ['y', 'x', 'z']);
});

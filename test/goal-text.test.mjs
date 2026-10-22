import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { Limiter } from '../server/llm.mjs';
import { RunStore } from '../server/runs.mjs';
import { buildPlan, normalizeGoal, routeByExplicit, routeByRules, fallbackRoute } from '../server/office.mjs';

// Задача с кодом и таблицей: отступы, табуляция, двойные пробелы и пустые строки — часть смысла.
const RAW = 'Проверь код и таблицу:\n\nif ok:\n    send()\n\nимя\t\tцена\nСравни «a  b» и «a b».';

test('buildPlan: разбор по нормализованной копии, сотруднику — исходный текст', () => {
  const parsed = normalizeGoal(RAW);
  assert.notEqual(parsed, RAW);
  const route = routeByExplicit(parsed) || routeByRules(parsed) || fallbackRoute(parsed);
  const plan = buildPlan(parsed, route, { text: RAW });
  for (const task of plan.tasks) {
    assert.ok(task.objective.includes(RAW), `${task.agentId}: задание с исходным текстом`);
    assert.equal(task.context, RAW);
  }
});

test('buildPlan: адресное поручение сотруднику — как написал пользователь, разбор — по копии', () => {
  const raw = 'Luma 4 — сравни «a  b» и «a\tb»;   Luma 2 —  рынок  кофе;\nLuma 4 — ещё  один слоган';
  const parsed = normalizeGoal(raw);
  const route = routeByExplicit(parsed);
  const plan = buildPlan(parsed, route, { text: raw });
  const task = id => plan.tasks.find(t => t.agentId === id);
  assert.equal(task('creator').objective, 'сравни «a  b» и «a\tb»; ещё  один слоган');
  assert.equal(task('research').objective, 'рынок  кофе');
  assert.equal(task('creator').exactlyOne, true, 'разбор по копии: «один слоган»');
  // Без исходного текста — разобранное поручение, как раньше
  assert.equal(buildPlan(parsed, route).tasks.find(t => t.agentId === 'creator').objective, route.assignments.creator);
});

test('сервер: в истории и в подсказке сотрудника — исходный текст задачи', async () => {
  const config = readConfig({ OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_MODEL: 'mock' });
  const limiter = new Limiter(1);
  const prompts = [];
  async function callModel(messages, opts) {
    await limiter.acquire(opts.signal, 5_000);
    try {
      opts.onStart?.();
      prompts.push(messages.map(m => m.content).join('\n'));
      return { text: 'Готово.', stats: { outputTokens: 1 } };
    } finally { limiter.release(); }
  }
  const runs = new RunStore();
  const server = createApp({ config, callModel, limiter, runs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: RAW }) })).json();
    const run = runs.get(runId);
    while (run.status === 'running') await new Promise(r => setTimeout(r, 5));
    assert.equal(run.goal, RAW);
    assert.ok(prompts.some(prompt => prompt.includes('if ok:\n    send()') && prompt.includes('имя\t\tцена') && prompt.includes('«a  b»')), 'сотрудник видит исходный текст');
  } finally { server.closeAllConnections(); server.close(); }
});

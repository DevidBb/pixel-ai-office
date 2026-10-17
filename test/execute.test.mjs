import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { Limiter } from '../server/llm.mjs';
import { COFFEE_GOAL, COFFEE_ASSIGNMENTS, SLOGAN_GOAL } from './fixtures.mjs';

const baseEnv = { OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_MODEL: 'mock' };
const autoConfig = readConfig(baseEnv);
const alwaysSummaryConfig = readConfig({ ...baseEnv, CEO_SUMMARY: 'true' });

// Мок-модель: каждый сотрудник отвечает своим уникальным текстом; можно заставить его «писать за команду».
function mockModel({ impersonator } = {}) {
  const calls = [];
  const limiter = new Limiter(1);
  async function callModel(messages, opts = {}) {
    calls.push({ label: opts.label, messages, maxTokens: opts.maxTokens });
    await limiter.acquire(opts.signal, 5_000);
    try {
      opts.onStart?.();
      await new Promise(resolve => setTimeout(resolve, 5));
      const agentId = opts.label.split('/')[1];
      if (agentId === 'ceo-summary') return { text: 'СВОДКА CEO', stats: { outputTokens: 3 } };
      if (agentId === impersonator) {
        return { text: '## Luma 2\nстуденты\n## Luma 3\nлатте\n## Luma 4\nслоган\n## Luma 6\n90 €', stats: { outputTokens: 20, doneReason: 'stop' } };
      }
      const task = messages[1].content.match(/ТВОЁ ЗАДАНИЕ:\n(.*)/);
      return { text: `ОТВЕТ ${agentId}: ${task ? task[1] : 'общая задача'}`, stats: { outputTokens: 10, tokPerSec: 6, doneReason: 'stop' } };
    } finally {
      limiter.release();
    }
  }
  return { callModel, calls, limiter };
}

async function execute(goal, model, config = autoConfig) {
  const server = createApp({ config, callModel: model.callModel, limiter: model.limiter });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal })
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    return text.split('\n\n').filter(block => block.startsWith('data:')).map(block => JSON.parse(block.slice(5)));
  } finally {
    server.close();
  }
}

const ofType = (events, type) => events.filter(e => e.type === type);

test('POST /api/execute, кофейня: 5 разных agent-start и agent-result со своими заданиями', async () => {
  const model = mockModel();
  const events = await execute(COFFEE_GOAL, model);

  assert.equal(model.calls.filter(c => c.label === 'ceo-router').length, 0, 'маршрут без вызова модели');
  const plan = ofType(events, 'plan')[0];
  assert.deepEqual(plan.subtasks.map(s => s.agentId), Object.keys(COFFEE_ASSIGNMENTS));

  const starts = ofType(events, 'agent-start');
  const results = ofType(events, 'agent-result');
  assert.equal(new Set(starts.map(e => e.agentId)).size, 5);
  assert.equal(new Set(results.map(e => e.agentId)).size, 5);
  for (const event of results) {
    assert.equal(event.result, `ОТВЕТ ${event.agentId}: ${COFFEE_ASSIGNMENTS[event.agentId]}`);
    assert.deepEqual(event.foreign, []);
  }
  // Задания выданы все сразу: каждая подзадача стоит в очереди ещё до первого результата.
  const firstResult = events.indexOf(results[0]);
  const queued = events.filter(e => e.type === 'agent-status' && e.agentId !== 'ceo' && e.status === 'idle');
  assert.equal(queued.length, 5);
  assert.ok(queued.every(e => events.indexOf(e) < firstResult));

  const final = ofType(events, 'final')[0];
  assert.deepEqual(final.completedAgents.sort(), Object.keys(COFFEE_ASSIGNMENTS).sort());
  assert.deepEqual(final.failedAgents, []);
  for (const name of ['Luma 2', 'Luma 3', 'Luma 4', 'Luma 5', 'Luma 6']) {
    assert.match(final.result, new RegExp(`✅ ${name}`));
  }
  // Задания адресные → итог состоит из настоящих ответов под подписями их авторов, без пересказа моделью.
  assert.equal(model.calls.filter(c => c.label.endsWith('ceo-summary')).length, 0);
  const labels = { research: 'Luma 2 · Исследователь рынка', product: 'Luma 3 · Продуктолог', creator: 'Luma 4 · Креатор', sales: 'Luma 5 · Менеджер продаж', finance: 'Luma 6 · Финансовый аналитик' };
  for (const event of results) {
    assert.ok(final.result.includes(`### ${labels[event.agentId]}\n${event.result}`), `ответ ${event.agentId} не под своей подписью`);
  }
  assert.ok(ofType(events, 'done').length === 1);
});

test('POST /api/execute, кофейня с CEO_SUMMARY=true: сводка видит результаты под подписями авторов', async () => {
  const model = mockModel();
  const events = await execute(COFFEE_GOAL, model, alwaysSummaryConfig);
  const summaryCall = model.calls.find(c => c.label.endsWith('ceo-summary'));
  assert.ok(summaryCall);
  assert.match(summaryCall.messages[1].content, /### Luma 4 · Креатор\nОТВЕТ creator: слоган/);
  const final = ofType(events, 'final')[0];
  assert.match(final.result, /^## Кто выполнил задачу/);
  assert.match(final.result, /СВОДКА CEO$/);
});

test('POST /api/execute: ответ Luma 5 «за всю команду» не подменяет остальных', async () => {
  const model = mockModel({ impersonator: 'sales' });
  const events = await execute(COFFEE_GOAL, model);
  const results = ofType(events, 'agent-result');
  assert.equal(results.length, 5);
  const sales = results.find(e => e.agentId === 'sales');
  assert.deepEqual(sales.foreign, ['Luma 2', 'Luma 3', 'Luma 4', 'Luma 6']);
  for (const event of results.filter(e => e.agentId !== 'sales')) {
    assert.equal(event.result, `ОТВЕТ ${event.agentId}: ${COFFEE_ASSIGNMENTS[event.agentId]}`);
  }
  const warning = ofType(events, 'log').find(e => e.agentId === 'sales' && e.kind === 'warning');
  assert.match(warning.message, /упомянуты другие сотрудники/);
  // В итоге текст Luma 5 остаётся под его собственной подписью.
  const final = ofType(events, 'final')[0];
  assert.match(final.result, /### Luma 5 · Менеджер продаж\n## Luma 2/);
  assert.match(final.result, /### Luma 2 · Исследователь рынка\nОТВЕТ research: 3 группы клиентов/);
});

test('POST /api/execute: сбой одного сотрудника честно виден в итоге', async () => {
  const model = mockModel();
  const original = model.callModel;
  model.callModel = (messages, opts) => opts.label.endsWith('/finance') ? Promise.reject(new Error('тайм-аут')) : original(messages, opts);
  const events = await execute(COFFEE_GOAL, model);
  const final = ofType(events, 'final')[0];
  assert.deepEqual(final.failedAgents, ['finance']);
  assert.match(final.result, /❌ Luma 6 · Финансовый аналитик.*не выполнено \(тайм-аут\)/);
  assert.equal(ofType(events, 'agent-result').length, 4);
});

test('POST /api/execute, один слоган: работает только Luma 4', async () => {
  const model = mockModel();
  const events = await execute(SLOGAN_GOAL, model);
  assert.deepEqual(ofType(events, 'agent-start').map(e => e.agentId), ['creator']);
  assert.deepEqual(ofType(events, 'agent-result').map(e => e.agentId), ['creator']);
  assert.equal(model.calls.filter(c => c.label.endsWith('ceo-summary')).length, 0);
  assert.match(ofType(events, 'final')[0].result, /✅ Luma 4 · Креатор/);
});

test('CEO_ROUTER_MODE=llm: исключение пользователя сильнее выбора модели', async () => {
  const model = mockModel();
  const original = model.callModel;
  model.callModel = (messages, opts) => opts.label === 'ceo-router'
    ? Promise.resolve({ text: '{"agents":["sales","product"],"reason":"так решила модель"}' })
    : original(messages, opts);
  const events = await execute('Без Luma 5 подумай, как назвать кофейню у кампуса', model, readConfig({ ...baseEnv, CEO_ROUTER_MODE: 'llm' }));
  assert.deepEqual(ofType(events, 'plan')[0].subtasks.map(s => s.agentId), ['product']);
  assert.deepEqual(ofType(events, 'agent-start').map(e => e.agentId), ['product']);
});

test('CEO_SUMMARY=true для адресных заданий: предупреждение в журнале и значение в /api/health', async () => {
  const model = mockModel();
  const events = await execute(COFFEE_GOAL, model, alwaysSummaryConfig);
  assert.ok(ofType(events, 'log').some(e => e.kind === 'warning' && /CEO_SUMMARY=true/.test(e.message)));

  const server = createApp({ config: alwaysSummaryConfig, callModel: model.callModel, limiter: model.limiter });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const health = await (await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).json();
    assert.equal(health.ceoSummary, true);
    assert.equal(health.agentShortMaxTokens, 220);
    assert.equal(readConfig(baseEnv).ceoSummary, 'auto');
  } finally {
    server.close();
  }
});

test('POST /api/execute: закрытие соединения клиентом отменяет все запросы к модели', async () => {
  const signals = [];
  let started = 0;
  const limiter = new Limiter(1);
  // Модель «думает» до отмены: так проверяется, что сигнал отмены доходит до каждого вызова.
  async function callModel(messages, opts) {
    signals.push(opts.signal);
    await limiter.acquire(opts.signal, 5_000);
    try {
      started++;
      opts.onStart?.();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        opts.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
      });
      return { text: 'не должно дойти' };
    } finally {
      limiter.release();
    }
  }
  const server = createApp({ config: autoConfig, callModel, limiter });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: COFFEE_GOAL }), signal: controller.signal
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"type":"agent-start"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    controller.abort();
    const startedAt = Date.now();
    while (signals.length < 5 || !signals.every(s => s.aborted)) {
      if (Date.now() - startedAt > 2_000) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(signals.length, 5);
    assert.ok(signals.every(s => s.aborted), 'все 5 вызовов модели должны получить отмену');
    assert.equal(started, 1, 'после отмены новые вызовы модели не стартуют');
    assert.equal(limiter.active, 0);
    assert.equal(limiter.waiting, 0);
  } finally {
    server.close();
  }
});

// Регрессия ревью PR #2: при исключении всех сервер отвечает событием error и не вызывает модель ни для кого.
for (const routerMode of ['auto', 'rules', 'llm']) {
  test(`POST /api/execute, CEO_ROUTER_MODE=${routerMode}: «кроме Luma 2–6» → error, никто не назначен`, async () => {
    const model = mockModel();
    const original = model.callModel;
    // Даже если модель-маршрутизатор выберет запрещённого, до неё дело дойти не должно.
    model.callModel = (messages, opts) => opts.label === 'ceo-router'
      ? Promise.resolve({ text: '{"agents":["product"],"reason":"модель"}' })
      : original(messages, opts);
    const events = await execute('Всем специалистам, кроме Luma 2–6: идеи для кофейни', model, readConfig({ ...baseEnv, CEO_ROUTER_MODE: routerMode }));
    assert.equal(model.calls.length, 0, 'модель не вызывается');
    assert.equal(ofType(events, 'plan').length, 0);
    assert.equal(ofType(events, 'agent-start').length, 0);
    assert.match(ofType(events, 'error')[0].message, /Все исполнители исключены/);
  });
}

test('CEO_ROUTER_MODE=llm: модель выбрала только исключённого → резервный выбор не назначает его', async () => {
  const model = mockModel();
  const original = model.callModel;
  model.callModel = (messages, opts) => opts.label === 'ceo-router'
    ? Promise.resolve({ text: '{"agents":["product"],"reason":"модель"}' })
    : original(messages, opts);
  const events = await execute('Не подключай Luma 3, подумай про кофейню у кампуса', model, readConfig({ ...baseEnv, CEO_ROUTER_MODE: 'llm' }));
  const assigned = ofType(events, 'plan')[0].subtasks.map(s => s.agentId);
  assert.ok(assigned.length > 0);
  assert.ok(!assigned.includes('product'), `назначен исключённый: ${assigned}`);
  assert.ok(!ofType(events, 'agent-start').some(e => e.agentId === 'product'));
});

// Регрессия ревью PR #2 (a05b6cd): выбор сотрудников по «исключительно» и «никого, кроме» на уровне HTTP.
for (const [goal, expected] of [
  ['Исключительно Luma 4 — придумай слоган', ['creator']],
  ['Никого, кроме Luma 4, не подключай', ['creator']],
  ['Не назначай никого, кроме Luma 4 — придумай слоган', ['creator']],
  ['Всем, кроме Luma 4', ['research', 'product', 'sales', 'finance']]
]) {
  test(`POST /api/execute, CEO_ROUTER_MODE=llm: «${goal}» → ${expected.join(', ')}`, async () => {
    const model = mockModel();
    const original = model.callModel;
    // Модель-маршрутизатор выбрала бы другого — явное указание пользователя должно победить без её вызова.
    model.callModel = (messages, opts) => opts.label === 'ceo-router'
      ? Promise.resolve({ text: '{"agents":["sales"],"reason":"модель"}' })
      : original(messages, opts);
    const events = await execute(goal, model, readConfig({ ...baseEnv, CEO_ROUTER_MODE: 'llm' }));
    assert.equal(model.calls.filter(c => c.label === 'ceo-router').length, 0);
    assert.deepEqual(ofType(events, 'plan')[0].subtasks.map(s => s.agentId), expected);
    assert.deepEqual(ofType(events, 'agent-start').map(e => e.agentId).sort(), [...expected].sort());
  });
}

// Регрессия независимого ревью b7898cd на уровне HTTP: даже в llm-режиме явный маршрут не назначает исключённого.
test('POST /api/execute, CEO_ROUTER_MODE=llm: «Не подключай, пожалуйста, Luma 2; Luma 4 — …» → только Luma 4', async () => {
  const model = mockModel();
  const events = await execute('Не подключай, пожалуйста, Luma 2; Luma 4 — придумай слоган', model, readConfig({ ...baseEnv, CEO_ROUTER_MODE: 'llm' }));
  assert.equal(model.calls.filter(c => c.label === 'ceo-router').length, 0);
  assert.deepEqual(ofType(events, 'agent-start').map(e => e.agentId), ['creator']);
  assert.equal(ofType(events, 'agent-result')[0].result, 'ОТВЕТ creator: придумай слоган');
  assert.ok(!ofType(events, 'log').some(e => /Проверь: рядом/.test(e.message)));
});

test('POST /api/execute: нераспознанное «не» — предупреждение в журнале CEO', async () => {
  const events = await execute('Не забудь подключить Luma 4 — придумай слоган', mockModel());
  assert.deepEqual(ofType(events, 'agent-start').map(e => e.agentId), ['creator']);
  assert.ok(ofType(events, 'log').some(e => e.agentId === 'ceo' && e.kind === 'warning' && /Проверь: рядом с Luma 4/.test(e.message)));
});

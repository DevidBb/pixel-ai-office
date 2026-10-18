import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { Limiter } from '../server/llm.mjs';
import { RunStore } from '../server/runs.mjs';
import { AGENTS, chatMessages, cleanChatReply, CHAT_PEER_CHARS } from '../server/office.mjs';
import { reduceTask, resetTask } from '../src/taskEvents.ts';
import { COFFEE_GOAL } from './fixtures.mjs';

const baseEnv = { OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_MODEL: 'mock' };
const ALL = AGENTS.map(a => a.id);

// --- Чистые функции ---

test('cleanChatReply: заглушки «OK», пустота и <think> отфильтровываются', () => {
  for (const stub of ['OK', 'ok.', ' Ок! ', 'Хорошо.', '«Понял»', 'Да', '', '   ', '—', '...', '<think>надо подумать</think>', '<think>думаю без конца',
    '<think>x</think> OK', 'Luma 5: OK', 'Спасибо!', 'Нет замечаний.', 'Luma 2, да.']) {
    assert.equal(cleanChatReply(stub, 'sales', ALL), null, JSON.stringify(stub));
  }
  assert.equal(cleanChatReply(undefined, 'sales', ALL), null);
});

test('cleanChatReply: подпись автора убрана, максимум два предложения, адресат — участник обсуждения', () => {
  const reply = cleanChatReply('<think>план</think>**Luma 5 · Менеджер продаж**: Luma 2, сколько студентов приходит утром? Это нужно для рассылки. И третье.', 'sales', ALL);
  assert.deepEqual(reply, { text: 'Luma 2, сколько студентов приходит утром? Это нужно для рассылки.', to: 'research' });
  // Обращение к тому, кто не участвует, — реплика остаётся, но без адресата.
  assert.deepEqual(cleanChatReply('Luma 3, предлагаю начать с латте для студентов.', 'sales', ['sales', 'research']), { text: 'Luma 3, предлагаю начать с латте для студентов.' });
  // Чужая подпись не срезается: это обращение.
  assert.equal(cleanChatReply('Luma 6: проверь, пожалуйста, цену стакана.', 'sales', ALL).to, 'finance');
  assert.ok(cleanChatReply('а'.repeat(500), 'sales', ALL).text.length <= 280);
});

test('chatMessages: сжатые ответы коллег, имена коллег, без формата «ТВОЁ ЗАДАНИЕ»', () => {
  const long = 'Строка отчёта очень подробная.\n'.repeat(30);
  const [system, user] = chatMessages(AGENTS.find(a => a.id === 'sales'), `<think>x</think>${long}`, [
    { agentId: 'research', result: long }, { agentId: 'finance', result: 'Выручка 90 €.' }
  ]);
  assert.match(system.content, /Ты Luma 5, Менеджер продаж/);
  assert.match(system.content, /не отчёт/);
  assert.match(user.content, /- Luma 2 · Исследователь рынка: Строка/);
  assert.match(user.content, /- Luma 6 · Финансовый аналитик: Выручка 90 €\./);
  assert.match(user.content, /«Luma 2, …»/);
  assert.ok(!user.content.includes('ТВОЁ ЗАДАНИЕ') && !user.content.includes('think'));
  const researchLine = user.content.split('\n').find(l => l.startsWith('- Luma 2'));
  assert.ok(researchLine.length <= CHAT_PEER_CHARS + 40, 'ответ коллеги обрезан');
});

test('reduceTask: agent-chat попадает в обсуждение, а не в результаты; resetTask очищает', () => {
  let task = resetTask({ id: 't', title: 'x', agentId: 'ceo', status: 'planning', createdAt: '' });
  task = reduceTask(task, { type: 'plan', summary: 's', subtasks: [{ id: 'task-sales', agentId: 'sales', title: 't', objective: 'o', status: 'queued' }] });
  task = reduceTask(task, { type: 'agent-result', agentId: 'sales', subtaskId: 'task-sales', result: 'РЕЗУЛЬТАТ', handoffFrom: ['research'] });
  task = reduceTask(task, { type: 'agent-chat', agentId: 'sales', to: 'research', text: 'Luma 2, уточни сегмент.', at: 0 });
  task = reduceTask(task, { type: 'agent-chat', agentId: 'sales', text: '' });
  assert.equal(task.chat.length, 1);
  assert.deepEqual({ ...task.chat[0], id: undefined, time: undefined }, { id: undefined, time: undefined, agentId: 'sales', to: 'research', text: 'Luma 2, уточни сегмент.' });
  assert.equal(task.subtasks[0].result, 'РЕЗУЛЬТАТ');
  assert.deepEqual(task.subtasks[0].handoffFrom, ['research']);
  assert.deepEqual(resetTask(task).chat, []);
});

// --- HTTP с мок-моделью ---

const CHAT_ANSWERS = {
  research: '<think>что спросить</think>Luma 3, какие напитки дешевле всего для студентов?',
  product: 'OK',
  creator: '',
  sales: '<think>бесконечные размышления',
  finance: 'Luma 6: Luma 5, сколько клиентов даст листовка в первую неделю? Это нужно для выручки. Третье лишнее.'
};

function mockModel({ hangChat = false } = {}) {
  const calls = [];
  const limiter = new Limiter(1);
  async function callModel(messages, opts = {}) {
    const agentId = opts.label.split('/')[1];
    calls.push({ agentId, messages, maxTokens: opts.maxTokens, signal: opts.signal });
    await limiter.acquire(opts.signal, 5_000);
    try {
      opts.onStart?.();
      if (agentId.startsWith('chat-')) {
        if (hangChat) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 5_000);
            opts.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
          });
        }
        return { text: CHAT_ANSWERS[agentId.slice(5)], stats: {} };
      }
      await new Promise(resolve => setTimeout(resolve, 2));
      const task = messages[1].content.match(/ТВОЁ ЗАДАНИЕ:\n(.*)/);
      return { text: `ОТВЕТ ${agentId}: ${task ? task[1] : 'общая задача'}`, stats: { outputTokens: 4 } };
    } finally {
      limiter.release();
    }
  }
  return { callModel, calls, limiter };
}

async function execute(goal, model, env = {}) {
  const server = createApp({ config: readConfig({ ...baseEnv, ...env }), callModel: model.callModel, limiter: model.limiter });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal })
    });
    const text = await response.text();
    return text.split('\n\n').filter(block => block.startsWith('data:')).map(block => JSON.parse(block.slice(5)));
  } finally {
    server.close();
  }
}

const ofType = (events, type) => events.filter(e => e.type === type);

test('CROSS_TALK по умолчанию выключен: ни одного лишнего вызова модели, событий agent-chat нет', async () => {
  assert.equal(readConfig(baseEnv).crossTalk, false);
  const model = mockModel();
  const events = await execute(COFFEE_GOAL, model);
  assert.equal(model.calls.length, 5);
  assert.ok(!model.calls.some(c => c.agentId.startsWith('chat-')));
  assert.equal(ofType(events, 'agent-chat').length, 0);
  assert.equal(ofType(events, 'done').length, 1);
});

test('CROSS_TALK=true: реплики — отдельные события agent-chat, заглушки отброшены, итог не меняется', async () => {
  const model = mockModel();
  const events = await execute(COFFEE_GOAL, model, { CROSS_TALK: 'true' });
  const chatCalls = model.calls.filter(c => c.agentId.startsWith('chat-'));
  assert.equal(chatCalls.length, 5);
  assert.ok(chatCalls.every(c => c.maxTokens === 80), 'маленький лимит токенов');
  const chats = ofType(events, 'agent-chat');
  assert.deepEqual(chats.map(({ type, seq, at, ...rest }) => rest), [
    { agentId: 'research', to: 'product', text: 'Luma 3, какие напитки дешевле всего для студентов?' },
    { agentId: 'finance', to: 'sales', text: 'Luma 5, сколько клиентов даст листовка в первую неделю? Это нужно для выручки.' }
  ]);
  // Реплики после итога и до done: отчёт их не ждёт и не содержит.
  const final = ofType(events, 'final')[0];
  assert.ok(events.indexOf(final) < events.indexOf(chats[0]));
  assert.ok(events.indexOf(chats.at(-1)) < events.findIndex(e => e.type === 'done'));
  // Реплика остаётся подписью сотрудника на сцене: после agent-chat его статус больше не меняется.
  for (const chat of chats) {
    const later = events.slice(events.indexOf(chat) + 1);
    assert.ok(!later.some(e => e.type === 'agent-status' && e.agentId === chat.agentId), `${chat.agentId}: подпись не затирается`);
  }
  assert.ok(!final.result.includes('какие напитки дешевле'));
  assert.ok(!/Luma 5, сколько клиентов/.test(final.result));
  // Результаты и проверка чужих имён не затронуты репликами.
  for (const result of ofType(events, 'agent-result')) assert.deepEqual(result.foreign, []);
  assert.ok(!ofType(events, 'log').some(e => /упомянуты другие сотрудники/.test(e.message)));
  // Реплика коллеге видит сжатые результаты остальных.
  assert.match(chatCalls.find(c => c.agentId === 'chat-sales').messages[1].content, /- Luma 2 · Исследователь рынка: ОТВЕТ research: 3 группы клиентов/);
});

test('CROSS_TALK=true с одним исполнителем: обсуждать не с кем, вызовов нет', async () => {
  const model = mockModel();
  const events = await execute('Придумай один слоган для кофейни', model, { CROSS_TALK: 'true' });
  assert.equal(model.calls.length, 1);
  assert.equal(ofType(events, 'agent-chat').length, 0);
});

test('CROSS_TALK=true: отмена задачи прерывает раунд реплик', async () => {
  const runs = new RunStore();
  const model = mockModel({ hangChat: true });
  const server = createApp({ config: readConfig({ ...baseEnv, CROSS_TALK: 'true' }), callModel: model.callModel, limiter: model.limiter, runs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: COFFEE_GOAL }) })).json();
    const run = runs.get(runId);
    const started = Date.now();
    while (!model.calls.some(c => c.agentId.startsWith('chat-')) && Date.now() - started < 2_000) await new Promise(r => setTimeout(r, 5));
    await fetch(`${base}/api/runs/${runId}/cancel`, { method: 'POST' });
    while (run.status === 'running' && Date.now() - started < 3_000) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(run.status, 'cancelled');
    const chatCalls = model.calls.filter(c => c.agentId.startsWith('chat-'));
    assert.equal(chatCalls.length, 1, 'после отмены следующие реплики не запрашиваются');
    assert.ok(chatCalls[0].signal.aborted, 'идущий вызов получил отмену');
    assert.ok(!run.events.some(e => e.type === 'agent-chat' || e.type === 'done'));
    assert.equal(model.limiter.active, 0);
  } finally { server.closeAllConnections(); server.close(); }
});

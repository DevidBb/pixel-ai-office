import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { Limiter } from '../server/llm.mjs';
import { RunStore } from '../server/runs.mjs';
import { AGENTS, chatMessages, cleanChatReply, CHAT_PEER_CHARS } from '../server/office.mjs';
import { reduceTask, resetTask, taskFromRun } from '../src/taskEvents.ts';
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
  // Обращение по имени (его требует подсказка) не делает заглушку репликой.
  for (const stub of ['Luma 3, согласен.', 'Luma 2, нет замечаний.', 'Luma 2: OK!', 'Luma 6 — спасибо', 'Люма 4, хорошо', 'Luma 2, OK, согласен.', '**Luma 3**, хорошо.', '*Luma №3*: ок']) {
    assert.equal(cleanChatReply(stub, 'sales', ALL), null, stub);
  }
  assert.deepEqual(cleanChatReply('Luma 3, согласен, но латте дороже 3 €.', 'sales', ALL), { text: 'Luma 3, согласен, но латте дороже 3 €.', to: 'product' });
  assert.deepEqual(cleanChatReply('Luma 3, проверь цену.', 'sales', ALL), { text: 'Luma 3, проверь цену.', to: 'product' }, 'короткая, но по делу');
});

test('cleanChatReply: подпись автора убрана, максимум два предложения, адресат — участник обсуждения', () => {
  const reply = cleanChatReply('<think>план</think>**Luma 5 · Менеджер продаж**: Luma 2, сколько студентов приходит утром? Это нужно для рассылки. И третье.', 'sales', ALL);
  assert.deepEqual(reply, { text: 'Luma 2, сколько студентов приходит утром? Это нужно для рассылки.', to: 'research' });
  // Обращение к тому, кто не участвует, — реплика остаётся, но без адресата.
  assert.deepEqual(cleanChatReply('Luma 3, предлагаю начать с латте для студентов.', 'sales', ['sales', 'research']), { text: 'Luma 3, предлагаю начать с латте для студентов.' });
  // Чужая подпись не срезается: это обращение.
  assert.equal(cleanChatReply('Luma 6: проверь, пожалуйста, цену стакана.', 'sales', ALL).to, 'finance');
  assert.ok(cleanChatReply('а'.repeat(500), 'sales', ALL).text.length <= 280);
  // Точка внутри числа — не конец предложения.
  assert.equal(cleanChatReply('Luma 3, при цене 3.50 € и себестоимости 1.20 € маржа мала. Предлагаю поднять цену. Третье.', 'finance', ALL).text,
    'Luma 3, при цене 3.50 € и себестоимости 1.20 € маржа мала. Предлагаю поднять цену.');
  // Закрывающая кавычка после знака и пропущенный пробел перед заглавной — тоже граница предложения.
  assert.equal(cleanChatReply('Luma 3, клиент спросил: «Какая цена?» Предлагаю поднять цену. Третье лишнее.', 'finance', ALL).text,
    'Luma 3, клиент спросил: «Какая цена?» Предлагаю поднять цену.');
  assert.equal(cleanChatReply('Luma 3, цена 3.50 € высокая.Давай снизим. Третье.', 'finance', ALL).text, 'Luma 3, цена 3.50 € высокая.Давай снизим.');
  // Пропущенный пробел перед открывающей кавычкой или цифрой — тоже граница.
  assert.equal(cleanChatReply('Luma 3, проверим расчёты.«Цена высокая». Предлагаю снизить.', 'finance', ALL).text, 'Luma 3, проверим расчёты.«Цена высокая».');
  assert.equal(cleanChatReply('Luma 3, проверим расчёты!2 клиента уже есть. Третье.', 'finance', ALL).text, 'Luma 3, проверим расчёты!2 клиента уже есть.');
  assert.equal(cleanChatReply('Luma 3, смета 1.5 млн мала. Предлагаю 2.5 млн. Третье.', 'finance', ALL).text, 'Luma 3, смета 1.5 млн мала. Предлагаю 2.5 млн.');
  // Многоточие и «?!» перед строчной буквой не режутся посередине; похожий на точку знак (U+2024) остаётся как был.
  assert.equal(cleanChatReply('Luma 3, всё проверили. Второе предложение...третье тоже. Лишнее.', 'finance', ALL).text, 'Luma 3, всё проверили. Второе предложение...третье тоже.');
  assert.equal(cleanChatReply('Luma 3, правда?!это важно. Лишнее. Ещё.', 'finance', ALL).text, 'Luma 3, правда?!это важно. Лишнее.');
  assert.equal(cleanChatReply('Luma 3, всё проверили\u2024 Предлагаю снизить.', 'finance', ALL).text, 'Luma 3, всё проверили\u2024 Предлагаю снизить.');
  // Ответ оборван лимитом токенов: незаконченное второе предложение не показываем, первое — показываем.
  const cut = { truncated: true };
  assert.equal(cleanChatReply('Luma 3, капучино подтверждено. Luma 4, Креатор: Слоган "Качество, вкус', 'finance', ALL, cut).text, 'Luma 3, капучино подтверждено.');
  assert.equal(cleanChatReply('Luma 3, нужна цена стакана для расчёта выручки', 'finance', ALL, cut).text, 'Luma 3, нужна цена стакана для расчёта выручки');
  // Сокращение перед строчной буквой — не конец предложения: при обрыве оно не теряет продолжение.
  assert.equal(cleanChatReply('Luma 3, ожидаем выручку 20 тыс. рублей при продаже', 'finance', ALL, cut).text, 'Luma 3, ожидаем выручку 20 тыс. рублей при продаже');
  assert.equal(cleanChatReply('Luma 3, нужна смета, т.е. расчёт. Второе. Третье.', 'finance', ALL).text, 'Luma 3, нужна смета, т.е. расчёт. Второе.');
  // Модель закончила сама, просто без точки: оба предложения остаются.
  assert.equal(cleanChatReply('Luma 3, расчёты проверены. Предлагаю снизить цену до 250 рублей', 'finance', ALL).text, 'Luma 3, расчёты проверены. Предлагаю снизить цену до 250 рублей');
  assert.equal(cleanChatReply('Luma 3, да. Уточни себестоимость стакана', 'finance', ALL).text, 'Luma 3, да. Уточни себестоимость стакана');
  for (const [open, close] of [['„', '“'], ['‘', '’'], ['"', '"'], ['(', ')']]) {
    assert.equal(cleanChatReply(`Luma 3, клиент спросил: ${open}Какая цена?${close} Предлагаю поднять. Третье.`, 'finance', ALL).text,
      `Luma 3, клиент спросил: ${open}Какая цена?${close} Предлагаю поднять.`, `${open}…${close}`);
  }
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

test('reduceTask: после итога идёт обсуждение — статус «discussion», а не «Проверка CEO»', () => {
  let task = resetTask({ id: 't', title: 'x', agentId: 'ceo', status: 'planning', createdAt: '' });
  task = reduceTask(task, { type: 'final', result: 'отчёт' });
  assert.equal(task.status, 'review');
  task = reduceTask(task, { type: 'chat-start' });
  assert.equal(task.status, 'discussion');
  assert.equal(task.result, 'отчёт');
  task = reduceTask(task, { type: 'done' });
  assert.equal(task.status, 'done');
});

// --- HTTP с мок-моделью ---

const CHAT_ANSWERS = {
  // Оборван лимитом токенов (doneReason: length): недописанный хвост не показывается.
  research: '<think>что спросить</think>Luma 3, какие напитки дешевле всего для студентов? Luma 4, слоган «Кофе',
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
        return { text: CHAT_ANSWERS[agentId.slice(5)], stats: agentId === 'chat-research' ? { doneReason: 'length' } : {} };
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
  assert.equal(ofType(events, 'chat-start').length, 0);
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
  // Реплики после итога и до done: отчёт их не ждёт и не содержит. Начало обсуждения отмечено событием chat-start.
  const final = ofType(events, 'final')[0];
  const chatStart = ofType(events, 'chat-start');
  assert.equal(chatStart.length, 1);
  assert.ok(events.indexOf(final) < events.indexOf(chatStart[0]) && events.indexOf(chatStart[0]) < events.indexOf(chats[0]));
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

test('CROSS_TALK=true: остановка во время обсуждения прерывает реплики, но готовый отчёт остаётся', async () => {
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
    // Итог уже отправлен: остановка обрывает только необязательное обсуждение, задача завершена.
    assert.equal(run.status, 'done');
    const chatCalls = model.calls.filter(c => c.agentId.startsWith('chat-'));
    assert.equal(chatCalls.length, 1, 'после отмены следующие реплики не запрашиваются');
    assert.ok(chatCalls[0].signal.aborted, 'идущий вызов получил отмену');
    assert.ok(!run.events.some(e => e.type === 'agent-chat' || e.type === 'error'));
    assert.equal(model.limiter.active, 0);
    const task = taskFromRun(await (await fetch(`${base}/api/runs/${runId}`)).json());
    assert.equal(task.status, 'done');
    assert.match(task.result, /^## Кто выполнил задачу/, 'отчёт не заменён текстом об остановке');
    assert.ok(task.logs.some(l => /Обсуждение команды остановлено/.test(l.message)));
    // Тот, кто писал реплику, не остаётся «думающим» на сцене.
    const lastStatus = new Map(ofType(run.events, 'agent-status').map(e => [e.agentId, e.status]));
    assert.ok(![...lastStatus.values()].includes('thinking'));
  } finally { server.closeAllConnections(); server.close(); }
});

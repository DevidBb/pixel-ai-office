import test from 'node:test';
import assert from 'node:assert/strict';
import { countListItems, countSlogans, echo, scoreResults, scoreTeamRun } from '../server/eval.mjs';
import { arithmeticHints, requestedCount, requestedItems, agentMessages, buildPlan, routeByRules, AGENTS } from '../server/office.mjs';
import { COFFEE_GOAL } from './fixtures.mjs';

// Настоящие ответы qwen3:1.7b из базового замера (data/evals) — до исправления подсказок.
const BEFORE = [
  { agentId: 'research', result: '3 группы клиентов:\n1. **Студенты** – допущение: часто посещают.\n2. **Учёные** – ценят качество.\n3. **Популярные клиенты** – ищут дешёвое.' },
  { agentId: 'product', result: '**Предложение:**\n3 напитка\n**Цена-гипотеза:** 100 р. за 100 мл\n**Критерии результата:** 3 напитка, 100 мл, 100 р.' },
  { agentId: 'creator', result: '- **"Вдохновение в каждом бургере."**\n- **"Кофе, который делает день лучше."**\n- **"Пусть кофе поднимет настроение."**' },
  { agentId: 'sales', result: 'Допущение: клиенты будут интересоваться.\n\n2 способа привлечения:\n1. Удобное место.\n2. Скидки для студентов.' },
  { agentId: 'finance', result: 'Выручка: 90 €\nЗатраты: 60 €\nМаржа: 30 €\nДопущение: продажи стабильны.' }
];
// И после (последний замер).
const AFTER = [
  { agentId: 'research', result: '1. Студенты — ...\n2. Преподаватели — ...\n3. Сотрудники кампуса — ...' },
  { agentId: 'product', result: '1. Капучино – классический напиток.\n2. Коктейль – фруктовый.\n3. Чай – натуральный.\n\nдопущение: выбор ориентирован на студентов.' },
  { agentId: 'creator', result: 'Слоган: «Кофе в университете – вкусно и дружно».\nДопущение: слоган соответствует аудитории.' },
  { agentId: 'sales', result: '1. Скидки по студенческому.\n2. Акция в соцсетях.' },
  { agentId: 'finance', result: 'Выручка: 90 € (30 заказов × 3 €). Допущение: 30 заказов.' }
];

test('оценка кофейни: настоящие ответы до исправления — 2/5, после — 5/5', () => {
  const before = scoreResults(BEFORE);
  assert.equal(before.passed, 2);
  assert.deepEqual(before.agents.filter(a => !a.ok).map(a => a.agentId), ['product', 'creator', 'finance']);
  assert.match(before.agents.find(a => a.agentId === 'finance').detail, /лишние числа: 60/);
  assert.equal(scoreResults(AFTER).passed, 5);
});

test('счётчики: пометка «допущение» под номером не считается пунктом, слоганы — по кавычкам', () => {
  assert.equal(countListItems('1. Капучино\n2. Чай\n3. Допущение: клиенты любят кофе'), 2);
  assert.equal(countListItems('**3 группы:**\n- Студенты\n- Преподаватели'), 2);
  assert.equal(countSlogans('Слоган: «Кофе между парами». Ещё раз: «Кофе между парами»'), 1);
  assert.equal(countSlogans('- "Один вариант"\n- "Другой вариант"'), 2);
});

test('нет результата у сотрудника — задание не выполнено', () => {
  const report = scoreResults(AFTER.filter(r => r.agentId !== 'sales'));
  assert.equal(report.passed, 4);
  assert.equal(report.agents.find(a => a.agentId === 'sales').detail, 'нет результата');
});

test('калькулятор офиса: точные значения, диапазоны и одиночные числа не трогает', () => {
  assert.deepEqual(arithmeticHints('выручка 30 × 3 €'), ['30 × 3 = 90']);
  assert.deepEqual(arithmeticHints('120 / 4 + 10 и 2,5 * 4'), ['120 / 4 + 10 = 40', '2,5 * 4 = 10']);
  assert.deepEqual(arithmeticHints('2-3 варианта за 10-15 минут'), []);
  assert.deepEqual(arithmeticHints('3 напитка в 2026 году'), []);
  assert.deepEqual(arithmeticHints('1 / 3'), ['1 / 3 = 0,33']);
  // Не выражения: телефон, дата, номер, версия, время.
  for (const text of ['позвони +7 900 123-45-67', 'встреча 18/10/2026', 'ИНН 7701-123456', 'версия 1.2.3', 'к 15:30', 'дата 18.10.2026']) {
    assert.deepEqual(arithmeticHints(text), [], text);
  }
  assert.deepEqual(arithmeticHints('выручка 30×3€ и 100 - 15 + 5'), ['30×3 = 90', '100 - 15 + 5 = 90']);
});

test('requestedCount: «3 напитка», «три идеи» — да; «30 × 3 €», «слоган» — нет', () => {
  assert.equal(requestedCount('3 напитка'), 3);
  assert.equal(requestedCount('2 способа привлечения'), 2);
  assert.equal(requestedCount('три идеи'), 3);
  assert.equal(requestedCount('выручка 30 × 3 €'), null);
  assert.equal(requestedCount('30 × 3 €'), null);
  assert.equal(requestedCount('слоган'), null);
  assert.equal(requestedCount('1 слоган'), null);
});

test('подсказка адресного задания: без шаблона роли, с формой списка и калькулятором', () => {
  const plan = buildPlan(COFFEE_GOAL, routeByRules(COFFEE_GOAL));
  const messagesFor = id => agentMessages(AGENTS.find(a => a.id === id), plan.tasks.find(t => t.agentId === id), plan);
  const [productSystem, productUser] = messagesFor('product');
  assert.ok(!productSystem.content.includes('цену-гипотезу'), 'описание роли продуктолога не передаётся');
  assert.match(productSystem.content, /не добавляй разделы, цифры и расчёты, о которых не просили/);
  assert.match(productUser.content, /нумерованный список ровно из 3 пунктов/);
  assert.match(productUser.content, /что перечислить: «напитка»/);
  const [financeSystem, financeUser] = messagesFor('finance');
  assert.ok(!financeSystem.content.includes('затраты, маржу'), 'описание роли финансиста не передаётся');
  assert.match(financeUser.content, /КАЛЬКУЛЯТОР ОФИСА.*30 × 3 = 90/);
  assert.ok(!financeUser.content.includes('нумерованный список'));
  // Формат «ТВОЁ ЗАДАНИЕ:\n<поручение>» сохранён (на него опираются мок-модели в тестах).
  assert.match(financeUser.content, /ТВОЁ ЗАДАНИЕ:\nвыручка 30 × 3 €\n/);
});

test('ролевое задание (без адресации) по-прежнему получает описание роли', () => {
  const goal = 'Запуск стартапа с нуля';
  const plan = buildPlan(goal, routeByRules(goal));
  const finance = plan.tasks.find(t => t.agentId === 'finance');
  const [system] = agentMessages(AGENTS.find(a => a.id === 'finance'), finance, plan);
  assert.match(system.content, /Рассчитывай выручку, затраты, маржу/);
});

// Ревью Codex (PR #9, P1): даты, телефоны, периоды и версии не должны превращаться в «точные» подсказки.
test('калькулятор не считает даты, телефоны, периоды и версии', () => {
  for (const text of ['дата 2026-10-18', 'телефон 8-800-555-35-35', 'сезон 2025/2026', 'версия 1.2.3+4', 'релиз v2.0.1-3', '18/10/2026', 'ставка 12.5+3.2.1']) {
    assert.deepEqual(arithmeticHints(text), [], text);
  }
  // «/» и «-» с пробелами — действия; × и * — в любом написании.
  assert.deepEqual(arithmeticHints('120 / 4 + 10; 100 - 15 + 5; 30×3; 2,5 * 4'), ['120 / 4 + 10 = 40', '100 - 15 + 5 = 90', '30×3 = 90', '2,5 * 4 = 10']);
});

// Ревью Codex (PR #9, P2): число-дата не количество; количество после глагола находится.
test('requestedItems: «3 сентября», «2 квартал» — не количество; «предложи 3 напитка» — количество', () => {
  for (const text of ['3 сентября подготовь анонс', '2 квартал — прогноз продаж', 'к 5 часам отчёт', 'посчитай 30 заказов', '2 раза в неделю пост']) {
    assert.equal(requestedItems(text), null, text);
  }
  assert.deepEqual(requestedItems('предложи 3 напитка'), { count: 3, what: 'напитка' });
  assert.deepEqual(requestedItems('придумай три идеи для акции'), { count: 3, what: 'идеи для акции' });
  assert.deepEqual(requestedItems('2 способа привлечения'), { count: 2, what: 'способа привлечения' });
});

test('подсказка: «Luma 3 — предложи 3 напитка» получает форму списка, «3 сентября подготовь анонс» — нет', () => {
  for (const [goal, id, expected] of [
    ['Luma 3 — предложи 3 напитка для кофейни', 'product', /ровно из 3 пунктов.*«напитка для кофейни»/],
    ['Luma 4 — 3 сентября подготовь анонс открытия', 'creator', null]
  ]) {
    const plan = buildPlan(goal, routeByRules(goal));
    const [, user] = agentMessages(AGENTS.find(a => a.id === id), plan.tasks[0], plan);
    if (expected) assert.match(user.content, expected, goal);
    else assert.ok(!user.content.includes('нумерованный список'), goal);
  }
});

// Ревью Codex (PR #9, второй круг).
test('форма «ровно N пунктов» — только для перечисляемых вариантов, не для денег и единиц', () => {
  for (const text of ['составь бюджет 5 тысяч рублей', 'цена 3 евро', 'аренда 2 месяца', 'зал на 40 мест', 'сделай 3 сентября анонс', 'открой 2 кассы']) {
    assert.equal(requestedItems(text), null, text);
  }
  for (const [text, count] of [['3 напитка', 3], ['3 группы клиентов', 3], ['2 способа привлечения', 2], ['предложи 5 идей', 5], ['напиши 3 поста', 3], ['придумай три слогана', 3]]) {
    assert.equal(requestedItems(text)?.count, count, text);
  }
});

test('countSlogans: подписанный слоган с пояснением в кавычках — один вариант', () => {
  assert.equal(countSlogans('Слоган: «Кофе между парами». Он обращён к аудитории «студенты и преподаватели».'), 1);
  assert.equal(countSlogans('**Слоган:** "Кофе между парами" — для «первокурсников».'), 1);
  assert.equal(countSlogans('Слоганы:\n1. «Кофе между парами»\n2. «Перерыв со вкусом»\n3. «Твоя пара — кофе»'), 3);
  assert.equal(countSlogans('- **"Вдохновение в каждом бургере."**\n- **"Кофе, который делает день лучше."**'), 2);
});

// Ревью Codex (PR #9, третий круг).
test('калькулятор: разделители тысяч склеиваются, а не режут число', () => {
  assert.deepEqual(arithmeticHints('бюджет 1 000 + 2 000 рублей'), ['1000 + 2000 = 3000']);
  assert.deepEqual(arithmeticHints('10 000 * 3'), ['10000 * 3 = 30000']);
  assert.deepEqual(arithmeticHints('30 × 3 €, зал на 40 мест'), ['30 × 3 = 90']);
});

test('оценка финансиста: выдуманные цифры в строке «допущение» тоже провал', () => {
  const report = scoreResults([{ agentId: 'finance', result: 'Выручка: 90 €. Допущение: затраты 60 € и маржа 30 €.' }]);
  const finance = report.agents.find(a => a.agentId === 'finance');
  assert.equal(finance.ok, false);
  assert.match(finance.detail, /лишние числа: 60/);
  assert.equal(scoreResults([{ agentId: 'finance', result: 'Выручка: 90 € (30 заказов × 3 €). Допущение: 30 заказов.' }]).agents.find(a => a.agentId === 'finance').ok, true);
});

test('countListItems: вложенные пояснения не считаются отдельными вариантами', () => {
  assert.equal(countListItems('1. Студенты\n   - Нужна низкая цена\n   - Быстрое обслуживание\n2. Преподаватели\n3. Сотрудники'), 3);
  assert.equal(countListItems('- Капучино\n\t* с корицей\n- Чай\n- Лимонад'), 3);
});

// Ревью Codex (PR #9, четвёртый круг).
test('калькулятор: «1920x1080» — размер, а «10 x 3» и «30×3» — умножение', () => {
  for (const text of ['баннер 1920x1080 пикселей', 'плитка 4x4 см', 'формат 16X9']) assert.deepEqual(arithmeticHints(text), [], text);
  assert.deepEqual(arithmeticHints('10 x 3 и 30×3'), ['10 x 3 = 30', '30×3 = 90']);
});

test('requestedItems: число под отрицанием — не количество', () => {
  assert.equal(requestedItems('не предлагай 3 слогана, дай один слоган'), null);
  assert.equal(requestedItems('вместо 5 идей дай одну'), null);
  assert.equal(requestedItems('предложи 3 слогана').count, 3);
});

test('оценка финансиста: 30 и 3 вне расчёта — выдуманные цифры; 90,00 € засчитывается', () => {
  const finance = text => scoreResults([{ agentId: 'finance', result: text }]).agents.find(a => a.agentId === 'finance');
  assert.equal(finance('Выручка: 90 €. Затраты: 30 €. Маржа: 3 €.').ok, false);
  assert.equal(finance('Выручка: 90,00 €').ok, true);
  assert.equal(finance('Выручка: 30 × 3 € = 90 €').ok, true);
  assert.equal(finance('Выручка: 90 € (30 заказов × 3 €). Допущение: 30 заказов.').ok, true);
  assert.equal(finance('Выручка: 90 €. Допущение: затраты 60 € и маржа 30 €.').ok, false);
});

test('countListItems: пункт с двоеточием и вложенными пояснениями считается', () => {
  assert.equal(countListItems('1. Студенты:\n   - ценят цену\n2. Преподаватели:\n   - ценят тишину\n3. Сотрудники:\n   - заходят утром'), 3);
});

// Настоящий прогон qwen3:1.7b с HANDOFF=true (data/evals, 2026-10-18): продуктолог пересказывает исследование
// и копирует его строку «допущение».
const RESEARCH = '1. Группа студентов — регулярные посетители, ценящие качественный вкус и доступную цену.\n2. Группа взрослых — предпочитают более спокойные и уютные варианты, часто приходят в вечернее время.\n\nдопущение: данные основаны на общем поведению клиентов и не исключают индивидуальных особенностей.';
const PRODUCT = '1. Для группы студентов — регулярные посетители, ценящие качественный вкус и доступную цену: капучино.\n2. Латте на овсяном молоке за 180 ₽ — тёплый и недорогой.\nДопущение: данные основаны на общем поведению клиентов и не исключают индивидуальных особенностей.';

test('echo: списанные строки — по совпадению словесных троек; регистр, «ё», знаки и маркеры списка не мешают', () => {
  const report = echo(PRODUCT, [RESEARCH]);
  assert.equal(report.lines, 3);
  assert.equal(report.copiedLines, 2, 'пересказ исследования и чужое «допущение»');
  assert.equal(report.copiedAssumption, true);
  assert.ok(report.share > 0.4 && report.share < 0.9, String(report.share));
  // Своё содержание — ничего не списано.
  assert.deepEqual(echo('Латте на овсяном молоке за 180 ₽ — тёплый и недорогой.', [RESEARCH]), { lines: 1, copiedLines: 0, copiedAssumption: false, share: 0 });
  // Общие слова без общих троек — не копия.
  assert.equal(echo('Студенты ценят цену и вкус кофе утром.', [RESEARCH]).copiedLines, 0);
  assert.equal(echo('* ГРУППА СТУДЕНТОВ: регулярные посетители, ценящие качественный вкус!', [RESEARCH]).copiedLines, 1);
  assert.equal(echo('Пусть всё будет тёплым и уютным вечером.', ['пусть все будет теплым и уютным вечером']).copiedLines, 1);
});

test('echo: короткие строки, <think>, пустой ответ и пустые источники', () => {
  assert.deepEqual(echo('', [RESEARCH]), { lines: 0, copiedLines: 0, copiedAssumption: false, share: 0 });
  assert.deepEqual(echo('Группа студентов', [RESEARCH]), { lines: 0, copiedLines: 0, copiedAssumption: false, share: 0 }, 'меньше трёх слов не сравниваем');
  assert.equal(echo('<think>группа студентов — регулярные посетители, ценящие качественный вкус</think>Своё мнение о кофейне рядом.', [RESEARCH]).copiedLines, 0);
  assert.equal(echo(PRODUCT, []).copiedLines, 0);
});

test('scoreTeamRun: повторы в результатах считаются только против полученных данных, реплики — против результатов коллег', () => {
  const events = [
    { type: 'agent-result', agentId: 'research', result: RESEARCH, at: 1000 },
    { type: 'agent-result', agentId: 'product', result: PRODUCT, handoffFrom: ['research'], at: 2000 },
    { type: 'agent-result', agentId: 'creator', result: 'Слоган: «Тёплый кофе у пары». Группа студентов — регулярные посетители, ценящие качественный вкус и доступную цену.', at: 3000 },
    { type: 'final', at: 4000 },
    { type: 'agent-chat', agentId: 'product', text: 'Luma 2, группа взрослых — предпочитают более спокойные и уютные варианты?', to: 'research', at: 5000 },
    { type: 'agent-chat', agentId: 'research', text: 'Luma 3, сколько стоит латте на овсяном и берут ли его вечером?', to: 'product', at: 6000 }
  ];
  const report = scoreTeamRun(events);
  assert.equal(report.seconds, 5);
  const product = report.agents.find(a => a.agentId === 'product');
  assert.deepEqual([product.handoffFrom, product.copiedLines, product.copiedAssumption], [['research'], 2, true]);
  // Креатор данных не получал: совпадение с исследованием — не handoff-повтор.
  assert.equal(report.agents.find(a => a.agentId === 'creator').copiedLines, 0);
  assert.deepEqual(report.chat.map(c => [c.agentId, c.echo]), [['product', true], ['research', false]]);
  // Повтор уже сказанной в чате реплики — тоже пересказ.
  const repeated = scoreTeamRun([...events, { type: 'agent-chat', agentId: 'creator', text: 'Luma 3, сколько стоит латте на овсяном и берут ли его вечером?', at: 7000 }]);
  assert.equal(repeated.chat.at(-1).echo, true);
  assert.deepEqual([report.copiedLines, report.copiedAssumptions, report.chatEchoes, report.chatReplies], [2, 1, 1, 2]);
});

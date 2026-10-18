import test from 'node:test';
import assert from 'node:assert/strict';
import { countListItems, countSlogans, scoreResults } from '../server/eval.mjs';
import { arithmeticHints, requestedCount, agentMessages, buildPlan, routeByRules, AGENTS } from '../server/office.mjs';
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

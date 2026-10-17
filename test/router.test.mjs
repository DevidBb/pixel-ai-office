import test from 'node:test';
import assert from 'node:assert/strict';
import { routeByRules, fallbackRoute, parseAssignments, buildPlan, agentMessages, foreignAttributions, needsModelSummary, AGENTS } from '../server/office.mjs';
import { COFFEE_GOAL, COFFEE_ASSIGNMENTS, SLOGAN_GOAL } from './fixtures.mjs';

const ALL = ['research', 'product', 'creator', 'sales', 'finance'];

test('кофейня: CEO назначает всех пятерых без вызова модели', () => {
  const route = routeByRules(COFFEE_GOAL);
  assert.ok(route, 'маршрут должен находиться правилами, до вызова модели');
  assert.deepEqual(route.agentIds, ALL);
  assert.equal(route.source, 'explicit');
});

test('кофейня: каждый получает своё адресное задание, а не общую цель', () => {
  const plan = buildPlan(COFFEE_GOAL, routeByRules(COFFEE_GOAL));
  assert.equal(plan.tasks.length, 5);
  for (const task of plan.tasks) {
    assert.equal(task.objective, COFFEE_ASSIGNMENTS[task.agentId], task.agentId);
    assert.equal(task.assigned, true);
  }
  assert.equal(new Set(plan.tasks.map(t => t.objective)).size, 5, 'задания должны различаться');
});

test('кофейня: в подсказке сотрудника нет чужих поручений', () => {
  const plan = buildPlan(COFFEE_GOAL, routeByRules(COFFEE_GOAL));
  const salesTask = plan.tasks.find(t => t.agentId === 'sales');
  const [system, user] = agentMessages(AGENTS.find(a => a.id === 'sales'), salesTask, plan);
  assert.equal(user.content.split('\n\n')[0], 'КОНТЕКСТ:\nЯ хочу открыть маленькую кофейню возле университета.');
  assert.match(user.content, /ТВОЁ ЗАДАНИЕ:\n2 способа привлечения\n/);
  for (const other of ['3 группы клиентов', '3 напитка', 'слоган', '30 × 3', 'CEO', 'специалист']) {
    assert.ok(!user.content.includes(other), `«${other}» попало в задание Luma 5`);
  }
  // Имена коллег в подсказке провоцируют модель писать о них.
  for (const name of ['Luma 2', 'Luma 3', 'Luma 4', 'Luma 6', 'Luma 1']) {
    assert.ok(!system.content.includes(name) && !user.content.includes(name), `имя ${name} в подсказке Luma 5`);
  }
  assert.match(system.content, /Ты Luma 5, Менеджер продаж/);
  assert.match(system.content, /только свой результат/i);
});

test('сводка CEO моделью: auto пропускает её для адресных заданий', () => {
  const explicit = buildPlan(COFFEE_GOAL, routeByRules(COFFEE_GOAL));
  const roleBased = buildPlan('Запуск стартапа с нуля', routeByRules('Запуск стартапа с нуля'));
  assert.equal(needsModelSummary(explicit, 'auto'), false);
  assert.equal(needsModelSummary(roleBased, 'auto'), true);
  assert.equal(needsModelSummary(explicit, true), true);
  assert.equal(needsModelSummary(roleBased, false), false);
});

test('кофейня: просьба «коротко» уменьшает лимит токенов', () => {
  const plan = buildPlan(COFFEE_GOAL, routeByRules(COFFEE_GOAL), { agentMaxTokens: 700, agentShortMaxTokens: 220 });
  for (const task of plan.tasks) assert.equal(task.maxTokens, 220);
});

test('один слоган: только Luma 4, короткий лимит и просьба дать ровно один вариант', () => {
  const route = routeByRules(SLOGAN_GOAL);
  assert.deepEqual(route.agentIds, ['creator']);
  const plan = buildPlan(SLOGAN_GOAL, route, { agentMaxTokens: 700, agentShortMaxTokens: 220 });
  assert.equal(plan.tasks[0].objective, SLOGAN_GOAL);
  assert.equal(plan.tasks[0].maxTokens, 220);
  assert.equal(plan.tasks[0].exactlyOne, true);
  const [, user] = agentMessages(AGENTS.find(a => a.id === 'creator'), plan.tasks[0], plan);
  assert.match(user.content, /ровно один вариант/);
});

test('«один/одно/одну …» включает короткий лимит, обычная задача — нет', () => {
  for (const goal of ['Дай одно название для кофейни', 'Предложи одну идею для акции', 'Напиши один пост про кофейню']) {
    const plan = buildPlan(goal, fallbackRoute(goal), { agentMaxTokens: 700, agentShortMaxTokens: 220 });
    assert.equal(plan.tasks[0].maxTokens, 220, goal);
    assert.equal(plan.tasks[0].exactlyOne, true, goal);
  }
  const plan = buildPlan('Напиши пост про кофейню', routeByRules('Напиши пост про кофейню'), { agentMaxTokens: 700, agentShortMaxTokens: 220 });
  assert.equal(plan.tasks[0].maxTokens, 700);
  assert.equal(plan.tasks[0].exactlyOne, false);
  const coffee = buildPlan(COFFEE_GOAL, routeByRules(COFFEE_GOAL));
  assert.ok(coffee.tasks.every(t => !t.exactlyOne));
});

test('диапазон «Luma 2–6» назначает Luma 2…6 одним заданием', () => {
  for (const goal of ['Luma 2–6, проанализируйте кофейню', 'Luma 2-6 — проанализируйте кофейню', 'Luma 2…6: проанализируйте кофейню', 'С Luma 2 по Luma 6 — проанализируйте кофейню', 'Luma 2 — Luma 6: проанализируйте кофейню']) {
    const route = routeByRules(goal);
    assert.deepEqual(route.agentIds, ALL, goal);
    assert.ok(Object.values(route.assignments).every(a => a === 'проанализируйте кофейню'), goal);
  }
});

test('диапазон-подмножество «Luma 3-5» и обратный диапазон', () => {
  assert.deepEqual(routeByRules('Luma 3-5 — идеи для кофейни').agentIds, ['product', 'creator', 'sales']);
  // «Luma 5–3» не диапазон: читается как Luma 5 с заданием.
  assert.deepEqual(routeByRules('Luma 5–3 идеи').agentIds, ['sales']);
});

test('«Luma 2 — 3 группы клиентов» — поручение, а не диапазон Luma 2–3', () => {
  const route = routeByRules('Luma 2 — 3 группы клиентов');
  assert.deepEqual(route.agentIds, ['research']);
  assert.equal(route.assignments.research, '3 группы клиентов');
});

test('отрицание: «Не подключай Luma 2, пусть работает Luma 4» → только Luma 4', () => {
  const route = routeByRules('Не подключай Luma 2, пусть работает Luma 4');
  assert.deepEqual(route.agentIds, ['creator']);
  assert.deepEqual(route.excluded, ['research']);
  assert.equal(route.assignments.research, undefined);
});

test('отрицание сильнее просьбы о всей команде: «всем, кроме Luma 6»', () => {
  const route = routeByRules('Всем специалистам, кроме Luma 6: идеи для кофейни');
  assert.deepEqual(route.agentIds, ['research', 'product', 'creator', 'sales']);
  assert.deepEqual(route.excluded, ['finance']);
  assert.match(route.reason, /не подключены: Luma 6/);
});

test('отрицание распространяется на перечисление: «не подключай Luma 2 и Luma 3»', () => {
  const route = routeByRules('Не подключай Luma 2 и Luma 3, Luma 4 — слоган');
  assert.deepEqual(route.agentIds, ['creator']);
  assert.deepEqual(route.excluded.sort(), ['product', 'research']);
  assert.equal(route.assignments.creator, 'слоган');
});

test('отрицание после имени и при маршрутизации по ключевым словам', () => {
  const route = routeByRules('Luma 5 не нужен, придумай слоган и текст для привлечения клиентов');
  assert.ok(!route.agentIds.includes('sales'));
  assert.deepEqual(route.excluded, ['sales']);
  // Исключён единственный профильный сотрудник → резервный выбор, но не он.
  const fallback = fallbackRoute('Без Luma 4 придумай слоган');
  assert.ok(!fallback.agentIds.includes('creator'));
  assert.deepEqual(fallback.agentIds, ['product']);
});

test('«не» внутри поручения не исключает сотрудника', () => {
  const route = routeByRules('Luma 4 — не забудь про слоган; Luma 6 — выручка без учёта налогов');
  assert.deepEqual(route.agentIds, ['creator', 'finance']);
  assert.deepEqual(route.excluded, []);
  assert.equal(route.assignments.creator, 'не забудь про слоган');
});

test('явное имя главнее ключевых слов: «Luma 4, придумай слоган для привлечения клиентов» → только Luma 4', () => {
  const route = routeByRules('Luma 4, придумай слоган для привлечения клиентов и продаж');
  assert.deepEqual(route.agentIds, ['creator']);
  assert.equal(route.assignments.creator, 'придумай слоган для привлечения клиентов и продаж');
});

test('подмножество: «Luma 2 и Luma 4 — ...» назначает обоих с одним заданием', () => {
  const route = routeByRules('Luma 2 и Luma 4 — подумайте над названием кофейни');
  assert.deepEqual(route.agentIds, ['research', 'creator']);
  assert.equal(route.assignments.research, 'подумайте над названием кофейни');
  assert.equal(route.assignments.creator, 'подумайте над названием кофейни');
});

test('«всем специалистам» без имён → вся команда с ролевыми заданиями', () => {
  const route = routeByRules('Пусть всем специалистам достанется по задаче про кофейню');
  assert.deepEqual(route.agentIds, ALL);
  const plan = buildPlan('x', route);
  assert.ok(plan.tasks.every(t => !t.assigned));
});

test('роль с разделителем считается адресным поручением', () => {
  const { assignments } = parseAssignments('Креатор — слоган; Финансовый аналитик: выручка за день');
  assert.deepEqual(assignments, { creator: 'слоган', finance: 'выручка за день' });
});

test('«всем клиентам» не включает всю команду', () => {
  const route = routeByRules('Напиши письмо всем клиентам о скидке');
  assert.notDeepEqual(route.agentIds, ALL);
});

test('обычная задача по ключевым словам работает как раньше', () => {
  assert.deepEqual(routeByRules('Посчитай маржу и окупаемость').agentIds, ['finance']);
  assert.deepEqual(routeByRules('Запуск стартапа с нуля').agentIds, ALL);
});

test('поиск чужих имён в ответе агента', () => {
  assert.deepEqual(foreignAttributions('sales', '## Luma 2\nгруппы\n## Luma 5\nканалы\nLuma 6: 90 €'), ['Luma 2', 'Luma 6']);
  assert.deepEqual(foreignAttributions('creator', 'Слоган: «Кофе между парами»'), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { routeByRules, routeByExplicit, wantsWholeTeam, fallbackRoute, parseAssignments, assertSomeoneAllowed, uncertainNote, buildPlan, agentMessages, foreignAttributions, needsModelSummary, AGENTS } from '../server/office.mjs';
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

// Регрессия ревью PR #2 (коммит 171fb91): обычное «не»/«без» рядом с именем не должно исключать сотрудника.
test('«Не забудь подключить Luma 4 — придумай слоган» назначает Luma 4', () => {
  const goal = 'Не забудь подключить Luma 4 — придумай слоган';
  const parsed = parseAssignments(goal);
  assert.deepEqual(parsed.excluded, []);
  assert.equal(parsed.assignments.creator, 'придумай слоган');
  assert.deepEqual(routeByRules(goal).agentIds, ['creator']);
});

test('«Без задержки запусти Luma 5 — продажи» назначает только Luma 5', () => {
  const goal = 'Без задержки запусти Luma 5 — продажи';
  const parsed = parseAssignments(goal);
  assert.deepEqual(parsed.excluded, []);
  assert.equal(parsed.assignments.sales, 'продажи');
  assert.deepEqual(routeByRules(goal).agentIds, ['sales']);
});

test('«Luma 4 не нужно исключать» оставляет Luma 4', () => {
  const goal = 'Luma 4 не нужно исключать';
  assert.deepEqual(parseAssignments(goal).excluded, []);
  assert.deepEqual(routeByRules(goal).agentIds, ['creator']);
  assert.deepEqual(fallbackRoute(goal).agentIds, ['creator']);
});

test('другие «не»/«без» рядом с именем тоже не исключают', () => {
  for (const [goal, expected] of [
    ['Не стесняйся, Luma 4 — придумай слоган', ['creator']],
    ['Не торопясь, пусть Luma 6 посчитает выручку', ['finance']],
    ['Без лишних слов, Luma 2 — 3 группы клиентов', ['research']],
    ['Luma 3 не должен забыть про цены — 3 напитка', ['product']]
  ]) {
    assert.deepEqual(parseAssignments(goal).excluded, [], goal);
    assert.deepEqual(routeByRules(goal).agentIds, expected, goal);
  }
});

test('явные формы исключения по-прежнему работают', () => {
  for (const [goal, excluded] of [
    ['Без участия Luma 5 придумай слоган', ['sales']],
    ['Без Luma 5 придумай слоган', ['sales']],
    ['Исключи Luma 3, Luma 4 — слоган', ['product']],
    ['Не привлекай специалиста Luma 6. Luma 4 — слоган', ['finance']],
    ['Luma 2 не нужно, Luma 4 — слоган', ['research']],
    ['Luma 2 не надо подключать; Luma 4 — слоган', ['research']],
    ['Luma 6 пусть отдыхает, Luma 4 — слоган', ['finance']],
    ['Luma 5 не участвует. Luma 4 — слоган', ['sales']]
  ]) {
    const route = routeByRules(goal);
    assert.deepEqual(route.excluded, excluded, goal);
    assert.ok(!route.agentIds.some(id => excluded.includes(id)), goal);
  }
});

// Регрессия ревью PR #2: если исключены все, никого запрещённого назначать нельзя.
test('все исключены: правила не назначают, fallbackRoute бросает понятную ошибку', () => {
  for (const goal of ['Всем специалистам, кроме Luma 2–6', 'Кроме Luma 2–6, придумай слоган', 'Не подключай Luma 2, Luma 3, Luma 4, Luma 5 и Luma 6']) {
    assert.deepEqual(parseAssignments(goal).excluded.sort(), [...ALL].sort(), goal);
    assert.equal(routeByRules(goal), null, goal);
    assert.throws(() => fallbackRoute(goal), /Все исполнители исключены/, goal);
  }
  assert.throws(() => assertSomeoneAllowed(ALL), /укажи хотя бы одного сотрудника/);
  assert.doesNotThrow(() => assertSomeoneAllowed(['research', 'product', 'creator', 'sales']));
});

// Регрессия ревью PR #2 (коммит a05b6cd): «исключительно» — это «только», а не «исключи».
test('«Исключительно Luma 4 — придумай слоган» назначает Luma 4, никого не исключая', () => {
  const goal = 'Исключительно Luma 4 — придумай слоган';
  const parsed = parseAssignments(goal);
  assert.deepEqual(parsed.excluded, []);
  assert.equal(parsed.assignments.creator, 'придумай слоган');
  assert.deepEqual(routeByRules(goal).agentIds, ['creator']);
  assert.deepEqual(fallbackRoute(goal).agentIds, ['creator']);
});

test('«исключи» / «исключите» по-прежнему исключают', () => {
  for (const goal of ['Исключи Luma 4, Luma 5 — продажи', 'Исключите Luma 4, Luma 5 — продажи']) {
    const route = routeByRules(goal);
    assert.deepEqual(route.excluded, ['creator'], goal);
    assert.deepEqual(route.agentIds, ['sales'], goal);
  }
});

// Регрессия ревью PR #2: «никого, кроме X» разрешает ТОЛЬКО X; «всем, кроме X» исключает X.
test('«Никого, кроме Luma 4, не подключай» → только Luma 4', () => {
  const goal = 'Никого, кроме Luma 4, не подключай';
  const parsed = parseAssignments(goal);
  assert.deepEqual(parsed.excluded.sort(), ['finance', 'product', 'research', 'sales']);
  assert.equal(parsed.assignments.creator, '', '«не подключай» относится к остальным и не является поручением');
  const route = routeByRules(goal);
  assert.deepEqual(route.agentIds, ['creator']);
  assert.deepEqual(fallbackRoute(goal).agentIds, ['creator']);
  assert.equal(buildPlan(goal, route).tasks[0].objective, goal);
});

test('«Не назначай никого, кроме Luma 4 — придумай слоган» → только Luma 4 со своим заданием', () => {
  const goal = 'Не назначай никого, кроме Luma 4 — придумай слоган';
  const route = routeByRules(goal);
  assert.deepEqual(route.agentIds, ['creator']);
  assert.equal(route.assignments.creator, 'придумай слоган');
  assert.deepEqual(fallbackRoute(goal).agentIds, ['creator']);
});

test('«никого, кроме» с перечислением и другими формами', () => {
  assert.deepEqual(routeByRules('Никого не подключай, кроме Luma 4 и Luma 6').agentIds, ['creator', 'finance']);
  assert.deepEqual(routeByRules('Ни одного сотрудника, кроме Luma 2 — 3 группы клиентов').agentIds, ['research']);
  assert.deepEqual(routeByRules('Никому, кроме Luma 6, не давай задание: посчитай выручку').agentIds, ['finance']);
});

test('противоположный контекст: «Всем, кроме Luma 4» исключает Luma 4 и подключает остальных', () => {
  for (const goal of ['Всем, кроме Luma 4', 'Всем специалистам, кроме Luma 4: идеи для кофейни', 'Все за исключением Luma 4, идеи для кофейни']) {
    const route = routeByRules(goal);
    assert.deepEqual(route.excluded, ['creator'], goal);
    assert.deepEqual(route.agentIds, ['research', 'product', 'sales', 'finance'], goal);
  }
});

test('«всем, кроме» без сотрудника после «кроме» не включает всю команду', () => {
  const route = routeByRules('Напиши письмо всем, кроме постоянных клиентов');
  assert.notDeepEqual(route.agentIds, ALL);
  assert.deepEqual(route.excluded, []);
});

// Регрессия независимого ревью b7898cd: вставки между глаголом-запретом и именем.
test('запрет со вставками исключает Luma 2, работает только Luma 4', () => {
  for (const goal of [
    'Не подключай, пожалуйста, Luma 2; Luma 4 — придумай слоган',
    'Не надо подключать Luma 2; Luma 4 — придумай слоган',
    'Не используй Luma 2; Luma 4 — придумай слоган',
    'Исключите из задачи Luma 2; Luma 4 — придумай слоган',
    'Не подключай к этой работе Luma 2, Luma 4 — придумай слоган',
    'Пожалуйста, не привлекайте сегодня специалиста Luma 2. Luma 4 — придумай слоган',
    'Не нужно задействовать Luma 2; Luma 4 — придумай слоган',
    'Убери из команды Luma 2; Luma 4 — придумай слоган'
  ]) {
    const parsed = parseAssignments(goal);
    assert.deepEqual(parsed.excluded, ['research'], goal);
    assert.deepEqual(parsed.assignments, { creator: 'придумай слоган' }, goal);
    assert.deepEqual(routeByRules(goal).agentIds, ['creator'], goal);
    assert.deepEqual(fallbackRoute(goal).agentIds, ['creator'], goal);
  }
});

test('вставки не делают запретом обычное «не»: прежние регрессии держатся', () => {
  for (const [goal, expected] of [
    ['Не забудь подключить Luma 4 — придумай слоган', ['creator']],
    ['Без задержки запусти Luma 5 — продажи', ['sales']],
    ['Не используй клише, Luma 4 — придумай слоган', ['creator']],
    ['Без лишних слов, Luma 2 — 3 группы клиентов', ['research']],
    ['Luma 4 не нужно исключать', ['creator']]
  ]) {
    assert.deepEqual(parseAssignments(goal).excluded, [], goal);
    assert.deepEqual(routeByRules(goal).agentIds, expected, goal);
  }
});

// Регрессия: сотрудник без своего задания не получает чужое через «;» или конец предложения.
test('поручение не перескакивает через «;» и точку, но делится через «и»', () => {
  assert.deepEqual(parseAssignments('Luma 2; Luma 4 — придумай слоган').assignments, { research: '', creator: 'придумай слоган' });
  assert.deepEqual(parseAssignments('Luma 2. Luma 4 — придумай слоган').assignments, { research: '', creator: 'придумай слоган' });
  assert.deepEqual(parseAssignments('Luma 2 и Luma 4 — придумай слоган').assignments, { research: 'придумай слоган', creator: 'придумай слоган' });
  assert.deepEqual(parseAssignments('Luma 2, Luma 4 — придумай слоган').assignments, { research: 'придумай слоган', creator: 'придумай слоган' });
  // Сотрудник без своего задания получает ролевую часть общей цели, а не чужое поручение.
  const goal = 'Luma 2; Luma 4 — придумай слоган для кофейни';
  const task = buildPlan(goal, routeByRules(goal)).tasks.find(t => t.agentId === 'research');
  assert.equal(task.assigned, false);
  assert.match(task.objective, /^Выполни часть цели, относящуюся к твоей роли/);
});

test('нераспознанное «не» рядом с именем: сотрудник назначен, в плане предупреждение', () => {
  const goal = 'Не забудь подключить Luma 4 — придумай слоган';
  const route = routeByRules(goal);
  assert.deepEqual(route.agentIds, ['creator']);
  assert.deepEqual(parseAssignments(goal).uncertain, ['creator']);
  assert.match(buildPlan(goal, route).summary, /Проверь: рядом с Luma 4 есть «не»\/«без»/);
  // Распознанный запрет и запятая-граница предупреждения не дают.
  assert.equal(uncertainNote('Не подключай, пожалуйста, Luma 2; Luma 4 — слоган', ['creator']), '');
  assert.equal(uncertainNote('Не стесняйся, Luma 4 — слоган', ['creator']), '');
  assert.equal(uncertainNote(COFFEE_GOAL, Object.keys(COFFEE_ASSIGNMENTS)), '');
});

// --- Вся команда: «всю» — новая форма, отказы от «всех». В сомнении — как раньше (main). ---

test('«подключи всю команду», «задействуй всю пятёрку» — просьба подключить всех', () => {
  for (const goal of [
    'Подключи всю команду: идеи для кофейни',
    'Задействуй всю пятёрку специалистов: идеи для кофейни',
    'Хочу заработать 300 € за месяц на фотосъёмке. Подключи всю команду: кому продавать и по какой цене',
    'Не забудь подключить всю команду: идеи для кофейни',
    'Не стесняйся позвать всю команду: идеи для кофейни',
    'Не надо торопиться и подключи всю команду: придумай слоган',
    'Подключи всю команду, не нужно экономить время: идеи для кофейни'
  ]) {
    const route = routeByRules(goal);
    assert.deepEqual(route.agentIds, ALL, goal);
    assert.equal(route.source, 'explicit', goal);
  }
  const route = routeByRules('Подключи всю команду кроме Luma 2: придумай слоган');
  assert.deepEqual([route.agentIds, route.excluded], [['product', 'creator', 'sales', 'finance'], ['research']]);
});

test('«всю» без глагола «подключить» вплотную или с отрицанием — не просьба', () => {
  for (const goal of [
    'Не всю команду, а только Luma 4 — слоган',
    'Не хочу всю команду, придумай слоган',
    'Не надо сразу всю команду, придумай слоган',
    'Не нужно для этого всю команду, Luma 4 — слоган',
    'Не надо подключать к этой работе всю команду, Luma 4 — слоган',
    'Всю команду, пожалуйста, не подключай, Luma 4 — слоган',
    'Всю команду лучше не подключай, придумай слоган',
    'Всю команду подключать не надо, Luma 4 — слоган',
    'Всю команду не подключайте, придумай слоган',
    'Ни к чему подключать всю команду, придумай слоган',
    'Убери всю команду, оставь только Luma 4: придумай слоган',
    'Исключи всю команду, оставь Luma 4 — слоган',
    'Всю команду — не надо, только Luma 4: придумай слоган',
    'Всю команду? Нет, только Luma 4: придумай слоган',
    'Зачем всю команду? Luma 4 — слоган',
    'Хватит звать всю команду, Luma 4 — слоган',
    'Вместо того, чтобы позвать всю команду, попроси Luma 4 придумать слоган',
    'Вместо того, чтобы звать всю команду, попроси Luma 4 придумать слоган'
  ]) {
    assert.deepEqual(routeByRules(goal).agentIds, ['creator'], goal);
  }
  for (const goal of [
    'Вместо того чтобы звать всю команду, попроси Luma 4 придумать слоган',
    'Посчитай бюджет на всю командировку в Казань',
    'Luma 4, напиши письмо, которое мотивирует всю команду кофейни',
    'Проанализируй всю пятёрку лидеров рынка кофеен'
  ]) {
    assert.equal(wantsWholeTeam(goal), false, goal);
  }
});

test('отказ от «всех»: отрицание вплотную, и ему больше нечего отрицать во фрагменте', () => {
  for (const goal of [
    'Не подключай всех специалистов, придумай слоган',
    'Не нужно звать всех сотрудников, придумай слоган',
    'Не нужно, пожалуйста, всех сотрудников, придумай слоган',
    'Не всех специалистов, только Luma 4 — слоган',
    'Не все специалисты нужны, придумай слоган',
    'Все специалисты не нужны, придумай слоган',
    'Всех сотрудников не зови, придумай слоган',
    'Всех специалистов не зовите, придумай слоган',
    'Всех специалистов, пожалуйста, не зови, придумай слоган',
    'Всех сотрудников лучше не подключай, придумай слоган',
    'Всех сотрудников не используйте, придумай слоган',
    'Всех специалистов подключать не надо, придумай слоган'
  ]) {
    assert.deepEqual(routeByRules(goal).agentIds, ['creator'], goal);
  }
});

test('«не» про другое рядом с «всех/всем/всей» — команда остаётся, как раньше', () => {
  for (const goal of [
    'Всеми пятью специалистами не трогайте бюджет: идеи для кофейни',
    'Всем пятерым не нужен отдельный отчёт: идеи для кофейни',
    'Всем специалистам не нужны вступления: идеи для кофейни',
    'Не используйте англицизмы работайте всей командой: идеи для кофейни',
    'Не используй клише и поработайте всей командой над идеями для кофейни',
    'Подключи всех специалистов, пожалуйста, не трогай бюджет: идеи для кофейни',
    'Все специалисты, пожалуйста, не используйте клише: идеи для кофейни',
    'Позови всех сотрудников, пожалуйста, не ставьте жёсткие сроки: идеи для кофейни',
    'Все пятеро, пожалуйста, не используйте клише: идеи для кофейни',
    'Все агенты не трогайте бюджет: идеи для кофейни',
    'Всех специалистов собери не трогай бюджет: идеи для кофейни',
    'Не используй клише подключи всех специалистов: идеи для кофейни',
    'Не используй клише пригласи всех специалистов: идеи для кофейни',
    'Не используй англицизмы все специалисты должны писать по-русски: идеи для кофейни',
    'Не трогай бюджет все сотрудники предложите идеи для кофейни',
    'Не зови всех специалистов по одному — собери их вместе: идеи для кофейни',
    'Для всех сотрудников не нужен отдельный отчёт: придумай слоган',
    'Все специалисты не нужны в отчёте отдельно: идеи для кофейни',
    'Всех сотрудников не нужно исключать, придумай слоган',
    'Всех сотрудников исключать не нужно, придумай слоган',
    'Нельзя не задействовать всех сотрудников: придумайте слоган',
    'Почему бы не подключать всех специалистов? Придумайте слоган',
    'Не могу не звать всех специалистов: придумайте слоган'
  ]) {
    assert.deepEqual(routeByExplicit(goal)?.agentIds, ALL, goal);
  }
});

test('запрет с именем после «всех» — про сотрудника, а не про команду', () => {
  for (const goal of [
    'Подключи всех сотрудников и не зови Luma 2: придумай слоган',
    'Подключи всех специалистов только не зови Luma 2: идеи для кофейни',
    'Подключи всех специалистов только не зови, пожалуйста, Luma 2: идеи для кофейни',
    'Подключи всех специалистов, только не зови сотрудника Luma 2: идеи для кофейни',
    'Не подключай Luma 2 и поработайте всей командой: идеи для кофейни'
  ]) {
    const route = routeByExplicit(goal);
    assert.deepEqual([route?.agentIds, route?.excluded], [['product', 'creator', 'sales', 'finance'], ['research']], goal);
  }
});

test('просьба о всей команде без подстрок в признаках комплексной задачи', () => {
  for (const goal of ['Поработайте всей командой: идеи для кофейни', 'Все специалисты, придумайте слоган', 'Нужна помощь всей команды: идеи для кофейни']) {
    assert.deepEqual(routeByRules(goal).agentIds, ALL, goal);
  }
});

test('«всю» после инфинитива — тема задачи или вопрос, а не просьба подключить офис', () => {
  for (const goal of [
    'Подключить всю команду? Нет, только Luma 4 — слоган',
    'Зачем звать всю команду? Хватит Luma 4: придумай слоган',
    'Звать всю команду — лишнее, хватит Luma 4: придумай слоган',
    'Собрать всю команду — перебор. Luma 4, придумай слоган',
    'Нельзя звать всю команду, хватит Luma 4: придумай слоган',
    'Придумай повод собрать всю команду',
    'Напиши пост: мы смогли собрать всю команду',
    'Хочу собрать всю команду. Придумай, где провести тимбилдинг',
    'Рано звать всю команду, придумай слоган',
    'Стоит ли звать всю команду? Или хватит Luma 4?'
  ]) {
    assert.equal(wantsWholeTeam(goal), false, goal);
  }
  for (const goal of ['Luma 1, подключи всю команду: идеи для кофейни', 'Пожалуйста, подключи всю команду: идеи для кофейни', 'CEO, задействуй всю команду: идеи для кофейни']) {
    assert.equal(wantsWholeTeam(goal), true, goal);
  }
});

test('«не» перед «всех» в жалобе, вопросе или рассуждении — не отказ; «можно/лучше/давай/чтобы не» — отказ', () => {
  for (const goal of [
    'Ты подключил не всех специалистов. Повтори: идеи для кофейни',
    'Работают не все сотрудники — подключи остальных: идеи для кофейни',
    'Почему не задействовать всех специалистов? Идеи для кофейни',
    'Было бы глупо не задействовать всех специалистов: идеи для кофейни',
    'Разве не нужно подключать всех специалистов? Идеи для кофейни',
    'Разве всех специалистов подключать не нужно? Идеи для кофейни',
    'Не задействовать всех специалистов — ошибка. Идеи для кофейни',
    'Без всех специалистов не надо: идеи для кофейни'
  ]) {
    assert.deepEqual(routeByExplicit(goal)?.agentIds, ALL, goal);
  }
  for (const goal of [
    'Можно не звать всех специалистов, хватит Luma 4: придумай слоган',
    'Чтобы не звать всех специалистов, поручи это Luma 4: придумай слоган',
    'Лучше бы не звать всех специалистов, Luma 4 — слоган',
    'Давай не будем звать всех специалистов, Luma 4 — слоган',
    'Всех специалистов лучше не звать, Luma 4 — слоган',
    'Мне нужны не все специалисты, а только Luma 4: придумай слоган',
    'Не нужны все специалисты, Luma 4 — слоган'
  ]) {
    assert.deepEqual(routeByRules(goal).agentIds, ['creator'], goal);
  }
});

test('отказ после «всех» — только если «все/всех» начинает фрагмент; «всю» после двоеточия или в кавычках — цитата', () => {
  for (const goal of ['Исключать всех специалистов не стоит: придумайте слоган', 'Отказываться от помощи всех специалистов не нужно: придумайте слоган']) {
    assert.deepEqual(routeByExplicit(goal)?.agentIds, ALL, goal);
  }
  for (const goal of ['Luma 4, переведи на английский: подключи всю команду.', 'Luma 4, переведи фразу «подключи всю команду» на английский', 'Luma 4, перепиши "Подключи всю команду" вежливее']) {
    assert.equal(wantsWholeTeam(goal), false, goal);
  }
  assert.equal(wantsWholeTeam('Хочу заработать 300 €. Подключи всю команду: кому продавать'), true);
});

test('финальный круг: обращение «Все специалисты, не …», задача одному агенту, цитата, метка перед двоеточием', () => {
  for (const goal of ['Все специалисты не используйте: англицизмы, клише, воду. Идеи для кофейни', 'Все сотрудники не трогайте: бюджет фиксирован. Идеи для кофейни']) {
    assert.deepEqual(routeByExplicit(goal)?.agentIds, ALL, goal);
  }
  assert.deepEqual(routeByRules('Всех специалистов не используйте, придумай слоган').agentIds, ['creator']);
  for (const goal of [
    'Luma 6, посчитай бюджет корпоратива, возьми всю команду',
    'Luma 5, напиши приглашение на открытие и позови всю команду',
    'Начальник сказал — собери всю команду. Придумай повестку собрания',
    'Luma 4, переведи на английский — подключи всю команду',
    'Переведи на английский «Привет, подключи всю команду!»'
  ]) {
    assert.equal(wantsWholeTeam(goal), false, goal);
  }
  for (const goal of ['Задача: подключи всю команду и придумай идеи для кофейни', 'Важно: подключи всю команду. Идеи для кофейни',
    'Привет! Задача такая: подключи всю команду, идеи для кофейни', 'Luma 1, подключи всю команду: идеи для кофейни']) {
    assert.equal(wantsWholeTeam(goal), true, goal);
  }
});

test('Codex, 6-й круг: метка-содержимое, обращение по роли, «не всех, а весь офис»', () => {
  for (const goal of ['Переведи текст. Текст: позови всю команду', 'Переведи текст. Текст: привет, позови всю команду',
    'Переведи на английский: привет, подключи всю команду', 'Менеджер продаж — напиши приглашение на открытие и позови всю команду']) {
    assert.equal(wantsWholeTeam(goal), false, goal);
  }
  assert.deepEqual(routeByExplicit('Не всех специалистов, а вообще весь офис подключи к обсуждению идеи')?.agentIds, ALL);
  assert.deepEqual(routeByExplicit('Не всех специалистов, пожалуйста, а весь офис подключи к обсуждению идеи')?.agentIds, ALL);
  assert.deepEqual(routeByExplicit('Не всех специалистов, а сразу весь офис подключи к обсуждению идеи')?.agentIds, ALL);
  assert.equal(wantsWholeTeam('Хочу кофейню — подключи всю команду'), true, 'короткое вступление перед тире — не цитата');
  assert.deepEqual(routeByRules('Не всех специалистов, а только Luma 4 — слоган').agentIds, ['creator']);
});

test('Codex, 7-й круг: отказ сразу после просьбы, перевод на новой строке, «не всех — а весь офис»', () => {
  assert.deepEqual(routeByRules('Подключи всю команду? Нет, только Luma 4 — слоган').agentIds, ['creator']);
  assert.deepEqual(routeByRules('Подключи всю команду — не надо, только Luma 4 — слоган').agentIds, ['creator']);
  assert.equal(wantsWholeTeam('Подключи всю команду: не надо экономить на идеях'), true, '«не надо экономить» — не отказ от команды');
  assert.deepEqual(routeByRules('Переведи на английский:\nПодключи всю команду: придумай слоган.').agentIds, ['creator']);
  assert.equal(wantsWholeTeam('Хочу кофейню.\nПодключи всю команду: придумай слоган.'), true, 'новая строка без двоеточия — новое предложение');
  assert.deepEqual(routeByRules('Не всех специалистов — а весь офис подключи: придумайте слоган').agentIds, ALL);
});

// Ввод до 5000 символов: правила не должны перебирать пробелы (раньше 5000 пробелов — минуты на одну задачу).
test('разбор длинной строки пробелов и повторов укладывается в секунду', () => {
  for (const goal of [' '.repeat(4980) + 'всю команду', 'Напиши' + ' '.repeat(4900) + 'слоган всей командой', 'подключи всю команду '.repeat(238)]) {
    const started = performance.now();
    wantsWholeTeam(goal);
    assert.ok(performance.now() - started < 1000, `${Math.round(performance.now() - started)} мс`);
  }
});

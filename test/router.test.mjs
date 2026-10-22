import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { routeByRules, routeByExplicit, normalizeGoal, fallbackRoute, parseAssignments, assertSomeoneAllowed, uncertainNote, buildPlan, agentMessages, foreignAttributions, needsModelSummary, AGENTS } from '../server/office.mjs';
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

// Задача до 5000 символов разбирается синхронно: долгий разбор останавливает весь сервер. Разбор — в отдельном
// процессе с внешним тайм-аутом: если медленное выражение вернётся, тест упадёт, а не повиснет.
// Путь сервера: разбор нормализованной копии, план с исходным текстом, подсказки каждому сотруднику.
function parsesQuickly(goal, ms = 1500) {
  const office = new URL('../server/office.mjs', import.meta.url).href;
  const code = `import(${JSON.stringify(office)}).then(o => { const raw = ${JSON.stringify(goal)}; const g = o.normalizeGoal(raw);` +
    ' const r = o.routeByExplicit(g, 5) || o.routeByRules(g, 5) || o.fallbackRoute(g, 5); const plan = o.buildPlan(g, r, { text: raw });' +
    ' for (const t of plan.tasks) o.agentMessages(o.AGENTS.find(a => a.id === t.agentId), t, plan); o.wantsWholeTeam(g); })';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: ms });
  return !result.error && result.status === 0;
}

test('длинные серии разделителей и пробелов разбираются быстро (раньше — секунды и часы)', () => {
  const S = ' '.repeat(2400);
  for (const goal of [';'.repeat(40) + 'о', ','.repeat(40) + 'о', ';'.repeat(4999) + 'о',
    'не подключай' + (' '.repeat(8) + 'пожалуйста').repeat(4) + ' '.repeat(8) + '! Luma 4 — слоган',
    'x' + S + ';' + S + 'о', 'Luma' + S + S + 'о', 'всем' + S + S + 'о', 'Luma 2' + S + 'о Luma 4 — слоган',
    'не подключай' + S + '! Luma 4 — слоган', 'Luma 4 — x' + S + 'о', 'никого '.repeat(700) + ': Luma 4 — слоган',
    'не '.repeat(1600) + ': Luma 4 — слоган', '1'.repeat(4999) + 'о',
    'не подключай' + (' '.repeat(48) + 'пожалуйста').repeat(4) + ' '.repeat(48) + '! Luma 4 — слоган',
    'Luma 4 — x' + ','.repeat(4988) + 'о', 'Всем специалистам: ' + '1'.repeat(4979) + 'о']) {
    assert.ok(parsesQuickly(goal), `${JSON.stringify(goal.slice(0, 30))}… (${goal.length} символов)`);
  }
  // Хвост из разделителей по-прежнему убирается, как до исправления.
  assert.equal(parseAssignments('Сделай план;;; ,,').context, 'Сделай план');
  assert.equal(parseAssignments('Сделай план: ;, .').context, 'Сделай план.');
});

// Квадратичный разбор на 5000 символах — 0.2–0.4 с, от порога с запуском процесса его не отличить. В десять раз
// длиннее (самих функций лимит не касается) квадратичное выражение работает 10–40 с, линейное — десятки мс.
test('очистка хвоста, «никого … кроме», «не» и арифметика линейны: в 10 раз длиннее лимита — быстро', () => {
  const N = 50000;
  for (const goal of ['Luma 4 — x' + ','.repeat(N) + 'о', 'никого '.repeat(N / 7) + ': Luma 4 — слоган',
    'не '.repeat(N / 3) + ': Luma 4 — слоган', 'Всем специалистам: ' + '1'.repeat(N) + 'о']) {
    assert.ok(parsesQuickly(goal, 3000), `${JSON.stringify(goal.slice(0, 30))}… (${goal.length} символов)`);
  }
});

test('повторное упоминание сотрудника не дописывает поручение повторно', () => {
  assert.deepEqual(parseAssignments('Luma 4 — другое; Luma 4 и Luma 4 и Luma 4 — слоган').assignments, { creator: 'другое; слоган' });
  const big = 'Luma 4 — другое; ' + 'Luma 4 и '.repeat(260) + ' — ' + 'о'.repeat(2400);
  assert.ok(parseAssignments(normalizeGoal(big)).assignments.creator.length < 3000, 'раньше — 625 тыс. символов в запрос модели');
});

test('«ни одного … кроме» через перенос строки: только названный сотрудник', () => {
  const route = routeByExplicit(normalizeGoal('Не назначай ни\nодного сотрудника, кроме Luma 4. Нужен слоган для кофейни.'));
  assert.deepEqual(route.agentIds, ['creator']);
  assert.deepEqual(route.excluded.sort(), ['finance', 'product', 'research', 'sales']);
});

test('normalizeGoal: серии пробелов — один пробел, переносы — не больше двух подряд, смысл задачи тот же', () => {
  assert.equal(normalizeGoal('  Luma 4\t\t—   слоган\r\n\r\n\r\n\r\nLuma 2 — рынок  '), 'Luma 4 — слоган\n\nLuma 2 — рынок');
  assert.equal(normalizeGoal('1. Рынок\n2. Слоган'), '1. Рынок\n2. Слоган');
  const goal = 'Luma 2 —   3 группы клиентов;   Luma 4 —\tслоган';
  assert.deepEqual(routeByExplicit(normalizeGoal(goal))?.agentIds, routeByExplicit(goal)?.agentIds);
});

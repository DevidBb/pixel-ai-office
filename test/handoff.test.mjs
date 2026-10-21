import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { Limiter } from '../server/llm.mjs';
import {
  AGENTS, routeByRules, buildPlan, agentMessages, foreignAttributions, attributionBlock,
  handoffEnabled, handoffGraph, compactHandoffs, handoffBlock, handoffDigest, HANDOFF_SOURCE_CHARS, HANDOFF_TOTAL_CHARS
} from '../server/office.mjs';
import { COFFEE_GOAL, COFFEE_ASSIGNMENTS } from './fixtures.mjs';

const baseEnv = { OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_MODEL: 'mock' };
const STARTUP_GOAL = 'Запуск стартапа с нуля: сервис доставки кофе в офисы';
const agent = id => AGENTS.find(a => a.id === id);
const planFor = goal => buildPlan(goal, routeByRules(goal));

// --- Чистые функции ---

test('handoffGraph: полная команда — исследование → продукт → креатив/продажи → финансы', () => {
  const graph = handoffGraph(planFor(STARTUP_GOAL));
  assert.deepEqual(graph, {
    research: [],
    product: ['research'],
    creator: ['product', 'research'],
    sales: ['research', 'product'],
    finance: ['product', 'sales', 'research']
  });
});

test('handoffGraph: зависимости только между сотрудниками из плана', () => {
  const graph = handoffGraph(planFor('Luma 4 — слоган; Luma 6 — выручка 30 × 3 €'));
  assert.deepEqual(graph, { creator: [], finance: [] });
  assert.deepEqual(handoffGraph(planFor('Luma 6 — выручка; Luma 2 — 3 группы клиентов')), { finance: ['research'], research: [] });
});

test('handoffGraph: без циклов — топологический порядок обходит всех', () => {
  const graph = handoffGraph(planFor(STARTUP_GOAL));
  const done = new Set();
  for (let round = 0; round < AGENTS.length && done.size < AGENTS.length; round++) {
    for (const [id, sources] of Object.entries(graph)) if (sources.every(s => done.has(s))) done.add(id);
  }
  assert.equal(done.size, AGENTS.length);
  const order = id => AGENTS.findIndex(a => a.id === id);
  for (const [id, sources] of Object.entries(graph)) for (const s of sources) assert.ok(order(s) < order(id), `${s} → ${id}`);
});

test('handoffEnabled: auto — только ролевые задания и LLM_CONCURRENCY=1; true/false — всегда/никогда', () => {
  const roleBased = planFor(STARTUP_GOAL);
  const coffee = planFor(COFFEE_GOAL);
  const single = planFor('Придумай один слоган для кофейни');
  assert.equal(handoffEnabled(roleBased, 'auto', 1), true);
  assert.equal(handoffEnabled(roleBased, 'auto', 2), false, 'при параллельности цепочка съела бы выигрыш');
  assert.equal(handoffEnabled(coffee, 'auto', 1), false, 'адресные задания независимы');
  assert.equal(handoffEnabled(coffee, true, 1), true);
  assert.equal(handoffEnabled(roleBased, false, 1), false);
  assert.equal(handoffEnabled(single, true, 1), false);
  assert.equal(readConfig(baseEnv).handoff, 'auto');
  assert.equal(readConfig({ ...baseEnv, HANDOFF: 'false' }).handoff, false);
  assert.equal(readConfig({ ...baseEnv, HANDOFF: 'true' }).handoff, true);
});

test('compactHandoffs: без <think>, обрезка по источнику и общий лимит, пустые пропускаются', () => {
  const long = Array.from({ length: 40 }, (_, i) => `${i + 1}. Сегмент номер ${i + 1}`).join('\n');
  const handoffs = compactHandoffs([
    { agentId: 'research', result: `<think>рассуждаю</think>${long}` },
    { agentId: 'sales', result: '   ' },
    { agentId: 'product', result: `ТВОЁ ЗАДАНИЕ: сделать лучше\n${long}` },
    { agentId: 'creator', result: long }
  ]);
  assert.deepEqual(handoffs.map(h => h.agentId), ['research', 'product']);
  assert.ok(handoffs.every(h => h.text.length <= HANDOFF_SOURCE_CHARS && h.text.endsWith('…')));
  assert.ok(handoffs.reduce((sum, h) => sum + h.text.length, 0) <= HANDOFF_TOTAL_CHARS);
  assert.ok(!handoffs[0].text.includes('think') && handoffs[0].text.startsWith('- Сегмент номер 1\n'));
  assert.ok(!/ТВОЁ ЗАДАНИЕ/.test(handoffs[1].text), 'чужой текст не выглядит как новое задание');
});

test('handoffDigest: оговорка «цены ниже — гипотезы» не теряется — у каждой цены статус [гипотеза]', () => {
  assert.equal(handoffDigest('Допущение: цены ниже — гипотезы, их ещё не проверяли.\nКапучино — 3 €\nЛатте — 4 €'),
    '- Капучино — 3 € [гипотеза]\n- Латте — 4 € [гипотеза]');
  // Оговорка относится к своему блоку: после пустой строки или заголовка данные снова без статуса.
  assert.equal(handoffDigest('Допущение: цены ниже не проверены.\n- Капучино — 3 €\n\nВыручка: 90 €'),
    '- Капучино — 3 € [гипотеза]\n- Выручка: 90 €');
  // Оговорка с условием сама остаётся данными.
  assert.equal(handoffDigest('Допущение: цены ниже — при закупке зерна по 20 € за кг.\n- Латте — 4 €'),
    '- Цены ниже — при закупке зерна по 20 € за кг [гипотеза]\n- Латте — 4 € [гипотеза]');
});

test('handoffDigest: факт, гипотеза и оценка различаются; общая оговорка в конце — о пунктах выше', () => {
  assert.equal(handoffDigest('**Факт:** Студенты — основная аудитория.\n- **Допущение:** 30 гостей в день.\n- Выручка примерно 2 700 € в месяц.\n- Средний чек 4 €'),
    '- Студенты — основная аудитория [факт]\n- 30 гостей в день [гипотеза]\n- Выручка примерно 2 700 € в месяц\n- Средний чек 4 €',
    'оценку видно по «примерно»; у пункта без пометки статус не выдумывается');
  const research = '**3 группы клиентов:**\n- **Факт:** Студенты — рядом с кофейней.\n1. Преподаватели — днём.\n2. Соседи — вечером, допущение: живут рядом.\n\nдопущение: данные основаны на общем поведении.';
  assert.equal(handoffDigest(research),
    '3 группы клиентов:\n- Студенты — рядом с кофейней [факт]\n- Преподаватели — днём [гипотеза]\n- Соседи — вечером, допущение: живут рядом',
    'своя пометка пункта сильнее общей оговорки; пометка уже в тексте — без повтора');
  // Источник только из допущения — это тоже данные со статусом.
  assert.equal(handoffDigest('Допущение: спрос есть.'), '- Спрос есть [гипотеза]');
});

test('handoffDigest: раздел «Гипотезы:» или «Оценка выручки:» — статус у пунктов раздела', () => {
  assert.equal(handoffDigest('**Гипотезы:**\n- Студенты берут латте\n- Преподаватели — днём\n\n**Напитки:**\n- Капучино — 3 €'),
    '- Студенты берут латте [гипотеза]\n- Преподаватели — днём [гипотеза]\nНапитки:\n- Капучино — 3 €');
  assert.equal(handoffDigest('Оценка выручки:\n- 30 гостей × 3 € = 90 € в день\nНапитки:\n- Латте — 4 €'),
    'Оценка выручки:\n- 30 гостей × 3 € = 90 € в день [оценка]\nНапитки:\n- Латте — 4 €');
});

test('handoffDigest: строка с числами, условиями и ограничениями — целиком; сокращается только описание', () => {
  const digest = line => handoffDigest(line).replace(/^- /, '');
  // Данные не режутся: в списке слов условий всегда чего-то не хватит («с мая по сентябрь», «до конца месяца»).
  for (const line of [
    'Преподаватели — приходят днём, 2–3 раза в неделю, средний чек 4 €, любят тишину и уютную атмосферу для работы',
    'Скидка 10 % для студентов — действует только по будням до 10:00, при покупке двух напитков, очень выгодная акция для всех',
    'Латте на овсяном молоке — мягкий вкус, для тех, кто не пьёт коровье молоко, объём 350 мл, цена 4 €',
    'Выручка в первый месяц: 30 гостей × 3 € × 30 дней = 2 700 € при условии, что кофейня работает без выходных и праздников',
    'Выручка — 2 700 € в месяц при условии, что кофейня работает ежедневно и все гости покупают кофе по полной цене',
    'Выручка — 30 гостей в день × 3 € за чашку × 30 рабочих дней при стабильном потоке студентов и преподавателей в течение первого месяца = 2 700 €',
    'Мороженое-фраппе — освежающий напиток для жаркой погоды, продаётся с мая по сентябрь, хорошо идёт с выпечкой',
    'Акция «Приведи друга» — второй кофе для друга, действует до конца месяца, помогает быстро набрать постоянных гостей',
    'Средний чек — четыре евро на гостя, чаще всего берут капучино с выпечкой или сэндвичем',
    'Скидка для студентов только по будням при покупке двух напитков и до конца первого семестра',
    'Способ привлечения: Листовки у входа в университет, 500 штук в первую неделю за 20 €',
    'Объём порции — стандартный стакан для студентов и преподавателей университета, двести миллилитров',
    'Доставка — удобный способ получить кофе прямо к началу занятий в университете, доступна после обеда'
  ]) assert.equal(digest(`${line}.`), line);
  // Перечисление после тире — целиком: это и есть данные.
  assert.equal(digest('Клиенты — студенты, преподаватели, ученые, которые посещают университет.'), 'Клиенты — студенты, преподаватели, ученые, которые посещают университет');
  assert.equal(digest('Сегменты — студенты, преподаватели, аспиранты, сотрудники офисов рядом, жители района.'), 'Сегменты — студенты, преподаватели, аспиранты, сотрудники офисов рядом, жители района');
  assert.equal(digest('**Допущение**: Предложить специальные предложения для первых клиентов (например, приветственные скидки, бесплатный кофе).'),
    'Предложить специальные предложения для первых клиентов (например, приветственные скидки, бесплатный кофе) [гипотеза]');
  // Описание без данных — коротко по словам: маленькая модель переписывала такие строки к себе.
  assert.equal(digest('1. Группа студентов — регулярные посетители, ценящие качественный вкус и доступную цену.'), 'Группа студентов — регулярные посетители, ценящие качественный вкус…');
  assert.equal(digest('1. Капучино — напиток, который подходит для студентов и офисных работников из-за его удобства и вкуса.'), 'Капучино — напиток, который подходит для студентов и офисных…');
  assert.equal(digest('**Факт:** Студенты и преподаватели — основная аудитория для кофейни возле университета.'),
    'Студенты и преподаватели — основная аудитория для кофейни возле университета [факт]');
  assert.equal(digest('**Допущение:** Клиенты будут преимущественно студентами, преподавателями и учителями.'),
    'Клиенты будут преимущественно студентами, преподавателями и учителями [гипотеза]');
  const long = digest('Очень длинное описание напитка с яркими нотами которое продолжается и продолжается дальше чем нужно для коллеги и для всех');
  assert.ok(long.length <= 102 && long.endsWith('…'), long);
  assert.equal(handoffDigest('<think>x</think>\n   \n'), '');
});

test('handoffDigest: оговорка «ниже» переживает пустые строки внутри списка и заголовок сразу после неё', () => {
  assert.equal(handoffDigest('Допущение: цены ниже не проверены.\n\n1. Капучино — 3 €\n\n2. Латте — 4 €'), '- Капучино — 3 € [гипотеза]\n- Латте — 4 € [гипотеза]');
  assert.equal(handoffDigest('**Допущение:** цены ниже — примерные.\n**Напитки:**\n- Капучино — 3 €'), 'Напитки:\n- Капучино — 3 € [гипотеза]');
  assert.equal(handoffDigest('Допущение: цены ниже — примерные.\n\n### Напитки\n- Капучино — 3 €'), 'Напитки:\n- Капучино — 3 € [гипотеза]');
  // Пункт со своей пометкой тоже в области оговорки: следующий заголовок её закрывает.
  assert.equal(handoffDigest('Допущение: цены ниже не проверены.\n### Напитки\n- Оценка: латте — 4 €\n### Выручка\n- 90 € в день'),
    'Напитки:\n- Латте — 4 € [оценка]\nВыручка:\n- 90 € в день', 'своя пометка сильнее общей оговорки');
  // После пунктов заголовок закрывает оговорку.
  assert.equal(handoffDigest('Допущение: цены ниже — примерные.\n- Капучино — 3 €\n### Выручка\n- 90 € в день'), '- Капучино — 3 € [гипотеза]\nВыручка:\n- 90 € в день');
  // Жирная строка с данными или пометкой статуса — пункт, а не заголовок.
  assert.equal(handoffDigest('**Допущение: 30 гостей в день**\n- Выручка: 90 €'), '- 30 гостей в день [гипотеза]\n- Выручка: 90 €');
  assert.equal(handoffDigest('**Итого: 2 700 € в месяц**'), '- Итого: 2 700 € в месяц');
});

test('handoffDigest: [факт] — только по явной пометке; «Возможности», «Оценка конкурентов» — не статус', () => {
  assert.equal(handoffDigest('Факторы:\n- Низкая цена\n- Близость к университету'), 'Факторы:\n- Низкая цена\n- Близость к университету');
  assert.equal(handoffDigest('**Факты и допущения:**\n- 30 гостей в день'), '- 30 гостей в день [гипотеза]');
  assert.equal(handoffDigest('Фактически: студенты приходят утром.'), '- Фактически: студенты приходят утром');
  assert.equal(handoffDigest('Возможности:\n- Доставка в аудитории'), 'Возможности:\n- Доставка в аудитории');
  assert.equal(handoffDigest('Оценка конкурентов:\n- Рядом две кофейни'), 'Оценка конкурентов:\n- Рядом две кофейни');
  // «спрос основан на …» — сама гипотеза, а не оговорка о других строках.
  assert.equal(handoffDigest('Допущение: спрос основан на близости университета.\n- Латте — 4 €'), '- Спрос основан на близости университета [гипотеза]\n- Латте — 4 €');
  // Примечание о статусе всех данных — оговорка о пунктах выше.
  assert.equal(handoffDigest('- Латте — 4 €\n- Капучино — 3 €\n*Примечание: все данные — предположения*'), '- Латте — 4 € [гипотеза]\n- Капучино — 3 € [гипотеза]');
});

test('handoffDigest: заголовки Markdown и строки жирным — заголовки разделов, линии «---» пропускаются, цитаты не режутся', () => {
  const answer = '**Исследователь рынка**\n\n---\n\n### **Клиенты**\n- **Допущение:** Клиенты — студенты.\n---\n### Слоган\n- «Кофе для студентов, преподавателей и учителей — вкусно, доступно и в твоем месте рядом с парами.»\n- **Призыв к действию** – "Попробуйте, получите скидку на первый месяц и приведите друга с курса!"';
  assert.equal(handoffDigest(answer),
    'Исследователь рынка:\nКлиенты:\n- Клиенты — студенты [гипотеза]\nСлоган:\n- «Кофе для студентов, преподавателей и учителей — вкусно, доступно и в твоем месте рядом с парами.»\n- Призыв к действию – "Попробуйте, получите скидку на первый месяц и приведите друга с курса!"');
  // Заголовок «Гипотезы» жирным без двоеточия — тоже раздел со статусом.
  assert.equal(handoffDigest('**Гипотезы**\n- Латте — 4 €'), '- Латте — 4 € [гипотеза]');
});

test('handoffDigest: замечания проверки — осторожное слово сильнее «Факт:», сравнительное «ниже», разделы и длинные условия', () => {
  // Пометки [факт] нет: осторожное слово осталось в тексте и само говорит о статусе.
  assert.equal(handoffDigest('Факт: возможно 30 гостей в день.'), '- Возможно 30 гостей в день');
  assert.equal(handoffDigest('Факт: примерно 30 гостей в день.'), '- Примерно 30 гостей в день');
  assert.equal(handoffDigest('Факт: 30 гостей в день — оценка по соседней кофейне.'), '- 30 гостей в день — оценка по соседней кофейне');
  // «ниже рынка» — сравнение, а не ссылка на следующие строки.
  assert.equal(handoffDigest('Допущение: цены ниже рынка на 20 %.\nФактическая выручка 90 €'), '- Цены ниже рынка на 20 % [гипотеза]\n- Фактическая выручка 90 €');
  assert.equal(handoffDigest('- Капучино — 3 €\nДопущение: цены выше рынка.\n- Латте — 4 €'), '- Капучино — 3 €\n- Цены выше рынка [гипотеза]\n- Латте — 4 €');
  // Пункт раздела «Факты:» общая оговорка в конце не перекрашивает.
  assert.equal(handoffDigest('Факты:\n- Гостей 30\n\nГипотезы:\n- Средний чек 4 €\nДопущение: эти данные не проверены.'), '- Гостей 30 [факт]\n- Средний чек 4 € [гипотеза]');
});

test('compactHandoffs: от коллеги — его раздел, если он есть; обычные ответы трёх коллег доходят до финансиста целиком', () => {
  const product = 'Продуктолог:\n- Результат: план\n### Клиенты\n- Студенты — основная аудитория, приходят утром и днём между парами\n### Напитки\n1. Капучино — 3 €\n2. Латте — 4 €\n### Меню\n- Круассан — 2 €\n### Слоган\n«Кофе между парами»';
  const [handoff] = compactHandoffs([{ agentId: 'product', result: product }]);
  assert.equal(handoff.text, 'Напитки:\n- Капучино — 3 €\n- Латте — 4 €\nМеню:\n- Круассан — 2 €', 'финансисту нужны напитки продуктолога, а не его пересказ клиентов');
  // Подразделы («Холодные») — часть своего раздела; пункты до первого заголовка (условия цен) — тоже передаются.
  const nested = 'Допущение: цены ниже — при закупке зерна по 20 € за кг.\n### Напитки\n#### Горячие\n- Латте — 4 €\n#### Холодные\n- Лимонад — 3 €\n### Клиенты\n- Студенты';
  assert.equal(compactHandoffs([{ agentId: 'product', result: nested }])[0].text,
    '- Цены ниже — при закупке зерна по 20 € за кг [гипотеза]\nНапитки:\nГорячие:\n- Латте — 4 € [гипотеза]\nХолодные:\n- Лимонад — 3 € [гипотеза]');
  // Нет своего раздела — сводка целиком.
  assert.equal(compactHandoffs([{ agentId: 'creator', result: '### Клиенты\n- Студенты' }])[0].text, 'Клиенты:\n- Студенты');
  const handoffs = compactHandoffs([
    { agentId: 'product', result: '1. Капучино — 3 €, самый популярный у студентов\n2. Латте — 4 €\n3. Раф — 4,5 €, допущение: спрос есть' },
    { agentId: 'sales', result: '1. Листовки у входа — 500 штук за 20 €\n2. Скидка 10 % студентам до 10:00\nДопущение: отклик 5 %.' },
    { agentId: 'research', result: '1. Студенты — утром, средний чек 3 €\n2. Преподаватели — днём, средний чек 4 €\n3. Сотрудники соседних офисов — после 18:00, средний чек 3,5 €' }
  ]);
  assert.deepEqual(handoffs.map(h => h.agentId), ['product', 'sales', 'research']);
  assert.ok(handoffs.every(h => !h.text.endsWith('…')), 'ничего не обрезано');
  assert.match(handoffs[2].text, /Сотрудники соседних офисов — после 18:00, средний чек 3,5 €/);
});

test('compactHandoffs: статусы данных доходят до коллеги вместе с цифрами', () => {
  const [handoff] = compactHandoffs([{ agentId: 'product', result: 'Допущение: цены ниже — гипотезы, их ещё не проверяли.\n1. Капучино — 3 €\n2. Латте — 4 €' }]);
  assert.equal(handoff.text, '- Капучино — 3 € [гипотеза]\n- Латте — 4 € [гипотеза]');
});

test('agentMessages: данные коллеги — помеченный блок перед заданием, формат «ТВОЁ ЗАДАНИЕ» сохранён', () => {
  const plan = planFor(COFFEE_GOAL);
  const task = plan.tasks.find(t => t.agentId === 'finance');
  const handoffs = [{ agentId: 'sales', text: '1. Листовки\n2. Скидка' }];
  const [system, user] = agentMessages(agent('finance'), task, plan, handoffs);
  assert.match(user.content, /ДАННЫЕ ОТ КОЛЛЕГИ \(Luma 5 · Менеджер продаж\), используй как вход, не переписывай и не приписывай себе:\n1\. Листовки\n2\. Скидка\n\nСделай свою часть своими словами: строки коллег не переписывай\.\n\nТВОЁ ЗАДАНИЕ:\nвыручка 30 × 3 €\n/);
  assert.match(user.content, /КАЛЬКУЛЯТОР ОФИСА.*30 × 3 = 90/, 'калькулятор на месте');
  assert.ok(user.content.indexOf('ДАННЫЕ ОТ КОЛЛЕГИ') < user.content.indexOf('ТВОЁ ЗАДАНИЕ'));
  assert.match(system.content, /не упоминай других сотрудников/);
  // Без передачи подсказка в точности прежняя.
  assert.deepEqual(agentMessages(agent('finance'), task, plan, []), agentMessages(agent('finance'), task, plan));
  const roleBased = planFor(STARTUP_GOAL);
  const [, roleUser] = agentMessages(agent('sales'), roleBased.tasks.find(t => t.agentId === 'sales'), roleBased, handoffs);
  assert.match(roleUser.content, /ЦЕЛЬ ПОЛЬЗОВАТЕЛЯ:\n.*\n\nДАННЫЕ ОТ КОЛЛЕГИ \(Luma 5[^\n]*\n1\. Листовки\n2\. Скидка\n\nСделай свою часть[^\n]*\n\nТВОЯ ЗАДАЧА:/);
  assert.equal(handoffBlock([]), '');
});

test('handoffBlock: есть пометки статуса — сотрудник знает, что гипотезы и оценки коллег не факты', () => {
  const tagged = handoffBlock([{ agentId: 'product', text: '- Капучино — 3 € [гипотеза]' }]);
  assert.match(tagged, /\[гипотеза\]\n\nСделай свою часть своими словами: строки коллег не переписывай\. В квадратных скобках — статус данных у коллеги: гипотезы и оценки не выдавай за факты, а если опираешься на них, так и пометь\.\n\n$/);
  assert.doesNotMatch(handoffBlock([{ agentId: 'product', text: '- Капучино — 3 €' }]), /статус данных/, 'без пометок — без лишних токенов');
});

test('foreignAttributions: имя коллеги, чьи данные переданы явно, — не «пишет за команду»', () => {
  const text = 'По данным Luma 2 студенты — основной сегмент. Luma 4 пусть сделает слоган.';
  assert.deepEqual(foreignAttributions('sales', text), ['Luma 2', 'Luma 4']);
  assert.deepEqual(foreignAttributions('sales', text, ['research']), ['Luma 4']);
  assert.deepEqual(foreignAttributions('sales', text, ['research', 'creator']), []);
});

test('attributionBlock: отметка «с данными от …» детерминированная, по outcome.handoffFrom', () => {
  const plan = planFor(STARTUP_GOAL);
  const block = attributionBlock(plan, [
    { agentId: 'research', result: 'x' },
    { agentId: 'sales', result: 'y', handoffFrom: ['research'] },
    { agentId: 'finance', error: 'тайм-аут' }
  ]);
  assert.match(block, /✅ Luma 2 · Исследователь рынка: результат получен\n/);
  assert.match(block, /✅ Luma 5 · Менеджер продаж: результат получен \(с данными от Luma 2\)/);
  assert.match(block, /❌ Luma 6 · Финансовый аналитик: не выполнено \(тайм-аут\)/);
});

// --- HTTP с мок-моделью ---

function mockModel({ answers = {}, fail = [], concurrency = 1 } = {}) {
  const calls = [];
  const limiter = new Limiter(concurrency);
  let clock = 0;
  async function callModel(messages, opts = {}) {
    const agentId = opts.label.split('/')[1];
    const call = { agentId, label: opts.label, messages, maxTokens: opts.maxTokens, calledAt: clock++ };
    calls.push(call);
    await limiter.acquire(opts.signal, 5_000);
    try {
      opts.onStart?.();
      await new Promise(resolve => setTimeout(resolve, 5));
      if (fail.includes(agentId)) throw new Error('тайм-аут');
      call.doneAt = clock++;
      if (agentId === 'ceo-summary') return { text: 'СВОДКА CEO', stats: {} };
      if (answers[agentId]) return { text: answers[agentId], stats: { outputTokens: 5 } };
      const task = messages[1].content.match(/ТВОЁ ЗАДАНИЕ:\n(.*)/);
      return { text: `ОТВЕТ ${agentId}: ${task ? task[1] : 'общая задача'}`, stats: { outputTokens: 5 } };
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
const userPrompt = (model, agentId) => model.calls.find(c => c.agentId === agentId).messages[1].content;

test('HANDOFF=auto, ролевая задача: зависимые ждут источники и получают помеченные данные', async () => {
  const model = mockModel({ answers: { research: 'Сегменты: офисы IT-компаний, коворкинги.' } });
  const events = await execute(STARTUP_GOAL, model);
  const results = ofType(events, 'agent-result');
  assert.equal(results.length, 5);
  const resultAt = id => events.findIndex(e => e.type === 'agent-result' && e.agentId === id);
  const startAt = id => events.findIndex(e => e.type === 'agent-start' && e.agentId === id);
  const graph = handoffGraph(planFor(STARTUP_GOAL));
  for (const [id, sources] of Object.entries(graph)) {
    for (const s of sources) {
      assert.ok(resultAt(s) < startAt(id), `${id} стартовал раньше результата ${s}`);
      const call = model.calls.find(c => c.agentId === id);
      assert.ok(model.calls.find(c => c.agentId === s).doneAt < call.calledAt, `${id} вызван до готовности ${s}`);
    }
  }
  assert.match(userPrompt(model, 'sales'), /ДАННЫЕ ОТ КОЛЛЕГИ \(Luma 2 · Исследователь рынка\), используй как вход, не переписывай и не приписывай себе:\n- Сегменты: офисы IT-компаний, коворкинги\n\nДАННЫЕ ОТ КОЛЛЕГИ \(Luma 3 · Продуктолог\)[^\n]*\n- ОТВЕТ product: общая задача\n\nСделай свою часть своими словами[^\n]*\n\nТВОЯ ЗАДАЧА:/);
  assert.ok(!userPrompt(model, 'research').includes('ДАННЫЕ ОТ КОЛЛЕГИ'), 'у исследователя источников нет');
  // Журнал: кто чьи данные получил; в результате — список источников.
  const logs = ofType(events, 'log').map(e => e.message);
  assert.ok(logs.includes('Luma 5 получил данные от Luma 2, Luma 3.'));
  assert.ok(logs.includes('Luma 6 получил данные от Luma 3, Luma 5, Luma 2.'));
  assert.ok(logs.some(m => /^CEO связал работу команды: .*Luma 2 → Luma 3/.test(m)));
  assert.deepEqual(results.find(e => e.agentId === 'sales').handoffFrom, ['research', 'product']);
  assert.equal(results.find(e => e.agentId === 'research').handoffFrom, undefined);
  const waiting = events.find(e => e.type === 'agent-status' && e.agentId === 'finance' && e.status === 'idle');
  assert.equal(waiting.task, 'Задание получено, ждёт данные от Luma 3, Luma 5, Luma 2');
  assert.match(ofType(events, 'final')[0].result, /✅ Luma 5 · Менеджер продаж: результат получен \(с данными от Luma 2, Luma 3\)/);
});

test('HANDOFF: упоминание источника не даёт ложного предупреждения, чужое имя — даёт', async () => {
  const model = mockModel({ answers: { sales: 'Опираюсь на сегменты Luma 2: пишем коворкингам.', creator: 'Как сказал Luma 5, слоган для офисов.' } });
  const events = await execute(STARTUP_GOAL, model);
  const results = ofType(events, 'agent-result');
  assert.deepEqual(results.find(e => e.agentId === 'sales').foreign, []);
  assert.deepEqual(results.find(e => e.agentId === 'creator').foreign, ['Luma 5'], 'Luma 5 не передавал данных креатору');
  const warnings = ofType(events, 'log').filter(e => e.kind === 'warning' && /упомянуты другие сотрудники/.test(e.message));
  assert.deepEqual(warnings.map(e => e.agentId), ['creator']);
});

test('HANDOFF по умолчанию, кофейня (адресные задания): никаких данных коллег, все стартуют сразу', async () => {
  const model = mockModel();
  const events = await execute(COFFEE_GOAL, model);
  assert.equal(model.calls.length, 5);
  for (const call of model.calls) assert.ok(!call.messages[1].content.includes('ДАННЫЕ ОТ КОЛЛЕГИ'), call.agentId);
  const firstResult = model.calls.map(c => c.doneAt).sort((a, b) => a - b)[0];
  assert.ok(model.calls.every(c => c.calledAt < firstResult), 'все задания выданы до первого результата');
  assert.ok(!ofType(events, 'log').some(e => /получил данные/.test(e.message)));
  for (const event of ofType(events, 'agent-result')) assert.equal(event.result, `ОТВЕТ ${event.agentId}: ${COFFEE_ASSIGNMENTS[event.agentId]}`);
});

test('HANDOFF=true, кофейня: финансист получает данные, задание и калькулятор на месте', async () => {
  const model = mockModel();
  const events = await execute(COFFEE_GOAL, model, { HANDOFF: 'true' });
  const finance = userPrompt(model, 'finance');
  assert.match(finance, /ДАННЫЕ ОТ КОЛЛЕГИ \(Luma 3 · Продуктолог\)[^\n]*\n- ОТВЕТ product: 3 напитка\n/);
  assert.match(finance, /ТВОЁ ЗАДАНИЕ:\nвыручка 30 × 3 €\n/);
  assert.match(finance, /30 × 3 = 90/);
  assert.equal(ofType(events, 'agent-result').find(e => e.agentId === 'finance').result, 'ОТВЕТ finance: выручка 30 × 3 €');
});

test('HANDOFF=true: независимые (креатор и продажи) стартуют сразу, без ожидания друг друга', async () => {
  const model = mockModel();
  await execute('Luma 4 — слоган; Luma 5 — 2 способа привлечения', model, { HANDOFF: 'true' });
  assert.equal(model.calls.length, 2);
  assert.ok(model.calls.every(c => c.calledAt < Math.min(...model.calls.map(x => x.doneAt))));
  assert.ok(model.calls.every(c => !c.messages[1].content.includes('ДАННЫЕ ОТ КОЛЛЕГИ')));
});

test('HANDOFF: сбой источника — зависимый работает без данных и честно пишет об этом', async () => {
  const model = mockModel({ fail: ['research'] });
  const events = await execute(STARTUP_GOAL, model);
  assert.ok(!userPrompt(model, 'product').includes('ДАННЫЕ ОТ КОЛЛЕГИ'));
  assert.ok(ofType(events, 'log').some(e => e.agentId === 'product' && e.kind === 'warning' && e.message === 'Данных от Luma 2 нет — Luma 3 работает без них.'));
  const final = ofType(events, 'final')[0];
  assert.deepEqual(final.failedAgents, ['research']);
  assert.match(final.result, /✅ Luma 3 · Продуктолог: результат получен\n/);
});

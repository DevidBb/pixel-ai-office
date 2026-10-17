// Состав офиса, маршрутизация CEO и тексты заданий. Чистые функции без вызовов модели.

export const AGENTS = [
  { id: 'research', name: 'Luma 2', role: 'Исследователь рынка', focus: 'Проверяй спрос, сегменты клиентов, конкурентов и источники. Отделяй факты от гипотез.' },
  { id: 'product', name: 'Luma 3', role: 'Продуктолог', focus: 'Создавай конкретное предложение, состав услуги/продукта, цену-гипотезу и критерии результата.' },
  { id: 'creator', name: 'Luma 4', role: 'Креатор', focus: 'Создавай полезные демонстрации, тексты, сценарии или другие реальные материалы для проверки идеи.' },
  { id: 'sales', name: 'Luma 5', role: 'Менеджер продаж', focus: 'Предлагай честную стратегию привлечения клиентов, персональные сообщения и следующие шаги. Ничего не отправляй автоматически.' },
  { id: 'finance', name: 'Luma 6', role: 'Финансовый аналитик', focus: 'Рассчитывай выручку, затраты, маржу и риски с явными допущениями. Не выдавай прогноз за факт.' }
];
export const CEO = { id: 'ceo', name: 'Luma 1', role: 'CEO · Руководитель' };

const agentById = id => AGENTS.find(a => a.id === id);
const agentByNumber = number => [CEO, ...AGENTS].find(a => a.name === `Luma ${number}`);

// Ключевые слова для быстрой маршрутизации без вызова модели (корни слов, нижний регистр).
const ROUTING_KEYWORDS = {
  research: ['рынок', 'рынк', 'конкурент', 'спрос', 'аудитори', 'сегмент', 'исследова', 'ниш', 'тренд', 'целев', 'опрос', 'market', 'competitor'],
  product: ['продукт', 'оффер', 'услуг', 'mvp', 'функци', 'тариф', 'упаков', 'ценност', 'фич', 'прототип', 'требовани', 'product'],
  creator: ['текст', 'пост', 'сценари', 'стать', 'слоган', 'контент', 'креатив', 'назван', 'лендинг', 'описани', 'видео', 'стих', 'истори', 'напиши', 'сочини', 'придумай'],
  sales: ['продаж', 'продат', 'клиент', 'письм', 'сообщени', 'холодн', 'переговор', 'воронк', 'лид', 'скрипт', 'привлеч', 'рассылк', 'sales'],
  finance: ['выручк', 'затрат', 'марж', 'бюджет', 'расход', 'окупаем', 'прибыл', 'юнит', 'финанс', 'себестоимост', 'рассчита', 'посчита', 'доход', 'деньг', 'стоимост']
};
const COMPLEX_MARKERS = ['бизнес', 'стартап', 'запуст', 'запуск', 'с нуля', 'комплексн', 'полный план', 'стратеги', 'всей команд', 'все специалист'];

// Явная просьба подключить всю команду: «всеми пятью специалистами», «всем сотрудникам», «всем пятерым».
const ALL_TEAM_PATTERNS = [
  /(?<!\p{L})(?:все|всем|всеми|всех|всей)\s+(?:(?:пят\p{L}*|5)\s+)?(?:специалист|сотрудник|команд|агент|исполнител)\p{L}*/iu,
  /(?<!\p{L})(?:все|всем|всеми|всех|всей)\s+(?:пятью|пятер\p{L}*|пятёр\p{L}*)/iu
];

// Упоминание сотрудника по имени («Luma 4», «Люма 4») или по роли с разделителем («Креатор — слоган»).
const NAME = String.raw`(?:luma|люма)\s*[#№]?\s*`;
const NAME_MENTION = new RegExp(String.raw`(?<![\p{L}\d])(?:luma|люма)\s*[-#№]?\s*([1-6])(?!\d)`, 'giu');
// Диапазон: «Luma 2–6», «Luma 2…6», «Luma 2 — Luma 6», «с Luma 2 по Luma 6».
// Тире с пробелами без второго имени («Luma 2 — 3 группы») — это поручение, а не диапазон.
const RANGE_MENTION = new RegExp(
  String.raw`(?<![\p{L}\d])(?:с\s+)?${NAME}([1-6])(?:(?:[-–—]|\.{2,3}|…)(?:${NAME})?([1-6])|\s*(?:[-–—]|\.{2,3}|…|по|до)\s*${NAME}([1-6]))(?!\d)`,
  'giu'
);
const ROLE_MENTIONS = [
  ['research', /(?<!\p{L})(?:исследовател\p{L}*(?:\s+рынка)?|аналитик\p{L}*\s+рынка)\s*(?=[:—–-])/giu],
  ['product', /(?<!\p{L})продуктолог\p{L}*\s*(?=[:—–-])/giu],
  ['creator', /(?<!\p{L})креатор\p{L}*\s*(?=[:—–-])/giu],
  ['sales', /(?<!\p{L})(?:менеджер\p{L}*\s+(?:по\s+)?продаж\p{L}*|продажник\p{L}*)\s*(?=[:—–-])/giu],
  ['finance', /(?<!\p{L})(?:финансов\p{L}*\s+аналитик\p{L}*|финансист\p{L}*)\s*(?=[:—–-])/giu]
];
// Исключение — только конкретная конструкция вплотную к имени: «не подключай Luma 2», «кроме Luma 6»,
// «без участия Luma 5», «исключи Luma 3». Произвольное «не»/«без» рядом («Не забудь подключить Luma 4»,
// «Без задержки запусти Luma 5») исключением не считается: лучше лишний исполнитель, чем пропавший.
const EXCLUDE_FILLER = String.raw`(?:(?:сотрудник|специалист|агент|исполнител)\p{L}*\s+|(?:участия|помощи)\s+)?`;
const NEGATION_BEFORE = new RegExp(
  String.raw`(?<!\p{L})(?:кроме|исключая|за\s+исключением|без|исключи\p{L}*|убери|отключи|не\s+(?:подключай\p{L}*|привлекай\p{L}*|задействуй\p{L}*|назначай\p{L}*|зови|бери|трогай|ставь))\s+${EXCLUDE_FILLER}$`,
  'iu'
);
// После имени: «Luma 2 не нужен», «Luma 5 не участвует», «Luma 4 не нужно», «Luma 3 не надо подключать»,
// «Luma 6 пусть отдыхает», «Luma 2 исключить». Но «Luma 4 не нужно исключать» — не исключение.
const NEGATION_AFTER = new RegExp(
  String.raw`^\s*[-—–:,]?\s*(?:не\s+(?:нуж(?:ен|на|ны)|участву\p{L}*|требуется|подключай\p{L}*|привлекай\p{L}*)(?!\p{L})` +
  String.raw`|не\s+(?:нужно|надо)(?=\s*(?:$|[,.;:!?]|(?:подключать|привлекать|звать|задействовать|трогать)(?!\p{L})))` +
  String.raw`|пусть\s+отдыха\p{L}*|отдыха(?:ет|ют)(?!\p{L})|исключ(?:ить|аем|ён|ен|ена|ены)(?!\p{L}))`,
  'iu'
);
// «не подключай Luma 2 и Luma 3» — отрицание действует на перечисление через «и»/«или»;
// через запятую — только если у следующего сотрудника нет своего поручения («Luma 3, Luma 4 — слоган»).
const LIST_AND = /^\s*,?\s*(?:и|или)\s*$/iu;
const LIST_COMMA = /^\s*,\s*$/u;
// Конец адресного поручения: «;», перевод строки или точка в конце предложения.
const CLAUSE_END = /;|\r?\n|\.(?=\s+\p{Lu}|\s*$)/u;
const SHORT_MARKERS = /(?<!\p{L})(?:коротко|кратко|краткий|короткий|в двух словах|одн\p{L}*\s+предложени\p{L}*)/iu;
// «один слоган», «одно название», «одну идею» — нужен ровно один вариант.
const ONE_ITEM = /(?<!\p{L})(?:один|одну|одно|одним)\s+(?:слоган|вариант|назван|предложени|фраз|абзац|строк|совет|пример|иде|пост|заголов)\p{L}*/iu;

function agentIdsInRange(from, to) {
  const ids = [];
  for (let n = Number(from); n <= Number(to); n++) {
    const agent = agentByNumber(n);
    if (agent && agent.id !== CEO.id) ids.push(agent.id);
  }
  return ids;
}

function findMentions(goal) {
  const mentions = [];
  const covered = [];
  for (const match of goal.matchAll(RANGE_MENTION)) {
    const from = match[1];
    const to = match[2] ?? match[3];
    if (Number(to) <= Number(from)) continue;
    const end = match.index + match[0].length;
    mentions.push({ agentIds: agentIdsInRange(from, to), start: match.index, end, range: `Luma ${from}–${to}` });
    covered.push([match.index, end]);
  }
  const isCovered = index => covered.some(([start, end]) => index >= start && index < end);
  for (const match of goal.matchAll(NAME_MENTION)) {
    if (isCovered(match.index)) continue;
    const agent = agentByNumber(match[1]);
    mentions.push({ agentIds: [agent.id], start: match.index, end: match.index + match[0].length });
  }
  for (const [agentId, pattern] of ROLE_MENTIONS) {
    for (const match of goal.matchAll(pattern)) {
      if (isCovered(match.index)) continue;
      mentions.push({ agentIds: [agentId], start: match.index, end: match.index + match[0].length });
    }
  }
  return mentions.sort((a, b) => a.start - b.start);
}

function cleanClause(text) {
  return text.replace(/^[\s,:—–\-]+/u, '').replace(/[\s,;.]+$/u, '').trim();
}

/**
 * Находит адресные поручения пользователя: «Luma 2 — 3 группы клиентов; Luma 3 — 3 напитка».
 * Возвращает задания по сотрудникам, исключённых сотрудников и общий контекст без чужих поручений.
 * «Luma 2 и Luma 4 — слоган» и «Luma 2–6 — слоган» дают одно задание всем названным.
 * «Не подключай Luma 2», «кроме Luma 6» исключают сотрудника, даже если просили всю команду.
 */
export function parseAssignments(goal) {
  const mentions = findMentions(goal);
  const assignments = new Map();
  const excluded = new Set();
  const spans = [];
  let pending = [];
  let previousNegated = false;
  for (let i = 0; i < mentions.length; i++) {
    const mention = mentions[i];
    const prefix = goal.slice(mentions[i - 1]?.end ?? 0, mention.start);
    const nextStart = mentions[i + 1]?.start ?? goal.length;
    const tail = goal.slice(mention.end, nextStart);
    const stop = tail.search(CLAUSE_END);
    const raw = stop >= 0 ? tail.slice(0, stop) : tail;
    spans.push([mention.start, mention.end + raw.length]);
    const ids = mention.agentIds.filter(id => id !== CEO.id);
    const clause = cleanClause(raw);
    const ownClause = clause && !/^(?:и|или|а также)$/iu.test(clause);
    const listed = previousNegated && (LIST_AND.test(prefix) || (LIST_COMMA.test(prefix) && !ownClause));
    const negated = NEGATION_BEFORE.test(prefix) || NEGATION_AFTER.test(tail) || listed;
    previousNegated = negated;
    if (negated) {
      ids.forEach(id => excluded.add(id));
      pending = [];
      continue;
    }
    if (!ids.length) continue;
    pending.push(...ids);
    if (!clause || /^(?:и|или|а также|,)$/iu.test(clause)) continue;
    for (const agentId of pending) {
      const previous = assignments.get(agentId);
      assignments.set(agentId, previous && previous !== clause ? `${previous}; ${clause}` : clause);
    }
    pending = [];
  }
  for (const agentId of pending) if (!assignments.has(agentId)) assignments.set(agentId, '');
  for (const agentId of excluded) assignments.delete(agentId);

  let context = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    context += goal.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  context += goal.slice(cursor);
  context = context
    .replace(/\s*[:;,](?:[\s;,]*[;,])*\s*(?=\.|$)/g, '')
    .replace(/(?:\s*[;,]\s*){2,}/g, '; ').replace(/\s+([.;,])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return { assignments: Object.fromEntries(assignments), excluded: [...excluded], context };
}

export function wantsWholeTeam(goal) {
  return ALL_TEAM_PATTERNS.some(pattern => pattern.test(goal));
}

export function isShortRequest(goal) {
  return SHORT_MARKERS.test(goal) || ONE_ITEM.test(goal);
}

export function asksForOne(goal) {
  return ONE_ITEM.test(goal);
}

/** Сотрудники, которых пользователь явно исключил («не подключай Luma 2», «кроме Luma 6»). */
export function excludedAgents(goal) {
  return parseAssignments(goal).excluded;
}

/** Пользователь исключил всех исполнителей: назначать некого, и запрещённого назначать нельзя. */
export function assertSomeoneAllowed(excluded) {
  if (AGENTS.every(a => excluded.includes(a.id))) {
    throw new Error(`Все исполнители исключены по просьбе пользователя (${names(excluded)}). Назначать некого — укажи хотя бы одного сотрудника.`);
  }
}

function scoreAgents(goal) {
  const text = goal.toLowerCase();
  const scores = AGENTS.map(agent => ({
    id: agent.id,
    score: ROUTING_KEYWORDS[agent.id].reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0)
  }));
  const complex = COMPLEX_MARKERS.some(marker => text.includes(marker));
  return { scores: scores.sort((a, b) => b.score - a.score), complex };
}

const names = ids => ids.map(id => agentById(id).name).join(', ');
const withExclusions = (reason, excluded) => excluded.length ? `${reason}; по просьбе пользователя не подключены: ${names(excluded)}` : reason;

/**
 * Явные указания пользователя («всеми пятью», «Luma 2 — ...», «кроме Luma 6») главнее подсчёта ключевых слов.
 * Возвращает null, если явных назначений нет.
 */
export function routeByExplicit(goal, maxAgents = 5) {
  const { assignments, excluded, context } = parseAssignments(goal);
  const allowed = AGENTS.map(a => a.id).filter(id => !excluded.includes(id));
  const named = Object.keys(assignments).filter(id => agentById(id));
  if (wantsWholeTeam(goal) && allowed.length) {
    return {
      agentIds: allowed.slice(0, maxAgents),
      assignments, excluded, context,
      source: 'explicit',
      reason: withExclusions(named.length ? `пользователь явно попросил всю команду и указал задания для ${names(named)}` : 'пользователь явно попросил всю команду', excluded)
    };
  }
  if (named.length) {
    const agentIds = allowed.filter(id => named.includes(id)).slice(0, maxAgents);
    return { agentIds, assignments, excluded, context, source: 'explicit', reason: withExclusions(`пользователь явно назначил: ${names(agentIds)}`, excluded) };
  }
  return null;
}

// Быстрое решение без модели. Возвращает null, если в тексте нет явных признаков профиля.
export function routeByRules(goal, maxAgents = 5) {
  const explicit = routeByExplicit(goal, maxAgents);
  if (explicit) return explicit;
  const excluded = excludedAgents(goal);
  const { scores, complex } = scoreAgents(goal);
  const allowed = scores.filter(s => !excluded.includes(s.id));
  if (!allowed.length) return null;
  if (complex) return { agentIds: AGENTS.map(a => a.id).filter(id => !excluded.includes(id)).slice(0, maxAgents), excluded, source: 'keywords', reason: withExclusions('комплексная задача — подключена команда', excluded) };
  const matched = allowed.filter(s => s.score > 0 && s.score === allowed[0].score).map(s => s.id).slice(0, maxAgents);
  if (matched.length === 1) return { agentIds: matched, excluded, source: 'keywords', reason: withExclusions('простая задача — один профильный специалист', excluded) };
  if (matched.length) return { agentIds: matched, excluded, source: 'keywords', reason: withExclusions('задача затрагивает несколько профилей', excluded) };
  return null;
}

export function fallbackRoute(goal, maxAgents = 5) {
  const quick = routeByRules(goal, maxAgents);
  if (quick) return quick;
  const excluded = excludedAgents(goal);
  assertSomeoneAllowed(excluded);
  const agentId = ['product', ...AGENTS.map(a => a.id)].find(id => !excluded.includes(id));
  return { agentIds: [agentId], excluded, source: 'fallback', reason: withExclusions(`профиль не определён — задача передана: ${agentById(agentId).role}`, excluded) };
}

export function routerMessages(goal) {
  const catalog = AGENTS.map(a => `${a.id}: ${a.name}, ${a.role}`).join('\n');
  return [
    { role: 'system', content: 'Ты CEO-диспетчер. Быстро выбираешь исполнителей. Отвечаешь только JSON.' },
    { role: 'user', content: `Задача пользователя:\n${goal}\n\nСотрудники:\n${catalog}\n\nВыбери МИНИМУМ нужных сотрудников. Простая задача (текст, расчёт, вопрос) — ровно один. Всю команду — только для комплексных задач вроде запуска бизнеса. Ответ: {"agents":["id"],"reason":"кратко почему"}` }
  ];
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function buildPlan(goal, route, { agentMaxTokens = 700, agentShortMaxTokens = 220 } = {}) {
  const single = route.agentIds.length === 1;
  const short = isShortRequest(goal);
  const assignments = route.assignments || {};
  const context = route.context || goal;
  return {
    summary: `CEO назначил: ${route.agentIds.map(id => `${agentById(id).name} (${agentById(id).role})`).join(', ')} — ${route.reason}.`,
    tasks: route.agentIds.map(agentId => {
      const agent = agentById(agentId);
      const assignment = assignments[agentId];
      const objective = assignment
        ? assignment
        : single
          ? goal
          : `Выполни часть цели, относящуюся к твоей роли (${agent.role}): ${goal}`;
      return {
        id: `task-${agentId}`,
        agentId,
        title: assignment ? `${agent.name}: ${clip(assignment, 70)}` : single ? `${agent.role}: выполнить задачу` : `${agent.role}: своя часть задачи`,
        objective,
        context: assignment ? context : goal,
        assigned: Boolean(assignment),
        exactlyOne: asksForOne(objective),
        maxTokens: short || isShortRequest(objective) ? Math.min(agentShortMaxTokens, agentMaxTokens) : agentMaxTokens
      };
    })
  };
}

// Предложения-распоряжения для CEO («распредели работу между специалистами») сотруднику не нужны:
// маленькая модель начинает пересказывать их и писать о команде.
const META_SENTENCE = /(?<!\p{L})(?:ceo|специалист|сотрудник|задани|распредел|команд|luma|люма)/iu;

export function contextForAgent(context) {
  const sentences = context.split(/(?<=[.!?])\s+/u).filter(s => s.trim() && !META_SENTENCE.test(s));
  return sentences.join(' ').trim();
}

// Подсказка намеренно короткая и без имён коллег: на CPU каждый токен подсказки стоит ~45 мс,
// а перечисленные имена модель повторяет в ответе.
export function agentMessages(agent, task, plan) {
  const system = `Ты ${agent.name}, ${agent.role} в Pixel AI Office. ${agent.focus} Отвечай на русском, конкретно и честно. Не выдумывай ссылки, клиентов, контакты и продажи. Пиши только свой результат: не упоминай других сотрудников и не пиши за них.`;
  const shared = plan.tasks.length > 1 ? ' Другие части цели делают коллеги — пиши только по своей роли.' : '';
  const context = task.assigned ? contextForAgent(task.context) : '';
  const one = task.exactlyOne ? ' Нужен ровно один вариант — дай один, без списка альтернатив.' : '';
  const user = task.assigned
    ? `${context ? `КОНТЕКСТ:\n${context}\n\n` : ''}ТВОЁ ЗАДАНИЕ:\n${task.objective}\n\nДай только готовый результат по этому заданию, коротко.${one} Допущения помечай словом «допущение».`
    : `ЦЕЛЬ ПОЛЬЗОВАТЕЛЯ:\n${task.context}\n\nТВОЯ ЗАДАЧА:\n${task.objective}${shared}\n\nДай готовый практический результат (не план намерений). Будь кратким: заголовки и короткие списки.${one} Допущения помечай словом «допущение».`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Нужна ли сводка CEO моделью: в режиме auto — нет, если все задания адресные (итог = настоящие ответы). */
export function needsModelSummary(plan, mode) {
  if (mode === 'auto') return !plan.tasks.every(t => t.assigned);
  return Boolean(mode);
}

/** Имена других сотрудников, которые встречаются в ответе агента (признак того, что он пишет «за команду»). */
export function foreignAttributions(agentId, text) {
  const found = new Set();
  for (const match of text.matchAll(NAME_MENTION)) {
    const agent = agentByNumber(match[1]);
    if (agent.id !== agentId) found.add(agent.name);
  }
  return [...found];
}

export function agentLabel(agentId) {
  const agent = agentById(agentId) || CEO;
  return `${agent.name} · ${agent.role}`;
}

/** Детерминированный список исполнителей: не зависит от того, что написала модель. */
export function attributionBlock(plan, outcomes) {
  const lines = plan.tasks.map(task => {
    const outcome = outcomes.find(o => o.agentId === task.agentId);
    const what = task.assigned ? ` — «${clip(task.objective, 80)}»` : '';
    if (outcome?.result) return `- ✅ ${agentLabel(task.agentId)}${what}: результат получен`;
    return `- ❌ ${agentLabel(task.agentId)}${what}: не выполнено${outcome?.error ? ` (${outcome.error})` : ''}`;
  });
  return `## Кто выполнил задачу\n${lines.join('\n')}`;
}

export function combinedResults(results) {
  return results.map(r => `### ${agentLabel(r.agentId)}\n${r.result}`).join('\n\n');
}

export function summaryMessages(goal, results, failed) {
  const missing = failed.length ? `\n\nНЕ ВЫПОЛНИЛИ (результатов нет): ${failed.map(agentLabel).join(', ')}.` : '';
  return [
    { role: 'system', content: 'Ты CEO и редактор итогового отчёта. Обобщай фактические результаты команды кратко. Не называй потенциальную выручку полученной прибылью, а планы — выполненными действиями. Ссылайся на сотрудников только по тем результатам, которые есть ниже, и не приписывай им того, чего они не писали.' },
    { role: 'user', content: `ЦЕЛЬ:\n${goal}\n\nРЕЗУЛЬТАТЫ СПЕЦИАЛИСТОВ:\n${combinedResults(results)}${missing}\n\nСоставь краткий итог на русском: (1) вывод, (2) что готово и кем, (3) гипотезы и пробелы, (4) три следующих действия.` }
  ];
}

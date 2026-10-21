// Состав офиса, маршрутизация CEO и тексты заданий. Чистые функции без вызовов модели.
import { echo, ownPart, ECHO_LINE_SHARE } from './eval.mjs';

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
  /(?<!\p{L})(?:все|всем|всеми|всех|всей)\s+(?:пятью|пятер\p{L}*|пятёр\p{L}*)/iu,
  // «Всем, кроме Luma 4», «все за исключением Luma 6» — только если после «кроме» назван сотрудник
  // (а не «всем, кроме постоянных клиентов»).
  /(?<!\p{L})(?:все|всем|всеми|всех)\s*,?\s*(?:кроме|за\s+исключением|помимо)\s+(?:(?:сотрудник|специалист|агент)\p{L}*\s+)?(?:luma|люма|исследовател|продуктолог|креатор|менеджер\p{L}*\s+(?:по\s+)?продаж|финансов\p{L}*\s+аналитик|финансист)/iu
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
// Предлоги-исключения действуют только вплотную к имени: «без» слишком часто значит другое («без задержки»).
const ADJACENT_EXCLUDE = String.raw`(?:кроме|исключая|за\s+исключением|без)`;
// Глаголы-исключения однозначны, поэтому между ними и именем допускаются вставки:
// «Не подключай, пожалуйста, Luma 2», «Исключите из задачи Luma 2», «Не надо подключать к этой работе Luma 2».
const EXCLUDE_VERB = String.raw`(?:исключи(?:те)?|убери(?:те)?|отключи(?:те)?` +
  String.raw`|не\s+(?:подключай|привлекай|задействуй|используй|назначай|включай|добавляй|приглашай|зови|бери|трогай|ставь)(?:те)?` +
  String.raw`|не\s+(?:надо|нужно|стоит|будем|хочу)\s+(?:подключать|привлекать|задействовать|использовать|назначать|включать|добавлять|приглашать|звать|брать|трогать))`;
const POLITE = String.raw`\s*,?\s*(?:пожалуйста|плиз)\s*,?`;
// До четырёх слов без знаков препинания (запятая — только вокруг «пожалуйста»): «Не используй клише, Luma 4 — …» не исключение.
const EXCLUDE_GAP = String.raw`(?:${POLITE}|\s+[\p{L}\d-]+){0,4}`;
const NEGATION_BEFORE = new RegExp(
  String.raw`(?:(?<!\p{L})${ADJACENT_EXCLUDE}|(?<!\p{L})${EXCLUDE_VERB}(?!\p{L})${EXCLUDE_GAP})\s+${EXCLUDE_FILLER}$`,
  'iu'
);
// «Не»/«без» в том же фрагменте, но не распознанное как запрет — сотрудник остаётся, а CEO предупреждает.
const UNCERTAIN_NEGATION = /(?<!\p{L})(?:не|без)(?!\p{L})[^,;.:!?\n]*$/iu;
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
// «Никого, кроме Luma 4, не подключай», «Не назначай никого, кроме Luma 4» — разрешён ТОЛЬКО названный.
// Без отрицательного местоимения («Всем, кроме Luma 4») «кроме» по-прежнему исключает.
const ONLY_BEFORE = new RegExp(
  String.raw`(?<!\p{L})(?:никого|никому|никем|никаких|никто|ни\s+одного|ни\s+одному)(?!\p{L})[^.;!?\n]*(?<!\p{L})(?:кроме|за\s+исключением|помимо)\s+${EXCLUDE_FILLER}$`,
  'iu'
);
// Хвост той же конструкции («…, не подключай») — часть запрета для остальных, а не поручение.
const ONLY_VERB_CLAUSE = /^(?:не\s+)?(?:подключай|назначай|привлекай|задействуй|зови|бери|трогай|ставь)\p{L}*$/iu;
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
  const only = new Set();
  const uncertain = new Set();
  let pending = [];
  let previous = null; // 'negated' | 'only' | null — для перечислений «Luma 2 и Luma 3»
  for (let i = 0; i < mentions.length; i++) {
    const mention = mentions[i];
    const prefix = goal.slice(mentions[i - 1]?.end ?? 0, mention.start);
    const nextStart = mentions[i + 1]?.start ?? goal.length;
    const tail = goal.slice(mention.end, nextStart);
    const stop = tail.search(CLAUSE_END);
    const raw = stop >= 0 ? tail.slice(0, stop) : tail;
    spans.push([mention.start, mention.end + raw.length]);
    const ids = mention.agentIds.filter(id => id !== CEO.id);
    let clause = cleanClause(raw);
    const ownClause = clause && !/^(?:и|или|а также)$/iu.test(clause);
    const inList = LIST_AND.test(prefix) || (LIST_COMMA.test(prefix) && !ownClause);
    const isOnly = ONLY_BEFORE.test(prefix) || (previous === 'only' && inList);
    const negated = !isOnly && (NEGATION_BEFORE.test(prefix) || NEGATION_AFTER.test(tail) || (previous === 'negated' && inList));
    previous = isOnly ? 'only' : negated ? 'negated' : null;
    if (!isOnly && !negated && UNCERTAIN_NEGATION.test(prefix)) ids.forEach(id => uncertain.add(id));
    if (isOnly) {
      ids.forEach(id => only.add(id));
      if (ONLY_VERB_CLAUSE.test(clause)) clause = '';
    }
    if (negated) {
      ids.forEach(id => excluded.add(id));
      pending = [];
      continue;
    }
    if (!ids.length) continue;
    pending.push(...ids);
    if (!clause || /^(?:и|или|а также|,)$/iu.test(clause)) {
      // Общее поручение передаётся только внутри фрагмента («Luma 2 и Luma 4 — слоган»),
      // но не через «;» или конец предложения («Luma 2; Luma 4 — слоган»).
      if (stop >= 0) {
        for (const agentId of pending) if (!assignments.has(agentId)) assignments.set(agentId, '');
        pending = [];
      }
      continue;
    }
    for (const agentId of pending) {
      const previous = assignments.get(agentId);
      assignments.set(agentId, previous && previous !== clause ? `${previous}; ${clause}` : clause);
    }
    pending = [];
  }
  for (const agentId of pending) if (!assignments.has(agentId)) assignments.set(agentId, '');
  if (only.size) for (const agent of AGENTS) if (!only.has(agent.id)) excluded.add(agent.id);
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
  for (const agentId of excluded) uncertain.delete(agentId);
  return { assignments: Object.fromEntries(assignments), excluded: [...excluded], uncertain: [...uncertain], context };
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

/** Предупреждение о «не»/«без» рядом с назначенным сотрудником, которое не распознано как запрет. */
export function uncertainNote(goal, agentIds) {
  const doubtful = parseAssignments(goal).uncertain.filter(id => agentIds.includes(id));
  return doubtful.length
    ? ` Проверь: рядом с ${names(doubtful)} есть «не»/«без», но это не распознано как запрет — сотрудник назначен. Чтобы исключить, напиши «не подключай Luma N» или «без участия Luma N».`
    : '';
}

export function buildPlan(goal, route, { agentMaxTokens = 700, agentShortMaxTokens = 220 } = {}) {
  const single = route.agentIds.length === 1;
  const short = isShortRequest(goal);
  const assignments = route.assignments || {};
  const context = route.context || goal;
  return {
    summary: `CEO назначил: ${route.agentIds.map(id => `${agentById(id).name} (${agentById(id).role})`).join(', ')} — ${route.reason}.${uncertainNote(goal, route.agentIds)}`,
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

// Калькулятор офиса: точные значения арифметики из задания. Маленькая модель ошибается в счёте,
// поэтому сервер считает сам и подсказывает ответ («30 × 3 = 90»).
const ARITHMETIC = /\d+(?:[.,]\d+)?(?:\s*[×x*·/+\-−]\s*\d+(?:[.,]\d+)?)+/gu;

function evaluateArithmetic(expression) {
  const tokens = expression.replace(/[×x*·]/g, '*').replace(/−/g, '-').match(/\d+(?:[.,]\d+)?|[*/+-]/g);
  if (!tokens) return null;
  const values = [];
  const ops = [];
  const apply = () => {
    const b = values.pop();
    const a = values.pop();
    const op = ops.pop();
    values.push(op === '*' ? a * b : op === '/' ? a / b : op === '+' ? a + b : a - b);
  };
  const rank = op => (op === '*' || op === '/' ? 2 : 1);
  for (const token of tokens) {
    if (/\d/.test(token)) { values.push(Number(token.replace(',', '.'))); continue; }
    while (ops.length && rank(ops.at(-1)) >= rank(token)) apply();
    ops.push(token);
  }
  while (ops.length) apply();
  const [result] = values;
  return Number.isFinite(result) ? Math.round(result * 100) / 100 : null;
}

/**
 * «выручка 30 × 3 €» → ['30 × 3 = 90']. Осторожно: лучше не подсказать, чем подсказать неверно.
 * - «/» и «-» — действие только с пробелами вокруг («120 / 4», «100 - 15»); без пробелов это
 *   период, дата, телефон, номер или диапазон («2025/2026», «2026-10-18», «8-800-555-35-35», «2-3»);
 * - выражение не может быть частью числа с точками или версии («1.2.3+4», «18.10.2026»);
 * - «-» в цепочке из одних «-» — диапазон, а не вычитание; дд/мм/гггг — дата;
 * - разделители тысяч («1 000») склеиваются до поиска выражений;
 * - латинская «x» — умножение только с пробелами вокруг («10 x 3»), а «1920x1080» — размер.
 */
export function arithmeticHints(input) {
  // «1 000 + 2 000», «10 000 * 3»: склеиваем разделители тысяч (пробел, неразрывный пробел), иначе выражение
  // начнётся внутри первого числа («000 + 2 = 2»).
  const text = input.replace(/(\d)[ \u00a0\u202f](?=\d{3}(?!\d))/g, '$1');
  const hints = [];
  for (const match of text.matchAll(ARITHMETIC)) {
    const expression = match[0];
    const before = text[match.index - 1] || '';
    const after = text.slice(match.index + expression.length, match.index + expression.length + 2);
    if (/[\d.,]/.test(before) || /^[.,]?\d/.test(after)) continue;
    const trimmed = expression.trim();
    if (/\d[/\-−]|[/\-−]\d/.test(trimmed)) continue;
    // Латинская «x» без пробелов — размер или формат («1920x1080», «4x4»), а не умножение; «×» и «*» — всегда действие.
    if (/\dx|x\d/i.test(trimmed)) continue;
    if (/^\d+(?:\s*[-−]\s*\d+)+$/.test(trimmed)) continue;
    if (/^\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{2,4}$/.test(trimmed)) continue;
    const value = evaluateArithmetic(expression);
    if (value !== null) hints.push(`${trimmed} = ${String(value).replace('.', ',')}`);
  }
  return [...new Set(hints)];
}

const NUMBER_WORDS = { два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10 };

// Форма «ровно N пунктов» — только если после числа стоит то, что перечисляют (разрешённый список).
// Всё остальное («5 тысяч рублей», «3 сентября», «2 квартал», «30 заказов») — не количество вариантов,
// и подсказка остаётся обычной: лучше без формы списка, чем с неверной.
const LISTABLE = String.raw`(?:вариант|иде[яийю]|способ|напит|групп|сегмент|пункт|слоган|назван|пост|текст|совет|шаг|причин|вопрос|пример|продукт|блюд|услуг|канал|тезис|заголов|письм|сообщени|гипотез|риск|конкурент|аргумент|функци|преимуществ|акци|позици|тариф|правил|задач|цел[ьией]|метрик|сценари|формат|рубрик|тем[аыу])`;
// Количество в начале поручения или после 1–2 слов: «3 напитка», «предложи 3 напитка», «придумай три идеи».
const COUNT_PATTERN = new RegExp(
  String.raw`^(?:\p{L}+\s+){0,2}?(\d+|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять)\s+(${LISTABLE}[\s\S]*)$`,
  'iu'
);

/** «3 напитка», «предложи 2 способа», «три идеи» → { count, what }; иначе null. «3 сентября», «2 квартал», «30 × 3 €» — не количество. */
export function requestedItems(objective) {
  const match = objective.trim().match(COUNT_PATTERN);
  if (!match) return null;
  // «не предлагай 3 слогана, дай один» — число под отрицанием, это не просьба о трёх пунктах.
  const lead = objective.trim().slice(0, match.index + match[0].indexOf(match[1]));
  if (/(?<!\p{L})(?:не|без|кроме|вместо)(?!\p{L})/iu.test(lead)) return null;
  const count = /^\d+$/.test(match[1]) ? Number(match[1]) : NUMBER_WORDS[match[1].toLowerCase()];
  return count >= 2 && count <= 10 ? { count, what: match[2].trim() } : null;
}

export function requestedCount(objective) {
  return requestedItems(objective)?.count ?? null;
}

// Подсказка намеренно короткая и без имён коллег: на CPU каждый токен подсказки стоит ~45 мс,
// а перечисленные имена модель повторяет в ответе.
// Для адресного задания описание роли не передаётся: маленькая модель заполняет его как шаблон
// («Предложение / Цена-гипотеза / Критерии» вместо трёх напитков, «затраты и маржа», когда просили выручку).
export function agentMessages(agent, task, plan, handoffs = []) {
  const base = `Ты ${agent.name}, ${agent.role} в Pixel AI Office. Отвечай на русском, конкретно и честно. Не выдумывай ссылки, клиентов, контакты и продажи. Пиши только свой результат: не упоминай других сотрудников и не пиши за них.`;
  const system = task.assigned
    ? `${base} Выполняй ровно то, что сказано в задании: не добавляй разделы, цифры и расчёты, о которых не просили.`
    : `Ты ${agent.name}, ${agent.role} в Pixel AI Office. ${agent.focus} ${base.slice(base.indexOf('Отвечай'))}`;
  const shared = plan.tasks.length > 1 ? ' Другие части цели делают коллеги — пиши только по своей роли.' : '';
  const context = task.assigned ? contextForAgent(task.context) : '';
  const one = task.exactlyOne ? ' Нужен ровно один вариант — дай один, без списка альтернатив.' : '';
  // «3 напитка» → что именно перечислять: «напитка»; пункт — само название, а не совет и не пометка.
  const { count, what } = (task.assigned && requestedItems(task.objective)) || {};
  const shape = count
    ? ` Ответ — нумерованный список ровно из ${count} пунктов (1. … ${count}. …). Каждый пункт начинается с конкретного названия (что перечислить: «${what}»), затем короткое пояснение. Не пиши советов вместо вариантов. Допущения — одной строкой после списка, не пунктом списка.`
    : '';
  const math = arithmeticHints(task.objective);
  const calc = math.length ? `\nКАЛЬКУЛЯТОР ОФИСА (посчитано точно, используй эти значения и покажи расчёт): ${math.join('; ')}\n` : '';
  const received = handoffBlock(handoffs);
  const user = task.assigned
    ? `${context ? `КОНТЕКСТ:\n${context}\n\n` : ''}${received}ТВОЁ ЗАДАНИЕ:\n${task.objective}\n${calc}\nДай только готовый результат по этому заданию, коротко.${shape}${one} Допущения помечай словом «допущение».`
    : `ЦЕЛЬ ПОЛЬЗОВАТЕЛЯ:\n${task.context}\n\n${received}ТВОЯ ЗАДАЧА:\n${task.objective}${shared}\n\nДай готовый практический результат (не план намерений). Будь кратким: заголовки и короткие списки.${one} Допущения помечай словом «допущение».`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Нужна ли сводка CEO моделью: в режиме auto — нет, если все задания адресные (итог = настоящие ответы). */
export function needsModelSummary(plan, mode) {
  if (mode === 'auto') return !plan.tasks.every(t => t.assigned);
  return Boolean(mode);
}

/**
 * Имена других сотрудников, которые встречаются в ответе агента (признак того, что он пишет «за команду»).
 * received — сотрудники, чьи данные агенту передали явно (handoff): ссылка на источник — не подмена, их имена не считаются.
 */
export function foreignAttributions(agentId, text, received = []) {
  const found = new Set();
  for (const match of text.matchAll(NAME_MENTION)) {
    const agent = agentByNumber(match[1]);
    if (agent.id !== agentId && !received.includes(agent.id)) found.add(agent.name);
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
    const used = outcome?.handoffFrom?.length ? ` (с данными от ${names(outcome.handoffFrom)})` : '';
    if (outcome?.result) return `- ✅ ${agentLabel(task.agentId)}${what}: результат получен${used}`;
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

// --- Передача результата (handoff) ---------------------------------------------------------------
// Кто на чьих данных строит работу. Порядок источников — по важности: при обрезке первыми остаются они.
// Зависеть можно только от сотрудника выше по списку AGENTS — так циклов не бывает по построению.
const HANDOFF_SOURCES = {
  research: [],
  product: ['research'],
  creator: ['product', 'research'],
  sales: ['research', 'product'],
  finance: ['product', 'sales', 'research']
};
// На CPU каждый токен подсказки стоит ~45 мс: 450 символов источника ≈ 150 токенов ≈ 7 с.
export const HANDOFF_SOURCE_CHARS = 450;
export const HANDOFF_TOTAL_CHARS = 900;

/**
 * Нужна ли передача результата.
 * auto — только для ролевых заданий (каждый делает «свою часть» общей цели) и при LLM_CONCURRENCY=1:
 * - адресные задания пользователь разделил сам («Luma 2 — …; Luma 6 — …», «все получают сразу») — они независимы,
 *   а чужие данные в подсказке маленькой модели провоцируют лишние разделы и цифры;
 * - при одном запросе к модели за раз очередь и так идёт по порядку AGENTS, ожидание не стоит времени —
 *   платим только токенами подсказки. При параллельности ≥2 цепочка зависимостей съела бы выигрыш.
 */
export function handoffEnabled(plan, mode, concurrency = 1) {
  if (plan.tasks.length < 2) return false;
  if (mode === 'auto') return concurrency === 1 && plan.tasks.every(t => !t.assigned);
  return Boolean(mode);
}

/** Граф зависимостей плана: agentId → от кого ждать данных. Только сотрудники из плана, без циклов. */
export function handoffGraph(plan) {
  const inPlan = new Set(plan.tasks.map(t => t.agentId));
  const order = id => AGENTS.findIndex(a => a.id === id);
  return Object.fromEntries(plan.tasks.map(task => [
    task.agentId,
    (HANDOFF_SOURCES[task.agentId] || []).filter(id => inPlan.has(id) && order(id) < order(task.agentId))
  ]));
}

// Размышления модели (<think>…</think>, в том числе незакрытые) — не данные и не реплика.
const THINK = /<think>[\s\S]*?(?:<\/think>|$)/giu;

function stripThink(text) {
  return String(text || '').replace(THINK, '').trim();
}

/** Обрезка по строкам: целые строки, пока влезают; длинная первая строка — с многоточием. */
function clipLines(text, max) {
  if (text.length <= max) return text;
  let out = '';
  for (const line of text.split(/\r?\n/)) {
    if (`${out}\n${line}`.length > max - 1) break;
    out = out ? `${out}\n${line}` : line;
  }
  return `${(out || clip(text, max - 1)).trimEnd()}…`;
}

/**
 * Результаты коллег для подсказки: суть (handoffDigest), обрезанная, с общим лимитом.
 * outcomes — [{ agentId, result }] в порядке важности. Пустые и неудачные пропускаются.
 */
// Статус данных так, как его назвал автор. Порядок — от осторожного к уверенному: при нескольких признаках
// побеждает более осторожный («Факт: примерно 30 гостей» — оценка). Факт — только по явной пометке («Факт:», «Факты:»).
// «Оценка конкурентов», «Возможности» — не статус данных.
const STATUSES = [
  { tag: 'гипотеза', word: /допущ|допуска|допустим|предпол|гипотез|не\s+провер|непровер|не\s+подтвержд|неподтвержд|(?<!\p{L})(?:вероятно|возможно)(?!\p{L})/iu },
  { tag: 'оценка', word: /оценочн|примерн|приблизит|ориентировоч|прогноз|(?:около|порядка)\s+\d|[~≈]\s*\d|(?<!\p{L})оценк\p{L}*(?!\p{L})(?!\s+(?:конкурент|рынк|риск|качеств|клиент|отзыв))/iu },
  { tag: 'факт', word: /(?<!\p{L})факт(?:ы|ически)?(?!\p{L})|проверен|подтвержд/iu, labelOnly: true }
];
// Пометка статуса в начале строки: «Допущение: …», «Факт — …», «Факты и допущения:».
const STATUS_LABEL = /^(?:допущени\p{L}*|предположени\p{L}*|гипотез\p{L}*|оценк[аи](?!\p{L})|прогноз\p{L}*|факты?(?!\p{L})|проверено|не\s+проверено)(?:\s+и\s+\p{L}+)?\s*(?:[:—–-]\s*|$)/iu;
// «Примечание: все данные — предположения» — оговорка, если в ней есть слово статуса.
const NOTE_LABEL = /^(?:примечани\p{L}*|важно|оговорк\p{L}*)\s*[:—–-]\s*/iu;
// Оговорка о других строках: «цены ниже — гипотезы» — о следующих, «данные основаны на общем поведении» — о предыдущих.
// «ниже рынка», «выше, чем у конкурентов», «ниже на 20 %» — сравнение, а не ссылка на строки; «спрос основан на …» — сама гипотеза.
const NOT_COMPARISON = String.raw`(?!\s*,?\s*(?:чем|на\s+\d|\d|рынк|конкур|средн|обычн))`;
const ABOUT_NEXT = new RegExp(String.raw`(?<!\p{L})(?:ниже|далее)${NOT_COMPARISON}|(?<!\p{L})следующ`, 'iu');
const ABOUT_PREVIOUS = new RegExp(String.raw`(?<!\p{L})выше${NOT_COMPARISON}|вс[её],?\s+что|приведен|приведён|(?:эт[иоа]|вс[её])\s+(?:данн|цифр|цен|расч|результ|вариант)|(?:данн|цифр|расч|оценк|вс[её]|эт[оиа])\p{L}*[^.]{0,40}?основан`, 'iu');

function statusOf(text, { label = false } = {}) {
  return STATUSES.find(s => (label || !s.labelOnly) && s.word.test(text))?.tag;
}

function cautious(...statuses) {
  return STATUSES.find(s => statuses.includes(s.tag))?.tag;
}

const DIGEST_LINE_CHARS = 60;
const DIGEST_EXPLAIN_CHARS = 50;
const DIGEST_SENTENCE_CHARS = 100;
// Данные в строке: числа (и словами), единицы, условия и ограничения, сроки и время, валюта словами. Такая строка передаётся целиком:
// список слов условий всегда неполон, а резать по частям — терять «с мая по сентябрь» или «до конца месяца».
const DIGEST_DATA = /\d|(?<!\p{L})(?:если|при|в\s+случае|когда|только|лишь|кроме|без|до\s+конца|в\s+течение|максимум|минимум|в\s+зависимости|зависит|огранич\p{L}*|бесплатн\p{L}*|утр\p{L}*|дн[её]м|вечер\p{L}*|будн\p{L}*|выходн\p{L}*|январ\p{L}*|феврал\p{L}*|март\p{L}*|апрел\p{L}*|ма[йя]|июн\p{L}*|июл\p{L}*|август\p{L}*|сентябр\p{L}*|октябр\p{L}*|ноябр\p{L}*|декабр\p{L}*|после|евро|рубл\p{L}*|доллар\p{L}*|процент\p{L}*|миллилитр\p{L}*|литр\p{L}*|грамм\p{L}*|килограмм\p{L}*|штук\p{L}*|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|двадцать|тридцать|сорок|пятьдесят|сто|двести|триста|пятьсот|тысяч\p{L}*)(?!\p{L})/iu;
// Ограничение отрицанием («кто не пьёт коровье молоко», «не суммируется с акциями»).
const DIGEST_LIMIT = /(?<!\p{L})не\s+\p{L}/iu;
const DIGEST_DASH = /\s[—–-]\s/u;
// Цитата (слоган, название) и скобки не режутся и не делятся по запятым: на время разбора — один заместитель.
const DIGEST_QUOTE = /«[^»\n]*»|"[^"\n]*"|“[^”\n]*”|\([^()\n]*\)/gu;
const QUOTE_MARK = '';

function cutWords(text, max) {
  return text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/u, '')}…`;
}

/**
 * Длинная строка коротко. Строка с данными (числа, условия, ограничения) — целиком. «Название — пояснение»:
 * перечисление после тире («студенты, преподаватели, аспиранты») — целиком, описание — первые 50 знаков по словам.
 * Предложение без тире — до 100 знаков.
 */
function shortenLine(text) {
  const line = text.replace(/[.;,]+$/u, '');
  if (line.length <= DIGEST_LINE_CHARS || DIGEST_DATA.test(line) || DIGEST_LIMIT.test(line)) return line;
  const quotes = [];
  const masked = line.replace(DIGEST_QUOTE, quote => `${QUOTE_MARK}${quotes.push(quote) - 1}${QUOTE_MARK}`);
  const restore = short => short.replace(new RegExp(`${QUOTE_MARK}(\\d+)${QUOTE_MARK}`, 'gu'), (_, i) => quotes[i]);
  if (masked.length <= DIGEST_LINE_CHARS) return line;
  const dash = masked.search(DIGEST_DASH);
  if (dash < 0) return restore(cutWords(masked, DIGEST_SENTENCE_CHARS));
  const head = cutWords(masked.slice(0, dash), DIGEST_LINE_CHARS);
  const explain = masked.slice(dash).replace(DIGEST_DASH, '');
  const enumeration = explain.split(/,\s+/u).every(part => part.split(/\s+/u).length <= 3);
  return restore(`${head} — ${enumeration ? explain : cutWords(explain, DIGEST_EXPLAIN_CHARS)}`);
}

/**
 * Суть результата коллеги: по строке на пункт, заголовки разделов сохраняются.
 * Готовые описания маленькая модель переписывала к себе почти дословно, поэтому они сокращаются (shortenLine),
 * а подсказка короче (на CPU каждый токен ~45 мс). Оговорки автора не переписываются, но и не теряются:
 * статус данных — факт, гипотеза или оценка — становится пометкой пункта («Латте — 4 € [гипотеза]»):
 * - «Допущение: 30 гостей в день» — сам пункт со статусом;
 * - «Допущение: цены ниже не проверены» — статус следующих пунктов: до заголовка или до строки не из списка
 *   после пустой строки, но не раньше, чем статус получит хотя бы один пункт;
 * - «допущение: данные основаны на общем поведении», «Примечание: все данные — предположения» — статус
 *   предыдущих пунктов без своей пометки;
 * - заголовок «Гипотезы:», «Оценка выручки:» — статус пунктов раздела.
 * Если слово статуса и так осталось в тексте пункта («примерно 2 700 €»), пометка не дублируется.
 */
export function handoffDigest(text) {
  const rows = [];
  let section;
  let next;
  let nextUsed = false;
  let gap = false;
  for (const raw of stripThink(text).split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:(?:[-*•–]|\d+[.)])\s+)?/u, '').replace(/[*_#`]+/g, '').trim();
    if (!/[\p{L}\d]/u.test(line)) {
      // Пустая строка или линия «---»: что она закрывает, решает следующая строка.
      gap = rows.length > 0;
      continue;
    }
    const listItem = /^\s*(?:[-*•–]|\d+[.)])\s+/u.test(raw);
    if (gap && !listItem) {
      // После пустой строки — уже не продолжение списка: раздел и использованная оговорка «ниже» закрыты.
      section = undefined;
      if (nextUsed) next = undefined;
    }
    gap = false;
    const note = line.match(NOTE_LABEL);
    const label = line.match(STATUS_LABEL) || (note && statusOf(line.slice(note[0].length)) ? note : null);
    const labelled = label ? statusOf(label === note ? line.slice(note[0].length) : label[0], { label: true }) : undefined;
    const content = label ? line.slice(label[0].length).trim() : line;
    // «### Клиенты», «**Напитки**» — заголовки; жирная строка с данными, пометкой статуса, цитатой или точкой — пункт.
    const bold = raw.match(/^\s*(\*\*|__)([^*_«"“\n]+?)\1\s*:?\s*$/u);
    const heading = /^\s*#/u.test(raw) || Boolean(bold && !/\d/u.test(bold[2]) && !/[.!?]$/u.test(bold[2]) && !(label && content));
    if (!content || heading || /:$/.test(content)) {
      // Заголовок раздела: «Гипотезы:» задаёт статус пунктов, «Напитки:» — сбрасывает. Оговорка «ниже» переживает
      // заголовок сразу после себя.
      section = labelled || statusOf(content);
      if (nextUsed) next = undefined;
      if (content) rows.push({ header: content.replace(/:$/u, '') });
      continue;
    }
    const about = label ? (ABOUT_NEXT.test(content) ? 'next' : ABOUT_PREVIOUS.test(content) ? 'previous' : '') : '';
    const before = rows.filter(r => r.item && !r.own && !r.closed);
    if (about === 'previous' && before.length) {
      for (const r of before) r.status = cautious(r.status, labelled);
    } else if (about) {
      next = labelled;
      nextUsed = false;
    }
    if (about) {
      for (const r of rows) r.closed = true;
      // Оговорка — о других строках; своё содержание передаётся, только если в нём есть данные.
      if (!DIGEST_DATA.test(content)) continue;
    }
    // Своя пометка и раздел («Факты:») сильнее общей оговорки, но осторожное слово в тексте сильнее пометки:
    // «Факт: возможно 30 гостей» — гипотеза.
    const inline = statusOf(content);
    if (next) nextUsed = true;
    rows.push({
      item: content[0].toUpperCase() + content.slice(1),
      own: Boolean(labelled || section),
      status: labelled ? cautious(labelled, inline) : cautious(inline, section, next)
    });
  }
  return rows.map(r => {
    if (r.header) return `${r.header}:`;
    const short = shortenLine(r.item);
    const word = STATUSES.find(s => s.tag === r.status)?.word;
    return `- ${short}${r.status && !word.test(short) ? ` [${r.status}]` : ''}`;
  }).join('\n');
}

// Своя часть источника по заголовку раздела. Маленькая модель пишет и чужие разделы («Клиенты» у продуктолога),
// а лимит подсказки уходил на них: если раздел своей роли есть, коллеге передаётся он (с подразделами — до заголовка
// другой роли) и пункты до первого заголовка с данными или статусом («Цены ниже — при закупке по 20 €/кг [гипотеза]»).
// Без своих разделов (короткий ответ, другие заголовки) — сводка целиком.
const OWN_SECTION = {
  research: /клиент|аудитор|сегмент/iu,
  product: /напит|меню|ассортимент/iu,
  creator: /слоган|креатив|бренд/iu,
  sales: /привлеч|продаж|продвиж|маркетинг|канал/iu,
  finance: /выручк|финанс|доход|расход|бюджет|прибыл/iu
};

function ownSections(agentId, digest) {
  const roleOf = header => Object.keys(OWN_SECTION).find(id => OWN_SECTION[id].test(header));
  const sections = [{ role: null, lines: [] }];
  for (const line of digest.split('\n')) {
    const role = line.startsWith('- ') ? undefined : roleOf(line);
    if (role) sections.push({ role, lines: [] });
    sections.at(-1).lines.push(line);
  }
  const own = sections.filter(s => s.role === agentId && s.lines.some(line => line.startsWith('- ')));
  if (!own.length) return digest;
  const lead = sections[0].lines.filter(line => line.startsWith('- ') && /\d|\[(?:гипотеза|оценка|факт)\]/u.test(line));
  return [...lead, ...own.flatMap(s => s.lines)].join('\n');
}

export function compactHandoffs(outcomes, { perSource = HANDOFF_SOURCE_CHARS, total = HANDOFF_TOTAL_CHARS } = {}) {
  const handoffs = [];
  let left = total;
  for (const outcome of outcomes) {
    // Маркеры подсказки в чужом тексте не должны выглядеть как новое задание.
    const text = ownSections(outcome?.agentId, handoffDigest(outcome?.result)).replace(/ТВО[ЁЕ]\s+(?:ЗАДАНИЕ|ЗАДАЧА)\s*:/giu, 'задание:');
    if (!text || left < 80) continue;
    const clipped = clipLines(text, Math.min(perSource, left));
    handoffs.push({ agentId: outcome.agentId, text: clipped });
    left -= clipped.length;
  }
  return handoffs;
}

// Имя источника в подсказке есть (иначе модель не поймёт, откуда данные), но с явным запретом выдавать их за свои.
// Пометки статуса (handoffDigest) объясняются, только если они есть: на CPU каждый токен подсказки ~45 мс.
export function handoffBlock(handoffs = []) {
  if (!handoffs.length) return '';
  const tagged = handoffs.some(h => /\[(?:гипотеза|оценка|факт)\]/u.test(h.text));
  return handoffs.map(h => `ДАННЫЕ ОТ КОЛЛЕГИ (${agentLabel(h.agentId)}), используй как вход, не переписывай и не приписывай себе:\n${h.text}\n\n`).join('') +
    `Сделай свою часть своими словами: строки коллег не переписывай.${tagged ? ' В квадратных скобках — статус данных у коллеги: гипотезы и оценки не выдавай за факты, а если опираешься на них, так и пометь.' : ''}\n\n`;
}

// --- Реплики команды (CROSS_TALK) ----------------------------------------------------------------
export const CHAT_PEER_CHARS = 220;

/**
 * С кем говорить в чате. Сначала — с тем, кто уже написал этому сотруднику (ответ на вопрос),
 * затем — с тем, чьими данными он пользуется (HANDOFF_SOURCES), затем — с тем, кто строит работу на его данных,
 * иначе — с первым другим участником. Один собеседник вместо всех: короче подсказка, реплика по делу.
 */
export function chatPartner(agentId, participantIds, askedBy) {
  const others = participantIds.filter(id => id !== agentId);
  if (others.includes(askedBy)) return askedBy;
  return (HANDOFF_SOURCES[agentId] || []).find(id => others.includes(id))
    ?? others.find(id => (HANDOFF_SOURCES[id] || []).includes(agentId))
    ?? others[0];
}

/**
 * Подсказка для реплики коллеге: свой результат и результат собеседника (сжатые), 1–2 предложения, обращение по имени.
 * incoming — реплика, которую собеседник уже написал этому сотруднику: на неё нужно ответить.
 */
export function chatMessages(agent, ownResult, partner, incoming) {
  const squeeze = text => clipLines(stripThink(text), CHAT_PEER_CHARS).replace(/\s*\n\s*/g, ' ');
  const name = agentById(partner.agentId).name;
  const ask = incoming
    ? `${name} пишет тебе: «${incoming.text}»\n\nОтветь ${name} 1–2 предложениями по своему результату: конкретно, с названием или цифрой из него.`
    : `Напиши ${name} 1–2 предложения: один конкретный вопрос или предложение, как связать его результат с твоим.`;
  return [
    { role: 'system', content: `Ты ${agent.name}, ${agent.role} в Pixel AI Office. Это короткая реплика коллеге в рабочем чате, а не отчёт. Отвечай на русском. Не выдумывай факты, клиентов и цифры.` },
    { role: 'user', content: `ТВОЙ РЕЗУЛЬТАТ (сжато):\n${squeeze(ownResult)}\n\nРЕЗУЛЬТАТ ${agentLabel(partner.agentId)} (сжато):\n${squeeze(partner.result)}\n\n${ask} Не пересказывай результат коллеги. Начни с имени («${name}, …»). Без приветствий и списков.` }
  ];
}

// «Luma 2, исследователь рынка: …», «Luma 6 · Финансовый аналитик, …» — ярлык роли после имени адресата
// (модель копирует его из подсказки) не нужен: в чате обращаются по имени.
const ADDRESS_ROLE = /^\s*((?:luma|люма)\s*[1-6])(?!\d)\s*[,·:—–-]?\s*(?:исследовател\p{L}*(?:\s+рынка)?|продуктолог\p{L}*|креатор\p{L}*|менеджер\p{L}*\s+(?:по\s+)?продаж\p{L}*|финансов\p{L}*\s+аналитик\p{L}*)\s*[,:—–-]\s*/iu;

// Временная замена точки в числе: символ из области для частного использования, в ответах модели его нет.
const DECIMAL_DOT = '\uE000';

// Ответ-заглушка: «OK», «Хорошо.», «Понял», «—». Такую реплику не показываем.
// Несколько таких слов подряд («OK, согласен») — тоже заглушка.
const STUB_WORD = String.raw`(?:ok(?:ay)?|ок(?:ей)?|хорошо|ладно|понял[аи]?|принято|да|нет|готово|согласен|согласна|спасибо|ясно|n\/?a|нет\s+замечаний|без\s+замечаний|с\s+тобой|полностью|ты\s+прав[аы]?|верно|отлично)`;
const STUB_REPLY = new RegExp(String.raw`^${STUB_WORD}(?:\s+${STUB_WORD})*$`, 'iu');
// Обращение в начале («Luma 3, …») подсказка требует, но содержанием реплики оно не считается.
// Проверяется после удаления разметки и знаков («**Luma 3**, хорошо» → «Luma 3 хорошо»).
const LEADING_ADDRESS = /^(?:luma|люма)\s*[1-6](?!\d)/iu;

// Своё после цитаты: новое число; свой вопрос или возражение хотя бы с одним своим словом («Почему?», «А утром?»,
// «Не согласен, утром»); утверждение — из двух своих слов. Пустой хвост («Звучит логично», «Именно так?») — пересказ.
function addsToQuote(reply, sources) {
  const own = ownPart(reply, sources);
  const asks = /\?[?!.…]*["»”')\]]*$/u.test(reply) && own.endsOwn;
  return own.number || own.words.length >= (asks || own.objects ? 1 : 2);
}

/**
 * Реплика коллеге из ответа модели или null. Убирает <think>, свою подпись («Luma 5:»), кавычки,
 * оставляет максимум два предложения. to — первый упомянутый участник обсуждения (кроме самого автора).
 * truncated — ответ оборван лимитом токенов: недописанное второе предложение отбрасывается.
 * sources — результаты коллег: реплика, которая в основном их пересказывает, отбрасывается.
 */
export function cleanChatReply(text, speakerId, participantIds = [], { truncated = false, sources = [] } = {}) {
  const speaker = agentById(speakerId);
  // «Luma 5:», «**Luma 5 · Менеджер продаж**:» — подпись автора, не часть реплики.
  const signature = speaker ? new RegExp(String.raw`^\s*(?:\*\*)?(?:luma|люма)\s*${speaker.name.slice(-1)}(?!\d)[^:\n]{0,40}?(?:\*\*)?\s*:\s*`, 'iu') : /$^/;
  let reply = stripThink(text)
    .replace(signature, '')
    .replace(ADDRESS_ROLE, '$1, ')
    .replace(/\s+/g, ' ')
    .replace(/^["«“'\s]+|["»”'\s]+$/gu, '')
    .trim();
  // Конец предложения — знак и закрывающие кавычки/скобки, за которыми (через пробелы или сразу) идёт не строчная
  // буква: «…цена?» Предлагаю» режется после кавычки, «расчёты.«Цена…» и «!2 клиента» — тоже, а сокращения
  // перед строчной («20 тыс. рублей», «т.е. смета») — нет. Точка между цифрами («3.50 €») — не конец:
  // на время разбора она заменена служебным знаком.
  const sentences = reply.replace(/(\d)\.(?=\d)/g, `$1${DECIMAL_DOT}`)
    .match(/.+?(?:[.!?…]+["'»”“’)\]]*(?=\s*[^\p{Ll}\s.!?…"'»”“’)\]]|\s*$)|$)/gu) || [];
  // Ответ, оборванный лимитом токенов (truncated: doneReason = length), кончается недописанным предложением:
  // второе такое не показываем («…Слоган "Качество, вкус»), единственное — показываем как есть.
  // Без обрыва предложение без точки в конце — законченное.
  const picked = sentences.slice(0, 2);
  if (truncated && picked.length === 2 && !/[.!?…]["'»”“’)\]]*$/u.test(picked[1].trim())) picked.pop();
  reply = clip(picked.join('').replaceAll(DECIMAL_DOT, '.').trim(), 280);
  const bare = reply.replace(/[\s\p{P}\p{S}]+/gu, ' ').trim().replace(LEADING_ADDRESS, '').trim();
  if (!bare || STUB_REPLY.test(bare) || (bare.match(/\p{L}/gu) || []).length < 8) return null;
  // Пересказ результата коллеги (sources — их результаты и сказанные реплики) — не реплика: в чате ничего нового.
  // Цитата перед своим вопросом, возражением или исправлением — реплика: важно, что осталось кроме цитаты.
  if (sources.length && echo(reply, sources).share >= ECHO_LINE_SHARE && !addsToQuote(reply, sources)) return null;
  let to;
  for (const match of reply.matchAll(NAME_MENTION)) {
    const agent = agentByNumber(match[1]);
    if (agent.id !== speakerId && participantIds.includes(agent.id)) { to = agent.id; break; }
  }
  return { text: reply, ...(to ? { to } : {}) };
}

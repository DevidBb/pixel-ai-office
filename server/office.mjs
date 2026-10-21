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
// Явную просьбу о всей команде (и отказ от неё) распознаёт wantsWholeTeam, а не подстрока здесь.
const COMPLEX_MARKERS = ['бизнес', 'стартап', 'запуст', 'запуск', 'с нуля', 'комплексн', 'полный план', 'стратеги'];

// Явная просьба подключить всю команду: «всеми пятью специалистами», «всем сотрудникам», «всем пятерым», «всю команду».
const ALL_TEAM_PATTERNS = [
  // «команд» — только падежи слова «команда»: «всю командировку» — не про офис.
  /(?<!\p{L})(?:все|всем|всеми|всех|всей|всю)\s+(?:(?:пят\p{L}*|5)\s+)?(?:(?:специалист|сотрудник|агент|исполнител)\p{L}*|команд(?:а|у|ы|е|ой|ою|ам|ами|ах)?(?!\p{L}))/giu,
  /(?<!\p{L})(?:все|всем|всеми|всех|всей|всю)\s+(?:пятью|пятер\p{L}*|пятёр\p{L}*)/giu,
  // «Всем, кроме Luma 4», «все за исключением Luma 6» — только если после «кроме» назван сотрудник
  // (а не «всем, кроме постоянных клиентов»).
  /(?<!\p{L})(?:все|всем|всеми|всех)\s*,?\s*(?:кроме|за\s+исключением|помимо)\s+(?:(?:сотрудник|специалист|агент)\p{L}*\s+)?(?:luma|люма|исследовател|продуктолог|креатор|менеджер\p{L}*\s+(?:по\s+)?продаж|финансов\p{L}*\s+аналитик|финансист)/giu
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
// Без двух «\s*» подряд вокруг необязательной запятой: на длинной строке пробелов движок перебирал все способы
// поделить пробелы между ними (5000 пробелов — минуты на одну задачу).
const POLITE = String.raw`\s*(?:,\s*)?(?:пожалуйста|плиз)\s*,?`;
// До четырёх слов без знаков препинания (запятая — только вокруг «пожалуйста»): «Не используй клише, Luma 4 — …» не исключение.
const EXCLUDE_GAP = String.raw`(?:${POLITE}|\s+[\p{L}\d-]+){0,4}`;
const NEGATION_BEFORE = new RegExp(
  String.raw`(?:(?<!\p{L})${ADJACENT_EXCLUDE}|(?<!\p{L})${EXCLUDE_VERB}(?!\p{L})${EXCLUDE_GAP})\s+${EXCLUDE_FILLER}$`,
  'iu'
);
// Просьба о всей команде и отказ от неё. Правило: в сомнении — как раньше, когда «все/всех/всем/всеми/всей» всегда
// были просьбой, а «всю» не распознавалось. Решает фрагмент фразы вокруг слова — до запятой, точки, двоеточия,
// «?», тире или союза; «пожалуйста» в запятых фрагмент не делит.
const FRAGMENT_SPLIT = /[,.;:!?\n—–]|(?<!\p{L})(?:и|а|но|или|либо)(?!\p{L})/iu;
// Совпадение начинается только с начала серии пробелов, а не с каждого пробела в ней.
const POLITE_INSERT = new RegExp(String.raw`(?<!\s)${POLITE}`, 'giu');
const fragmentBefore = (goal, start) => goal.slice(0, start).replace(POLITE_INSERT, ' ').split(FRAGMENT_SPLIT).at(-1);
const fragmentAfter = (goal, end) => goal.slice(end).replace(POLITE_INSERT, ' ').split(FRAGMENT_SPLIT)[0];
// «всю команду» не поручение офису, если это цитата или задача уже адресована одному сотруднику:
// - перед фрагментом двоеточие или тире после поручения («Luma 4, переведи на английский: подключи всю команду»),
//   но короткая метка без глагола — не поручение («Задача: подключи всю команду», «Важно: …»);
// - фрагмент внутри кавычек;
// - раньше в том же предложении назван Luma 2–6 («Luma 5, напиши приглашение и позови всю команду» — команда бизнеса).
const FRAGMENT_DELIMITERS = new RegExp(FRAGMENT_SPLIT.source, 'giu');
const LABEL = /^\s*(?:[\p{L}-]+\s*){1,2}$/u;
// «Текст: …», «Черновик: …» — дальше материал для обработки, а не поручение.
const CONTENT_LABEL = /(?<!\p{L})(?:текст|черновик|фраз|цитат|пример|сообщени|письм|пост|перевод|оригинал)\p{L}*/iu;
// Задача адресована сотруднику по роли: «Менеджер продаж — напиши приглашение и позови всю команду».
const ROLE_ADDRESS = /(?<!\p{L})(?:исследовател\p{L}*(?:\s+рынка)?|аналитик\p{L}*\s+рынка|продуктолог\p{L}*|креатор\p{L}*|менеджер\p{L}*\s+(?:по\s+)?продаж\p{L}*|продажник\p{L}*|финансов\p{L}*\s+аналитик\p{L}*|финансист\p{L}*)\s*[:—–-]/iu;
const VERB_LIKE = /(?:и|й|ь|ти)(?:те)?(?!\p{L})/iu;
const SENTENCE_START = /[.!?\n](?=[^.!?\n]*$)/u;
const ADDRESSED_AGENT = /(?<![\p{L}\d])(?:luma|люма)\s*[-#№]?\s*[2-6](?!\d)/iu;
function notForOffice(goal, start) {
  // Перенос строки после двоеточия не начинает новое предложение: «Переведи на английский:\n<текст>».
  const head = goal.slice(0, start).replace(POLITE_INSERT, ' ').replace(/:[^\S\n]*\n\s*/gu, ': ');
  const count = pattern => (head.match(pattern) || []).length;
  if (count(/«/g) > count(/»/g) || count(/["“”]/g) % 2 === 1) return true;
  const sentence = head.slice(head.search(SENTENCE_START) + 1);
  if (ADDRESSED_AGENT.test(sentence) || ROLE_ADDRESS.test(sentence)) return true;
  // Любое двоеточие или тире после поручения в этом предложении — дальше материал, даже через запятые
  // («Текст: привет, позови всю команду»).
  const pieces = sentence.split(FRAGMENT_SPLIT);
  const delimiters = sentence.match(FRAGMENT_DELIMITERS) || [];
  return delimiters.some((mark, i) => [':', '—', '–'].includes(mark) &&
    !(LABEL.test(pieces[i]) && !VERB_LIKE.test(pieces[i]) && !CONTENT_LABEL.test(pieces[i])));
}
// Фрагмент — вопрос («Разве всех подключать не нужно?»): риторика, а не отказ.
const fragmentIsQuestion = (goal, end) => goal.slice(end).replace(POLITE_INSERT, ' ').match(FRAGMENT_SPLIT)?.[0] === '?';

// «всю» — просьба, только если фрагмент начинается с приказа «подключи/позови…» вплотную к ней («Подключи всю команду: …»,
// «Не забудь позвать всю команду»), после неё фрагмент кончается (или «кроме Luma 2») и в нём нет отрицания.
// «Убери всю команду», «мотивирует всю команду кофейни», «Зачем звать всю команду?», «Придумай повод собрать всю команду» —
// не просьба: инфинитив без «не забудь» — тема задачи, а не поручение офису.
// «возьми/собери всю команду» чаще про команду самого бизнеса («собери всю команду на планёрку») — не считаем.
const CALL_IMPERATIVE = String.raw`(?:подключи|задействуй|привлеки|позови|зови)(?:те)?`;
const CALL_INFINITIVE_PERFECT = String.raw`(?:подключить|задействовать|привлечь|позвать|собрать|звать)`;
const CALL_BEFORE = new RegExp(
  String.raw`^\s*(?:${CALL_IMPERATIVE}|не\s+(?:забудь|забудьте|стесняйся|стесняйтесь)\s+${CALL_INFINITIVE_PERFECT})(?:\s+(?:сразу|сюда|ещё|еще))?\s+$`,
  'iu'
);
const EMPTY_OR_EXCEPTION = /^\s*(?:(?:кроме|за\s+исключением|помимо)\s[\s\S]*)?$/iu;
// «чтобы» — цель, а не просьба: «Вместо того, чтобы звать всю команду, …» (запятая отрезает «вместо»).
const FRAGMENT_NEGATION = /(?<!\p{L})(?:не|ни|нет|хватит|незачем|необязательно|вместо|чтобы)(?!\p{L})/iu;
// «Подключи всю команду? Нет, только Luma 4», «Подключи всю команду — не надо, …»: следующий фрагмент отменяет просьбу.
// «Подключи всю команду: не надо экономить» — отказ не от команды.
const REFUSAL_NEXT = /^\s*[?!.;:—–-]\s*(?:нет|не\s+(?:надо|нужно|стоит))\s*(?:[,.!;—–-]|$)/iu;
// «Не забудь подключить всю команду», «Не стесняйся позвать всю команду» — по смыслу не отказ.
const NOT_A_REFUSAL = /(?<!\p{L})не\s+(?:забудь|забудьте|забывай|забывайте|стесняйся|стесняйтесь)(?!\p{L})/giu;

// «все», «всех» — отказ, только если фрагмент начинается с отрицания вплотную к слову и больше ему нечего отрицать:
// «Не подключай всех специалистов, …», «Не всех, только Luma 4», «Можно не звать всех, …», «Мне нужны не все, …»,
// «Всех сотрудников, пожалуйста, не зовите, …». Просьба, как раньше: «Подключи всех, пожалуйста, не трогай бюджет»,
// «Не зови всех специалистов по одному», «Ты подключил не всех специалистов», «Нельзя не задействовать всех».
const REFUSE_VERB = String.raw`(?:подключай|привлекай|задействуй|используй|назначай|включай|добавляй|приглашай|зови|бери|трогай|ставь)(?:те)?`;
const CALL_INFINITIVE = String.raw`(?:подключать|привлекать|задействовать|использовать|назначать|включать|добавлять|приглашать|звать|брать|трогать)`;
const REFUSAL_BEFORE = new RegExp(String.raw`^\s*(?:(?:мне|нам)\s+нужн\p{L}*\s+не` +
  String.raw`|не(?:\s+${REFUSE_VERB}|\s+(?:надо|нужн\p{L}*|стоит|хочу|будем)(?:\s+${CALL_INFINITIVE})?)?` +
  String.raw`|(?:можно|можешь|можете|можем|давай|давайте|чтобы|лучше(?:\s+бы)?|хорошо\s+бы)\s+не(?:\s+будем)?\s+${CALL_INFINITIVE})\s+$`, 'iu');
const NOTHING_AFTER_REFUSAL = /^\s*(?:нуж\p{L}*|требуются)?\s*$/iu;
// «Не всех специалистов, а вообще весь офис подключи» — противопоставление снова про всех: не отказ.
const CONTRAST_TO_ALL = /^\s*[,—–-]?\s*а\s+(?:[\p{L}-]+\s+){0,2}?(?:весь|всю|всех|все|вся|всем)(?!\p{L})/iu;
// «Всех специалистов подключать не надо», «Все специалисты не нужны», «Всех лучше не звать». «Исключать не нужно» — не отказ.
const REFUSAL_AFTER = new RegExp(String.raw`^(?:\s+лучше)?(?:\s+${CALL_INFINITIVE})?\s+не\s+(?:${REFUSE_VERB}|${CALL_INFINITIVE}|надо|нужно|стоит|требуется|нуж(?:ен|на|ны))\s*$`, 'iu');
const ADDRESS_TO_ALL = new RegExp(String.raw`^\s+не\s+${REFUSE_VERB}\s*$`, 'iu');
// «Для всех сотрудников», «у всех», «без всех» — не объект отказа.
const PREPOSITION_BEFORE = /(?<!\p{L})(?:для|у|от|из|про|о|об|обо|на|в|во|с|со|по|к|ко|при|среди|между|кроме|помимо|без)\s+$/iu;

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
  return ALL_TEAM_PATTERNS.some(pattern => [...goal.matchAll(pattern)].some(match => {
    const before = fragmentBefore(goal, match.index);
    const after = fragmentAfter(goal, match.index + match[0].length);
    const form = match[0].match(/^\p{L}+/u)[0].toLowerCase();
    if (form === 'всю') {
      const next = goal.slice(match.index + match[0].length).replace(POLITE_INSERT, ' ').slice(after.length);
      return CALL_BEFORE.test(before) && EMPTY_OR_EXCEPTION.test(after) && !notForOffice(goal, match.index) && !REFUSAL_NEXT.test(next) &&
        !FRAGMENT_NEGATION.test(`${before} ${after}`.replace(NOT_A_REFUSAL, ' '));
    }
    // «всем», «всеми», «всей» не бывают объектом отказа («Всем пятерым не нужен отчёт» — про отчёт).
    if ((form !== 'все' && form !== 'всех') || PREPOSITION_BEFORE.test(before)) return true;
    if (fragmentIsQuestion(goal, match.index + match[0].length)) return true;
    // Отказ после слова — только когда «все/всех» начинает фрагмент: «Исключать всех специалистов не стоит» — просьба.
    // «Все специалисты, не используйте …» — обращение к агентам (именительный и приказ), а не отказ от них.
    const addressed = form === 'все' && ADDRESS_TO_ALL.test(after);
    const refusedBefore = REFUSAL_BEFORE.test(before) && NOTHING_AFTER_REFUSAL.test(after) &&
      !CONTRAST_TO_ALL.test(goal.slice(match.index + match[0].length).replace(POLITE_INSERT, ' ').slice(after.length));
    return !refusedBefore && !(!before.trim() && !addressed && REFUSAL_AFTER.test(after));
  }));
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
export function agentMessages(agent, task, plan) {
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
  const user = task.assigned
    ? `${context ? `КОНТЕКСТ:\n${context}\n\n` : ''}ТВОЁ ЗАДАНИЕ:\n${task.objective}\n${calc}\nДай только готовый результат по этому заданию, коротко.${shape}${one} Допущения помечай словом «допущение».`
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

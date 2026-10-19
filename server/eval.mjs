// Автоматическая оценка ответов команды на задаче кофейни (test/fixtures.mjs → COFFEE_GOAL).
// Простые проверяемые правила вместо «на глаз»: выполнено ли именно то, что просили, и не выдумано ли лишнее.

/** Строки ответа без пометок «допущение» и без пустых строк. */
function contentLines(text) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => {
    // «3. Допущение: …» — это пометка, а не пункт ответа.
    const body = line.replace(/^(?:[-*•–]|\d+[.)])\s+/u, '');
    return line && !/^[*_\s]*допущени/iu.test(body) && !/^[*_\s]*(?:факт|итог)[*_\s]*:?[*_\s]*$/iu.test(body);
  });
}

const LIST_MARKER = /^(\s*)(?:[-*•–]|\d+[.)])\s+(.*)$/u;

/**
 * Пункты списка верхнего уровня: «- …», «* …», «• …», «1. …», «1) …».
 * Вложенные пояснения (с большим отступом), заголовки вида «**3 группы:**» и пометки «допущение» не считаются.
 */
export function countListItems(text) {
  const items = text.split(/\r?\n/).map(line => line.match(LIST_MARKER)).filter(Boolean)
    .map(([, indent, body]) => ({ indent: indent.replace(/\t/g, '    ').length, body: body.trim() }))
    .filter(({ body }) => body && !/^[*_\s]*допущени/iu.test(body));
  if (!items.length) return 0;
  const top = Math.min(...items.map(item => item.indent));
  return items.filter(item => item.indent === top).length;
}

const QUOTE = String.raw`(?:«[^»\n]{3,}»|"[^"\n]{3,}"|“[^”\n]{3,}”)`;

/**
 * Сколько вариантов слогана в ответе.
 * - слоганы списком («- "A"», «1. «B»») → число таких пунктов;
 * - подпись «Слоган: «…»» → 1, даже если дальше в пояснении есть другие цитаты (аудитория, название);
 * - иначе — разные цитаты, а без кавычек — непустые строки ответа.
 */
export function countSlogans(text) {
  const listed = contentLines(text).filter(line => /^(?:[-*•–]|\d+[.)])\s+/u.test(line) && new RegExp(QUOTE, 'u').test(line));
  if (listed.length >= 2) return listed.length;
  if (new RegExp(String.raw`слоган\p{L}*[^\n:«"“]*:\s*(?:\*\*)?\s*${QUOTE}`, 'iu').test(text)) return 1;
  const quoted = text.match(new RegExp(QUOTE, 'gu')) || [];
  if (quoted.length) return new Set(quoted.map(q => q.slice(1, -1).trim().toLowerCase())).size;
  return contentLines(text).length;
}

/** Числа в тексте без пометок «допущение» (для поиска выдуманных цифр). */
export function numbersIn(text) {
  return contentLines(text).join(' ').match(/\d+(?:[.,]\d+)?/g)?.map(n => Number(n.replace(',', '.'))) || [];
}

const CHECKS = {
  research: { label: '3 группы клиентов', check: text => ({ ok: countListItems(text) === 3, detail: `пунктов: ${countListItems(text)}` }) },
  product: { label: '3 напитка', check: text => ({ ok: countListItems(text) === 3, detail: `пунктов: ${countListItems(text)}` }) },
  creator: { label: 'один слоган', check: text => ({ ok: countSlogans(text) === 1, detail: `вариантов: ${countSlogans(text)}` }) },
  sales: { label: '2 способа привлечения', check: text => ({ ok: countListItems(text) === 2, detail: `пунктов: ${countListItems(text)}` }) },
  finance: {
    label: 'выручка 30 × 3 € = 90 € без выдуманных цифр',
    check: text => {
      // Ищем во всём ответе, включая «допущение» (туда модель может спрятать выдуманные затраты).
      // 30 и 3 допустимы только в самом расчёте («30 × 3», «30 заказов × 3 €») и как «30 заказов»;
      // «Затраты: 30 €» или «Маржа: 3 €» — выдуманные цифры. «90,00 €» — это 90.
      const has90 = /(?<![\d.,])90(?:[.,]0+)?(?![\d.,]?\d)/.test(text);
      const rest = text
        .replace(/(?<![\d.,])30\s*(?:\p{L}+\s*)?[×xх*·]\s*3(?![\d.,]?\d)\s*€?/giu, ' ')
        .replace(/(?<![\d.,])30\s+(?:заказ|клиент|покупател|продаж|чаш|напит|шт|человек|гост)\p{L}*/giu, ' ');
      const extra = [...new Set((rest.match(/\d+(?:[.,]\d+)?/g) || []).map(n => Number(n.replace(',', '.'))).filter(n => n !== 90))];
      return { ok: has90 && extra.length === 0, detail: `${has90 ? '90 есть' : 'нет 90'}${extra.length ? `; лишние числа: ${extra.join(', ')}` : ''}` };
    }
  }
};

/**
 * Оценка одного прогона по событиям задачи (/api/runs/:id).
 * Возвращает по сотрудникам: выполнено ли задание, писал ли за других, обрезан ли ответ, время — и общий балл.
 */
/** Пересчёт по сохранённым ответам (data/evals/*.json → reports[].results). */
export function scoreResults(results) {
  return scoreCoffeeRun(results.map(r => ({ type: 'agent-result', agentId: r.agentId, result: r.result })));
}

export function scoreCoffeeRun(events) {
  const results = new Map(events.filter(e => e.type === 'agent-result').map(e => [e.agentId, e]));
  const agents = Object.entries(CHECKS).map(([agentId, { label, check }]) => {
    const event = results.get(agentId);
    if (!event) return { agentId, label, ok: false, detail: 'нет результата', foreign: [], truncated: false, seconds: null, tokens: null };
    const { ok, detail } = check(event.result);
    return {
      agentId, label, ok, detail,
      foreign: event.foreign || [],
      truncated: event.stats?.doneReason === 'length',
      seconds: event.stats?.totalMs ? Math.round(event.stats.totalMs / 100) / 10 : null,
      tokens: event.stats?.outputTokens ?? null
    };
  });
  const passed = agents.filter(a => a.ok && !a.foreign.length && !a.truncated).length;
  const first = events[0]?.at;
  const last = events.at(-1)?.at;
  return { agents, passed, total: agents.length, seconds: first && last ? Math.round((last - first) / 100) / 10 : null };
}

// --- Повторы за коллегами (HANDOFF, CROSS_TALK) --------------------------------------------------
// Маленькая модель, получив чужой результат, переписывает его строки (и чужие «допущения») вместо своей работы.
// Мера — общие тройки слов: слова сравниваются по первым пяти буквам, чтобы «группа/группы», «ценящие/ценящих»
// совпадали, а порядок слов и смысл фразы — нет.
export const ECHO_LINE_SHARE = 0.6;
const STEM = 5;

function stems(line) {
  return (line.toLowerCase().replaceAll('ё', 'е').match(/[\p{L}\d]+/gu) || []).map(word => word.slice(0, STEM));
}

function trigrams(words) {
  return words.slice(2).map((_, i) => `${words[i]} ${words[i + 1]} ${words[i + 2]}`);
}

function echoLines(text) {
  return String(text || '').replace(/<think>[\s\S]*?(?:<\/think>|$)/giu, '').split(/\r?\n/)
    .map(line => line.trim().replace(/^(?:[-*•–]|\d+[.)])\s+/u, ''))
    .map(line => {
      const words = stems(line);
      return { line, words, grams: trigrams(words) };
    })
    .filter(({ words }) => words.length);
}

function knownGrams(sources) {
  return new Set(sources.flatMap(source => echoLines(source).flatMap(({ grams }) => grams)));
}

/**
 * Сколько в тексте списано из источников: строка (от трёх слов) списана, если ≥ 60 % её троек слов есть в источниках.
 * copiedAssumption — среди списанных есть чужая пометка «допущение». share — доля всех троек текста, найденных в источниках.
 */
export function echo(text, sources = []) {
  const known = knownGrams(sources);
  let total = 0;
  let found = 0;
  let copiedLines = 0;
  let copiedAssumption = false;
  const lines = echoLines(text).filter(({ grams }) => grams.length);
  for (const { line, grams } of lines) {
    const hits = grams.filter(gram => known.has(gram)).length;
    total += grams.length;
    found += hits;
    if (hits / grams.length >= ECHO_LINE_SHARE) {
      copiedLines++;
      if (/^[*_\s]*допущени/iu.test(line)) copiedAssumption = true;
    }
  }
  return { lines: lines.length, copiedLines, copiedAssumption, share: total ? Math.round((found / total) * 100) / 100 : 0 };
}

// Служебные слова, обращение, связки пересказа («ты пишешь, что …», «нужно уточнить») и согласие («да, полностью согласен»):
// своим содержанием не считаются.
const FILLER = new Set(['и', 'в', 'во', 'на', 'с', 'со', 'а', 'но', 'не', 'по', 'к', 'о', 'об', 'у', 'за', 'из', 'от', 'до', 'для',
  'что', 'как', 'это', 'ты', 'вы', 'я', 'мы', 'он', 'она', 'они', 'его', 'ее', 'их', 'же', 'ли', 'бы', 'то', 'так', 'или', 'уже',
  'еще', 'все', 'тебя', 'тебе', 'твой', 'твои', 'твоя', 'пишеш', 'пишет', 'говор', 'отмет', 'указа', 'нужно', 'надо', 'уточн',
  'важно', 'luma', 'люма', 'да', 'нет', 'согла', 'полно', 'верно', 'прав', 'права', 'прави', 'точно', 'отлич', 'хорош', 'спаси',
  'понял', 'ясно', 'ок', 'окей']);

/**
 * Свои слова текста: не входят в тройки слов, найденные в источниках, и не служебные.
 * «Luma 2, группа взрослых … приходят вечером: во сколько именно?» → ['сколь', 'именн'] (основы по пять букв).
 */
export function novelWords(text, sources = []) {
  const known = knownGrams(sources);
  return echoLines(text).flatMap(({ words, grams }) => {
    const copied = new Set();
    grams.forEach((gram, i) => { if (known.has(gram)) [i, i + 1, i + 2].forEach(j => copied.add(j)); });
    return words.filter((word, i) => !copied.has(i) && !FILLER.has(word) && !(/^\d$/u.test(word) && /^(?:luma|люма)$/u.test(words[i - 1])));
  });
}

/**
 * Оценка ролевой задачи с HANDOFF и CROSS_TALK: что сотрудники списали из полученных данных
 * и сколько реплик чата лишь пересказывают результаты коллег.
 */
export function scoreTeamRun(events) {
  const results = events.filter(e => e.type === 'agent-result');
  const resultOf = id => results.find(e => e.agentId === id)?.result || '';
  const agents = results.map(e => {
    const handoffFrom = e.handoffFrom || [];
    return { agentId: e.agentId, handoffFrom, ...echo(e.result, handoffFrom.map(resultOf)) };
  });
  const chatEvents = events.filter(e => e.type === 'agent-chat');
  // Пересказ — против результатов коллег и уже сказанных реплик.
  const chat = chatEvents.map((e, i) => {
    const { share } = echo(e.text, [...results.filter(r => r.agentId !== e.agentId).map(r => r.result), ...chatEvents.slice(0, i).map(c => c.text)]);
    return { agentId: e.agentId, to: e.to, text: e.text, share, echo: share >= ECHO_LINE_SHARE };
  });
  const first = events[0]?.at;
  const last = events.at(-1)?.at;
  return {
    agents, chat,
    copiedLines: agents.reduce((sum, a) => sum + a.copiedLines, 0),
    copiedAssumptions: agents.filter(a => a.copiedAssumption).length,
    chatReplies: chat.length,
    chatEchoes: chat.filter(c => c.echo).length,
    seconds: first && last ? Math.round((last - first) / 100) / 10 : null
  };
}

// --- Оценка «живой команды» для сравнения версий (scripts/eval-team.mjs --rescore) -----------------
// Всё считается по сохранённым событиям и вызовам модели, поэтому одинаково для любой версии кода.

// Кто за какую часть ролевой задачи отвечает (TEAM_GOAL): по этим словам видно и чужие разделы в ответе.
const TEAM_PARTS = {
  research: { label: 'клиенты', section: /клиент|аудитор|сегмент/iu },
  product: { label: 'напитки', section: /напит|меню|ассортимент/iu },
  creator: { label: 'слоган', section: /слоган/iu },
  sales: { label: 'первые гости', section: /привлеч|первых\s+гост|продвиж|маркетинг/iu },
  finance: { label: 'выручка за месяц', section: /выручк|финанс|доход/iu }
};
const DRINKS = /кофе|капучино|латте|эспрессо|американо|раф|флэт|мокко|какао|чай|матча|лимонад|смузи|сок|фраппе|шоколад/giu;
const ATTRACT = /скидк|акци|листовк|флаер|соцсет|инстаграм|телеграм|вконтакт|дегустац|бонус|лояльн|партн[её]р|мероприят|промокод|бесплатн|подар/giu;
const CLIENTS = /студент|преподават|сотрудник|аспирант|жител|офис|гост|школьник|учител|посетител/giu;

const distinct = (text, pattern) => new Set((text.match(pattern) || []).map(w => w.toLowerCase().slice(0, 5))).size;

/** Выполнена ли своя часть ролевой задачи (форма, не качество идей) — для разбора вручную это только подсказка. */
export function teamPartDone(agentId, text) {
  switch (agentId) {
    case 'research': return distinct(text, CLIENTS) >= 2;
    case 'product': return distinct(text, DRINKS) >= 2;
    case 'creator': return /«[^»\n]{3,}»|"[^"\n]{3,}"|“[^”\n]{3,}”/u.test(text);
    case 'sales': return distinct(text, ATTRACT) >= 2;
    case 'finance': return /выручк[^\n]{0,120}?\d[\d\s.,]*\s*(?:€|евро|руб|₽|\$|тыс)/iu.test(text) || /\d[\d\s.,]*\s*(?:€|евро|руб|₽|\$)[^\n]{0,60}выручк/iu.test(text);
    default: return false;
  }
}

/** Разделы ответа о чужих частях задачи («### Слоган» у продуктолога): сотрудник пишет за коллег. */
export function foreignSections(agentId, text) {
  const headers = text.split(/\r?\n/).filter(line => /^\s*(?:#+\s|\*\*[^*]+\*\*\s*:?\s*$|[^\s].{0,40}:\s*$)/u.test(line));
  return [...new Set(headers.flatMap(line => Object.entries(TEAM_PARTS)
    .filter(([id, part]) => id !== agentId && part.section.test(line)).map(([id]) => id)))];
}

// Оговорка о статусе: слово в строке или пометка из сводки.
const HEDGE = /допущ|гипотез|предпол|примерн|приблизит|оценк|оценочн|прогноз|ориентировоч|около\s+\d|[~≈]\s*\d|не\s+провер|\[(?:гипотеза|оценка)\]/iu;
// Общая оговорка обо всём ответе или блоке: «допущение: данные основаны…», «цены ниже — гипотезы».
const GLOBAL_HEDGE = /^\W*(?:допущ|гипотез|предпол)[^\n]*(?:ниже|выше|данн|основан|цифр|цен|расч|вс[её])/imu;
// Значимые числа: с валютой или процентом, либо из двух и более цифр («3 €», «10 %», «30», «2 700»).
const NUMBER = /\d[\d   ]*(?:[.,]\d+)?(?=\s*(?:€|евро|руб|₽|\$|%))|\d{2,}(?:[   ]\d{3})*(?:[.,]\d+)?/gu;

function numbersByLine(text) {
  return String(text || '').split(/\r?\n/).map(line => ({
    line,
    numbers: [...new Set((line.match(NUMBER) || []).map(n => n.replace(/[\s  ]/gu, '').replace(',', '.')))]
  }));
}

/** Числа источника со статусом «гипотеза/оценка»: в строке с оговоркой или при общей оговорке. */
export function hedgedNumbers(text) {
  const global = GLOBAL_HEDGE.test(text);
  return new Set(numbersByLine(text).filter(({ line }) => global || HEDGE.test(line)).flatMap(({ numbers }) => numbers));
}

/**
 * Как сотрудник обошёлся с числами коллег: taken — взял в свой ответ; hedged — из них со статусом
 * гипотезы или оценки у коллеги; kept — у сотрудника тоже с оговоркой (в строке или общей); lost — подал как факт.
 * sources — что сотрудник получил (данные из подсказки), status — исходные ответы коллег, по ним статус числа.
 */
export function numberUse(result, sources, { status = sources } = {}) {
  const known = new Set(sources.flatMap(source => numbersByLine(source).flatMap(({ numbers }) => numbers)));
  const hedged = new Set(status.flatMap(source => [...hedgedNumbers(source)]));
  const global = GLOBAL_HEDGE.test(result);
  const lines = numbersByLine(result);
  const taken = new Set(lines.flatMap(({ numbers }) => numbers).filter(n => known.has(n)));
  const use = { taken: taken.size, hedged: 0, kept: 0, lost: [] };
  for (const n of taken) {
    if (!hedged.has(n)) continue;
    use.hedged++;
    if (global || lines.some(({ line, numbers }) => numbers.includes(n) && HEDGE.test(line))) use.kept++;
    else use.lost.push(n);
  }
  return use;
}

const AGENT_BY_NUMBER = { 2: 'research', 3: 'product', 4: 'creator', 5: 'sales', 6: 'finance' };

/** Данные коллег из подсказки: блоки «ДАННЫЕ ОТ КОЛЛЕГИ (Luma N · …)…:\n…» до следующего блока или задания. */
export function receivedBlocks(prompt) {
  return [...String(prompt || '').matchAll(/ДАННЫЕ ОТ КОЛЛЕГИ \(Luma (\d)[^)]*\)[^\n]*:\n([\s\S]*?)(?=\n\n(?:ДАННЫЕ ОТ КОЛЛЕГИ|Сделай свою часть|ТВО[ЯЁ] ЗАДА)|$)/gu)]
    .map(m => ({ agentId: AGENT_BY_NUMBER[m[1]], text: m[2] }));
}

const sumOf = (items, key) => items.reduce((total, item) => total + (item?.[key] || 0), 0);

/**
 * Полная оценка прогона для сравнения версий: поручения (своя часть ролевой задачи или проверка кофейни),
 * чужие разделы, списанные строки, числа коллег и их оговорки — в подсказке (delivered) и в ответе (numbers),
 * реплики до фильтра и после, время работы и обсуждения, токены.
 */
export function scoreTeamEval({ events, calls = [] }, goal = 'team') {
  const team = scoreTeamRun(events);
  const results = events.filter(e => e.type === 'agent-result');
  const resultOf = id => results.find(e => e.agentId === id)?.result || '';
  const coffee = goal === 'coffee' ? scoreCoffeeRun(events) : null;
  const call = label => calls.find(c => c.label?.split('/').at(-1) === label);
  const agents = team.agents.map(a => {
    const result = resultOf(a.agentId);
    const check = coffee?.agents.find(c => c.agentId === a.agentId);
    const blocks = receivedBlocks(call(a.agentId)?.messages?.at(-1)?.content);
    const delivered = blocks.map(b => numberUse(b.text, [resultOf(b.agentId)]));
    return {
      ...a,
      part: coffee ? Boolean(check?.ok && !check.foreign.length && !check.truncated) : teamPartDone(a.agentId, result),
      foreignSections: foreignSections(a.agentId, result),
      // Совпадение с числом, которого в подсказке не было (обрезано), — не взятое у коллеги.
      numbers: numberUse(result, blocks.length ? blocks.map(b => b.text) : a.handoffFrom.map(resultOf), { status: a.handoffFrom.map(resultOf) }),
      delivered: blocks.length
        ? { taken: sumOf(delivered, 'taken'), hedged: sumOf(delivered, 'hedged'), kept: sumOf(delivered, 'kept'), lost: delivered.flatMap(d => d.lost) }
        : null
    };
  });
  const shown = events.filter(e => e.type === 'agent-chat');
  const chat = calls.filter(c => /\/chat-/u.test(c.label || '')).map(c => {
    const agentId = c.label.split('/chat-').at(-1);
    const reply = shown.find(e => e.agentId === agentId);
    return { agentId, raw: c.text ?? null, shown: reply?.text ?? null, to: reply?.to };
  });
  const first = events[0]?.at;
  const last = events.at(-1)?.at;
  const final = events.find(e => e.type === 'final')?.at;
  const seconds = (from, to) => (from && to ? Math.round((to - from) / 100) / 10 : null);
  return {
    ...team, agents, chat,
    ...(coffee ? { coffee: { passed: coffee.passed, total: coffee.total } } : {}),
    partsDone: agents.filter(a => a.part).length,
    agentsWithForeignSections: agents.filter(a => a.foreignSections.length).length,
    hedgedTaken: sumOf(agents.map(a => a.numbers), 'hedged'),
    hedgedKept: sumOf(agents.map(a => a.numbers), 'kept'),
    hedgedReceived: sumOf(agents.map(a => a.delivered), 'hedged'),
    hedgedDelivered: sumOf(agents.map(a => a.delivered), 'kept'),
    chatRaw: chat.length,
    workSeconds: seconds(first, final),
    discussionSeconds: seconds(final, last),
    promptTokens: sumOf(calls.map(c => c.stats), 'promptTokens'),
    outputTokens: sumOf(calls.map(c => c.stats), 'outputTokens')
  };
}

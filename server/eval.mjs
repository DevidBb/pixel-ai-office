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
    .map(line => ({ line, grams: trigrams(stems(line)) }))
    .filter(({ grams }) => grams.length);
}

/**
 * Сколько в тексте списано из источников: строка (от трёх слов) списана, если ≥ 60 % её троек слов есть в источниках.
 * copiedAssumption — среди списанных есть чужая пометка «допущение». share — доля всех троек текста, найденных в источниках.
 */
export function echo(text, sources = []) {
  const known = new Set(sources.flatMap(source => echoLines(source).flatMap(({ grams }) => grams)));
  let total = 0;
  let found = 0;
  let copiedLines = 0;
  let copiedAssumption = false;
  const lines = echoLines(text);
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

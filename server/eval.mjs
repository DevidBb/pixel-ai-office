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

/** Пункты списка: «- …», «* …», «• …», «1. …», «1) …». Заголовки вида «**3 группы:**» не считаются. */
export function countListItems(text) {
  return contentLines(text).filter(line => /^(?:[-*•–]\s+|\d+[.)]\s+)/u.test(line) && !/:\s*\**$/u.test(line.replace(/^(?:[-*•–]|\d+[.)])\s+/u, ''))).length;
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
      // 90 ищем во всём ответе (модель иногда помечает сам расчёт как «допущение»),
      // лишние числа — только вне пометок «допущение».
      const has90 = /(?<![\d.,])90(?![\d.,])/.test(text);
      const extra = [...new Set(numbersIn(text).filter(n => ![30, 3, 90].includes(n)))];
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

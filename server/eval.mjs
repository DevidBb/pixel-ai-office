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
  return listItems(text).length;
}

const isNote = body => /^[*_\s]*допущени/iu.test(body);
// «Итого: …», «Вывод: …» сразу после списка — общий абзац, а не продолжение последнего пункта.
const isSummary = body => /^[*_\s]*(?:итог|вывод|резюме|примечани|комментари)/iu.test(body);

/**
 * Пункты списка верхнего уровня с продолжением: «1. Группы клиентов\nГруппа студентов — …» → один пункт из двух строк;
 * вложенные пояснения входят в пункт, но не считаются отдельными. Пункт завершают строка «допущение» и текст
 * без отступа после пустой строки («Итого: …» после списка).
 */
export function listItems(text) {
  const lines = text.split(/\r?\n/);
  const marked = lines.map(line => line.match(LIST_MARKER))
    .map(match => match && { indent: match[1].replace(/\t/g, '    ').length, body: match[2].trim() });
  const real = marked.filter(item => item && item.body && !isNote(item.body));
  if (!real.length) return [];
  const top = Math.min(...real.map(item => item.indent));
  const items = [];
  let open = false;
  lines.forEach((line, i) => {
    const item = marked[i];
    if (item && item.indent === top) {
      open = Boolean(item.body) && !isNote(item.body);
      items.push(open ? [item.body] : null);
      return;
    }
    const body = item ? item.body : line.trim();
    if (!open || !body) return;
    const nested = Boolean(item) || /^\s/.test(line);
    // Вложенное «- Допущение: …» пропускаем, а пункт продолжается; «допущение» без отступа, итог и абзац после
    // пустой строки пункт завершают.
    if (isNote(body) && nested) return;
    if (isNote(body) || (!nested && (isSummary(body) || !lines[i - 1].trim()))) {
      open = false;
      return;
    }
    items.at(-1).push(body);
  });
  return items.filter(Boolean);
}

// Реалистичность: существует ли названное в настоящей жизни. Форма может быть верной («3 напитка»),
// а сами напитки — «Смешанник из вина» и «Молочный шаурма». Словари — для задачи кофейни у университета.
const WORD = String.raw`(?<!\p{L})`;
const words = list => new RegExp(`${WORD}(?:${list.join('|')})`, 'iu');
const REALITY = {
  research: {
    scope: 'name',
    real: words(['студент', 'преподавател', 'сотрудник', 'работник', 'персонал', 'абитуриент', 'аспирант', 'магистрант', 'школьник',
      'жител', 'сосед', 'офисн', 'фрилансер', 'родител', 'профессор', 'учён', 'учен', 'турист', 'пенсионер', 'курьер', 'спортсмен'])
  },
  product: {
    scope: 'name',
    real: words(['эспрессо', 'американо', 'капучино', 'латте', 'раф(?:а|у|ом|е|ы)?(?!\\p{L})', 'флэт', 'флет', 'мокк', 'мокачино', 'макиато', 'маккиато',
      'кортадо', 'лунго', 'ристретто', 'колд[- ]?брю', 'cold brew', 'фраппе', 'фраппучино', 'глясе', 'бамбл', 'кофе(?!\\p{L})', 'кофейн(?:ый|ая|ое|ые|ого|ой|ом|ым|ую)(?!\\p{L})', 'какао',
      'горяч\\p{L}* шоколад', 'шоколад', 'ча(?:й|я|ю|ем?|и)(?!\\p{L})', 'чайн(?:ый|ая|ое|ые|ого|ой|ую|ым|ом)(?!\\p{L})', 'матча', 'пуэр', 'улун',
      'каркаде', 'сбитень', 'цикори', 'лимонад', 'смузи', 'морс', 'сок(?:и|а|ов|ом|у|е)?(?!\\p{L})', 'фреш', 'милкшейк', 'молочн\\p{L}* коктейл',
      'вод(?:а|ы|у|ой|е)(?!\\p{L})']),
    // Еда и посуда в названии («Шоколадный торт», «Чайная ложка») — не напиток, даже если в названии есть «шоколад» или «кофе».
    unrealName: words(['шаурм', 'бургер', 'пицц', 'торт(?:ы|а|ик)?(?!\\p{L})', 'кекс', 'пирог', 'печень', 'круассан', 'булоч', 'сэндвич', 'бутерброд',
      'салат', 'оливье', 'чизкейк', 'маффин', 'макарон', 'десерт', 'ложк', 'машин', 'кофейник', 'чайник']),
    // Алкоголь где угодно в пункте — не для кофейни у университета; «без алкоголя», «без сахара и алкоголя» не считаются.
    unreal: new RegExp(String.raw`(?<!(?:без|не)\s+(?:\p{L}+\s+)?(?:\p{L}+(?:\s*,\s*|\s+(?:и|или)\s+)){0,3})${WORD}(?:вин(?:о|а|у|ом|е)(?!\p{L})|винн|пив|алкогол|коньяк|ликёр|ликер|ром(?:а|у|ом|е)?(?!\p{L})|виски|водк|шампанск)`, 'iu')
  },
  sales: {
    scope: 'line',
    real: words(['соцсет', 'социальн\\p{L}* сет', 'инстаграм', 'instagram', 'вконтакт', 'вк(?!\\p{L})', 'vk', 'телеграм', 'telegram', 'тикток', 'tiktok',
      'ютуб', 'youtube', 'листов(?:к|ок)', 'флаер', 'плакат', 'афиш', 'объявлени', 'визит(?:к|ок)', 'баннер', 'вывес(?:к|ок)', 'штендер', 'скид(?:к|ок)', 'акци',
      'лояльност', 'бонус', 'промокод', 'купон', 'абонемент', 'студенческ', 'партн[её]р', 'сотрудничеств', 'дегустац', 'пробн', 'бесплатн',
      'мероприяти', 'вечер', 'спецпредложени', 'специальн\\p{L}* предложени', 'конкурс', 'розыгрыш', 'викторин', 'квиз', 'ярмар(?:к|ок)', 'фестивал', 'рассыл', 'отзыв', '2гис', '2gis', 'яндекс', 'сарафан', 'рекомендац', 'достав', 'стенд', 'реклам', 'сми'])
  }
};

// «Группа студентов», «Группа: студенты», «Группа 1 — …», «Способ привлечения: …», «Группы клиентов», «Напиток: Латте»,
// «Вариант 2 — …» — подпись пункта, а не его содержание. «Напиток с чаем» (без двоеточия) — название.
const ITEM_LABEL = /^(?:(?:групп\p{L}*(?:\s+клиент\p{L}*)?|способ\p{L}*(?:\s+привлечени\p{L}*)?)(?:\s*№?\s*\d+)?(?=[\s:—–-]|$)\s*[:—–-]?|(?:напит\p{L}*|вариант\p{L}*|услуг\p{L}*|канал\p{L}*)(?:\s*№?\s*\d+)?\s*[:—–-])\s*/iu;

/** Что пункт называет: «**Капучино** – классика» → «Капучино»; для 'line' — вся первая строка. */
function itemName(lines, scope) {
  const text = lines.map(line => line.replace(/[*_«»"“”]/g, '').replace(ITEM_LABEL, '').trim()).find(Boolean) || '';
  return scope === 'line' ? text : text.split(/\s+[—–-]\s+|[:(,.]/u)[0].trim();
}

/** Сколько пунктов ответа называют существующее; null — для роли нет словаря (слоган, расчёт). */
export function realityCheck(agentId, text) {
  const rule = REALITY[agentId];
  if (!rule) return null;
  const items = listItems(text).map(lines => ({ name: itemName(lines, rule.scope), text: lines.join(' ') }));
  const unreal = items.filter(item => !rule.real.test(item.name) || rule.unrealName?.test(item.name) || rule.unreal?.test(item.text))
    .map(item => item.name || '—');
  return { real: items.length - unreal.length, total: items.length, unreal };
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

// qwen2.5:3b иногда переходит на китайский посреди ответа («Чай с лимоном —清新而爽口的选择»): такой ответ не засчитывается.
const ALIEN_SCRIPT = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u;

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
    if (!event) return { agentId, label, ok: false, detail: 'нет результата', reality: null, foreign: [], truncated: false, alien: false, seconds: null, tokens: null };
    const { ok, detail } = check(event.result);
    return {
      agentId, label, ok, detail,
      reality: realityCheck(agentId, event.result),
      foreign: event.foreign || [],
      truncated: event.stats?.doneReason === 'length',
      alien: ALIEN_SCRIPT.test(event.result),
      seconds: event.stats?.totalMs ? Math.round(event.stats.totalMs / 100) / 10 : null,
      tokens: event.stats?.outputTokens ?? null
    };
  });
  const passed = agents.filter(a => a.ok && !a.foreign.length && !a.truncated && !a.alien).length;
  const first = events[0]?.at;
  const last = events.at(-1)?.at;
  const checked = agents.map(a => a.reality).filter(Boolean);
  const reality = { real: checked.reduce((sum, r) => sum + r.real, 0), total: checked.reduce((sum, r) => sum + r.total, 0) };
  return { agents, passed, total: agents.length, reality, seconds: first && last ? Math.round((last - first) / 100) / 10 : null };
}

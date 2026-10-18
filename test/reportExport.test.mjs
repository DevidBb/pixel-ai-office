import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';
import { Limiter } from '../server/llm.mjs';
import { RunStore } from '../server/runs.mjs';
import { AGENTS, CEO } from '../server/office.mjs';
// Модули интерфейса на TypeScript: Node 24 запускает их напрямую (снятие типов).
import { taskFromRun } from '../src/taskEvents.ts';
import { buildReportMarkdown, reportFileName } from '../src/reportExport.ts';
import { COFFEE_GOAL, COFFEE_ASSIGNMENTS } from './fixtures.mjs';

const config = readConfig({ OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1', OPENAI_MODEL: 'mock' });
const team = [CEO, ...AGENTS].map(({ id, name, role }) => ({ id, name, role }));

function model() {
  const limiter = new Limiter(1);
  async function callModel(messages, opts) {
    await limiter.acquire(opts.signal, 5_000);
    try {
      opts.onStart?.();
      const task = messages[1].content.match(/ТВОЁ ЗАДАНИЕ:\n(.*)/);
      return { text: `ОТВЕТ ${opts.label.split('/')[1]}: ${task ? task[1] : '—'}`, stats: { outputTokens: 4 } };
    } finally { limiter.release(); }
  }
  return { callModel, limiter };
}

// Настоящая задача: сервер с мок-моделью → журнал → задача интерфейса.
async function coffeeTask() {
  const runs = new RunStore();
  const m = model();
  const server = createApp({ config, callModel: m.callModel, limiter: m.limiter, runs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { runId } = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: COFFEE_GOAL }) })).json();
    const run = runs.get(runId);
    while (run.status === 'running') await new Promise(r => setTimeout(r, 5));
    return taskFromRun(await (await fetch(`${base}/api/runs/${runId}`)).json());
  } finally { server.closeAllConnections(); server.close(); }
}

const baseTask = {
  id: 't1', title: 'Придумай слоган', agentId: 'ceo', status: 'done', createdAt: '03:11',
  startedAt: '2026-10-18T12:00:00.000Z', subtasks: [], logs: []
};

test('buildReportMarkdown: кофейня — задача, дата, статус, план, все пятеро по порядку, итог, без журнала', async () => {
  const task = await coffeeTask();
  const md = buildReportMarkdown(task, team);
  assert.ok(md.startsWith(`# ${COFFEE_GOAL}\n`));
  assert.match(md, /\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/, 'дата и время запуска');
  assert.match(md, /Статус: Завершено/);
  assert.match(md, /## План CEO\n\nCEO назначил: Luma 2/);
  const headings = [...md.matchAll(/^### (Luma \d) · (.+)$/gm)].map(m => `${m[1]} · ${m[2]}`);
  assert.deepEqual(headings, task.subtasks.map(s => {
    const agent = team.find(a => a.id === s.agentId);
    return `${agent.name} · ${agent.role}`;
  }));
  assert.deepEqual(headings.map(h => h.slice(0, 6)), ['Luma 2', 'Luma 3', 'Luma 4', 'Luma 5', 'Luma 6']);
  for (const subtask of task.subtasks) {
    assert.ok(md.includes(subtask.objective), `задание ${subtask.agentId}`);
    assert.ok(md.includes(`ОТВЕТ ${subtask.agentId}: ${COFFEE_ASSIGNMENTS[subtask.agentId]}`), `результат ${subtask.agentId}`);
  }
  assert.match(md, /## Итоговый отчёт CEO\n/);
  assert.ok(md.indexOf('## Итоговый отчёт CEO') > [...md.matchAll(/^### Luma/gm)].at(-1).index);
  // Итог CEO — цитатой: его «## Кто выполнил задачу» не становится разделом отчёта.
  assert.match(md, /^> ## Кто выполнил задачу$/m);
  assert.doesNotMatch(md, /^## Кто выполнил/m);
  for (const log of task.logs) assert.ok(!md.includes(log.message), `журнал не входит: ${log.message}`);
});

test('buildReportMarkdown: подзадача с ошибкой и невыполненная отмечены явно', () => {
  const md = buildReportMarkdown({
    ...baseTask, status: 'error', result: 'Выполнение остановлено: модель недоступна',
    subtasks: [
      { id: 's1', agentId: 'creator', title: 'Слоган', objective: 'слоган', status: 'done', result: 'Кофе, который ждёт тебя' },
      { id: 's2', agentId: 'finance', title: 'Выручка', objective: 'выручка 30 × 3 €', status: 'error', result: 'Ошибка: таймаут модели' },
      { id: 's3', agentId: 'sales', title: 'Привлечение', objective: '2 способа', status: 'queued' }
    ]
  }, team);
  assert.match(md, /Статус: Ошибка/);
  const finance = md.slice(md.indexOf('### Luma 6'), md.indexOf('### Luma 5'));
  assert.match(finance, /❌ Ошибка/);
  assert.match(finance, /таймаут модели/);
  const sales = md.slice(md.indexOf('### Luma 5'));
  assert.match(sales, /Не выполнено/);
  const creator = md.slice(md.indexOf('### Luma 4'), md.indexOf('### Luma 6'));
  assert.doesNotMatch(creator, /Ошибка|Не выполнено/);
});

test('buildReportMarkdown: задача без плана, подзадач и итога не ломается', () => {
  const md = buildReportMarkdown({ ...baseTask, startedAt: undefined, createdAt: '18.10, 03:11', status: 'error' }, team);
  assert.match(md, /^# Придумай слоган\n/);
  assert.match(md, /18\.10, 03:11/, 'без startedAt — createdAt');
  assert.doesNotMatch(md, /План CEO|Итоговый отчёт CEO|undefined|null/);
  const unknown = buildReportMarkdown({ ...baseTask, subtasks: [{ id: 's', agentId: 'ghost', title: 'X', objective: 'что-то', status: 'done', result: 'да' }] }, []);
  assert.match(unknown, /^### ghost$/m, 'неизвестный сотрудник — по идентификатору');
});

// Неудобные ответы, найденные проверками Codex: незакрытый и оборванный код, код в списке, закрытие с 4 пробелами,
// подчёркнутые заголовки, CRLF. Ответ целиком в цитате — что бы в нём ни было, следующий раздел начинается заново.
const NASTY = [
  'Код:\n```python\n# считаем\nx = 1',
  '- Пример:\n  ```js\n  const x = 1;\n\nИтого: работает.\n# Вывод',
  '```python\nprint(1)\n    ```',
  '  ```python\n# comment\nprint(1)',
  '- ```python\n  # comment',
  '# Итог\n\nИтог\n===\n- пункт\n---\n**жирный**\r\n\r\n> цитата\n    x = 1'
];

test('buildReportMarkdown: ответы — цитатой без изменений, незакрытая разметка не захватывает следующий раздел', () => {
  const subtasks = NASTY.map((result, i) => ({ id: `s${i}`, agentId: AGENTS[i % AGENTS.length].id, title: 'X', objective: 'о', status: 'done', result }));
  const md = buildReportMarkdown({ ...baseTask, subtasks, result: '## Кто выполнил задачу\n```\nне закрыт' }, team);
  assert.doesNotMatch(md, /\r/);
  for (const result of NASTY) {
    const quoted = result.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim() ? `> ${line}` : '>').join('\n');
    assert.ok(md.includes(`\n\n${quoted}\n\n`), `цитата отделена пустыми строками: ${JSON.stringify(result)}`);
  }
  // Вне цитат — только структура отчёта, все разделы на месте.
  const headings = md.split('\n').filter(line => /^#/.test(line));
  assert.deepEqual(headings, [
    '# Придумай слоган', '## Результаты сотрудников',
    ...subtasks.map(s => { const a = team.find(t => t.id === s.agentId); return `### ${a.name} · ${a.role}`; }),
    '## Итоговый отчёт CEO'
  ]);
  assert.ok(md.endsWith('\n\n> ## Кто выполнил задачу\n> ```\n> не закрыт\n'));
});

test('buildReportMarkdown: определения ссылок из ответов не действуют на весь отчёт, многострочный план — дословно', () => {
  const subtasks = [
    { id: 's1', agentId: 'research', title: 'X', objective: 'о', status: 'done', result: 'Источник [1]\n\n[1]: https://example.org/a' },
    { id: 's2', agentId: 'sales', title: 'Y', objective: 'о', status: 'done', result: 'Источник [1]\n\n  [1]: https://example.org/b "b"' }
  ];
  const planSummary = 'анализ\n\n~~~text\nчерновик';
  const md = buildReportMarkdown({ ...baseTask, planSummary, subtasks }, team);
  assert.match(md, /^> \\\[1\]: https:\/\/example\.org\/a$/m, 'адрес виден как текст');
  assert.match(md, /^> {3}\\\[1\]: https:\/\/example\.org\/b "b"$/m);
  assert.match(md, /^> Источник \[1\]$/m, 'ссылки в тексте не тронуты');
  // Любая строка, похожая на определение, — текстом: во вложенной цитате, в пункте и продолжении списка,
  // после кода в списке. В блоке кода тоже (цена простоты — видимый «\»), зато общих ссылок нет никогда.
  const md2 = buildReportMarkdown({ ...baseTask, subtasks: [{ id: 's', agentId: 'creator', title: 'X', objective: 'о', status: 'done',
    result: '> [3]: https://example.org/quote\n- [4]: https://example.org/list\n1. Источники:\n\n    [5]: https://example.org/cont\n- ```js\n  x = 1\n  ```\n\n[6]: https://example.org/after\n```\n[7]: https://example.org/code\n```' }] }, team);
  for (const [n, prefix] of [[3, '> > '], [4, '> - '], [5, '> {5}'], [6, '> '], [7, '> ']]) {
    assert.match(md2, new RegExp(`^${prefix}\\\\\\[${n}\\]: https://`, 'm'), `[${n}]`);
  }
  assert.ok(md.includes(`## План CEO\n\n\`\`\`\n${planSummary}\n\`\`\`\n`), 'многострочный план — блоком как есть');
});

test('buildReportMarkdown: текст задачи и задания — обычный текст, не разметка', () => {
  const md = buildReportMarkdown({
    ...baseTask, title: 'Объясни <div> и Array<T>, *не* жирный',
    subtasks: [{ id: 's', agentId: 'creator', title: 'X', objective: 'сравни [a] и `b`', status: 'done', result: '**жирный** ответ' }]
  }, team);
  assert.match(md, /^# Объясни \\<div\\> и Array\\<T\\>, \\\*не\\\* жирный$/m);
  assert.match(md, /^\*\*Задание:\*\* сравни \\\[a\\\] и \\`b\\`$/m);
  assert.match(md, /^> \*\*жирный\*\* ответ$/m, 'ответ сотрудника — Markdown, без экранирования');
  assert.match(buildReportMarkdown({ ...baseTask, title: 'Объясни &lt;div&gt; и &#35;' }, team), /^# Объясни \\&lt;div\\&gt; и \\&#35;$/m);
  assert.match(buildReportMarkdown({ ...baseTask, title: 'Сравни ~~старое~~ и новое' }, team), /^# Сравни \\~\\~старое\\~\\~ и новое$/m);
  // Переводы строк только «\r» — тоже многострочная задача.
  const cr = buildReportMarkdown({ ...baseTask, title: 'Первая\rВторая' }, team);
  assert.match(cr, /^# Первая$/m);
  assert.ok(cr.includes('\nПервая\nВторая\n'));
});

test('buildReportMarkdown: многострочные задача и задание сохраняются дословно', () => {
  const title = 'Проверь код:\n```python\nif ready:\n    send()\n```';
  const objective = 'Шаги:\n1. прочитай\n2. исправь';
  const md = buildReportMarkdown({ ...baseTask, title, subtasks: [{ id: 's', agentId: 'product', title: 'X', objective, status: 'done', result: 'ок' }] }, team);
  assert.match(md, /^# Проверь код:$/m, 'заголовок — первая строка');
  assert.ok(md.includes(`\n${title}\n`), 'полный текст задачи без изменений');
  assert.ok(md.includes(`\n${objective}\n`), 'задание без изменений');
  assert.match(md, /^````\n/m, 'ограждение длиннее ``` внутри текста');
});

test('reportFileName: дата, первые слова задачи, только безопасные символы', () => {
  assert.equal(reportFileName({ ...baseTask, title: COFFEE_GOAL }), 'pixel-office-2026-10-18-я-хочу-открыть-маленькую-кофейню.md');
  const nasty = reportFileName({ ...baseTask, title: 'План: a/b\\c *?"<>| \n\r\tдалее…' + ' слово'.repeat(50) });
  assert.match(nasty, /^pixel-office-2026-10-18-[\p{L}\p{N}-]+\.md$/u);
  assert.doesNotMatch(nasty, /[/\\:*?"<>|\r\n\t]/);
  assert.ok(nasty.length <= 80, `длина ${nasty.length}`);
  assert.equal(reportFileName({ ...baseTask, title: '?!…' }), 'pixel-office-2026-10-18-задача.md');
  // Без startedAt — сегодняшняя дата.
  assert.equal(reportFileName({ ...baseTask, startedAt: undefined }, new Date(2026, 0, 5, 9)), 'pixel-office-2026-01-05-придумай-слоган.md');
});

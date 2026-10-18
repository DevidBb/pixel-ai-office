// Экспорт итогового отчёта задачи в Markdown («Копировать», «Скачать .md» в карточке задачи).
// Чистые функции без DOM: тесты запускают модуль прямо в Node.
import type { OfficeTask, TaskStatus } from './types';

/** Сотрудник для заголовков отчёта: «Luma 2 · Исследователь рынка». */
export type ReportAgent = { id: string; name: string; role: string };

export const taskStatusLabel: Record<TaskStatus, string> = {
  planning: 'Планирует', working: 'Выполняется', review: 'Проверка CEO', done: 'Завершено', error: 'Ошибка'
};

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
// Без пустых строк по краям, но с отступом первой строки: «    x = 1» в начале ответа — код, а не текст.
const trimBlankLines = (text: string) => text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();

function startedDate(task: OfficeTask): Date | null {
  const date = task.startedAt ? new Date(task.startedAt) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/** Текст как есть, в блоке кода: ограждение длиннее любой серии ` внутри, поэтому блок не обрывается. */
function verbatim(text: string) {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
  return `${fence}\n${text}\n${fence}`;
}

/** Обычный текст (задача, задание, план) в Markdown: `<div>`, `*`, `[a]` показываются как есть, а не как разметка. */
function escapeText(text: string) {
  return text.replace(/[\\`*_~[\]<>&]/g, '\\$&').replace(/(\s)(#+)\s*$/, '$1\\$2');
}

// Строка, которая может быть определением ссылки «[1]: https://…» — с любым отступом и после маркеров
// цитаты или списка («> [1]:», «- [1]:», «    [1]:» в продолжении пункта).
const LINK_DEFINITION = /^([ \t>*+\-\d.)]*)\[((?:[^\]\\]|\\.)+)\]:/;

/**
 * Ответ модели — цитатой, каждая строка с «> ». Разметка внутри (списки, жирный, заголовки, код) сохраняется,
 * а всё, что модель оставила незакрытым (блок кода, оборванный лимитом токенов, список), по правилам
 * CommonMark заканчивается вместе с цитатой и не захватывает следующий раздел отчёта.
 * Определение ссылки («[1]: https://…») действует на весь документ даже из цитаты — у двух сотрудников
 * [1] вёл бы на один адрес, поэтому каждая строка, похожая на определение, показывается обычным текстом:
 * адрес остаётся виден. Блоки кода не отслеживаются — их разбор без парсера ошибался бы; цена — «\»
 * в редкой строке кода, начинающейся с «[…]:».
 */
function quoted(text: string) {
  return trimBlankLines(text).split('\n')
    .map(line => line.replace(LINK_DEFINITION, '$1\\[$2]:'))
    .map(line => line.trim() ? `> ${line}` : '>').join('\n');
}

/** Текст пользователя или сервера: одна строка — экранированным текстом, несколько — блоком как есть. */
function plain(text: string) {
  const value = trimBlankLines(text);
  return value.includes('\n') ? verbatim(value) : escapeText(value.trim());
}

/** Отчёт задачи в Markdown: задача, дата, статус, план CEO, результаты по подзадачам, итог. Журнал не входит. */
export function buildReportMarkdown(task: OfficeTask, agents: ReportAgent[]): string {
  const started = startedDate(task);
  const when = started
    ? started.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : task.createdAt;
  // Многострочная задача: в заголовке первая строка, ниже — весь текст без изменений (код, списки, отступы).
  const title = trimBlankLines(task.title);
  const multiline = title.includes('\n');
  const parts = [
    `# ${escapeText(oneLine(multiline ? title.split('\n')[0] : title))}`,
    [when ? `- Дата: ${when}` : '', `- Статус: ${taskStatusLabel[task.status] ?? task.status}`].filter(Boolean).join('\n')
  ];
  if (multiline) parts.push(`**Текст задачи:**\n\n${verbatim(title)}`);
  if (task.planSummary?.trim()) parts.push(`## План CEO\n\n${plain(task.planSummary)}`);
  const subtasks = task.subtasks || [];
  if (subtasks.length) {
    parts.push('## Результаты сотрудников');
    for (const subtask of subtasks) {
      const agent = agents.find(item => item.id === subtask.agentId);
      const section = [`### ${agent ? `${agent.name} · ${agent.role}` : subtask.agentId}`];
      const objective = trimBlankLines(subtask.objective || '');
      if (objective.trim()) section.push(`**Задание:**${objective.includes('\n') ? '\n\n' : ' '}${plain(objective)}`);
      if (subtask.status === 'error') section.push('**❌ Ошибка:** сотрудник не справился с заданием.');
      else if (subtask.status !== 'done') section.push('**Не выполнено:** задача остановлена раньше, чем пришёл результат.');
      if (subtask.result?.trim()) section.push(quoted(subtask.result));
      parts.push(section.join('\n\n'));
    }
  }
  if (task.result?.trim()) parts.push(`## Итоговый отчёт CEO\n\n${quoted(task.result)}`);
  return `${parts.join('\n\n')}\n`;
}

/**
 * «pixel-office-2026-10-18-я-хочу-открыть-маленькую-кофейню.md»: дата запуска (или сегодня) и до пяти слов задачи.
 * Только буквы (кириллица тоже), цифры и дефисы — имя годится для любой файловой системы.
 */
export function reportFileName(task: OfficeTask, now = new Date()): string {
  const date = startedDate(task) || now;
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(n => String(n).padStart(2, '0')).join('-');
  let slug = '';
  for (const word of task.title.toLocaleLowerCase('ru-RU').split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 5)) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 40) break;
    slug = next;
  }
  return `pixel-office-${day}-${slug || 'задача'}.md`;
}

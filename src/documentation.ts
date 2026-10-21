import type { OfficeTask } from './types';

/** Assemble the evidence already in the task; do not invent a second model-generated report. */
export function buildDocumentation(task: OfficeTask): string {
  const labels = { queued: 'Ожидает', working: 'В работе', done: 'Готово', error: 'Ошибка' };
  const taskLabels = { planning: 'Планирование', working: 'В работе', review: 'Проверка CEO', discussion: 'Обсуждение', done: 'Завершено', error: 'Ошибка или остановка' };
  const assignments = (task.subtasks || []).map(subtask =>
    `### ${subtask.title}\nИсполнитель: ${subtask.agentId}\nСтатус: ${task.status === 'error' && ['queued', 'working'].includes(subtask.status) ? 'Не завершено — задача остановлена' : labels[subtask.status]}\n\n${subtask.objective}\n\n${subtask.result || (subtask.draft ? `Черновик, не итоговый результат:\n\n${subtask.draft}` : 'Результат ещё не получен.')}`
  );
  return [
    '# Документация CEO',
    `Задача: ${task.runId || task.id}\nДата: ${task.startedAt || task.createdAt}\nСтатус: ${taskLabels[task.status]}`,
    `## Цель и исходные требования\n\n${task.title}`,
    `## План и распределение работы\n\n${task.planSummary || 'План ещё не составлен.'}`,
    `## Задания и материалы команды\n\n${assignments.join('\n\n') || 'Исполнители ещё не назначены.'}`,
    `## Итог CEO\n\n${task.result || 'Итог ещё не готов. Это промежуточная документация.'}`,
    '## Как использовать документ\n\nСверьте итог с исходной целью. Перед выполнением следующих действий проверьте указанные командой гипотезы, расчёты и пробелы. Предложения и планы в ответах не означают, что действия уже выполнены. Документ сохраняет исходные формулировки сотрудников; отдельная независимая проверка не проводилась.',
    ...(task.chat?.length ? [`## Обсуждение (не изменяет результаты)\n\n${task.chat.map(line => `- ${line.agentId}${line.to ? ` → ${line.to}` : ''}: ${line.text}`).join('\n')}`] : [])
  ].join('\n\n') + '\n';
}

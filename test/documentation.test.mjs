import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentation } from '../src/documentation.ts';

test('documentation preserves original uncertainty, assignments, partial failures and final report', () => {
  const task = { id: 'test', title: 'Посчитай выручку', status: 'done', createdAt: '12:00', planSummary: 'Проверить цены',
    subtasks: [
      { title: 'Цены', agentId: 'research', objective: 'Уточнить цены', status: 'done', result: 'Допущение: цены не проверены. Латте — 4 €.' },
      { title: 'Расчёт', agentId: 'finance', objective: 'Посчитать доход', status: 'error', result: 'Модель недоступна' }
    ], result: 'Данных недостаточно для итогового расчёта.' };
  const doc = buildDocumentation(task);
  assert.ok(doc.includes(task.subtasks[0].result));
  assert.ok(doc.includes(task.result));
  assert.match(doc, /Статус: Ошибка/);
  assert.match(doc, /Уточнить цены/);
});

test('unfinished documentation labels drafts and missing report', () => {
  const doc = buildDocumentation({ id: 'draft', title: 'Цель', status: 'working', createdAt: '12:00', subtasks: [
    { title: 'Идеи', agentId: 'creator', status: 'working', objective: 'Слоган', draft: 'Начало' }
  ] });
  assert.match(doc, /Черновик, не итоговый результат/);
  assert.match(doc, /Итог ещё не готов/);
  assert.doesNotMatch(doc, /Статус: Завершено/);
});


test('stopped documentation does not claim that a specialist is still running', () => {
  const doc = buildDocumentation({ id: 'stopped', title: 'Цель', status: 'error', createdAt: '12:00', subtasks: [
    { title: 'Идеи', agentId: 'creator', status: 'working', objective: 'Слоган', draft: 'Начало' }
  ] });
  assert.match(doc, /Не завершено — задача остановлена/);
  assert.doesNotMatch(doc, /Статус: В работе/);
});

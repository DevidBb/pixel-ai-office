// Оценка качества команды на задаче кофейни через настоящий конвейер офиса (маршрутизация, подсказки, модель).
// Запуск: node scripts/eval-coffee.mjs [--runs 2] [--model qwen3:1.7b] [--label "описание"]
// Результат: таблица в консоли и JSON в data/evals/ для сравнения моделей и подсказок.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, readConfig, rootDir } from '../server/config.mjs';
import { createModelClient } from '../server/llm.mjs';
import { createApp } from '../server/app.mjs';
import { RunStore } from '../server/runs.mjs';
import { scoreCoffeeRun } from '../server/eval.mjs';
import { COFFEE_GOAL } from '../test/fixtures.mjs';

loadEnv();
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const config = readConfig({ ...process.env, ...(arg('model') ? { OPENAI_MODEL: arg('model') } : {}) });
const runsCount = Number(arg('runs', 2));
const label = arg('label', '');

const { callModel, limiter } = createModelClient(config);
const store = new RunStore();
const server = createApp({ config, callModel, limiter, runs: store });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

console.log(`Модель: ${config.model} (${config.provider}) · прогонов: ${runsCount}${label ? ` · ${label}` : ''}`);
const reports = [];
try {
  for (let i = 1; i <= runsCount; i++) {
    const response = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: COFFEE_GOAL }) });
    const { runId, error } = await response.json();
    if (!runId) throw new Error(error || `HTTP ${response.status}`);
    const run = store.get(runId);
    while (run.status === 'running') await new Promise(resolve => setTimeout(resolve, 200));
    const report = scoreCoffeeRun(run.events);
    reports.push({ ...report, results: run.events.filter(e => e.type === 'agent-result').map(e => ({ agentId: e.agentId, result: e.result })) });
    console.log(`\nПрогон ${i}: ${report.passed}/${report.total} заданий выполнено · реальных вариантов ${report.reality.real}/${report.reality.total} · ${report.seconds} с`);
    for (const a of report.agents) {
      const flags = [a.foreign.length ? `пишет за ${a.foreign.join(', ')}` : '', a.truncated ? 'обрезан' : ''].filter(Boolean).join('; ');
      const real = a.reality ? ` · реально ${a.reality.real}/${a.reality.total}${a.reality.unreal.length ? ` (нет в жизни: ${a.reality.unreal.join('; ')})` : ''}` : '';
      console.log(`  ${a.ok && !flags ? '✅' : '❌'} ${a.agentId.padEnd(8)} ${a.label.padEnd(44)} ${a.detail}${flags ? ` · ${flags}` : ''}${real} · ${a.seconds ?? '—'} с, ${a.tokens ?? '—'} ток.`);
    }
  }
} finally {
  server.close();
}

const passed = reports.reduce((sum, r) => sum + r.passed, 0);
const total = reports.reduce((sum, r) => sum + r.total, 0);
const reality = { real: reports.reduce((sum, r) => sum + r.reality.real, 0), total: reports.reduce((sum, r) => sum + r.reality.total, 0) };
const avgSeconds = Math.round(reports.reduce((sum, r) => sum + (r.seconds || 0), 0) / reports.length);
console.log(`\nИТОГО: ${passed}/${total} (${Math.round((passed / total) * 100)} %) · реальных вариантов ${reality.real}/${reality.total} · в среднем ${avgSeconds} с на прогон`);

const dir = join(config.dataDir || join(rootDir, 'data'), 'evals');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${config.model.replace(/[^\w.-]+/g, '_')}.json`);
writeFileSync(file, JSON.stringify({ model: config.model, provider: config.provider, label, passed, total, reality, avgSeconds, reports }, null, 2));
console.log(`Сохранено: ${file}`);

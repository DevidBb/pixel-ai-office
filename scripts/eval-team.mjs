// Замер «живой команды» на ролевой задаче (test/fixtures.mjs → TEAM_GOAL) через настоящий конвейер офиса:
// сколько сотрудники списали из данных коллег (HANDOFF) и сколько реплик чата (CROSS_TALK) лишь пересказывают чужое.
// Запуск: HANDOFF=true CROSS_TALK=true node scripts/eval-team.mjs [--runs 3] [--model qwen3:1.7b] [--label "описание"]
// Результат: таблица в консоли и JSON в data/evals/ (team-…) для сравнения подсказок.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, readConfig, rootDir } from '../server/config.mjs';
import { createModelClient } from '../server/llm.mjs';
import { createApp } from '../server/app.mjs';
import { RunStore } from '../server/runs.mjs';
import { scoreTeamRun } from '../server/eval.mjs';
import { TEAM_GOAL } from '../test/fixtures.mjs';

loadEnv();
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const config = readConfig({ ...process.env, ...(arg('model') ? { OPENAI_MODEL: arg('model') } : {}) });
const runsCount = Number(arg('runs', 3));
const label = arg('label', '');

const { callModel, limiter } = createModelClient(config);
const store = new RunStore();
const server = createApp({ config, callModel, limiter, runs: store });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

console.log(`Модель: ${config.model} · HANDOFF=${config.handoff} · CROSS_TALK=${config.crossTalk} · прогонов: ${runsCount}${label ? ` · ${label}` : ''}`);
const reports = [];
try {
  for (let i = 1; i <= runsCount; i++) {
    const response = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: TEAM_GOAL }) });
    const { runId, error } = await response.json();
    if (!runId) throw new Error(error || `HTTP ${response.status}`);
    const run = store.get(runId);
    while (run.status === 'running') await new Promise(resolve => setTimeout(resolve, 200));
    const report = scoreTeamRun(run.events);
    reports.push({ ...report, results: run.events.filter(e => e.type === 'agent-result').map(e => ({ agentId: e.agentId, handoffFrom: e.handoffFrom, result: e.result })) });
    console.log(`\nПрогон ${i}: списано строк ${report.copiedLines}, чужих «допущений» ${report.copiedAssumptions}, реплик ${report.chatReplies} (пересказ: ${report.chatEchoes}) · ${report.seconds} с`);
    for (const a of report.agents) {
      console.log(`  ${a.agentId.padEnd(8)} ${a.handoffFrom.length ? `данные от ${a.handoffFrom.join(', ')}`.padEnd(40) : ''.padEnd(40)} списано ${a.copiedLines}/${a.lines}${a.copiedAssumption ? ' + «допущение»' : ''} · доля ${a.share}`);
    }
    for (const c of report.chat) console.log(`  💬 ${c.echo ? '🔁' : '✅'} ${c.agentId} → ${c.to || '—'}: ${c.text} (${c.share})`);
  }
} finally {
  server.close();
}

const sum = key => reports.reduce((total, r) => total + (r[key] || 0), 0);
const avgSeconds = Math.round(sum('seconds') / reports.length);
console.log(`\nИТОГО за ${reports.length}: списано строк ${sum('copiedLines')}, чужих «допущений» ${sum('copiedAssumptions')}, реплик ${sum('chatReplies')} (пересказ: ${sum('chatEchoes')}) · в среднем ${avgSeconds} с`);

const dir = join(config.dataDir || join(rootDir, 'data'), 'evals');
mkdirSync(dir, { recursive: true });
const file = join(dir, `team-${new Date().toISOString().replace(/[:.]/g, '-')}-${config.model.replace(/[^\w.-]+/g, '_')}.json`);
writeFileSync(file, JSON.stringify({ model: config.model, handoff: config.handoff, crossTalk: config.crossTalk, label, avgSeconds, reports }, null, 2));
console.log(`Сохранено: ${file}`);

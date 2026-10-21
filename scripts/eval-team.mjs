// Замер «живой команды» через настоящий конвейер офиса: как сотрудники пользуются данными коллег (HANDOFF)
// и что пишут друг другу (CROSS_TALK).
// Задачи: --goal team — ролевая (test/fixtures.mjs → TEAM_GOAL), --goal coffee — адресные поручения (COFFEE_GOAL).
// Запуск: HANDOFF=true CROSS_TALK=true node scripts/eval-team.mjs [--goal team|coffee] [--runs 3] [--model qwen3:1.7b] [--label "описание"]
// Пересчёт сохранённых замеров той же оценкой: node scripts/eval-team.mjs --rescore data/evals/team-….json [ещё файлы]
// В JSON (data/evals/team-…) — события задачи и все вызовы модели (подсказка, ответ до очистки, статистика):
// по ним разные версии кода сравниваются одной и той же оценкой.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, readConfig, rootDir } from '../server/config.mjs';
import { createModelClient } from '../server/llm.mjs';
import { createApp } from '../server/app.mjs';
import { RunStore } from '../server/runs.mjs';
import { scoreTeamRun, scoreCoffeeRun } from '../server/eval.mjs';
import { TEAM_GOAL, COFFEE_GOAL } from '../test/fixtures.mjs';

const GOALS = { team: TEAM_GOAL, coffee: COFFEE_GOAL };
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

function score(goal, report) {
  const team = scoreTeamRun(report.events);
  return { ...team, ...(goal === 'coffee' ? { coffee: scoreCoffeeRun(report.events) } : {}) };
}

function print(goal, i, s) {
  const coffee = s.coffee ? ` · поручения ${s.coffee.passed}/${s.coffee.total}` : '';
  console.log(`\nПрогон ${i}: списано строк ${s.copiedLines}, чужих «допущений» ${s.copiedAssumptions}, реплик ${s.chatReplies} (пересказ: ${s.chatEchoes})${coffee} · ${s.seconds} с`);
  for (const a of s.agents) {
    console.log(`  ${a.agentId.padEnd(8)} ${a.handoffFrom.length ? `данные от ${a.handoffFrom.join(', ')}`.padEnd(40) : ''.padEnd(40)} списано ${a.copiedLines}/${a.lines}${a.copiedAssumption ? ' + «допущение»' : ''} · доля ${a.share}`);
  }
  for (const c of s.chat) console.log(`  💬 ${c.echo ? '🔁' : '✅'} ${c.agentId} → ${c.to || '—'}: ${c.text} (${c.share})`);
}

function summary(goal, scores) {
  const sum = key => scores.reduce((total, s) => total + (s[key] || 0), 0);
  const coffee = goal === 'coffee' ? ` · поручения ${scores.reduce((t, s) => t + s.coffee.passed, 0)}/${scores.reduce((t, s) => t + s.coffee.total, 0)}` : '';
  console.log(`\nИТОГО за ${scores.length}: списано строк ${sum('copiedLines')}, чужих «допущений» ${sum('copiedAssumptions')}, реплик ${sum('chatReplies')} (пересказ: ${sum('chatEchoes')})${coffee} · в среднем ${Math.round(sum('seconds') / scores.length)} с`);
}

if (args.includes('--rescore')) {
  for (const file of args.filter(a => a.endsWith('.json'))) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const goal = saved.goal || 'team';
    console.log(`\n=== ${file}\n${saved.model} · ${goal} · HANDOFF=${saved.handoff} · CROSS_TALK=${saved.crossTalk}${saved.label ? ` · ${saved.label}` : ''}`);
    const scores = saved.reports.filter(r => r.events).map((report, i) => {
      const s = score(goal, report);
      print(goal, i + 1, s);
      return s;
    });
    if (scores.length) summary(goal, scores);
  }
  process.exit(0);
}

loadEnv();
const goal = arg('goal', 'team');
if (!GOALS[goal]) throw new Error(`--goal: ${Object.keys(GOALS).join(' | ')}`);
const config = readConfig({ ...process.env, ...(arg('model') ? { OPENAI_MODEL: arg('model') } : {}) });
const runsCount = Number(arg('runs', 3));
const label = arg('label', '');
const git = gitArgs => { try { return execFileSync('git', gitArgs, { cwd: rootDir, encoding: 'utf8' }).trim(); } catch { return ''; } };
const commit = `${git(['rev-parse', '--short', 'HEAD'])}${git(['status', '--porcelain']) ? ' (с незакоммиченными изменениями)' : ''}`;

const { callModel, limiter } = createModelClient(config);
// Каждый вызов модели с подсказкой и ответом до очистки: реплику, отброшенную фильтром, тоже видно.
const calls = [];
const recordingModel = async (messages, opts = {}) => {
  try {
    const answer = await callModel(messages, opts);
    calls.push({ label: opts.label, messages, text: answer.text, stats: answer.stats });
    return answer;
  } catch (error) {
    calls.push({ label: opts.label, messages, error: error?.message });
    throw error;
  }
};
const store = new RunStore();
const server = createApp({ config, callModel: recordingModel, limiter, runs: store });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

console.log(`Модель: ${config.model} · задача ${goal} · HANDOFF=${config.handoff} · CROSS_TALK=${config.crossTalk} · ${commit} · прогонов: ${runsCount}${label ? ` · ${label}` : ''}`);
const dir = join(config.dataDir || join(rootDir, 'data'), 'evals');
mkdirSync(dir, { recursive: true });
const file = join(dir, `team-${goal}-${new Date().toISOString().replace(/[:.]/g, '-')}-${config.model.replace(/[^\w.-]+/g, '_')}.json`);
const reports = [];
const scores = [];
// Файл перезаписывается после каждого прогона: долгий замер не пропадёт из-за сбоя в конце.
const save = () => writeFileSync(file, JSON.stringify({ model: config.model, goal, handoff: config.handoff, crossTalk: config.crossTalk, commit, label, reports }, null, 2));
try {
  for (let i = 1; i <= runsCount; i++) {
    const response = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: GOALS[goal] }) });
    const { runId, error } = await response.json();
    if (!runId) throw new Error(error || `HTTP ${response.status}`);
    const run = store.get(runId);
    while (run.status === 'running') await new Promise(resolve => setTimeout(resolve, 200));
    const report = { runId, status: run.status, events: run.events, calls: calls.filter(c => c.label?.startsWith(`${runId}/`)) };
    const s = score(goal, report);
    reports.push(report);
    save();
    scores.push(s);
    print(goal, i, s);
  }
} finally {
  server.close();
}
summary(goal, scores);
console.log(`Сохранено: ${file}`);

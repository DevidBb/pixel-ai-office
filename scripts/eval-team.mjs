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
import { scoreTeamEval } from '../server/eval.mjs';
import { TEAM_GOAL, COFFEE_GOAL } from '../test/fixtures.mjs';

const GOALS = { team: TEAM_GOAL, coffee: COFFEE_GOAL };
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

function print(i, s) {
  const coffee = s.coffee ? ` · поручения кофейни ${s.coffee.passed}/${s.coffee.total}` : '';
  console.log(`\nПрогон ${i}: своя часть ${s.partsDone}/${s.agents.length}${coffee} · с чужими разделами ${s.agentsWithForeignSections} · списано строк ${s.copiedLines}, «допущений» ${s.copiedAssumptions}` +
    ` · чисел-гипотез коллег взято ${s.hedgedTaken}, с оговоркой ${s.hedgedKept} · в подсказке со статусом ${s.hedgedDelivered}/${s.hedgedReceived}` +
    ` · реплик ${s.chatReplies}/${s.chatRaw} · ${s.seconds} с (работа ${s.workSeconds}, обсуждение ${s.discussionSeconds}) · токенов ${s.promptTokens}+${s.outputTokens}`);
  for (const a of s.agents) {
    const from = a.handoffFrom.length ? `данные от ${a.handoffFrom.join(', ')}` : '';
    const lost = a.numbers.lost.length ? ` · без оговорки: ${a.numbers.lost.join(', ')}` : '';
    console.log(`  ${a.part ? '✅' : '❌'} ${a.agentId.padEnd(8)} ${from.padEnd(40)} списано ${a.copiedLines}/${a.lines}${a.copiedAssumption ? ' + «допущение»' : ''}` +
      `${a.foreignSections.length ? ` · чужие разделы: ${a.foreignSections.join(', ')}` : ''} · чисел коллег ${a.numbers.taken}${lost}`);
  }
  for (const c of s.chat) console.log(`  💬 ${c.shown ? '✅' : '🚫'} ${c.agentId} → ${c.to || '—'}: ${(c.shown ?? c.raw ?? '').replace(/\s+/g, ' ').slice(0, 240)}`);
}

function summary(scores) {
  const sum = key => scores.reduce((total, s) => total + (s[key] || 0), 0);
  const avg = key => Math.round(sum(key) / scores.length);
  const coffee = scores[0]?.coffee ? ` · поручения кофейни ${scores.reduce((t, s) => t + s.coffee.passed, 0)}/${scores.reduce((t, s) => t + s.coffee.total, 0)}` : '';
  console.log(`\nИТОГО за ${scores.length}: своя часть ${sum('partsDone')}/${scores.reduce((t, s) => t + s.agents.length, 0)}${coffee} · с чужими разделами ${sum('agentsWithForeignSections')}` +
    ` · списано строк ${sum('copiedLines')}, «допущений» ${sum('copiedAssumptions')} · чисел-гипотез коллег взято ${sum('hedgedTaken')}, с оговоркой ${sum('hedgedKept')}` +
    ` · в подсказке со статусом ${sum('hedgedDelivered')}/${sum('hedgedReceived')} · реплик ${sum('chatReplies')}/${sum('chatRaw')}` +
    ` · в среднем ${avg('seconds')} с (работа ${avg('workSeconds')}, обсуждение ${avg('discussionSeconds')}) · токенов ${avg('promptTokens')}+${avg('outputTokens')}`);
}

if (args.includes('--rescore')) {
  for (const file of args.filter(a => a.endsWith('.json'))) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const goal = saved.goal || 'team';
    console.log(`\n=== ${file}\n${saved.model} · ${goal} · HANDOFF=${saved.handoff} · CROSS_TALK=${saved.crossTalk}${saved.label ? ` · ${saved.label}` : ''}`);
    const scores = saved.reports.filter(r => r.events).map((report, i) => {
      const s = scoreTeamEval(report, goal);
      print(i + 1, s);
      return s;
    });
    if (scores.length) summary(scores);
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
    // Прогоны идут по одному: все вызовы модели с этого места — этого прогона (и маршрутизатор CEO без runId в метке).
    const firstCall = calls.length;
    const response = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: GOALS[goal] }) });
    const { runId, error } = await response.json();
    if (!runId) throw new Error(error || `HTTP ${response.status}`);
    const run = store.get(runId);
    while (run.status === 'running') await new Promise(resolve => setTimeout(resolve, 200));
    const report = { runId, status: run.status, events: run.events, calls: calls.slice(firstCall) };
    const s = scoreTeamEval(report, goal);
    reports.push(report);
    save();
    scores.push(s);
    print(i, s);
  }
} finally {
  server.close();
}
summary(scores);
console.log(`Сохранено: ${file}`);

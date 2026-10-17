import { loadEnv, readConfig } from './server/config.mjs';
import { createModelClient } from './server/llm.mjs';
import { createApp } from './server/app.mjs';

loadEnv();
const config = readConfig();
const { callModel, limiter } = createModelClient(config);
const server = createApp({ config, callModel, limiter });

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Порт ${config.port} уже занят — скорее всего, Pixel AI Office уже запущен. Открой http://localhost:5173/ или останови прежний процесс: fuser -k ${config.port}/tcp 5173/tcp`);
    process.exit(1);
  }
  throw error;
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Pixel AI Office API: http://127.0.0.1:${config.port}`);
  console.log(`Model: ${config.model}; provider: ${config.provider}; API key: ${config.apiKey ? 'configured' : 'not configured'}`);
  console.log(`LLM: concurrency=${config.concurrency}, timeout=${config.timeoutMs} ms, agentMaxTokens=${config.agentMaxTokens}, agentShortMaxTokens=${config.agentShortMaxTokens}, router=${config.routerMode}, ceoSummary=${config.ceoSummary}${config.provider === 'ollama' ? `, think=${config.ollamaThink}, num_ctx=${config.ollamaNumCtx}` : ''}`);
  if (config.ceoSummary === true) {
    console.log('Внимание: CEO_SUMMARY=true — сводка CEO моделью запускается всегда, даже для адресных заданий (на CPU это +1–3 мин). Чтобы итог собирался из ответов сотрудников, укажи в .env CEO_SUMMARY=auto или удали эту строку.');
  }
});

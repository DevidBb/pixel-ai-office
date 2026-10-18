export function diag(message, extra) {
  const time = new Date().toISOString().slice(11, 23);
  console.log(`[${time}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

// Глобальный ограничитель одновременных запросов к модели (общий для всех задач сервера).
export class Limiter {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }

  acquire(signal, timeoutMs) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolveSlot, reject) => {
      const entry = { grant: null };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('aborted')); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Очередь к модели не освободилась за ${Math.round(timeoutMs / 1000)} с.`));
      }, timeoutMs);
      entry.grant = () => { cleanup(); this.active++; resolveSlot(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue[0];
    if (next && this.active < this.max) next.grant();
  }

  get waiting() { return this.queue.length; }
}

function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*<think>[\s\S]*$/i, '').trim();
}

/** Построчно читает тело ответа (NDJSON у Ollama, SSE у OpenAI) и вызывает onLine для каждой строки. */
async function readLines(response, onLine) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
    if (done) break;
  }
  if (buffer.trim()) onLine(buffer.trim());
}

async function requestOllama(config, messages, { json, maxTokens, signal, onChunk }) {
  const stream = Boolean(onChunk);
  const body = {
    model: config.model,
    messages,
    stream,
    think: config.ollamaThink,
    keep_alive: config.ollamaKeepAlive,
    options: { temperature: config.temperature, num_predict: maxTokens, num_ctx: config.ollamaNumCtx }
  };
  if (json) body.format = 'json';
  const response = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal
  });
  let data;
  if (!response.ok || !stream) {
    const responseText = await response.text();
    try { data = JSON.parse(responseText); }
    catch { data = null; }
    if (!response.ok) {
      const detail = data?.error || responseText.slice(0, 400) || `HTTP ${response.status}`;
      throw new Error(`Ошибка Ollama (${response.status}): ${detail}`);
    }
  } else {
    // Потоковый ответ: строка JSON на каждый кусок текста, последняя (done: true) несёт статистику.
    let content = '';
    await readLines(response, line => {
      let part;
      try { part = JSON.parse(line); } catch { return; }
      if (part.error) throw new Error(`Ошибка Ollama: ${part.error}`);
      const piece = part.message?.content || '';
      if (piece) { content += piece; onChunk(piece); }
      if (part.done) data = { ...part, message: { content } };
    });
    data ||= { message: { content } };
  }
  return {
    content: data?.message?.content,
    stats: {
      promptTokens: data?.prompt_eval_count,
      outputTokens: data?.eval_count,
      loadMs: Math.round((data?.load_duration || 0) / 1e6),
      promptMs: Math.round((data?.prompt_eval_duration || 0) / 1e6),
      genMs: Math.round((data?.eval_duration || 0) / 1e6),
      doneReason: data?.done_reason
    }
  };
}

async function requestOpenAI(config, messages, { json, maxTokens, signal, onChunk }) {
  const stream = Boolean(onChunk);
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const body = { model: config.model, messages, temperature: config.temperature, max_completion_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  if (stream) Object.assign(body, { stream: true, stream_options: { include_usage: true } });
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body), signal
  });
  let data;
  if (!response.ok || !stream) {
    const responseText = await response.text();
    try { data = JSON.parse(responseText); }
    catch { data = null; }
    if (!response.ok) {
      const detail = data?.error?.message || responseText.slice(0, 400) || `HTTP ${response.status}`;
      throw new Error(`Ошибка API (${response.status}): ${detail}`);
    }
  } else {
    // SSE: «data: {choices:[{delta:{content}}]}», в конце usage и «data: [DONE]».
    let content = '';
    let finishReason;
    let usage;
    await readLines(response, line => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let part;
      try { part = JSON.parse(payload); } catch { return; }
      const piece = part.choices?.[0]?.delta?.content || '';
      if (piece) { content += piece; onChunk(piece); }
      finishReason = part.choices?.[0]?.finish_reason || finishReason;
      usage = part.usage || usage;
    });
    data = { choices: [{ message: { content }, finish_reason: finishReason }], usage };
  }
  return {
    content: data?.choices?.[0]?.message?.content,
    stats: {
      promptTokens: data?.usage?.prompt_tokens,
      outputTokens: data?.usage?.completion_tokens,
      doneReason: data?.choices?.[0]?.finish_reason
    }
  };
}

/**
 * Возвращает callModel: один вызов модели ждёт свободный слот в очереди, ограничен тайм-аутом
 * и отменяется, если пользователь закрыл соединение (signal). Результат: { text, stats }.
 */
export function createModelClient(config, limiter = new Limiter(config.concurrency)) {
  let llmCallSeq = 0;
  async function callModel(messages, { json = false, maxTokens = config.agentMaxTokens, timeoutMs = config.timeoutMs, signal, label = 'llm', onStart, onToken } = {}) {
    const id = ++llmCallSeq;
    const queuedAt = Date.now();
    if (limiter.active >= limiter.max) diag(`[llm#${id}] ${label}: в очереди`, { waiting: limiter.waiting + 1 });
    await limiter.acquire(signal, config.queueTimeoutMs);
    const startedAt = Date.now();
    const queueMs = startedAt - queuedAt;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    diag(`[llm#${id}] ${label}: старт`, { provider: config.provider, maxTokens, timeoutMs, queueMs });
    try {
      onStart?.();
      const request = config.provider === 'ollama' ? requestOllama : requestOpenAI;
      // onToken получает только видимый прирост текста: блоки <think>…</think> не показываем.
      let raw = '';
      let shown = '';
      const onChunk = onToken && (piece => {
        raw += piece;
        const visible = stripThinking(raw);
        if (visible.length > shown.length && visible.startsWith(shown)) {
          onToken(visible.slice(shown.length));
          shown = visible;
        }
      });
      const { content, stats } = await request(config, messages, { json, maxTokens, signal: combined, onChunk });
      const text = typeof content === 'string' ? stripThinking(content) : '';
      const totalMs = Date.now() - startedAt;
      const tokPerSec = stats.genMs && stats.outputTokens ? +(stats.outputTokens / (stats.genMs / 1000)).toFixed(1) : undefined;
      const fullStats = { ...stats, maxTokens, queueMs, totalMs, tokPerSec };
      diag(`[llm#${id}] ${label}: готово за ${totalMs} мс`, { ...fullStats, chars: text.length });
      if (!text) throw new Error('Модель вернула пустой ответ. Проверь доступность выбранной модели.');
      return { text, stats: fullStats };
    } catch (error) {
      const totalMs = Date.now() - startedAt;
      if (timeoutSignal.aborted && !signal?.aborted) {
        diag(`[llm#${id}] ${label}: ТАЙМ-АУТ через ${totalMs} мс — запрос отменён`);
        throw new Error(`Модель не ответила за ${Math.round(timeoutMs / 1000)} с (LLM_TIMEOUT_MS). Запрос отменён.`);
      }
      if (signal?.aborted) {
        diag(`[llm#${id}] ${label}: отменён клиентом через ${totalMs} мс`);
        throw new Error('Запрос отменён: клиент закрыл соединение.');
      }
      diag(`[llm#${id}] ${label}: ошибка через ${totalMs} мс`, { error: error?.message });
      if (error?.message?.startsWith('Ошибка') || error?.message?.startsWith('Модель')) throw error;
      throw new Error(`Не удалось подключиться к API модели: ${error?.message || 'ошибка соединения'}`);
    } finally {
      limiter.release();
    }
  }
  return { callModel, limiter };
}

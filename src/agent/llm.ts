import { AgentConfig, ContextMessage } from '../types.js';

/**
 * Ruko ships NO provider default: base URL and model are whatever the user
 * configured (config file or env). The wizard requires them explicitly so the
 * CLI never promotes a specific provider on its own (§1).
 */

/**
 * Names of the settings still missing after config-file + env resolution.
 * Empty array means the provider is fully configured.
 */
export function missingConfigFields(
  cfg: { apiKey?: string; baseUrl?: string; model?: string },
  env: Record<string, string | undefined> = process.env,
): string[] {
  const missing: string[] = [];
  if (!((cfg.apiKey || env.OPENAI_API_KEY || '').trim())) missing.push('apiKey');
  if (!((cfg.baseUrl || env.OPENAI_BASE_URL || '').trim())) missing.push('baseUrl');
  if (!((cfg.model || env.AGENT_MODEL || env.OPENAI_MODEL || '').trim())) missing.push('model');
  return missing;
}

/** Tunables for automatic retry on provider rate limits (§7). */
export interface RetryOptions {
  /** Extra attempts after the first 429/503 response (default 2). */
  retries?: number;
  /** First backoff step in ms; doubles each attempt (default 1000). */
  baseDelayMs?: number;
  /** Upper bound for a single backoff step (default 15000). */
  maxDelayMs?: number;
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** HTTP statuses worth retrying — transient by nature. */
const RETRYABLE_STATUSES = new Set([429, 503]);

/** Exponential backoff: attempt 1 → base, 2 → 2×base, 3 → 4×base (capped). */
export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 15_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** Parses a `Retry-After` header (delta-seconds or HTTP date) into ms. */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Called with every text token as it streams in (real-time reveal). */
  onToken?: (token: string) => void;
  /**
   * v0.7 live input: aborts the in-flight request (fetch + stream reader)
   * when the user interrupts the turn.
   */
  signal?: AbortSignal;
}

/** Abstraction over any chat-completion backend the agent can talk to. */
export interface LLMProvider {
  readonly name: string;
  /** True when the backend can actually be called (e.g. API key present). */
  readonly isConfigured: boolean;
  /** The currently active model name. */
  readonly model: string;
  /** Finish reason of the most recent completion (e.g. 'stop', 'length', 'tool_calls'). */
  lastFinishReason?: string | null;
  /** Switches the active model at runtime (e.g. via /model). */
  setModel(model: string): void;
  /** Applies new API credentials at runtime (e.g. after `/config setup`). */
  setCredentials?(apiKey: string, baseUrl: string): void;
  /** Live connectivity probe used by the wizard (§2: test right after keys). */
  testConnection?(): Promise<ConnectionResult>;
  /** Model ids from the endpoint's /models listing (empty when unsupported). */
  listModels?(): Promise<string[]>;
  chat(messages: ContextMessage[], options?: ChatOptions): Promise<string>;
}

export interface ConnectionResult {
  ok: boolean;
  /** On success: model echoed back / endpoint name; on failure: human reason. */
  message: string;
}

/**
 * Redacts secrets (API keys, query token params, auth headers) from text or URLs.
 */
export function sanitizeSensitiveText(text: string, secretKey?: string): string {
  if (!text) return text;
  let sanitized = text;
  if (secretKey && secretKey.trim().length > 0) {
    const raw = secretKey.trim();
    sanitized = sanitized.split(raw).join('••••••••');
    const encoded = encodeURIComponent(raw);
    if (encoded !== raw) {
      sanitized = sanitized.split(encoded).join('••••••••');
    }
  }
  return sanitized
    .replace(/([?&](?:key|api_key|token)=)[^&\s"'`]+/gi, '$1••••••••')
    .replace(/(x-goog-api-key|x-api-key|authorization)\s*[:=]\s*([^\s"'`]+)/gi, '$1: ••••••••');
}

/**
 * Ensures Error instances do not carry unredacted credentials in their message or stack.
 */
export function sanitizeError(err: unknown, secretKey?: string): Error {
  if (err instanceof Error) {
    const cleanMsg = sanitizeSensitiveText(err.message, secretKey);
    if (cleanMsg !== err.message) {
      const sanitizedErr = new Error(cleanMsg);
      sanitizedErr.name = err.name;
      if (err.stack) {
        sanitizedErr.stack = sanitizeSensitiveText(err.stack, secretKey);
      }
      return sanitizedErr;
    }
    return err;
  }
  return new Error(sanitizeSensitiveText(String(err), secretKey));
}

/**
 * Translates raw transport/HTTP failures into beginner-proof explanations
 * with the fix command inline (§2: "pesan error yang menerjemahkan").
 */
export function explainProviderError(err: unknown): string {
  const rawText = err instanceof Error ? err.message : String(err);
  const text = sanitizeSensitiveText(rawText);
  const status = text.match(/\b(400|401|403|404|429|500|502|503)\b/)?.[1];
  switch (status) {
    case '400':
      return 'Request ditolak provider (400) — kemungkinan parameter internal Ruko tidak didukung model/endpoint ini. Coba `/model` lain atau periksa baseUrl.';
    case '401':
      return 'API key salah atau kedaluwarsa (401) — perbaiki dengan /login (atau ganti /profile).';
    case '403':
      return 'Akses ditolak (403) — API key tidak punya izin untuk model ini. Cek kuota/izin akun atau ganti /profile.';
    case '404':
      return 'Model tidak ditemukan (404) — cek nama (`/model <nama>`) atau baseUrl (`/config set baseUrl <url>`).';
    case '429':
      return 'Rate limit (429) — terlalu banyak permintaan. Ruko mencoba ulang otomatis; jika tetap gagal, tunggu sebentar atau ganti /profile.';
    case '500':
    case '502':
    case '503':
      return `Server provider sedang bermasalah (${status}) — coba lagi sebentar lagi.`;
    default:
      break;
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|EAI_AGAIN/i.test(text)) {
    if (/localhost|127\.0\.0\.1|::1/.test(text)) {
      return 'Server lokal belum jalan — contoh: jalankan `ollama serve` lalu coba lagi.';
    }
    return 'Server tidak bisa dihubungi — cek baseUrl (`/config set baseUrl <url>`) dan koneksi internet.';
  }
  if (/timeout|ETIMEDOUT|AbortError/i.test(text)) {
    return 'Percobaan habis waktu — server lambat atau baseUrl salah (`/config set baseUrl <url>`).';
  }
  return `Koneksi gagal: ${text}`;
}

/**
 * OpenAI-compatible chat completions provider (works with OpenAI and any
 * compatible endpoint such as Ollama, LM Studio, vLLM, ...).
 *
 * Credentials resolution (config file wins, env vars as fallback):
 *   apiKey   — `apiKey` in .ruko/config.json, else OPENAI_API_KEY
 *   baseUrl  — `baseUrl` in .ruko/config.json, else OPENAI_BASE_URL
 *   model    — `model` in config, else AGENT_MODEL / OPENAI_MODEL
 *
 * Responses stream via SSE (`stream: true`); tokens are piped through
 * `options.onToken` in real time and the full text is returned at the end.
 */
export class OpenAiCompatibleProvider implements LLMProvider {
  readonly name = 'openai-compatible';
  private apiKey: string;
  private baseUrl: string;
  private currentModel: string;
  private readonly retry: RetryOptions;
  lastFinishReason: string | null = null;

  constructor(cfg: Partial<AgentConfig> = {}, retry: RetryOptions = {}) {
    this.apiKey = cfg.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (cfg.baseUrl || process.env.OPENAI_BASE_URL || '').replace(/\/+$/, '');
    this.currentModel = cfg.model || process.env.AGENT_MODEL || process.env.OPENAI_MODEL || '';
    this.retry = retry;
  }

  /**
   * POST/GET with automatic exponential backoff on 429/503 so a long,
   * unattended Ruko run rides out provider rate limits instead of dying (§7).
   */
  private async requestWithRetry(url: string, init: RequestInit): Promise<Response> {
    const retries = this.retry.retries ?? 2;
    const base = this.retry.baseDelayMs ?? 1000;
    const max = this.retry.maxDelayMs ?? 15_000;
    const sleep =
      this.retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, init);
      if (response.ok || attempt >= retries || !RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
      const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
      await sleep(retryAfter ?? backoffDelay(attempt + 1, base, max));
    }
  }

  /** All three (key, URL, model) must be present before we call the backend. */
  get isConfigured(): boolean {
    return this.apiKey.length > 0 && this.baseUrl.length > 0 && this.currentModel.length > 0;
  }

  get model(): string {
    return this.currentModel;
  }

  setModel(model: string): void {
    this.currentModel = model.trim() || this.currentModel;
  }

  setCredentials(apiKey: string, baseUrl: string): void {
    if (apiKey.trim()) this.apiKey = apiKey.trim();
    if (baseUrl.trim()) this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
  }

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /**
   * Probes the endpoint with a minimal non-streamed completion so the wizard
   * can show "✓ Terhubung ke <model>" before the first real turn (§2).
   */
  async testConnection(): Promise<ConnectionResult> {
    if (!this.isConfigured) {
      const missing = missingConfigFields({
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        model: this.currentModel,
      });
      return { ok: false, message: `Belum lengkap: ${missing.join(', ')} — jalankan /login.` };
    }
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          model: this.currentModel,
          messages: [{ role: 'user', content: 'ping' }],
          // Some providers reject tiny budgets ("max_tokens must be greater
          // than 2"); a small but valid value keeps the probe portable (§1).
          max_tokens: 16,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM API error ${response.status}: ${body.slice(0, 200)}`);
      }
      return { ok: true, message: this.currentModel };
    } catch (err) {
      return { ok: false, message: explainProviderError(err) };
    }
  }

  /** Auto-fetch model ids from /models (§2) — never force users to type names. */
  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM API error ${response.status}: ${body.slice(0, 200)}`);
    }
    const data = (await response.json()) as { data?: Array<{ id?: string; name?: string }> };
    return (data.data ?? [])
      .map((m) => m.id ?? m.name ?? '')
      .filter((id) => id.length > 0)
      .sort();
  }

  async chat(messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    if (!this.isConfigured) {
      const missing = missingConfigFields({
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        model: this.currentModel,
      });
      throw new Error(
        `Konfigurasi belum lengkap (${missing.join(', ')}) — jalankan /login atau set OPENAI_API_KEY / OPENAI_BASE_URL / AGENT_MODEL.`,
      );
    }

    this.lastFinishReason = null;

    // Normalisasi Skema Tool Result: Pastikan payload pesan balik setelah tool execution
    // sesuai dengan skema standar provider (role: "tool" dengan tool_call_id yang valid).
    const formattedMessages = messages.map((m) => {
      if (m.role === 'tool') {
        const toolCallId = (m.tool_call_id && m.tool_call_id.trim()) || `call_${Date.now()}`;
        return {
          role: 'tool',
          tool_call_id: toolCallId,
          content: m.content,
          ...(m.name ? { name: m.name } : {}),
        };
      }
      const msgObj: Record<string, unknown> = {
        role: m.role,
        content: m.content,
      };
      if (m.tool_calls && m.tool_calls.length > 0) {
        msgObj.tool_calls = m.tool_calls;
      }
      return msgObj;
    });

    const response = await this.requestWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        model: options?.model ?? this.currentModel,
        messages: formattedMessages,
        temperature: options?.temperature ?? 0.3,
        max_tokens: options?.maxTokens ?? 2048,
        stream: true,
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM API error ${response.status}: ${body.slice(0, 500)}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      // Endpoint ignored `stream` — parse the plain JSON completion instead.
      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string | null };
          finish_reason?: string | null;
        }>;
      };
      this.lastFinishReason = data.choices?.[0]?.finish_reason ?? 'stop';
      const content = data.choices?.[0]?.message?.content ?? '';
      if (content) options?.onToken?.(content);
      return content;
    }

    let full = '';
    let buffer = '';
    const decoder = new TextDecoder();
    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: { content?: string | null };
            finish_reason?: string | null;
          }>;
        };
        const finishReason = parsed.choices?.[0]?.finish_reason;
        if (finishReason) {
          this.lastFinishReason = finishReason;
        }
        const token = parsed.choices?.[0]?.delta?.content;
        if (token) {
          full += token;
          options?.onToken?.(token);
        }
      } catch {
        // Keep-alive or malformed SSE frame — ignore.
      }
    };

    // Stream Ingestion Hardening: simpan sisa chunk yang belum newline lengkap ke buffer lokal
    // sebelum di-parse JSON agar teks streaming tidak terpotong di tengah kalimat.
    for await (const raw of response.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(raw, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) processLine(line);
    }
    if (!this.lastFinishReason) {
      this.lastFinishReason = 'stop';
    }
    return full;
  }
}

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

/**
 * Sanitizes an Anthropic base URL: strips quotes, trims whitespace,
 * removes trailing slashes, and defaults to https://api.anthropic.com/v1.
 */
export function sanitizeAnthropicBaseUrl(url?: string | null): string {
  if (!url) return DEFAULT_ANTHROPIC_BASE_URL;
  const unquoted = url.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!unquoted) return DEFAULT_ANTHROPIC_BASE_URL;
  const clean = unquoted.replace(/\/+$/, '');
  if (clean === 'https://api.anthropic.com') {
    return `${clean}/v1`;
  }
  return clean;
}

/**
 * Anthropic Claude provider (messages API format).
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private apiKey: string;
  private baseUrl: string;
  private currentModel: string;
  private readonly retry: RetryOptions;
  lastFinishReason: string | null = null;

  constructor(cfg: Partial<AgentConfig> = {}, retry: RetryOptions = {}) {
    this.apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
    const rawBase = cfg.baseUrl || process.env.ANTHROPIC_BASE_URL || '';
    this.baseUrl = sanitizeAnthropicBaseUrl(rawBase);
    this.currentModel = cfg.model || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
    this.retry = retry;
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0 && this.baseUrl.length > 0 && this.currentModel.length > 0;
  }

  get model(): string {
    return this.currentModel;
  }

  setModel(model: string): void {
    this.currentModel = model.trim() || this.currentModel;
  }

  setCredentials(apiKey: string, baseUrl: string): void {
    if (apiKey.trim()) this.apiKey = apiKey.trim();
    if (baseUrl !== undefined) {
      this.baseUrl = sanitizeAnthropicBaseUrl(baseUrl);
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  private buildEndpointUrl(endpoint = '/messages'): string {
    const cleanBase = sanitizeAnthropicBaseUrl(this.baseUrl);
    if (cleanBase.endsWith('/messages')) return cleanBase;
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    return `${cleanBase}/${cleanEndpoint}`;
  }

  private async requestWithRetry(url: string, init: RequestInit): Promise<Response> {
    const retries = this.retry.retries ?? 2;
    const base = this.retry.baseDelayMs ?? 1000;
    const max = this.retry.maxDelayMs ?? 15_000;
    const sleep =
      this.retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, init);
      if (response.ok || attempt >= retries || !RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
      const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
      await sleep(retryAfter ?? backoffDelay(attempt + 1, base, max));
    }
  }

  async testConnection(): Promise<ConnectionResult> {
    if (!this.isConfigured) {
      return { ok: false, message: 'Anthropic API key belum diatur — set ANTHROPIC_API_KEY atau jalankan /login.' };
    }
    try {
      const url = this.buildEndpointUrl('/messages');
      const response = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          model: this.currentModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 16,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${sanitizeSensitiveText(body.slice(0, 200), this.apiKey)}`);
      }
      return { ok: true, message: this.currentModel };
    } catch (err) {
      const sanitized = sanitizeError(err, this.apiKey);
      return { ok: false, message: explainProviderError(sanitized) };
    }
  }

  async listModels(): Promise<string[]> {
    return [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ];
  }

  async chat(messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    if (!this.isConfigured) {
      throw new Error('Konfigurasi Anthropic belum lengkap (API key kosong) — jalankan /login atau set ANTHROPIC_API_KEY.');
    }

    const systemParts: string[] = [];
    const nonSystem: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
      } else {
        const role: 'user' | 'assistant' = m.role === 'tool' ? 'user' : m.role;
        if (nonSystem.length > 0 && nonSystem[nonSystem.length - 1].role === role) {
          nonSystem[nonSystem.length - 1].content += '\n\n' + m.content;
        } else {
          nonSystem.push({ role, content: m.content });
        }
      }
    }

    if (nonSystem.length === 0) {
      nonSystem.push({ role: 'user', content: 'Hello' });
    }

    const payload: Record<string, unknown> = {
      model: options?.model ?? this.currentModel,
      messages: nonSystem,
      max_tokens: options?.maxTokens ?? 2048,
      temperature: options?.temperature ?? 0.3,
      stream: true,
    };
    if (systemParts.length > 0) {
      payload.system = systemParts.join('\n\n');
    }

    const url = this.buildEndpointUrl('/messages');

    let response: Response;
    try {
      response = await this.requestWithRetry(url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(payload),
        signal: options?.signal,
      });
    } catch (err) {
      throw sanitizeError(err, this.apiKey);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${sanitizeSensitiveText(body.slice(0, 500), this.apiKey)}`);
    }

    this.lastFinishReason = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      try {
        const data = (await response.json()) as {
          content?: Array<{ type?: string; text?: string }>;
          stop_reason?: string | null;
        };
        this.lastFinishReason = data.stop_reason ?? 'end_turn';
        const text = data.content?.map((c) => c.text ?? '').join('') ?? '';
        if (text) options?.onToken?.(text);
        return text;
      } catch (err) {
        throw sanitizeError(err, this.apiKey);
      }
    }

    let full = '';
    let buffer = '';
    const decoder = new TextDecoder();
    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payloadStr = trimmed.slice(5).trim();
      if (!payloadStr || payloadStr === '[DONE]') return;
      try {
        const parsed = JSON.parse(payloadStr) as {
          type?: string;
          error?: { type?: string; message?: string };
          delta?: { type?: string; text?: string; stop_reason?: string };
          content_block?: { type?: string; text?: string };
        };
        if (parsed.type === 'error' && parsed.error?.message) {
          throw new Error(`Anthropic stream error: ${parsed.error.message}`);
        }
        if (parsed.delta?.stop_reason) {
          this.lastFinishReason = parsed.delta.stop_reason;
        }
        if (parsed.delta?.text) {
          full += parsed.delta.text;
          options?.onToken?.(parsed.delta.text);
        } else if (parsed.type === 'content_block_start' && parsed.content_block?.text) {
          full += parsed.content_block.text;
          options?.onToken?.(parsed.content_block.text);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Anthropic stream error:')) {
          throw err;
        }
        // ignore malformed frame or ping
      }
    };

    try {
      for await (const raw of response.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(raw, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const line of buffer.split(/\r?\n/)) processLine(line);
      }
    } catch (err) {
      throw sanitizeError(err, this.apiKey);
    }
    if (!this.lastFinishReason) {
      this.lastFinishReason = 'end_turn';
    }

    return full;
  }
}

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Sanitizes a Gemini base URL: strips surrounding quotes, trims whitespace,
 * removes trailing slashes, and falls back to Google Generative Language API endpoint.
 */
export function sanitizeGeminiBaseUrl(url?: string | null): string {
  if (!url) return DEFAULT_GEMINI_BASE_URL;
  const unquoted = url.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!unquoted) return DEFAULT_GEMINI_BASE_URL;
  return unquoted.replace(/\/+$/, '');
}

/**
 * Google Gemini provider (Generative Language API format).
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  private apiKey: string;
  private baseUrl: string;
  private currentModel: string;
  private readonly retry: RetryOptions;
  lastFinishReason: string | null = null;

  constructor(cfg: Partial<AgentConfig> = {}, retry: RetryOptions = {}) {
    this.apiKey = cfg.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
    const rawBase = cfg.baseUrl || process.env.GEMINI_BASE_URL || '';
    this.baseUrl = sanitizeGeminiBaseUrl(rawBase);
    this.currentModel = cfg.model || process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    this.retry = retry;
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0 && this.baseUrl.length > 0 && this.currentModel.length > 0;
  }

  get model(): string {
    return this.currentModel;
  }

  setModel(model: string): void {
    this.currentModel = model.trim() || this.currentModel;
  }

  setCredentials(apiKey: string, baseUrl: string): void {
    if (apiKey.trim()) this.apiKey = apiKey.trim();
    if (baseUrl !== undefined) {
      this.baseUrl = sanitizeGeminiBaseUrl(baseUrl);
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey,
    };
  }

  private buildEndpointUrl(endpoint: string, queryParams?: Record<string, string>): string {
    const cleanBase = sanitizeGeminiBaseUrl(this.baseUrl);
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const fullUrl = `${cleanBase}/${cleanEndpoint}`;
    if (!queryParams || Object.keys(queryParams).length === 0) {
      return fullUrl;
    }
    const searchParams = new URLSearchParams(queryParams);
    return `${fullUrl}?${searchParams.toString()}`;
  }

  private async requestWithRetry(url: string, init: RequestInit): Promise<Response> {
    const retries = this.retry.retries ?? 2;
    const base = this.retry.baseDelayMs ?? 1000;
    const max = this.retry.maxDelayMs ?? 15_000;
    const sleep =
      this.retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, init);
      if (response.ok || attempt >= retries || !RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
      const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
      await sleep(retryAfter ?? backoffDelay(attempt + 1, base, max));
    }
  }

  async testConnection(): Promise<ConnectionResult> {
    if (!this.isConfigured) {
      return { ok: false, message: 'Gemini API key belum diatur — set GEMINI_API_KEY atau jalankan /login.' };
    }
    try {
      const url = this.buildEndpointUrl(`/models/${this.currentModel}:generateContent`);
      const response = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 16 },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Gemini API error ${response.status}: ${sanitizeSensitiveText(body.slice(0, 200), this.apiKey)}`);
      }
      return { ok: true, message: this.currentModel };
    } catch (err) {
      const sanitized = sanitizeError(err, this.apiKey);
      return { ok: false, message: explainProviderError(sanitized) };
    }
  }

  async listModels(): Promise<string[]> {
    return [
      'gemini-2.0-flash',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
    ];
  }

  async chat(messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    if (!this.isConfigured) {
      throw new Error('Konfigurasi Gemini belum lengkap (API key kosong) — jalankan /login atau set GEMINI_API_KEY.');
    }

    const systemParts: string[] = [];
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
      } else {
        const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
        if (contents.length > 0 && contents[contents.length - 1].role === role) {
          contents[contents.length - 1].parts[0].text += '\n\n' + m.content;
        } else {
          contents.push({ role, parts: [{ text: m.content }] });
        }
      }
    }

    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
    }

    const payload: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: options?.maxTokens ?? 2048,
        temperature: options?.temperature ?? 0.3,
      },
    };
    if (systemParts.length > 0) {
      payload.systemInstruction = {
        parts: [{ text: systemParts.join('\n\n') }],
      };
    }

    const modelName = options?.model ?? this.currentModel;
    const url = this.buildEndpointUrl(`/models/${modelName}:streamGenerateContent`, { alt: 'sse' });

    let response: Response;
    try {
      response = await this.requestWithRetry(url, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(payload),
        signal: options?.signal,
      });
    } catch (err) {
      throw sanitizeError(err, this.apiKey);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${sanitizeSensitiveText(body.slice(0, 500), this.apiKey)}`);
    }

    this.lastFinishReason = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      try {
        const data = (await response.json()) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
            finishReason?: string;
          }>;
        };
        this.lastFinishReason = data.candidates?.[0]?.finishReason ?? 'STOP';
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        if (text) {
          options?.onToken?.(text);
        }
        return text;
      } catch (err) {
        throw sanitizeError(err, this.apiKey);
      }
    }

    let full = '';
    let buffer = '';
    const decoder = new TextDecoder();
    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payloadStr = trimmed.slice(5).trim();
      if (!payloadStr) return;
      try {
        const parsed = JSON.parse(payloadStr) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
            finishReason?: string;
          }>;
        };
        const finishReason = parsed.candidates?.[0]?.finishReason;
        if (finishReason) {
          this.lastFinishReason = finishReason;
        }
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          full += text;
          options?.onToken?.(text);
        }
      } catch {
        // ignore
      }
    };

    try {
      for await (const raw of response.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(raw, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const line of buffer.split(/\r?\n/)) processLine(line);
      }
    } catch (err) {
      throw sanitizeError(err, this.apiKey);
    }
    if (!this.lastFinishReason) {
      this.lastFinishReason = 'STOP';
    }

    return full;
  }
}

/** Factory: returns the configured provider (extend here for more backends). */
export function createProvider(
  config: Partial<AgentConfig> = {},
  retry: RetryOptions = {},
): LLMProvider {
  const provider = (config.provider || '').toLowerCase();
  const rawBase = (config.baseUrl || '').toLowerCase().replace(/^["'`]+|["'`]+$/g, '').trim();
  const model = (config.model || '').toLowerCase();
  if (provider === 'anthropic' || rawBase.includes('anthropic.com') || model.startsWith('claude-')) {
    return new AnthropicProvider(config, retry);
  }
  if (provider === 'gemini' || rawBase.includes('googleapis.com') || (!rawBase && model.startsWith('gemini-'))) {
    return new GeminiProvider(config, retry);
  }
  return new OpenAiCompatibleProvider(config, retry);
}

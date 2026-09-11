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
}

/** Abstraction over any chat-completion backend the agent can talk to. */
export interface LLMProvider {
  readonly name: string;
  /** True when the backend can actually be called (e.g. API key present). */
  readonly isConfigured: boolean;
  /** The currently active model name. */
  readonly model: string;
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
 * Translates raw transport/HTTP failures into beginner-proof explanations
 * with the fix command inline (§2: "pesan error yang menerjemahkan").
 */
export function explainProviderError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
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

  constructor(cfg: Partial<AgentConfig> = {}, retry: RetryOptions = {}) {
    this.apiKey = cfg.apiKey || process.env.OPENAI_API_KEY || '';
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

    const response = await this.requestWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        model: options?.model ?? this.currentModel,
        // Tool results are inlined as user messages; keep only roles the API knows.
        messages: messages.map((m) => ({
          role: m.role === 'tool' ? 'user' : m.role,
          content: m.content,
        })),
        temperature: options?.temperature ?? 0.3,
        max_tokens: options?.maxTokens ?? 2048,
        stream: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM API error ${response.status}: ${body.slice(0, 500)}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      // Endpoint ignored `stream` — parse the plain JSON completion instead.
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      if (content) options?.onToken?.(content);
      return content;
    }

    let full = '';
    let pending = '';
    const decoder = new TextDecoder();
    const consumeEvent = (event: string): void => {
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string | null } }>;
          };
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) {
            full += token;
            options?.onToken?.(token);
          }
        } catch {
          // Keep-alive or malformed SSE frame — ignore.
        }
      }
    };
    for await (const raw of response.body as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(raw, { stream: true });
      const events = pending.split(/\r?\n\r?\n/);
      pending = events.pop() ?? '';
      for (const event of events) consumeEvent(event);
    }
    // Flush the decoder and any final frame that arrived WITHOUT a trailing
    // blank line — dropping it truncated the reply's last tokens (§2).
    pending += decoder.decode();
    if (pending.trim()) consumeEvent(pending);
    return full;
  }
}

/** Factory: returns the configured provider (extend here for more backends). */
export function createProvider(
  config: Partial<AgentConfig> = {},
  retry: RetryOptions = {},
): LLMProvider {
  return new OpenAiCompatibleProvider(config, retry);
}

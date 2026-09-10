import { AgentConfig, ContextMessage } from '../types.js';

/** Endpoint defaults (used when neither config file nor env vars say otherwise). */
export const DEFAULT_BASE_URL = 'https://api.b.ai/v1';
export const DEFAULT_MODEL = 'qwen3.8-flash';

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
  const status = text.match(/\b(401|403|404|429|500|502|503)\b/)?.[1];
  switch (status) {
    case '401':
    case '403':
      return 'API key salah atau kedaluwarsa — perbaiki dengan `/config setup` atau /profile.';
    case '404':
      return 'Model tidak ditemukan — cek nama (`/model <nama>`) atau baseUrl (`/config set baseUrl <url>`).';
    case '429':
      return 'Rate limit terpanggil — tunggu sebentar, atau ganti profil lewat /profile.';
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
  private apiKey: string
  private baseUrl: string;
  private currentModel: string;

  constructor(cfg: Partial<AgentConfig> = {}) {
    this.apiKey = cfg.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = (
      cfg.baseUrl ||
      process.env.OPENAI_BASE_URL ||
      DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    this.currentModel =
      cfg.model || process.env.AGENT_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL;
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0;
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
      return { ok: false, message: 'API key belum diisi.' };
    }
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          model: this.currentModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
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
      throw new Error('API key belum dikonfigurasi — jalankan `/config setup` atau set OPENAI_API_KEY.');
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
    for await (const raw of response.body as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(raw, { stream: true });
      const events = pending.split(/\r?\n\r?\n/);
      pending = events.pop() ?? '';
      for (const event of events) {
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
      }
    }
    return full;
  }
}

/** Factory: returns the configured provider (extend here for more backends). */
export function createProvider(config: Partial<AgentConfig> = {}): LLMProvider {
  return new OpenAiCompatibleProvider(config);
}

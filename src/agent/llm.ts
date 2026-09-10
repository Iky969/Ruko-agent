import { ContextMessage } from '../types.js';

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
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
  chat(messages: ContextMessage[], options?: ChatOptions): Promise<string>;
}

/**
 * OpenAI-compatible chat completions provider (works with OpenAI and any
 * compatible endpoint such as Ollama, LM Studio, vLLM, ...).
 *
 * Environment variables:
 *   OPENAI_API_KEY   — required to enable the AI backend
 *   OPENAI_BASE_URL  — optional, default https://api.openai.com/v1
 *   AGENT_MODEL      — optional model name, default gpt-4o-mini
 */
export class OpenAiCompatibleProvider implements LLMProvider {
  readonly name = 'openai-compatible';
  readonly isConfigured: boolean;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private currentModel: string;

  constructor(defaultModel?: string) {
    this.apiKey = process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.currentModel =
      defaultModel ?? process.env.AGENT_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    this.isConfigured = this.apiKey.length > 0;
  }

  get model(): string {
    return this.currentModel;
  }

  setModel(model: string): void {
    this.currentModel = model.trim() || this.currentModel;
  }

  async chat(messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    if (!this.isConfigured) {
      throw new Error('OPENAI_API_KEY is not set — cannot call the LLM backend.');
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model ?? this.currentModel,
        // Tool results are inlined as user messages; keep only roles the API knows.
        messages: messages.map((m) => ({
          role: m.role === 'tool' ? 'user' : m.role,
          content: m.content,
        })),
        temperature: options?.temperature ?? 0.3,
        max_tokens: options?.maxTokens ?? 2048,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM API error ${response.status}: ${body.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (content == null || content.length === 0) {
      throw new Error('LLM returned an empty response.');
    }
    return content;
  }
}

/** Factory: returns the configured provider (extend here for more backends). */
export function createProvider(defaultModel?: string): LLMProvider {
  return new OpenAiCompatibleProvider(defaultModel);
}
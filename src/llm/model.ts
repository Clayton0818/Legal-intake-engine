// c35 — the model-vendor interface (ADR-0001 D9). The only place in the
// codebase that may talk to a model vendor. Nothing here decides whether a
// call is allowed — ./classify.ts checks the vendor.ai_model gate and the
// prompt gate before it ever calls `complete()`.

export interface ModelRequest {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface ModelReply {
  text: string;
  /** Vendor model id actually used, for modelVersion. */
  model: string;
}

export interface TriageModel {
  readonly name: string;
  readonly isStub: boolean;
  complete(req: ModelRequest): Promise<ModelReply>;
}

export class ModelNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelNotConfiguredError";
  }
}
export class ModelTimeoutError extends Error {
  constructor() {
    super("Model call timed out.");
    this.name = "ModelTimeoutError";
  }
}

/**
 * Stub: records requests, never sends. By default it throws
 * ModelNotConfiguredError so the classifier falls back to rules; tests can
 * give it canned replies.
 */
export class StubTriageModel implements TriageModel {
  readonly name = "stub";
  readonly isStub = true;
  readonly recorded: ModelRequest[] = [];
  constructor(private readonly replies: Array<string | Error> = []) {}

  async complete(req: ModelRequest): Promise<ModelReply> {
    this.recorded.push(req);
    const next = this.replies.shift();
    if (next === undefined) throw new ModelNotConfiguredError("No model vendor is configured (stub adapter).");
    if (next instanceof Error) throw next;
    return { text: next, model: "stub-model" };
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Anthropic Messages API over plain fetch (no SDK dependency). Which vendor
 * to use is still the founder's DPA decision; this adapter only exists so
 * that decision is a config change, not a code change. Temperature 0, no
 * tools, one user message.
 */
export class AnthropicTriageModel implements TriageModel {
  readonly name = "anthropic";
  readonly isStub = false;
  constructor(
    private readonly config: { apiKey: string; model: string; baseUrl?: string },
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)
  ) {}

  async complete(req: ModelRequest): Promise<ModelReply> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.config.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: req.maxTokens,
          temperature: 0,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Model vendor returned HTTP ${res.status}.`);
      const body = (await res.json()) as { model?: string; content?: Array<{ type?: string; text?: string }> };
      const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      return { text, model: body.model ?? this.config.model };
    } catch (err) {
      if (ctrl.signal.aborted) throw new ModelTimeoutError();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

let override: TriageModel | null = null;

export function setTriageModel(model: TriageModel | null): void {
  override = model;
}

/** The configured model adapter. LLM_PROVIDER=anthropic + LLM_API_KEY + LLM_MODEL; anything else → stub. */
export function getTriageModel(env: Readonly<Record<string, string | undefined>> = process.env): TriageModel {
  if (override) return override;
  if (env.LLM_PROVIDER === "anthropic" && env.LLM_API_KEY && env.LLM_MODEL) {
    return new AnthropicTriageModel({ apiKey: env.LLM_API_KEY, model: env.LLM_MODEL, baseUrl: env.LLM_BASE_URL });
  }
  return new StubTriageModel();
}

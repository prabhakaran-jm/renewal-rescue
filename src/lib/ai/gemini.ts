export type GeminiErrorKind = "timeout" | "http" | "malformed";

export class GeminiError extends Error {
  readonly kind: GeminiErrorKind;
  readonly status?: number;

  constructor(kind: GeminiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "GeminiError";
    this.kind = kind;
    this.status = status;
  }
}

export type GeminiGenerateOpts = {
  apiKey: string;
  model: string;
  prompt: string;
  /** JSON Schema object for structured output */
  responseJsonSchema: Record<string, unknown>;
  /** Prefer responseJsonSchema; set "response_schema" if live API requires snake_case OpenAPI field */
  schemaField?: "responseJsonSchema" | "responseSchema" | "response_schema";
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
};

export type GeminiGenerateResult = {
  text: string;
  model: string;
  schemaField: string;
};

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Call Gemini generateContent with JSON mime + structured schema.
 * API key goes in x-goog-api-key only — never in the URL.
 */
export async function generateContentJson(
  opts: GeminiGenerateOpts
): Promise<GeminiGenerateResult> {
  const {
    apiKey,
    model,
    prompt,
    responseJsonSchema,
    schemaField = "responseJsonSchema",
    timeoutMs = 8_000,
    fetchImpl = fetch,
    baseUrl = DEFAULT_BASE,
  } = opts;

  if (!apiKey) {
    throw new GeminiError("http", "GEMINI_API_KEY missing", 401);
  }

  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  if (/[?&]key=/.test(url) || url.includes(apiKey)) {
    throw new GeminiError("malformed", "API key must not appear in request URL");
  }

  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
  };
  if (schemaField === "response_schema") {
    generationConfig.response_schema = responseJsonSchema;
  } else if (schemaField === "responseSchema") {
    generationConfig.responseSchema = responseJsonSchema;
  } else {
    generationConfig.responseJsonSchema = responseJsonSchema;
  }

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (
      (err instanceof Error && err.name === "AbortError") ||
      (typeof DOMException !== "undefined" &&
        err instanceof DOMException &&
        err.name === "AbortError")
    ) {
      throw new GeminiError("timeout", `Gemini timed out after ${timeoutMs}ms`);
    }
    throw new GeminiError(
      "http",
      err instanceof Error ? err.message : "Gemini fetch failed"
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      if (errBody?.error?.message) detail = errBody.error.message;
    } catch {
      /* ignore parse of error body */
    }
    throw new GeminiError("http", detail, res.status);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new GeminiError("malformed", "Gemini response was not JSON");
  }

  const text = extractText(payload);
  if (!text) {
    throw new GeminiError("malformed", "Gemini response missing text parts");
  }

  return { text, model, schemaField };
}

function extractText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const content = (candidates[0] as { content?: { parts?: unknown } })?.content;
  const parts = content?.parts;
  if (!Array.isArray(parts)) return null;
  const chunks: string[] = [];
  for (const part of parts) {
    if (
      part &&
      typeof part === "object" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      chunks.push((part as { text: string }).text);
    }
  }
  const joined = chunks.join("").trim();
  return joined || null;
}

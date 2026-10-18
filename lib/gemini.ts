// Minimal, dependency-free Gemini REST client.
//
// Multi-model routing (accuracy first):
// - extract + fill both default to gemini-3.8-flash (AI fill is source of truth)
// - optional GEMINI_MODEL_EXTRACT can still point at Flash-Lite for speed

/** Strong Flash for labeling, boxes, and values. */
const DEFAULT_FILL_MODEL = "gemini-3.8-flash";

/**
 * Task roles for routing.
 * Fill is always the quality path — review only patches clear mistakes afterward.
 */
export type GeminiRole = "extract" | "fill" | "map";

/**
 * Accuracy first: allow long Gemini runs. Client abort is higher still.
 * Override with GEMINI_TIMEOUT_MS if needed.
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 180_000;

function envModel(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

/**
 * Resolve model for a pipeline role.
 * Env: GEMINI_MODEL_EXTRACT, GEMINI_MODEL_FILL, GEMINI_MODEL_MAP, or GEMINI_MODEL.
 */
export function getGeminiModel(role: GeminiRole = "fill"): string {
  const global = envModel("GEMINI_MODEL");
  switch (role) {
    case "extract":
      // Fast document parse; fill model does the careful form work.
      return (
        envModel("GEMINI_MODEL_EXTRACT") ||
        global ||
        "gemini-3.5-flash-lite"
      );
    case "map":
      return envModel("GEMINI_MODEL_MAP") || global || DEFAULT_FILL_MODEL;
    case "fill":
      return envModel("GEMINI_MODEL_FILL") || global || DEFAULT_FILL_MODEL;
    default: {
      const _exhaustive: never = role;
      throw new Error(`Unknown Gemini role: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Thinking depth. Gemini 3.x uses thinkingLevel (not budget).
 * medium = best quality/latency balance for form fill (high often burns output tokens).
 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

function defaultThinkingLevel(role: GeminiRole): ThinkingLevel {
  const raw = process.env.GEMINI_THINKING_LEVEL?.trim().toLowerCase();
  if (
    raw === "minimal" ||
    raw === "low" ||
    raw === "medium" ||
    raw === "high"
  ) {
    return raw;
  }
  switch (role) {
    case "extract":
      return "medium";
    case "map":
      return "medium";
    case "fill":
      // medium: Google's recommended default for complex Flash work.
      // high often hits MAX_TOKENS on thinking and returns incomplete JSON.
      return "medium";
    default: {
      const _exhaustive: never = role;
      throw new Error(`Unknown Gemini role: ${String(_exhaustive)}`);
    }
  }
}

function isGemini3Family(model: string): boolean {
  return /gemini-3|gemini-4/i.test(model);
}

/** Gemini 3.8 Flash rejects thinkingLevel "minimal". */
function clampThinkingLevel(model: string, level: ThinkingLevel): ThinkingLevel {
  if (/gemini-3\.8-flash/i.test(model) && level === "minimal") return "low";
  return level;
}

export function getGeminiApiKey(): string | undefined {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    undefined
  );
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "No Gemini API key found. Add GEMINI_API_KEY to .env.local and restart the dev server.",
    );
    this.name = "MissingApiKeyError";
  }
}

export interface InlineImage {
  mimeType: string;
  /** base64-encoded bytes (no data: prefix) */
  data: string;
}

export type MediaResolution =
  | "MEDIA_RESOLUTION_LOW"
  | "MEDIA_RESOLUTION_MEDIUM"
  | "MEDIA_RESOLUTION_HIGH";

export type GeminiPart =
  | { text: string }
  | { inlineData: InlineImage; mediaResolution?: MediaResolution };

/** JSON-schema subset accepted by Gemini's responseSchema. */
export interface GeminiSchema {
  type: "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN" | "ARRAY" | "OBJECT";
  description?: string;
  nullable?: boolean;
  enum?: string[];
  format?: string;
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
}

/**
 * Appended whenever responseSchema is set. Structured output already forces JSON;
 * this blocks markdown fences / prose that sometimes leak beside thinking.
 */
export const JSON_ONLY_OUTPUT =
  "OUTPUT FORMAT: Return ONLY raw JSON matching the response schema. No introductory text, no explanations, no markdown code fences.";

interface GenerateArgs {
  parts: GeminiPart[];
  schema?: GeminiSchema;
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  role?: GeminiRole;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** @deprecated Gemini 3 uses thinkingLevel; kept for older 2.5 models. */
  thinkingBudget?: number;
  /** PDF/image token detail. HIGH = sharper form boxes (Gemini 3). */
  mediaResolution?: MediaResolution;
}

interface GeminiPartOut {
  text?: string;
  thought?: boolean;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPartOut[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

function toRestPart(part: GeminiPart): Record<string, unknown> {
  if ("text" in part) return { text: part.text };
  const rest: Record<string, unknown> = {
    inline_data: {
      mime_type: part.inlineData.mimeType,
      data: part.inlineData.data,
    },
  };
  // Per-part media_resolution must be an object { level }, not a bare enum string.
  // See: https://ai.google.dev/gemini-api/docs/generate-content/media-resolution
  if (part.mediaResolution) {
    rest.media_resolution = { level: part.mediaResolution };
  }
  return rest;
}

function buildGenerationConfig(args: {
  model: string;
  role: GeminiRole;
  schema?: GeminiSchema;
  temperature?: number;
  maxOutputTokens: number;
  thinkingLevel?: ThinkingLevel;
  thinkingBudget?: number;
  mediaResolution?: MediaResolution;
}): Record<string, unknown> {
  const {
    model,
    role,
    schema,
    temperature,
    maxOutputTokens,
    thinkingLevel,
    thinkingBudget,
    mediaResolution,
  } = args;

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens,
    ...(schema
      ? { responseMimeType: "application/json", responseSchema: schema }
      : {}),
  };

  if (mediaResolution) {
    generationConfig.mediaResolution = mediaResolution;
  }

  // Gemini 3.x deprecates temperature/topP/topK — omit for those models.
  if (!isGemini3Family(model) && temperature !== undefined) {
    generationConfig.temperature = temperature;
  }

  if (thinkingBudget === 0) {
    return generationConfig;
  }

  if (isGemini3Family(model)) {
    const level = clampThinkingLevel(
      model,
      thinkingLevel ?? defaultThinkingLevel(role),
    );
    generationConfig.thinkingConfig = { thinkingLevel: level };
    return generationConfig;
  }

  // Gemini 2.5 Flash: thinkingBudget. Lite often rejects thinkingConfig.
  if (!/lite/i.test(model)) {
    const budget = thinkingBudget ?? (role === "fill" ? 8192 : 4096);
    if (budget > 0) {
      generationConfig.thinkingConfig = { thinkingBudget: budget };
    }
  }
  if (temperature !== undefined) {
    generationConfig.temperature = temperature;
  }
  return generationConfig;
}

/** Prefer non-thought text parts (thinking summaries must not pollute JSON). */
function extractResponseText(parts: GeminiPartOut[] | undefined): string {
  if (!parts?.length) return "";
  const answer = parts
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (answer) return answer;
  // Fallback: some responses only expose text without thought flags.
  return parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

/**
 * Call Gemini and return the model's text output. When a schema is provided the
 * text is guaranteed to be JSON matching that schema.
 */
export async function geminiGenerate({
  parts,
  schema,
  system,
  temperature = 0,
  maxOutputTokens = 16384,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  role = "fill",
  model: modelOverride,
  thinkingLevel,
  thinkingBudget,
  mediaResolution,
}: GenerateArgs): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new MissingApiKeyError();

  const model = modelOverride?.trim() || getGeminiModel(role);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const t0 = Date.now();

  // Fill/map default to HIGH so form boxes get more PDF/page detail.
  const resolvedMedia =
    mediaResolution ??
    (role === "fill" || role === "map"
      ? ("MEDIA_RESOLUTION_HIGH" as const)
      : undefined);

  const generationConfig = buildGenerationConfig({
    model,
    role,
    schema,
    temperature,
    maxOutputTokens,
    thinkingLevel,
    thinkingBudget,
    mediaResolution: resolvedMedia,
  });

  // Structured JSON + thinkingConfig coexist: thinking is internal; answer parts
  // must still match responseSchema. We strip thought parts when reading text.
  const systemText = schema
    ? [system?.trim(), JSON_ONLY_OUTPUT].filter(Boolean).join("\n\n")
    : system?.trim();

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: parts.map(toRestPart) }],
    generationConfig,
  };
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
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
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `AI timed out after ${Math.round(timeoutMs / 1000)}s. Try fewer/smaller source files, or retry.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const json = (await res.json()) as GeminiResponse;
  const finish = json.candidates?.[0]?.finishReason;
  console.log(
    `[gemini] role=${role} ${model} ${res.status} in ${Date.now() - t0}ms` +
      (finish ? ` finish=${finish}` : ""),
  );

  if (!res.ok) {
    throw new Error(
      `Gemini request failed (${res.status}): ${json.error?.message ?? res.statusText}`,
    );
  }
  if (json.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the request: ${json.promptFeedback.blockReason}`);
  }

  const text = extractResponseText(json.candidates?.[0]?.content?.parts);

  if (!text) {
    throw new Error(
      finish === "MAX_TOKENS"
        ? "AI ran out of output tokens while thinking/filling. Retry — the fill model is the source of truth."
        : "Gemini returned an empty response.",
    );
  }
  if (finish === "MAX_TOKENS") {
    console.warn(
      "[gemini] finish=MAX_TOKENS — response may be truncated; using lenient JSON parse",
    );
  }
  return text;
}

/** Recover a truncated JSON array so a MAX_TOKENS cut still yields filled rows. */
function parseJsonLenient<T>(text: string): T {
  const cleaned = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("[");
    if (start < 0) throw new Error("Gemini JSON was not valid.");
    const body = cleaned.slice(start);
    const lastBrace = body.lastIndexOf("}");
    if (lastBrace < 0) throw new Error("Gemini JSON was not valid.");
    const repaired = `${body.slice(0, lastBrace + 1)}]`;
    console.warn("[gemini] recovered truncated JSON array");
    return JSON.parse(repaired) as T;
  }
}

/** Call Gemini expecting JSON output and parse it. */
export async function geminiGenerateJson<T>(args: GenerateArgs): Promise<T> {
  const text = await geminiGenerate(args);
  return parseJsonLenient<T>(text);
}

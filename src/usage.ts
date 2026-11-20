// Token accounting. Kilo speaks three wire formats, so usage can arrive as
// `usage` on a JSON response, in OpenAI's final SSE chunk, in Anthropic's
// message_start/message_delta events, or on the Responses API's
// response.completed event. The scanner never buffers the body: it consumes a
// decoded copy of each chunk and keeps one partial line.

import { isRecord } from "./json.ts";

export interface Usage {
  prompt: number;
  completion: number;
  total: number;
  cost: number | null;
}

export function emptyUsage(): Usage {
  return { prompt: 0, completion: 0, total: 0, cost: null };
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function usageOf(payload: unknown): unknown {
  if (!isRecord(payload)) return null;
  if ("usage" in payload) return payload.usage;
  if (isRecord(payload.message) && "usage" in payload.message) return payload.message.usage;
  if (isRecord(payload.response) && "usage" in payload.response) return payload.response.usage;
  return null;
}

/** Normalize any usage object (OpenAI, Anthropic, Responses) into one shape. */
export function usageFromPayload(payload: unknown): Usage | null {
  if (!isRecord(payload)) return null;
  const raw = usageOf(payload);
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let cost: number | null = null;

  if (isRecord(raw)) {
    prompt = num(raw.prompt_tokens ?? raw.input_tokens);
    completion = num(raw.completion_tokens ?? raw.output_tokens);
    total = num(raw.total_tokens) || prompt + completion;
    const costRaw = raw.cost ?? raw.total_cost;
    if (costRaw !== undefined && costRaw !== null) cost = num(costRaw);
  }

  if (isRecord(payload) && cost == null) {
    const topCost = payload.cost ?? payload.total_cost;
    if (typeof topCost === "number") cost = topCost;
  }

  if (prompt === 0 && completion === 0 && total === 0 && cost === null) return null;
  return { prompt, completion, total, cost };
}

function merge(into: Usage, next: Usage): void {
  into.prompt = Math.max(into.prompt, next.prompt);
  into.completion = Math.max(into.completion, next.completion);
  into.total = Math.max(into.total, next.total, into.prompt + into.completion);
  if (next.cost !== null) into.cost = next.cost;
}

/** Incremental SSE usage parser. Feed decoded text; call finish() at EOF. */
export class UsageScanner {
  readonly usage = emptyUsage();
  private buf = "";

  push(text: string): void {
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.line(line);
    }
    // A pathological upstream line must not grow without bound.
    if (this.buf.length > 1_000_000) this.buf = this.buf.slice(-8192);
  }

  finish(): Usage {
    if (this.buf) {
      this.line(this.buf);
      this.buf = "";
    }
    return this.usage;
  }

  private line(rawLine: string): void {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const parsed: unknown = JSON.parse(data);
      const usage = usageFromPayload(parsed);
      if (usage) merge(this.usage, usage);
    } catch {
      /* SSE comments and partial JSON are expected */
    }
  }
}

export function extractModel(body: string | null | undefined): string | null {
  if (!body) return null;
  if (body.length <= 2_000_000) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (isRecord(parsed) && typeof parsed.model === "string" && parsed.model.length <= 200) {
        return parsed.model;
      }
    } catch {
      /* fall through to the regex for non-JSON bodies */
    }
  }
  const match = /"model"\s*:\s*"([^"]{1,200})"/.exec(body);
  return match ? match[1] : null;
}

export function extractError(body: string | null | undefined, max = 400): string | null {
  if (!body) return null;
  let message: string | null = null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      if (typeof parsed.message === "string") message = parsed.message;
      else if (isRecord(parsed.error) && typeof parsed.error.message === "string") message = parsed.error.message;
    }
  } catch {
    message = body.slice(0, max);
  }
  if (!message) message = body.slice(0, max);
  return message.slice(0, max);
}

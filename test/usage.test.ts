import { describe, expect, test } from "bun:test";
import { UsageScanner, extractError, extractModel, usageFromPayload } from "../src/usage.ts";

describe("usage normalisation", () => {
  test("OpenAI chat usage", () => {
    expect(usageFromPayload({ usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })).toEqual({
      prompt: 3,
      completion: 4,
      total: 7,
      cost: null,
    });
  });

  test("Anthropic message usage", () => {
    expect(usageFromPayload({ usage: { input_tokens: 11, output_tokens: 5 } })).toEqual({
      prompt: 11,
      completion: 5,
      total: 16,
      cost: null,
    });
  });

  test("Responses API usage nested under response", () => {
    expect(
      usageFromPayload({ response: { usage: { input_tokens: 2, output_tokens: 8, total_tokens: 10 } } }),
    ).toEqual({ prompt: 2, completion: 8, total: 10, cost: null });
  });

  test("carries cost when the provider reports it", () => {
    const usage = usageFromPayload({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.004 } });
    expect(usage?.cost).toBe(0.004);
  });

  test("returns null without usable numbers", () => {
    expect(usageFromPayload({})).toBeNull();
    expect(usageFromPayload(null)).toBeNull();
    expect(usageFromPayload({ usage: { prompt_tokens: 0, completion_tokens: 0 } })).toBeNull();
  });
});

describe("SSE scanner", () => {
  test("collects Anthropic start/delta usage split across chunks", () => {
    const scanner = new UsageScanner();
    const events = [
      `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":0}}}\n\n`,
      `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n`,
    ].join("");
    for (const chunk of events.match(/[\s\S]{1,17}/g) ?? []) scanner.push(chunk);
    expect(scanner.finish()).toEqual({ prompt: 9, completion: 4, total: 13, cost: null });
  });

  test("collects OpenAI final chunk usage and ignores comments", () => {
    const scanner = new UsageScanner();
    scanner.push(": keep-alive\n\n");
    scanner.push(`data: {"choices":[{"delta":{"content":"hi"}}]}\n`);
    scanner.push(`data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n`);
    scanner.push("data: [DONE]\n\n");
    expect(scanner.finish()).toEqual({ prompt: 5, completion: 2, total: 7, cost: null });
  });

  test("survives malformed data lines", () => {
    const scanner = new UsageScanner();
    scanner.push("data: {not json\n\n");
    scanner.push(`data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n`);
    expect(scanner.finish().total).toBe(2);
  });
});

describe("request parsing helpers", () => {
  test("extracts the model from JSON and malformed JSON bodies", () => {
    expect(extractModel('{"model":"kilo-auto/free","messages":[]}')).toBe("kilo-auto/free");
    expect(extractModel('{"messages":[],"model": "a/b"}')).toBe("a/b");
    expect(extractModel("not json")).toBeNull();
  });

  test("extracts provider error messages", () => {
    expect(extractError('{"error":{"message":"rate limited"}}')).toBe("rate limited");
    expect(extractError("plain failure")).toBe("plain failure");
    expect(extractError("")).toBeNull();
  });
});

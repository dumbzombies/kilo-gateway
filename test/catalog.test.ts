import { describe, expect, test } from "bun:test";
import { Catalog, isFreeModel, toCatalogModel } from "../src/catalog.ts";
import { jsonResponse } from "./helpers.ts";

describe("free model selection", () => {
  test("accepts the explicit isFree flag", () => {
    expect(isFreeModel({ id: "vendor/model:free", isFree: true, pricing: { prompt: "2", completion: "2" } })).toBe(true);
  });

  test("falls back to zero pricing plus a free name", () => {
    expect(isFreeModel({ id: "vendor/model:free", pricing: { prompt: "0", completion: "0" } })).toBe(true);
    expect(isFreeModel({ id: "vendor/model:free", pricing: { prompt: "0.1", completion: "0" } })).toBe(false);
    expect(isFreeModel({ id: "vendor/model", pricing: { prompt: "0", completion: "0" } })).toBe(false);
  });

  test("ignores malformed rows", () => {
    expect(isFreeModel({})).toBe(false);
    expect(isFreeModel({ id: "x", pricing: { prompt: "nope", completion: "0" } })).toBe(false);
  });
});

describe("catalog mapping", () => {
  test("maps context, modalities and provider", () => {
    const model = toCatalogModel({
      id: "nvidia/thing:free",
      name: "Thing",
      description: "A thing",
      context_length: 1000,
      top_provider: { max_completion_tokens: 200 },
      architecture: { input_modalities: ["text", "image"] },
    });
    expect(model).not.toBeNull();
    expect(model?.id).toBe("nvidia/thing:free");
    expect(model?.owned_by).toBe("nvidia");
    expect(model?.context_length).toBe(1000);
    expect(model?.max_completion_tokens).toBe(200);
    expect(model?.input_modalities).toEqual(["text", "image"]);
  });

  test("rejects rows without an id", () => {
    expect(toCatalogModel({ name: "Nameless" })).toBeNull();
  });
});

describe("catalog cache", () => {
  test("fetches once and serves the cached list", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return jsonResponse({
        data: [
          { id: "a/free:free", name: "Free A", isFree: true },
          { id: "b/paid", name: "Paid", isFree: false, pricing: { prompt: "1", completion: "1" } },
        ],
      });
    }) as unknown as typeof fetch;
    const catalog = new Catalog("http://upstream", 60_000, fake);
    const first = await catalog.load();
    const second = await catalog.load();
    expect(first.map((m) => m.id)).toEqual(["a/free:free"]);
    expect(second).toBe(first);
    expect(calls).toBe(1);
    expect(catalog.status().total).toBe(2);
  });

  test("keeps the last good snapshot when a refresh fails", async () => {
    let fail = false;
    const fake = (async () => {
      if (fail) return jsonResponse({ error: "down" }, 503);
      return jsonResponse({ data: [{ id: "a/free:free", name: "Free", isFree: true }] });
    }) as unknown as typeof fetch;
    const catalog = new Catalog("http://upstream", 0, fake);
    await catalog.load();
    fail = true;
    const models = await catalog.load(true);
    expect(models).toHaveLength(1);
    expect(catalog.error).toContain("503");
  });
});

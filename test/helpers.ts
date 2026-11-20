import { loadConfig, type Config } from "../src/config.ts";

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ PORT: "0", DATA_DIR: "./data" }),
    dbPath: ":memory:",
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export async function readJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

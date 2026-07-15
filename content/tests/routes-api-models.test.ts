/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";

describe("POST /api/llm-models", () => {
  afterEach(() => vi.unstubAllGlobals());

  function authedFetchMock(modelsResponse: Response) {
    return vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/api/auth/me")) {
        return Promise.resolve(new Response(JSON.stringify({ member: { id: "m1" }, tenant: { id: "90" } }), { status: 200 }));
      }
      return Promise.resolve(modelsResponse);
    });
  }

  it("returns 401 when the session check fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-models", {
        method: "POST", headers: { Cookie: "session=bad", "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openai", apiKey: "sk-x" }),
      }),
      env
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when apiKey is missing for openai/anthropic", async () => {
    vi.stubGlobal("fetch", authedFetchMock(new Response("unused", { status: 200 })));
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-models", {
        method: "POST", headers: { Cookie: "session=ok", "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openai" }),
      }),
      env
    );
    expect(res.status).toBe(400);
  });

  it("returns models on a successful openai fetch", async () => {
    vi.stubGlobal("fetch", authedFetchMock(new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200 })));
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-models", {
        method: "POST", headers: { Cookie: "session=ok", "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openai", apiKey: "sk-x" }),
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ["gpt-4o"] });
  });

  it("returns 502 with an error message when the upstream fetch throws", async () => {
    vi.stubGlobal("fetch", authedFetchMock(new Response("bad key", { status: 401 })));
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-models", {
        method: "POST", headers: { Cookie: "session=ok", "Content-Type": "application/json" }, body: JSON.stringify({ provider: "openai", apiKey: "sk-bad" }),
      }),
      env
    );
    expect(res.status).toBe(502);
    expect((await res.json() as any).error).toBeTruthy();
  });

  it("does not require apiKey for provider: 'default'", async () => {
    vi.stubGlobal("fetch", authedFetchMock(new Response(JSON.stringify({ result: [{ name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", task: { name: "Text Generation" } }] }), { status: 200 })));
    const testEnv = { ...env, CF_ACCOUNT_ID: "acct-1", CF_API_TOKEN: "cf-token" };
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/api/llm-models", {
        method: "POST", headers: { Cookie: "session=ok", "Content-Type": "application/json" }, body: JSON.stringify({ provider: "default" }),
      }),
      testEnv
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"] });
  });
});

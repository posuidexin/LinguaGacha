import { afterEach, describe, expect, it, vi } from "vitest";

import { ANTIGRAVITY_BASE_URL } from "../../domain/model";
import { list_antigravity_models, request_antigravity_text } from "./antigravity-cloud-code";

afterEach(() => {
  vi.unstubAllGlobals();
});

const signal = () => new AbortController().signal;

describe("Cloud Code Assist 翻译请求", () => {
  it("合并思考文本和正文，并归一用量", async () => {
    const body = await capture_request({
      response: {
        candidates: [
          {
            content: {
              parts: [{ text: "先想一下", thought: true }, { text: "译文" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 3,
          cachedContentTokenCount: 1,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 2,
        },
      },
    });
    await expect(translate({ thinking_level: "HIGH", output_token_limit: 1000 })).resolves.toEqual({
      response_think: "先想一下",
      response_result: "译文",
      input_tokens: 4,
      reasoning_tokens: 2,
      output_tokens: 3,
      finish: "stop",
    });
    const request = body();
    expect(request["userAgent"]).toBe("antigravity");
    expect(request["requestType"]).toBe("agent");
    expect(request).not.toHaveProperty("tools");
    expect(request["request"]).toMatchObject({
      systemInstruction: { role: "user", parts: [{ text: "规则" }] },
      generationConfig: {
        temperature: 0.2,
        topP: 0.8,
        maxOutputTokens: 1000,
        thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
      },
    });
  });

  it("Claude 限制输出上限且不附带 Gemini 思考配置", async () => {
    const body = await capture_request({
      response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
    });
    await translate({ model_id: "claude-opus-4", output_token_limit: 100_000 });
    expect(body()).toMatchObject({
      request: { generationConfig: { maxOutputTokens: 64_000 } },
    });
    expect(
      (body()["request"] as { generationConfig: Record<string, unknown> }).generationConfig,
    ).not.toHaveProperty("thinkingConfig");
  });

  it("函数调用清空正文，空文本可以重试，拦截不可重试", async () => {
    await capture_request({
      response: {
        candidates: [{ content: { parts: [{ text: "忽略", functionCall: { name: "lookup" } }] } }],
      },
    });
    await expect(translate()).resolves.toMatchObject({ finish: "tool", response_result: "" });

    await capture_request({
      response: { candidates: [{ content: { parts: [{ text: "  " }] } }] },
    });
    await expect(translate()).rejects.toMatchObject({
      diagnostic_context: { retryable: true },
    });

    await capture_request({
      response: { promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "blocked text" } },
    });
    await expect(translate()).rejects.toMatchObject({
      message: "blocked text",
      diagnostic_context: { retryable: false },
    });
  });

  it("目录跳过内部和下线模型，主入口 503 时改试 sandbox", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          models: {
            "gemini-3.1-pro": { displayName: "Gemini 3.1 Pro" },
            chat_20706: { displayName: "Chat" },
            "gemini-2.5-pro": { displayName: "Old" },
            hidden: { displayName: "Hidden", isInternal: true },
          },
        }),
      ),
    );
    await expect(
      list_antigravity_models({
        access_token: "token",
        base_url: ANTIGRAVITY_BASE_URL,
        signal: signal(),
      }),
    ).resolves.toEqual([{ id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" }]);

    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.startsWith(`${ANTIGRAVITY_BASE_URL}/`))
          return new Response("busy", { status: 503 });
        return new Response(
          sse({ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }),
          {
            status: 200,
          },
        );
      }),
    );
    await expect(translate()).resolves.toMatchObject({ response_result: "ok" });
    expect(urls[0]).toContain("daily-cloudcode-pa.googleapis.com");
    expect(urls[1]).toContain("daily-cloudcode-pa.sandbox.googleapis.com");
  });
});

function translate(
  overrides: Partial<Parameters<typeof request_antigravity_text>[0]> = {},
): ReturnType<typeof request_antigravity_text> {
  return request_antigravity_text({
    access_token: "token",
    project_id: "projects/1",
    model_id: "gemini-3.1-pro",
    base_url: ANTIGRAVITY_BASE_URL,
    messages: [
      { role: "system", content: "规则" },
      { role: "user", content: "原文" },
    ],
    output_token_limit: 0,
    thinking_level: "OFF",
    temperature: 0.2,
    top_p: 0.8,
    signal: signal(),
    ...overrides,
  });
}

/** 下一次生成请求返回这段 SSE，并让调用方读取实际 JSON。 */
async function capture_request(payload: unknown): Promise<() => Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(sse(payload), { status: 200 });
    }),
  );
  return () => body;
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

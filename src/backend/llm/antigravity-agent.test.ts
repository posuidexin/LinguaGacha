import { Type } from "@earendil-works/pi-ai";
import {
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";

import { is_json_record, type JsonRecord } from "../../domain/json";
import { stream_antigravity_agent } from "./antigravity-agent";

const BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const SIGNATURE = "AAAA";
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const lookup = {
  name: "lookup",
  description: "Look up",
  parameters: Type.Object({ q: Type.String() }),
};

describe("Antigravity Agent 流", () => {
  it("Gemini 重放签名、合并函数结果，并只给第一条未签名调用补占位签名", async () => {
    const model = test_model("gemini-3.1-pro");
    const { captures } = await run(
      model,
      context([
        user("hello"),
        assistant(model, [
          { type: "thinking", thinking: "unsigned" },
          { type: "thinking", thinking: "kept", thinkingSignature: SIGNATURE },
          { type: "text", text: "answer", textSignature: SIGNATURE },
          { type: "text", text: "", textSignature: "BBBB" },
          {
            type: "toolCall",
            id: "call/1",
            name: "lookup",
            arguments: { q: "a" },
          },
          {
            type: "toolCall",
            id: "call_2",
            name: "lookup",
            arguments: { q: "b" },
            thoughtSignature: "bad!",
          },
        ]),
        tool_result("call/1", "found"),
        tool_result("call_2", "see", { error: true, image: true }),
      ]),
      {
        reasoning: "high",
        maxTokens: 100_000,
        headers: {
          "User-Agent": "LinguaGacha/Test",
          Authorization: "Bearer stolen",
          "X-Test": "1",
        },
        extra_body: { marker: true },
      },
    );
    const body = captures[0]?.body;
    const request = request_of(captures[0]);
    expect(body).toMatchObject({
      marker: true,
      project: "project",
      model: "gemini-pro-agent",
      userAgent: "antigravity",
      requestType: "agent",
    });
    expect(String(body?.["requestId"])).toMatch(/\/3$/u);
    expect(request["contents"]).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
      {
        role: "model",
        parts: [
          { text: "unsigned" },
          { thought: true, text: "kept", thoughtSignature: SIGNATURE },
          { text: "answer", thoughtSignature: SIGNATURE },
          { text: "", thoughtSignature: "BBBB" },
          {
            functionCall: { name: "lookup", args: { q: "a" } },
            thoughtSignature: SKIP_THOUGHT_SIGNATURE,
          },
          { functionCall: { name: "lookup", args: { q: "b" } } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: { name: "lookup", response: { output: "found" } },
          },
          {
            functionResponse: {
              name: "lookup",
              response: { error: "see" },
              parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }],
            },
          },
        ],
      },
    ]);
    expect(JSON.stringify(request["contents"])).not.toContain('"id"');
    expect(request["toolConfig"]).toEqual({
      functionCallingConfig: { mode: "VALIDATED" },
    });
    expect(JSON.stringify(request["tools"])).toContain("parametersJsonSchema");
    expect(JSON.stringify(request["tools"])).not.toContain('"parameters":');
    expect(generation_of(request)).toMatchObject({
      maxOutputTokens: 65_535,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 10_001 },
    });
    expect(generation_of(request)["thinkingConfig"]).not.toHaveProperty("thinkingLevel");
    expect(captures[0]?.headers.get("authorization")).toBe("Bearer token");
    expect(captures[0]?.headers.get("user-agent")).toMatch(/^antigravity\/hub\//u);
    expect(captures[0]?.headers.get("x-test")).toBe("1");
    expect(request["labels"]).toMatchObject({
      last_step_index: "2",
      used_claude: "false",
      model_enum: "MODEL_PLACEHOLDER_M16",
    });
  });

  it("关闭思考时按模型家族抑制，Claude 用思考预算和 beta 头", async () => {
    const pro = test_model("gemini-3-pro");
    const closed = await run(pro, context([user()]));
    expect(generation_of(request_of(closed.captures[0]))["thinkingConfig"]).toEqual({
      includeThoughts: false,
      thinkingLevel: "LOW",
    });
    const level = await run(pro, context([user()]), { reasoning: "xhigh" });
    expect(generation_of(request_of(level.captures[0]))["thinkingConfig"]).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });

    const flash = test_model("gemini-3.6-flash");
    const omitted = await run(flash, context([user()]));
    expect(generation_of(request_of(omitted.captures[0]))).not.toHaveProperty("thinkingConfig");

    const claude = test_model("claude-opus-4-6");
    const claude_turn = await run(claude, context([user()], []), {
      reasoning: "high",
      toolChoice: "none",
      maxTokens: 100_000,
    });
    const claude_request = request_of(claude_turn.captures[0]);
    expect(generation_of(claude_request)).toEqual({
      maxOutputTokens: 64_000,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 16_384 },
    });
    expect(claude_request["toolConfig"]).toEqual({
      functionCallingConfig: { mode: "VALIDATED" },
    });
    expect(claude_request).not.toHaveProperty("tools");
    expect(claude_turn.captures[0]?.headers.get("anthropic-beta")).toBe(
      "interleaved-thinking-2025-05-14",
    );
    expect(claude_request["labels"]).toMatchObject({
      used_claude: "true",
      used_claude_conservative: "true",
    });
  });

  it("3.1 Pro 高档请求名改为 gemini-pro-agent，关档留在 low 并写死输出上限", async () => {
    const closed = await run(test_model("gemini-3.1-pro-high"), context([user()]));
    const closed_request = request_of(closed.captures[0]);
    expect(closed.captures[0]?.body["model"]).toBe("gemini-3.1-pro-low");
    expect(generation_of(closed_request)).toMatchObject({
      maxOutputTokens: 65_535,
      thinkingConfig: { includeThoughts: false, thinkingBudget: 1_001 },
    });
    expect(labels_of(closed_request)["model_enum"]).toBe("MODEL_PLACEHOLDER_M36");

    const high = await run(test_model("gemini-3.1-pro-low"), context([user()]), {
      reasoning: "high",
    });
    const high_request = request_of(high.captures[0]);
    expect(high.captures[0]?.body["model"]).toBe("gemini-pro-agent");
    expect(generation_of(high_request)["thinkingConfig"]).toEqual({
      includeThoughts: true,
      thinkingBudget: 10_001,
    });
    expect(labels_of(high_request)["model_enum"]).toBe("MODEL_PLACEHOLDER_M16");
  });

  it("目录未标记思考能力的 Claude 仍按档位发送预算和 beta 头", async () => {
    const model = test_model("claude-sonnet-4-6", { reasoning: false });
    const closed = await run(model, context([user()], []));
    expect(generation_of(request_of(closed.captures[0]))).toEqual({
      maxOutputTokens: 64_000,
    });
    expect(closed.captures[0]?.headers.get("anthropic-beta")).toBeNull();

    const low = await run(model, context([user()], []), { reasoning: "low" });
    expect(generation_of(request_of(low.captures[0]))["thinkingConfig"]).toEqual({
      includeThoughts: true,
      thinkingBudget: 4_096,
    });
    expect(low.captures[0]?.headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");

    const high = await run(model, context([user()], []), { reasoning: "high" });
    expect(generation_of(request_of(high.captures[0]))["thinkingConfig"]).toEqual({
      includeThoughts: true,
      thinkingBudget: 16_384,
    });
  });

  it("把调用方的 temperature 和 top_p 写入 generationConfig", async () => {
    const flashed = await run(test_model("gemini-3.8-flash-high"), context([user()]), {
      temperature: 0.2,
      top_p: 0.8,
    });
    const request = request_of(flashed.captures[0]);
    expect(flashed.captures[0]?.body["model"]).toBe("gemini-3.8-flash-high");
    expect(generation_of(request)).toMatchObject({
      temperature: 0.2,
      topP: 0.8,
    });
    expect(generation_of(request)).not.toHaveProperty("thinkingConfig");
  });

  it("Claude 保留函数 id 和签名思考，并丢弃没有签名的思考", async () => {
    const model = test_model("vendor/claude-sonnet-4-6");
    const { captures } = await run(
      model,
      context(
        [
          user("hello"),
          assistant(model, [
            { type: "thinking", thinking: "drop me" },
            {
              type: "thinking",
              thinking: "keep me",
              thinkingSignature: SIGNATURE,
            },
            {
              type: "toolCall",
              id: "bad/id",
              name: "lookup",
              arguments: { q: "a" },
              thoughtSignature: SIGNATURE,
            },
          ]),
          tool_result("bad/id", "found"),
        ],
        [lookup],
      ),
      { toolChoice: "none" },
    );
    const request = request_of(captures[0]);
    expect(request["contents"]).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
      {
        role: "model",
        parts: [
          { thought: true, text: "keep me", thoughtSignature: SIGNATURE },
          {
            functionCall: { name: "lookup", args: { q: "a" }, id: "bad_id" },
            thoughtSignature: SIGNATURE,
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "lookup",
              id: "bad_id",
              response: { output: "found" },
            },
          },
        ],
      },
    ]);
    expect(request["toolConfig"]).toEqual({
      functionCallingConfig: { mode: "VALIDATED" },
    });
    expect(JSON.stringify(request["tools"])).toContain('"parameters"');
    expect(JSON.stringify(request["tools"])).not.toContain("parametersJsonSchema");
    expect(captures[0]?.headers.get("anthropic-beta")).toBeNull();
  });

  it("Gemini 2 把工具图片放到函数结果之后，Gemini 选择 none 时关闭工具", async () => {
    const model = test_model("gemini-2.5-flash", { input: ["text", "image"] });
    const { captures } = await run(
      model,
      context(
        [
          user("hello"),
          assistant(model, [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }]),
          tool_result("call_1", "", { image: true }),
        ],
        [lookup],
      ),
    );
    expect(request_of(captures[0])["contents"]).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "lookup", args: {} } }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "lookup",
              response: { output: "(see attached image)" },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          { text: "Tool result image:" },
          { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
        ],
      },
    ]);

    const none = await run(test_model("gemini-3-pro"), context([user()], [lookup]), {
      toolChoice: "none",
    });
    expect(request_of(none.captures[0])["toolConfig"]).toEqual({
      functionCallingConfig: { mode: "NONE" },
    });
  });

  it("流式拼接文本和工具调用，空响应与拦截按能否重试区分", async () => {
    const model = test_model("gemini-3.1-pro");
    const streamed = await run(model, context([user("hello")]), {
      responses: [
        chunked([
          `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "hel" }] } }] } })}\n\n`,
          `data: ${JSON.stringify({
            responseId: "resp-1",
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: "lo", thoughtSignature: SIGNATURE }],
                  },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                cachedContentTokenCount: 40,
                candidatesTokenCount: 4,
                thoughtsTokenCount: 3,
                totalTokenCount: 17,
              },
            },
          })}\n\n`,
        ]),
      ],
    });
    expect(streamed.events).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(streamed.message.content).toEqual([
      { type: "text", text: "hello", textSignature: SIGNATURE },
    ]);
    expect(streamed.message.responseId).toBe("resp-1");
    expect(streamed.message.usage).toMatchObject({
      input: 0,
      output: 7,
      cacheRead: 10,
      reasoning: 3,
      totalTokens: 17,
    });

    const thought_heavy = await run(model, context([user()]), {
      responses: [
        sse([
          {
            response: {
              candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
              usageMetadata: {
                promptTokenCount: 11,
                candidatesTokenCount: 34,
                thoughtsTokenCount: 372,
                totalTokenCount: 417,
              },
            },
          },
        ]),
      ],
    });
    expect(thought_heavy.message.usage).toMatchObject({
      input: 11,
      output: 406,
      reasoning: 372,
      totalTokens: 417,
    });

    const tool = await run(model, context([user()]), {
      responses: [
        sse([
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          name: "lookup",
                          id: "bad/id",
                          args: { q: "a" },
                        },
                      },
                    ],
                  },
                  finishReason: "MAX_TOKENS",
                },
              ],
            },
          },
        ]),
      ],
    });
    expect(tool.events).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(tool.message.stopReason).toBe("toolUse");
    expect(tool.message.content).toEqual([
      { type: "toolCall", id: "bad_id", name: "lookup", arguments: { q: "a" } },
    ]);

    const blocked = await run(model, context([user()]), {
      responses: [
        sse([
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ functionCall: { name: "lookup", args: {} } }],
                  },
                  finishReason: "SAFETY",
                },
              ],
            },
          },
        ]),
      ],
    });
    expect(blocked.message.stopReason).toBe("error");
    expect(blocked.message.errorMessage).toContain("SAFETY");
    expect(blocked.message.content[0]).toMatchObject({ type: "toolCall" });
    expect(isRetryableAssistantError(blocked.message)).toBe(false);

    const thought = await run(model, context([user()]), {
      responses: [
        sse([
          {
            response: {
              candidates: [
                {
                  content: { parts: [{ text: "hmm", thought: true }] },
                  finishReason: "STOP",
                },
              ],
            },
          },
        ]),
      ],
    });
    expect(thought.events).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "error",
    ]);
    expect(thought.message.errorMessage).toContain("503:");
    expect(isRetryableAssistantError(thought.message)).toBe(true);

    const empty = await run(model, context([user()]), {
      responses: [
        sse([
          {
            response: {
              candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
            },
          },
        ]),
      ],
    });
    expect(empty.events).toEqual(["error"]);
    expect(empty.message.errorMessage).toContain("503:");
    expect(isRetryableAssistantError(empty.message)).toBe(true);
  });

  it("限额可以重试，内容拦截和取消不能换入口", async () => {
    const model = test_model("gemini-3.1-pro");
    const limited = await run(model, context([user()]), {
      responses: [
        json_response({ error: { code: 429, message: "slow down" } }, 429),
        json_response({ error: { code: 429, message: "slow down" } }, 429),
      ],
    });
    expect(limited.captures.map((capture) => capture.url)).toEqual([
      `${BASE_URL}/v1internal:streamGenerateContent?alt=sse`,
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    ]);
    expect(limited.message.errorMessage).toContain("429");
    expect(isRetryableAssistantError(limited.message)).toBe(true);

    const blocked = await run(model, context([user()]), {
      responses: [
        sse([
          {
            response: {
              promptFeedback: {
                blockReason: "SAFETY",
                blockReasonMessage: "Blocked by policy",
              },
            },
          },
        ]),
      ],
    });
    expect(blocked.captures).toHaveLength(1);
    expect(blocked.message.errorMessage).toBe("Blocked by policy");
    expect(isRetryableAssistantError(blocked.message)).toBe(false);

    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const aborted = stream_antigravity_agent(model, context([user()]), {
      apiKey: "token",
      project_id: "project",
      signal: controller.signal,
      fetch: async () => {
        calls += 1;
        throw Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        });
      },
    });
    const aborted_message = await aborted.result();
    expect(calls).toBe(1);
    expect(aborted_message.stopReason).toBe("aborted");
    expect(aborted_message.errorMessage).toBe("Request was aborted");

    const missing = await stream_antigravity_agent(model, context([user()]), {
      apiKey: "token",
    }).result();
    expect(missing.stopReason).toBe("error");
    expect(missing.errorMessage).toBe("Account sign-in is required.");
    expect(isRetryableAssistantError(missing)).toBe(false);
  });

  it("同一条用户文本保持会话号，最近一次响应 id 才进入下一次请求", async () => {
    const model = test_model("gemini-3.1-pro");
    const first = await run(model, context([user("same")]));
    const second = await run(model, context([user("same")]));
    const first_request = request_of(first.captures[0]);
    const second_request = request_of(second.captures[0]);
    expect(first_request["sessionId"]).toBe(second_request["sessionId"]);
    expect(labels_of(first_request)["trajectory_id"]).toBe(
      labels_of(second_request)["trajectory_id"],
    );

    const followed = await run(
      model,
      context([
        user("same"),
        assistant(model, [{ type: "text", text: "old" }], {
          responseId: "exec-old",
        }),
        tool_result("missing", "ignored"),
        assistant(model, [{ type: "text", text: "new" }]),
      ]),
    );
    expect(labels_of(request_of(followed.captures[0]))).not.toHaveProperty("last_execution_id");
    expect(labels_of(request_of(followed.captures[0]))["last_step_index"]).toBe("3");

    const linked = await run(
      model,
      context([
        user("same"),
        assistant(model, [{ type: "text", text: "new" }], {
          responseId: "exec-new",
        }),
      ]),
    );
    expect(labels_of(request_of(linked.captures[0]))["last_execution_id"]).toBe("exec-new");
  });
});

function test_model(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...overrides,
  };
}

function context(
  messages: Message[],
  tools: readonly (typeof lookup)[] = [lookup],
): TranscriptContext {
  return normalizeContext({
    systemPrompt: "rules",
    ...(tools.length === 0 ? {} : { tools: [...tools] }),
    messages,
  });
}

function user(text = "hello"): Message {
  return { role: "user", content: text, timestamp: 1 };
}

function assistant(
  model: Model<Api>,
  content: AssistantMessage["content"],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
    ...extra,
  };
}

function tool_result(
  tool_call_id: string,
  text: string,
  options: { error?: boolean; image?: boolean } = {},
): Message {
  return {
    role: "toolResult",
    toolCallId: tool_call_id,
    toolName: "lookup",
    content: [
      ...(text === "" ? [] : [{ type: "text" as const, text }]),
      ...(options.image === true
        ? [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }]
        : []),
    ],
    isError: options.error === true,
    timestamp: 3,
  };
}

interface Capture {
  url: string;
  headers: Headers;
  body: JsonRecord;
}

async function run(
  model: Model<Api>,
  transcript: TranscriptContext,
  options: {
    reasoning?: "low" | "high" | "xhigh";
    maxTokens?: number;
    temperature?: number;
    top_p?: number;
    toolChoice?: "auto" | "none";
    headers?: Record<string, string>;
    extra_body?: JsonRecord;
    responses?: Response[];
  } = {},
): Promise<{
  message: AssistantMessage;
  events: AssistantMessageEvent["type"][];
  captures: Capture[];
}> {
  const captures: Capture[] = [];
  const responses = options.responses ?? [
    sse([
      {
        response: {
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        },
      },
    ]),
  ];
  let index = 0;
  const stream = stream_antigravity_agent(model, transcript, {
    apiKey: "token",
    project_id: "project",
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.top_p === undefined ? {} : { top_p: options.top_p }),
    ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.extra_body === undefined ? {} : { extra_body: options.extra_body }),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      captures.push({
        url: request.url,
        headers: request.headers,
        body: (await request.json()) as JsonRecord,
      });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (response === undefined) throw new Error("缺少测试响应");
      return response.clone();
    },
  });
  const events: AssistantMessageEvent["type"][] = [];
  for await (const event of stream) events.push(event.type);
  return { message: await stream.result(), events, captures };
}

function sse(events: readonly unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chunked(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function json_response(body: JsonRecord, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function request_of(capture: Capture | undefined): JsonRecord {
  const request = capture?.body["request"];
  if (!is_json_record(request)) throw new Error("缺少 Antigravity request");
  return request;
}

function generation_of(request: JsonRecord): JsonRecord {
  const generation = request["generationConfig"];
  if (!is_json_record(generation)) throw new Error("缺少 generationConfig");
  return generation;
}

function labels_of(request: JsonRecord): JsonRecord {
  const labels = request["labels"];
  if (!is_json_record(labels)) throw new Error("缺少 labels");
  return labels;
}

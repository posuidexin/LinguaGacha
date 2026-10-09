/*
 * Cloud Code Assist / Antigravity protocol adapted from oh-my-pi (MIT License).
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 * https://github.com/can1357/oh-my-pi
 *
 * 个人使用。通过 Antigravity 的 Cloud Code Assist 接口调用模型违反该服务条款，有封号风险。
 */
import { createHash, randomUUID } from "node:crypto";
import { ANTIGRAVITY_CLOUD_CODE_ENDPOINTS, type ModelThinkingLevel } from "../../domain/model";
import { is_json_record, type JsonRecord } from "../../domain/json";
import { create_provider_error, read_provider_response_error } from "../network/provider-error";
import type { LLMMessage } from "./llm-types";

const FREE_TIER_ID = "free-tier";
const ONBOARD_TIMEOUT_MS = 30_000;
const ONBOARD_POLL_INTERVAL_MS = 1_000;
const LOAD_METADATA = Object.freeze({ ideType: "ANTIGRAVITY" });
const DEFAULT_ANTIGRAVITY_VERSION = "2.19.1";
const DEFAULT_ANTIGRAVITY_CL = "963137146";
const CLAUDE_MAX_OUTPUT_TOKENS = 64_000;
const GEMINI_MAX_OUTPUT_TOKENS = 65_536;
const INT63_MASK = (1n << 63n) - 1n;
// 上游发现客户端会跳过这些内部或已下线的 id。
const DISCOVERY_DENYLIST = new Set(["chat_20706", "chat_23310", "gemini-2.5-pro"]);
const THINKING_LEVELS = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  XHIGH: "HIGH",
  MAX: "HIGH",
} as const;

export interface AntigravityCompletion {
  response_think: string;
  response_result: string;
  input_tokens: number;
  reasoning_tokens: number;
  output_tokens: number;
  finish: "stop" | "length" | "tool";
}

/** 版本只影响模型门禁；环境变量可覆盖，避免每次请求访问更新清单。 */
export function get_antigravity_user_agent(): string {
  const version = process.env["PI_AI_ANTIGRAVITY_VERSION"] || DEFAULT_ANTIGRAVITY_VERSION;
  const cl = process.env["PI_AI_ANTIGRAVITY_CL"] || DEFAULT_ANTIGRAVITY_CL;
  const os = process.env["PI_AI_ANTIGRAVITY_OS"] || "darwin";
  const arch = process.env["PI_AI_ANTIGRAVITY_ARCH"] || "arm64";
  return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

/** 登录后解析 Cloud Code 项目；没有当前套餐时先开通免费档。 */
export async function discover_antigravity_project(
  access_token: string,
  signal: AbortSignal,
): Promise<string> {
  const initial = await load_code_assist(access_token, signal);
  assert_free_tier_eligible(initial);
  if (!has_tier(initial, "currentTier")) await onboard_user(access_token, signal);
  const refreshed = await load_code_assist(access_token, signal);
  const project_id = read_project_id(refreshed);
  if (project_id === undefined)
    throw create_provider_error(
      "loadCodeAssist did not return a cloudaicompanionProject",
      undefined,
      { retryable: false },
    );
  return project_id;
}

/** 账户目录来自 `fetchAvailableModels`，内部条目不进入模型选择器。 */
export async function list_antigravity_models(options: {
  access_token: string;
  base_url: string;
  signal?: AbortSignal;
}): Promise<Array<{ id: string; name: string }>> {
  const payload = await request_json(
    options.base_url,
    "/v1internal:fetchAvailableModels",
    {},
    options.access_token,
    options.signal,
  );
  const models = is_json_record(payload["models"]) ? payload["models"] : {};
  const entries = Object.entries(models).flatMap(([id, value]) => {
    if (DISCOVERY_DENYLIST.has(id) || !is_json_record(value) || value["isInternal"] === true)
      return [];
    const name =
      typeof value["displayName"] === "string" && value["displayName"] !== ""
        ? value["displayName"]
        : id;
    return [{ id, name }];
  });
  entries.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  return entries;
}

/** 单轮文本翻译。不发送工具；响应里的函数调用由调用方拒绝。 */
export async function request_antigravity_text(options: {
  access_token: string;
  project_id: string;
  model_id: string;
  base_url: string;
  messages: readonly LLMMessage[];
  output_token_limit: number;
  thinking_level: ModelThinkingLevel;
  temperature: number | null;
  top_p: number | null;
  signal: AbortSignal;
}): Promise<AntigravityCompletion> {
  if (options.model_id.trim() === "")
    throw create_provider_error("Antigravity model id is required", undefined, {
      retryable: false,
    });
  if (options.project_id.trim() === "")
    throw create_provider_error("Antigravity project is not ready", undefined, {
      retryable: false,
    });
  const events = await request_sse(
    options.base_url,
    "/v1internal:streamGenerateContent?alt=sse",
    build_translation_request(options),
    options.access_token,
    options.signal,
  );
  return read_completion(events);
}

function antigravity_headers(access_token: string, accept_sse: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${access_token}`,
    "Content-Type": "application/json",
    "User-Agent": get_antigravity_user_agent(),
    ...(accept_sse ? { Accept: "text/event-stream" } : {}),
  };
}

async function load_code_assist(access_token: string, signal: AbortSignal): Promise<JsonRecord> {
  const endpoint = ANTIGRAVITY_CLOUD_CODE_ENDPOINTS[0];
  let payload = await request_json_url(
    `${endpoint}/v1internal:loadCodeAssist`,
    { metadata: LOAD_METADATA },
    access_token,
    signal,
  );
  const project_id = read_project_id(payload);
  if (!has_tier(payload, "paidTier") && project_id !== undefined) {
    payload = await request_json_url(
      `${endpoint}/v1internal:loadCodeAssist`,
      { cloudaicompanionProject: project_id, metadata: LOAD_METADATA },
      access_token,
      signal,
    );
  }
  return payload;
}

async function onboard_user(access_token: string, signal: AbortSignal): Promise<void> {
  const endpoint = ANTIGRAVITY_CLOUD_CODE_ENDPOINTS[0];
  const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
  let operation = await request_json_url(
    `${endpoint}/v1internal:onboardUser`,
    { tierId: FREE_TIER_ID, metadata: LOAD_METADATA },
    access_token,
    signal,
    remaining_onboard_time(deadline),
  );
  while (operation["done"] !== true) {
    const name = operation["name"];
    if (typeof name !== "string" || name === "")
      throw create_provider_error("onboardUser returned an operation without a name", undefined, {
        retryable: false,
      });
    await delay(Math.min(ONBOARD_POLL_INTERVAL_MS, remaining_onboard_time(deadline)), signal);
    operation = await request_json_url(
      `${endpoint}/v1internal/${name}`,
      undefined,
      access_token,
      signal,
      remaining_onboard_time(deadline),
      "GET",
    );
  }
  const error = operation["error"];
  if (is_json_record(error)) {
    const message = typeof error["message"] === "string" ? error["message"] : "OnboardUser failed";
    throw create_provider_error(message, undefined, { retryable: false });
  }
  if (!is_json_record(operation["response"]))
    throw create_provider_error("failed to read OnboardUserResponse", undefined, {
      retryable: false,
    });
}

function remaining_onboard_time(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining > 0) return remaining;
  throw create_provider_error(`onboardUser timed out after ${ONBOARD_TIMEOUT_MS}ms`, undefined, {
    retryable: false,
  });
}

function assert_free_tier_eligible(payload: JsonRecord): void {
  const allowed = payload["allowedTiers"];
  if (
    Array.isArray(allowed) &&
    allowed.some((tier) => is_json_record(tier) && tier["id"] === FREE_TIER_ID)
  )
    return;
  const blocked = read_free_tier_block(payload);
  if (blocked !== null) throw create_provider_error(blocked, undefined, { retryable: false });
}

function read_free_tier_block(payload: JsonRecord): string | null {
  const tiers = payload["ineligibleTiers"];
  if (!Array.isArray(tiers)) return null;
  for (const tier of tiers) {
    if (!is_json_record(tier) || tier["tierId"] !== FREE_TIER_ID) continue;
    if (typeof tier["reasonMessage"] !== "string" || tier["reasonMessage"] === "") continue;
    const url =
      typeof tier["validationUrl"] === "string" && tier["validationUrl"] !== ""
        ? `\n${tier["validationUrl"]}`
        : "";
    return `${tier["reasonMessage"]}${url}`;
  }
  return null;
}

function has_tier(payload: JsonRecord, field: "currentTier" | "paidTier"): boolean {
  const value = payload[field];
  return value !== undefined && value !== null;
}

function read_project_id(payload: JsonRecord): string | undefined {
  const project_id = payload["cloudaicompanionProject"];
  return typeof project_id === "string" && project_id !== "" ? project_id : undefined;
}

function build_translation_request(options: {
  project_id: string;
  model_id: string;
  messages: readonly LLMMessage[];
  output_token_limit: number;
  thinking_level: ModelThinkingLevel;
  temperature: number | null;
  top_p: number | null;
}): JsonRecord {
  const system = options.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .filter((content) => content.trim() !== "")
    .join("\n\n");
  const user = options.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .filter((content) => content.trim() !== "")
    .join("\n\n");
  if (user === "")
    throw create_provider_error("Antigravity translation requires user text", undefined, {
      retryable: false,
    });
  const is_claude = options.model_id.startsWith("claude");
  const generation_config: JsonRecord = {};
  if (options.temperature !== null) generation_config["temperature"] = options.temperature;
  if (options.top_p !== null) generation_config["topP"] = options.top_p;
  if (options.output_token_limit > 0) {
    const cap = is_claude ? CLAUDE_MAX_OUTPUT_TOKENS : GEMINI_MAX_OUTPUT_TOKENS;
    generation_config["maxOutputTokens"] = Math.min(
      cap,
      Math.max(1, Math.trunc(options.output_token_limit)),
    );
  }
  const thinking = THINKING_LEVELS[options.thinking_level as keyof typeof THINKING_LEVELS];
  if (!is_claude && thinking !== undefined)
    generation_config["thinkingConfig"] = { includeThoughts: true, thinkingLevel: thinking };
  const trajectory_id = randomUUID();
  const request: JsonRecord = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    sessionId: derive_session_id(user),
    labels: {
      last_step_index: "1",
      trajectory_id,
      used_claude: String(is_claude),
      used_claude_conservative: String(is_claude),
    },
  };
  if (system !== "") request["systemInstruction"] = { role: "user", parts: [{ text: system }] };
  if (Object.keys(generation_config).length > 0) request["generationConfig"] = generation_config;
  return {
    project: options.project_id,
    requestId: `agent/${randomUUID()}/${Date.now()}/${trajectory_id}/2`,
    request,
    model: options.model_id,
    userAgent: "antigravity",
    requestType: "agent",
  };
}

/** 会话号沿用客户端的负十进制形式，避免空会话被控制面拒绝。 */
function derive_session_id(text: string): string {
  const digest = createHash("sha256").update(text).digest();
  let value = 0n;
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(digest[index] ?? 0);
  return `-${(value & INT63_MASK).toString()}`;
}

function read_completion(events: readonly unknown[]): AntigravityCompletion {
  let response_result = "";
  let response_think = "";
  let saw_tool = false;
  let finish: AntigravityCompletion["finish"] = "stop";
  let input_tokens = 0;
  let reasoning_tokens = 0;
  let output_tokens = 0;
  for (const event of events) {
    if (!is_json_record(event)) continue;
    if (is_json_record(event["error"])) {
      const error = event["error"];
      const status = typeof error["code"] === "number" ? error["code"] : undefined;
      throw create_provider_error(error, status, {
        retryable: status === 429 || (status !== undefined && status >= 500),
      });
    }
    const response = is_json_record(event["response"]) ? event["response"] : event;
    const feedback = is_json_record(response["promptFeedback"]) ? response["promptFeedback"] : null;
    const candidates = Array.isArray(response["candidates"]) ? response["candidates"] : undefined;
    if (feedback?.["blockReason"] !== undefined && candidates === undefined)
      throw create_provider_error(
        typeof feedback["blockReasonMessage"] === "string"
          ? feedback["blockReasonMessage"]
          : `Blocked: ${String(feedback["blockReason"])}`,
        undefined,
        { retryable: false },
      );
    const candidate = candidates?.[0];
    if (is_json_record(candidate)) {
      const content = is_json_record(candidate["content"]) ? candidate["content"] : {};
      const parts = Array.isArray(content["parts"]) ? content["parts"] : [];
      for (const part of parts) {
        if (!is_json_record(part)) continue;
        if (is_json_record(part["functionCall"])) saw_tool = true;
        if (typeof part["text"] !== "string") continue;
        if (part["thought"] === true) response_think += part["text"];
        else response_result += part["text"];
      }
      if (candidate["finishReason"] === "MAX_TOKENS") finish = "length";
    }
    const usage = is_json_record(response["usageMetadata"]) ? response["usageMetadata"] : null;
    if (usage !== null) {
      const candidate_tokens = read_count(usage["candidatesTokenCount"]);
      const thoughts = read_count(usage["thoughtsTokenCount"]);
      reasoning_tokens = Math.min(candidate_tokens, thoughts);
      output_tokens = candidate_tokens - reasoning_tokens;
      input_tokens =
        read_count(usage["promptTokenCount"]) + read_count(usage["cachedContentTokenCount"]);
    }
  }
  if (saw_tool) finish = "tool";
  if (!saw_tool && response_result.trim() === "")
    throw create_provider_error("Cloud Code Assist returned an empty response", undefined, {
      retryable: true,
    });
  return {
    response_think: response_think.trim(),
    response_result: saw_tool ? "" : response_result.trim(),
    input_tokens,
    reasoning_tokens,
    output_tokens,
    finish,
  };
}

function read_count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

async function request_json(
  base_url: string,
  path: string,
  body: JsonRecord,
  access_token: string,
  signal: AbortSignal | undefined,
): Promise<JsonRecord> {
  return request_with_fallback(base_url, path, body, access_token, signal, false);
}

async function request_sse(
  base_url: string,
  path: string,
  body: JsonRecord,
  access_token: string,
  signal: AbortSignal,
): Promise<unknown[]> {
  return request_with_fallback(base_url, path, body, access_token, signal, true);
}

async function request_with_fallback(
  base_url: string,
  path: string,
  body: JsonRecord,
  access_token: string,
  signal: AbortSignal | undefined,
  sse: false,
): Promise<JsonRecord>;
async function request_with_fallback(
  base_url: string,
  path: string,
  body: JsonRecord,
  access_token: string,
  signal: AbortSignal | undefined,
  sse: true,
): Promise<unknown[]>;
async function request_with_fallback(
  base_url: string,
  path: string,
  body: JsonRecord,
  access_token: string,
  signal: AbortSignal | undefined,
  sse: boolean,
): Promise<JsonRecord | unknown[]> {
  const endpoints = endpoint_order(base_url);
  let last_error: unknown;
  for (const [index, endpoint] of endpoints.entries()) {
    try {
      return sse
        ? await request_url(
            `${endpoint}${path}`,
            body,
            access_token,
            signal,
            undefined,
            "POST",
            true,
          )
        : await request_url(
            `${endpoint}${path}`,
            body,
            access_token,
            signal,
            undefined,
            "POST",
            false,
          );
    } catch (error) {
      last_error = error;
      const status = read_status(error);
      const transient = status === undefined || status === 429 || status >= 500;
      if (!transient || index === endpoints.length - 1) throw error;
    }
  }
  throw last_error;
}

function endpoint_order(base_url: string): readonly string[] {
  const primary = base_url.replace(/\/+$/u, "");
  const alternate = ANTIGRAVITY_CLOUD_CODE_ENDPOINTS.find((endpoint) => endpoint !== primary);
  return alternate === undefined ? [primary] : [primary, alternate];
}

async function request_json_url(
  url: string,
  body: JsonRecord | undefined,
  access_token: string,
  signal: AbortSignal | undefined,
  timeout_ms?: number,
  method: "GET" | "POST" = "POST",
): Promise<JsonRecord> {
  return request_url(url, body, access_token, signal, timeout_ms, method, false);
}

async function request_url(
  url: string,
  body: JsonRecord | undefined,
  access_token: string,
  signal: AbortSignal | undefined,
  timeout_ms: number | undefined,
  method: "GET" | "POST",
  sse: false,
): Promise<JsonRecord>;
async function request_url(
  url: string,
  body: JsonRecord | undefined,
  access_token: string,
  signal: AbortSignal | undefined,
  timeout_ms: number | undefined,
  method: "GET" | "POST",
  sse: true,
): Promise<unknown[]>;
async function request_url(
  url: string,
  body: JsonRecord | undefined,
  access_token: string,
  signal: AbortSignal | undefined,
  timeout_ms: number | undefined,
  method: "GET" | "POST",
  sse: boolean,
): Promise<JsonRecord | unknown[]> {
  signal?.throwIfAborted();
  const request: RequestInit = {
    method,
    headers: antigravity_headers(access_token, sse),
    redirect: "error",
  };
  if (body !== undefined) request.body = JSON.stringify(body);
  const deadline = combine_signals(signal, timeout_ms);
  if (deadline !== undefined) request.signal = deadline;
  const response = await fetch(url, request);
  if (!response.ok)
    throw await read_provider_response_error(response, {
      retryable: response.status === 429 || response.status >= 500,
    });
  if (sse) return read_sse_events(await response.text());
  const data: unknown = await response.json();
  if (!is_json_record(data))
    throw create_provider_error("Invalid Cloud Code Assist response", undefined, {
      retryable: false,
    });
  return data;
}

function read_sse_events(body: string): unknown[] {
  const trimmed = body.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const events: unknown[] = [];
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") continue;
    events.push(JSON.parse(data) as unknown);
  }
  return events;
}

function combine_signals(signal?: AbortSignal, timeout_ms?: number): AbortSignal | undefined {
  const timeout = timeout_ms === undefined ? undefined : AbortSignal.timeout(timeout_ms);
  if (signal === undefined) return timeout;
  if (timeout === undefined) return signal;
  return AbortSignal.any([signal, timeout]);
}

function read_status(error: unknown): number | undefined {
  if (!(error instanceof Error) || !("diagnostic_context" in error)) return undefined;
  const status = (error as { diagnostic_context?: { status?: unknown } }).diagnostic_context?.[
    "status"
  ];
  return typeof status === "number" ? status : undefined;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", on_abort);
      resolve();
    }, ms);
    const on_abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    if (signal.aborted) on_abort();
    else signal.addEventListener("abort", on_abort, { once: true });
  });
}

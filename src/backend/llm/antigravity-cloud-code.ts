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
export const CLAUDE_MAX_OUTPUT_TOKENS = 64_000;
export const GEMINI_MAX_OUTPUT_TOKENS = 65_536;
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
// Cloud Code Assist 的 Claude 走 Gemini 信封，预算沿用这条传输的档位，不用 Anthropic Messages 的预算表。
const CLAUDE_THINKING_BUDGETS = {
  minimal: 1_024,
  low: 4_096,
  medium: 8_192,
  high: 16_384,
  xhigh: 24_575,
  max: 32_768,
} as const;
const PRO_31_LOW_MODEL = "gemini-3.1-pro-low";
const PRO_31_HIGH_MODEL = "gemini-pro-agent";
const PRO_31_LOW_BUDGET = 1_001;
const PRO_31_HIGH_BUDGET = 10_001;
// 捕获自 antigravity/hub。model_enum 是 labels 里的遥测；maxOutputTokens 超过档位会被 400。
// gemini-3.1-pro-high 不在表里：该部署对 streamGenerateContent 一律返回 invalid argument。
const WIRE_PROFILES: Readonly<Record<string, { max_output_tokens: number; model_enum?: string }>> =
  {
    [PRO_31_LOW_MODEL]: {
      max_output_tokens: 65_535,
      model_enum: "MODEL_PLACEHOLDER_M36",
    },
    [PRO_31_HIGH_MODEL]: {
      max_output_tokens: 65_535,
      model_enum: "MODEL_PLACEHOLDER_M16",
    },
    "claude-sonnet-4-6": { max_output_tokens: CLAUDE_MAX_OUTPUT_TOKENS },
    "claude-opus-4-6-thinking": { max_output_tokens: CLAUDE_MAX_OUTPUT_TOKENS },
  };
const RESERVED_REQUEST_HEADERS = new Set([
  "authorization",
  "host",
  "user-agent",
  "content-type",
  "accept",
]);
// 这些字段决定路由和这一次的请求体，用户扩展不能把它改回会 400 的模型名。
const ENVELOPE_OWNED_FIELDS = new Set([
  "project",
  "requestId",
  "request",
  "model",
  "userAgent",
  "requestType",
]);

export const ANTIGRAVITY_CLAUDE_THINKING_BETA = "interleaved-thinking-2025-05-14";
export type AntigravityEffort = "off" | keyof typeof CLAUDE_THINKING_BUDGETS;

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
  headers?: Readonly<Record<string, string>>;
  extra_body?: Readonly<JsonRecord>;
}): Promise<AntigravityCompletion> {
  if (options.model_id.trim() === "")
    throw create_provider_error("Antigravity model id is required", undefined, {
      retryable: false,
    });
  if (options.project_id.trim() === "")
    throw create_provider_error("Antigravity project is not ready", undefined, {
      retryable: false,
    });
  const effort = antigravity_effort_from_product(options.thinking_level);
  const headers = sanitize_antigravity_headers(options.headers);
  if (is_antigravity_claude_model(options.model_id) && effort !== "off")
    headers["anthropic-beta"] = ANTIGRAVITY_CLAUDE_THINKING_BETA;
  const events = await request_sse(
    options.base_url,
    build_translation_request(options, effort),
    options.access_token,
    options.signal,
    headers,
  );
  return read_completion(events);
}

export function is_antigravity_claude_model(model_id: string): boolean {
  return model_id.split(/[/:]/u).some((part) => part.toLowerCase().startsWith("claude"));
}

export function is_antigravity_gemini_31_pro(model_id: string): boolean {
  const id = model_id.trim().toLowerCase();
  return (
    id === "gemini-3.1-pro" ||
    id === PRO_31_LOW_MODEL ||
    id === "gemini-3.1-pro-high" ||
    id === PRO_31_HIGH_MODEL
  );
}

/** 高档改写到仍接受同一请求体的 gemini-pro-agent；关和低档留在 gemini-3.1-pro-low。 */
export function resolve_antigravity_request_model(
  model_id: string,
  effort: AntigravityEffort,
): string {
  if (!is_antigravity_gemini_31_pro(model_id)) return model_id;
  return effort === "high" || effort === "xhigh" || effort === "max"
    ? PRO_31_HIGH_MODEL
    : PRO_31_LOW_MODEL;
}

export function antigravity_wire_profile(
  request_model_id: string,
): { max_output_tokens: number; model_enum?: string } | undefined {
  return WIRE_PROFILES[request_model_id];
}

export function antigravity_effort_from_product(level: ModelThinkingLevel): AntigravityEffort {
  if (level === "LOW") return "low";
  if (level === "MEDIUM") return "medium";
  if (level === "HIGH") return "high";
  if (level === "XHIGH") return "xhigh";
  if (level === "MAX") return "max";
  return "off";
}

export function antigravity_claude_thinking(effort: AntigravityEffort): JsonRecord | undefined {
  if (effort === "off") return undefined;
  return {
    includeThoughts: true,
    thinkingBudget: CLAUDE_THINKING_BUDGETS[effort],
  };
}

/**
 * 3.1 Pro 只用 thinkingBudget。省略配置会回到 SKU 自带档位；
 * 预算 0 会被拒绝（只允许思考模式），关和默认改为最低预算且不回传思考。
 */
export function antigravity_pro_31_thinking(effort: AntigravityEffort): JsonRecord {
  const high = effort === "high" || effort === "xhigh" || effort === "max";
  return {
    includeThoughts: effort !== "off",
    thinkingBudget: high ? PRO_31_HIGH_BUDGET : PRO_31_LOW_BUDGET,
  };
}

/** 用户头不能改写认证、主机、内容类型和客户端标识。 */
export function sanitize_antigravity_headers(
  headers: Readonly<Record<string, string | null | undefined>> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === null || value === undefined || RESERVED_REQUEST_HEADERS.has(key.toLowerCase()))
      continue;
    result[key] = value;
  }
  return result;
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

function build_translation_request(
  options: {
    project_id: string;
    model_id: string;
    messages: readonly LLMMessage[];
    output_token_limit: number;
    thinking_level: ModelThinkingLevel;
    temperature: number | null;
    top_p: number | null;
    extra_body?: Readonly<JsonRecord>;
  },
  effort: AntigravityEffort,
): JsonRecord {
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
  const is_claude = is_antigravity_claude_model(options.model_id);
  const request_model = resolve_antigravity_request_model(options.model_id, effort);
  const profile = antigravity_wire_profile(request_model);
  const generation_config: JsonRecord = {};
  if (options.temperature !== null) generation_config["temperature"] = options.temperature;
  if (options.top_p !== null) generation_config["topP"] = options.top_p;
  if (profile !== undefined) generation_config["maxOutputTokens"] = profile.max_output_tokens;
  else if (options.output_token_limit > 0) {
    const cap = is_claude ? CLAUDE_MAX_OUTPUT_TOKENS : GEMINI_MAX_OUTPUT_TOKENS;
    generation_config["maxOutputTokens"] = Math.min(
      cap,
      Math.max(1, Math.trunc(options.output_token_limit)),
    );
  }
  const thinking = translation_thinking(options.model_id, effort);
  if (thinking !== undefined) generation_config["thinkingConfig"] = thinking;
  const trajectory_id = randomUUID();
  const labels: JsonRecord = {
    last_step_index: "1",
    trajectory_id,
    used_claude: String(is_claude),
    used_claude_conservative: String(is_claude),
  };
  if (profile?.model_enum !== undefined) labels["model_enum"] = profile.model_enum;
  const request: JsonRecord = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    sessionId: derive_antigravity_session_id(user),
    labels,
  };
  if (system !== "") request["systemInstruction"] = { role: "user", parts: [{ text: system }] };
  if (Object.keys(generation_config).length > 0) request["generationConfig"] = generation_config;
  return apply_antigravity_extra_body(
    {
      project: options.project_id,
      requestId: `agent/${randomUUID()}/${Date.now()}/${trajectory_id}/2`,
      request,
      model: request_model,
      userAgent: "antigravity",
      requestType: "agent",
    },
    options.extra_body,
  );
}

export function apply_antigravity_extra_body(
  envelope: JsonRecord,
  extra_body: Readonly<JsonRecord> | undefined,
): JsonRecord {
  if (extra_body === undefined) return envelope;
  const additions: JsonRecord = {};
  for (const [key, value] of Object.entries(extra_body)) {
    if (ENVELOPE_OWNED_FIELDS.has(key)) continue;
    additions[key] = value;
  }
  return { ...envelope, ...additions };
}

function translation_thinking(model_id: string, effort: AntigravityEffort): JsonRecord | undefined {
  if (is_antigravity_claude_model(model_id)) return antigravity_claude_thinking(effort);
  if (is_antigravity_gemini_31_pro(model_id)) return antigravity_pro_31_thinking(effort);
  if (effort === "off") return undefined;
  const level = THINKING_LEVELS[effort.toUpperCase() as keyof typeof THINKING_LEVELS];
  return level === undefined ? undefined : { includeThoughts: true, thinkingLevel: level };
}

/** 会话号沿用客户端的负十进制形式，避免空会话被控制面拒绝。 */
export function derive_antigravity_session_id(text: string): string {
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
      // candidatesTokenCount 不含思考。思考多于正文时不能从 candidates 里扣。
      reasoning_tokens = thoughts;
      output_tokens = candidate_tokens;
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
  return request_with_fallback(base_url, path, body, access_token, signal);
}

const GENERATE_PATH = "/v1internal:streamGenerateContent?alt=sse";

/** 生成流在读到正文前可以换备用入口；调用方负责消费 body。 */
export async function open_antigravity_generate_stream(options: {
  base_url: string;
  body: JsonRecord;
  access_token: string;
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
}): Promise<Response> {
  const endpoints = endpoint_order(options.base_url);
  const request_fetch = options.fetch ?? fetch;
  let last_error: unknown;
  for (const [index, endpoint] of endpoints.entries()) {
    try {
      const request: RequestInit = {
        method: "POST",
        headers: {
          ...antigravity_headers(options.access_token, true),
          ...sanitize_antigravity_headers(options.headers),
          Authorization: `Bearer ${options.access_token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "User-Agent": get_antigravity_user_agent(),
        },
        body: JSON.stringify(options.body),
        redirect: "error",
      };
      if (options.signal !== undefined) request.signal = options.signal;
      const response = await request_fetch(`${endpoint}${GENERATE_PATH}`, request);
      if (!response.ok)
        throw await read_provider_response_error(response, {
          retryable: response.status === 429 || response.status >= 500,
        });
      return response;
    } catch (error) {
      if (is_abort_error(error) || options.signal?.aborted === true) throw error;
      last_error = error;
      if (!can_failover(error, index, endpoints.length)) throw error;
    }
  }
  throw_last(last_error);
}

async function request_sse(
  base_url: string,
  body: JsonRecord,
  access_token: string,
  signal: AbortSignal,
  headers: Readonly<Record<string, string>>,
): Promise<unknown[]> {
  const response = await open_antigravity_generate_stream({
    base_url,
    body,
    access_token,
    signal,
    headers,
  });
  return read_sse_events(await response.text());
}

function can_failover(error: unknown, index: number, count: number): boolean {
  if (index >= count - 1) return false;
  const status = read_status(error);
  return status === undefined || status === 429 || status >= 500;
}

function is_abort_error(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function request_with_fallback(
  base_url: string,
  path: string,
  body: JsonRecord,
  access_token: string,
  signal: AbortSignal | undefined,
): Promise<JsonRecord> {
  const endpoints = endpoint_order(base_url);
  let last_error: unknown;
  for (const [index, endpoint] of endpoints.entries()) {
    try {
      return await request_url(`${endpoint}${path}`, body, access_token, signal, undefined, "POST");
    } catch (error) {
      last_error = error;
      if (!can_failover(error, index, endpoints.length)) throw error;
    }
  }
  throw_last(last_error);
}

function throw_last(error: unknown): never {
  if (error !== undefined) throw error;
  throw create_provider_error("Cloud Code Assist request failed", undefined, {
    retryable: true,
  });
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
  return request_url(url, body, access_token, signal, timeout_ms, method);
}

async function request_url(
  url: string,
  body: JsonRecord | undefined,
  access_token: string,
  signal: AbortSignal | undefined,
  timeout_ms: number | undefined,
  method: "GET" | "POST",
): Promise<JsonRecord> {
  signal?.throwIfAborted();
  const request: RequestInit = {
    method,
    headers: antigravity_headers(access_token, false),
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

/*
 * Antigravity agent transport adapted from oh-my-pi (MIT License).
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 * https://github.com/can1357/oh-my-pi
 *
 * 个人使用。通过 Antigravity 的 Cloud Code Assist 接口调用模型违反该服务条款，有封号风险。
 */
import { createHash } from "node:crypto";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ThinkingLevel,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  convertTools,
  mapStopReasonString,
  supportsGoogleStrictToolSampling,
} from "@earendil-works/pi-ai/api/google-shared";

import { is_json_record, type JsonRecord, type JsonValue } from "../../domain/json";
import { AppError } from "../../shared/error";
import { create_provider_error } from "../network/provider-error";
import {
  ANTIGRAVITY_CLAUDE_THINKING_BETA,
  CLAUDE_MAX_OUTPUT_TOKENS,
  GEMINI_MAX_OUTPUT_TOKENS,
  antigravity_claude_thinking,
  antigravity_pro_31_thinking,
  antigravity_wire_profile,
  apply_antigravity_extra_body,
  derive_antigravity_session_id,
  is_antigravity_claude_model,
  is_antigravity_gemini_31_pro,
  open_antigravity_generate_stream,
  resolve_antigravity_request_model,
  sanitize_antigravity_headers,
  type AntigravityEffort,
} from "./antigravity-cloud-code";
// 只放在一轮里第一条未签名的 Gemini 3 函数调用上；已签名的并行调用不能再补。
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
const OMITTED_IMAGE_TEXT = "[image omitted: model does not support vision]";
const TOOL_IMAGE_LABEL = "Tool result image:";
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/u;
const FLASH_LOW_BUDGET = 1_000;
const FLASH_MEDIUM_BUDGET = 4_000;
const FLASH_HIGH_BUDGET = 10_000;

interface WirePart {
  text?: string;
  thought?: true;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: JsonRecord; id?: string };
  functionResponse?: {
    name: string;
    id?: string;
    response: JsonRecord;
    parts?: WirePart[];
  };
}

interface WireContent {
  role: "user" | "model";
  parts: WirePart[];
}

type OpenBlock = TextContent | ThinkingContent;

interface AntigravityStreamOptions extends SimpleStreamOptions {
  project_id?: string;
  extra_body?: Readonly<JsonRecord>;
  top_p?: number;
}

/**
 * 把 Pi 会话流成 Cloud Code Assist 的 Agent 请求。
 * 不走 Pi 的 Gemini `convertMessages`：那条路径会给 Gemini 3 补函数 id，Antigravity 只接受 Claude 带 id。
 */
export function stream_antigravity_agent(
  model: Model<Api>,
  context: TranscriptContext,
  options: AntigravityStreamOptions = {},
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  void (async () => {
    const output = create_output(model);
    let settled = false;
    const finish = (reason: "error" | "aborted", message: string): void => {
      if (settled) return;
      settled = true;
      output.stopReason = reason;
      output.errorMessage = message;
      stream.push({ type: "error", reason, error: output });
      stream.end();
    };
    try {
      const api_key = options.apiKey?.trim() ?? "";
      const project_id = options.project_id?.trim() ?? "";
      if (api_key === "" || project_id === "") throw new AppError("model.auth_required");
      const response = await open_antigravity_generate_stream({
        base_url: model.baseUrl,
        body: build_envelope(model, context, project_id, options),
        access_token: api_key,
        headers: request_headers(
          options.headers,
          claude_thinking_beta(model.id, options.reasoning),
        ),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      await consume_response(response, output, stream, options.signal);
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        finish(
          output.stopReason === "aborted" ? "aborted" : "error",
          output.errorMessage ?? "Generation failed",
        );
        return;
      }
      if (
        (output.stopReason === "stop" || output.stopReason === "length") &&
        !has_visible_output(output)
      ) {
        finish(
          "error",
          has_thinking_text(output)
            ? "503: Cloud Code Assist returned a thought-only response"
            : "503: Cloud Code Assist returned an empty response",
        );
        return;
      }
      const reason = output.stopReason;
      if (reason !== "stop" && reason !== "length" && reason !== "toolUse") {
        finish("error", output.errorMessage ?? "503: Cloud Code Assist request failed");
        return;
      }
      settled = true;
      delete output.errorMessage;
      stream.push({ type: "done", reason, message: output });
      stream.end();
    } catch (error) {
      finish(failure_reason(error, options.signal), failure_message(error, options.signal));
    }
  })();
  return stream;
}

function create_output(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: empty_usage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function empty_usage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function build_envelope(
  model: Model<Api>,
  context: TranscriptContext,
  project_id: string,
  options: AntigravityStreamOptions,
): JsonRecord {
  const messages = context.messages;
  const user_text = first_user_text(messages);
  const assistant_count = messages.filter((message) => message.role === "assistant").length;
  const step = assistant_count + 2;
  const trajectory_id = stable_uuid(user_text, "trajectory");
  const claude = is_antigravity_claude_model(model.id);
  const effort = antigravity_effort(options.reasoning);
  const request_model = resolve_antigravity_request_model(model.id, effort);
  const profile = antigravity_wire_profile(request_model);
  const labels: JsonRecord = {
    last_step_index: String(step - 1),
    trajectory_id,
    used_claude: String(claude),
    used_claude_conservative: String(claude),
  };
  if (profile?.model_enum !== undefined) labels["model_enum"] = profile.model_enum;
  const execution_id = last_execution_id(messages);
  if (execution_id !== undefined) labels["last_execution_id"] = execution_id;
  const tools = getCurrentTools(messages);
  const converted = convertTools(
    tools,
    claude,
    !claude && supportsGoogleStrictToolSampling(model.id),
  );
  const generation: JsonRecord = {
    maxOutputTokens: profile?.max_output_tokens ?? output_token_limit(model, options.maxTokens),
  };
  if (options.temperature !== undefined && Number.isFinite(options.temperature))
    generation["temperature"] = options.temperature;
  if (options.top_p !== undefined && Number.isFinite(options.top_p))
    generation["topP"] = options.top_p;
  const thinking = thinking_config(model.id, model.reasoning, effort);
  if (thinking !== undefined) generation["thinkingConfig"] = thinking;
  const system = getCurrentSystemPrompt(messages);
  const request: JsonRecord = {
    contents: to_json(convert_contents(model, messages)),
    sessionId: derive_antigravity_session_id(user_text),
    labels,
    generationConfig: generation,
  };
  if (system !== "") request["systemInstruction"] = { role: "user", parts: [{ text: system }] };
  if (converted !== undefined) request["tools"] = to_json(converted);
  const calling = tool_config(model.id, tools.length, options.toolChoice);
  if (calling !== undefined) request["toolConfig"] = calling;
  // 会话号和轨迹号由首条用户文本推导：Pi 的流选项没有可持久化的 provider 会话槽。
  return apply_antigravity_extra_body(
    to_record({
      project: project_id,
      requestId: `agent/${stable_uuid(user_text, "agent")}/${Date.now()}/${trajectory_id}/${step}`,
      request,
      model: request_model,
      userAgent: "antigravity",
      requestType: "agent",
    }),
    options.extra_body,
  );
}

function convert_contents(model: Model<Api>, messages: readonly Message[]): WireContent[] {
  const contents: WireContent[] = [];
  const names = new Map<string, string>();
  const claude = is_antigravity_claude_model(model.id);
  const major = gemini_major_version(model.id);
  const multimodal = major === undefined || major >= 3;
  const vision = model.input.includes("image");
  let pending_images: WirePart[] = [];
  const flush_images = (): void => {
    if (pending_images.length === 0) return;
    contents.push({ role: "user", parts: pending_images });
    pending_images = [];
  };
  for (const message of messages) {
    if (message.role !== "toolResult") flush_images();
    if (message.role === "system") continue;
    if (message.role === "user") {
      push_content(contents, "user", user_parts(message.content, vision));
      continue;
    }
    if (message.role === "assistant") {
      push_content(contents, "model", assistant_parts(message, model, names, claude, major));
      continue;
    }
    push_tool_result(contents, message, names, claude, multimodal, vision, pending_images);
  }
  flush_images();
  return contents;
}

function user_parts(
  content: Extract<Message, { role: "user" }>["content"],
  vision: boolean,
): WirePart[] {
  if (typeof content === "string") {
    const text = content.toWellFormed();
    return text.trim() === "" ? [] : [{ text }];
  }
  const parts: WirePart[] = [];
  let omitted = false;
  for (const item of content) {
    if (item.type === "text") {
      const text = item.text.toWellFormed();
      if (text.trim() !== "") parts.push({ text });
      continue;
    }
    if (vision) parts.push(image_part(item));
    else omitted = true;
  }
  if (omitted) parts.push({ text: OMITTED_IMAGE_TEXT });
  return parts;
}

function assistant_parts(
  message: Extract<Message, { role: "assistant" }>,
  model: Model<Api>,
  names: Map<string, string>,
  claude: boolean,
  major: number | undefined,
): WirePart[] {
  const parts: WirePart[] = [];
  const same = message.provider === model.provider && message.model === model.id;
  let first_tool_call = true;
  for (const block of message.content) {
    if (block.type === "text") {
      const signature = thought_signature(same, block.textSignature);
      const text = block.text.toWellFormed();
      if (text.trim() === "" && signature === undefined) continue;
      parts.push({
        text,
        ...(signature === undefined ? {} : { thoughtSignature: signature }),
      });
      continue;
    }
    if (block.type === "thinking") {
      const signature = thought_signature(same, block.thinkingSignature);
      const text = block.thinking.toWellFormed();
      if (text.trim() === "" && signature === undefined) continue;
      // Claude 丢掉没有签名的思考。Gemini 的未签名思考改成普通文本，避免被后端静默丢弃。
      if (signature !== undefined) parts.push({ thought: true, text, thoughtSignature: signature });
      else if (!claude && text.trim() !== "") parts.push({ text });
      continue;
    }
    names.set(block.id, block.name);
    const signature = thought_signature(same, block.thoughtSignature);
    const fallback =
      first_tool_call && major !== undefined && major >= 3 && signature === undefined;
    first_tool_call = false;
    const effective = signature ?? (fallback ? SKIP_THOUGHT_SIGNATURE : undefined);
    const part: WirePart = {
      functionCall: {
        name: block.name,
        args: json_record(block.arguments),
        ...(claude ? { id: sanitize_tool_id(block.id) } : {}),
      },
    };
    if (effective !== undefined) part.thoughtSignature = effective;
    parts.push(part);
  }
  return parts;
}

function push_tool_result(
  contents: WireContent[],
  message: Extract<Message, { role: "toolResult" }>,
  names: Map<string, string>,
  claude: boolean,
  multimodal: boolean,
  vision: boolean,
  pending_images: WirePart[],
): void {
  const text = message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .toWellFormed();
  const images = message.content.filter((part): part is ImageContent => part.type === "image");
  const omitted = !vision && images.length > 0;
  const visible_images = vision ? images.map(image_part) : [];
  const value = omitted
    ? [text, OMITTED_IMAGE_TEXT].filter((part) => part !== "").join("\n")
    : text !== ""
      ? text
      : visible_images.length > 0
        ? "(see attached image)"
        : "";
  const part: WirePart = {
    functionResponse: {
      name: names.get(message.toolCallId) ?? message.toolName,
      response: message.isError ? { error: value } : { output: value },
      ...(visible_images.length > 0 && multimodal ? { parts: visible_images } : {}),
      ...(claude ? { id: sanitize_tool_id(message.toolCallId) } : {}),
    },
  };
  const last = contents.at(-1);
  if (last?.role === "user" && last.parts.some((item) => item.functionResponse !== undefined))
    last.parts.push(part);
  else contents.push({ role: "user", parts: [part] });
  // Gemini 3 以下不能把图片嵌进 functionResponse，合并完函数结果后再另起一轮。
  if (visible_images.length > 0 && !multimodal)
    pending_images.push({ text: TOOL_IMAGE_LABEL }, ...visible_images);
}

function push_content(contents: WireContent[], role: WireContent["role"], parts: WirePart[]): void {
  if (parts.length === 0) return;
  contents.push({ role, parts });
}

function image_part(image: ImageContent): WirePart {
  return { inlineData: { mimeType: image.mimeType, data: image.data } };
}

function tool_config(
  model_id: string,
  tool_count: number,
  tool_choice: SimpleStreamOptions["toolChoice"],
): JsonRecord | undefined {
  // Claude 即使没有工具也强制 VALIDATED，并覆盖本次的 toolChoice。
  if (is_antigravity_claude_model(model_id))
    return { functionCallingConfig: { mode: "VALIDATED" } };
  if (tool_count === 0) return undefined;
  if (tool_choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  return { functionCallingConfig: { mode: "VALIDATED" } };
}

function thinking_config(
  model_id: string,
  reasoning: boolean,
  effort: AntigravityEffort,
): JsonRecord | undefined {
  // Claude 的思考是 thinkingBudget，另加 interleaved-thinking beta 头。不看目录里的 reasoning。
  if (is_antigravity_claude_model(model_id)) return antigravity_claude_thinking(effort);
  if (is_antigravity_gemini_31_pro(model_id)) return antigravity_pro_31_thinking(effort);
  if (!reasoning) return undefined;
  if (effort === "off") {
    if (!suppresses_thinking_when_off(model_id)) return undefined;
    if (uses_thinking_budget(model_id)) return { includeThoughts: false, thinkingBudget: 0 };
    return { includeThoughts: false, thinkingLevel: "LOW" };
  }
  if (uses_thinking_budget(model_id))
    return {
      includeThoughts: true,
      thinkingBudget: thinking_budget(model_id, effort),
    };
  return { includeThoughts: true, thinkingLevel: wire_thinking_level(effort) };
}

function antigravity_effort(level: ThinkingLevel | undefined): AntigravityEffort {
  return level ?? "off";
}

function suppresses_thinking_when_off(model_id: string): boolean {
  const family = gemini_family(model_id);
  if (family?.major !== 3) return false;
  if (family.kind === "pro") return family.minor < 2;
  if (family.kind === "flash") return family.minor < 6;
  return false;
}

function uses_thinking_budget(model_id: string): boolean {
  const family = gemini_family(model_id);
  if (family === undefined || family.major !== 3) return true;
  if (family.kind === "flash" && family.minor < 6) return true;
  return false;
}

function thinking_budget(model_id: string, level: AntigravityEffort): number {
  const family = gemini_family(model_id);
  if (family?.major === 3 && family.kind === "flash" && family.minor < 6) {
    if (level === "medium") return FLASH_MEDIUM_BUDGET;
    if (level === "high" || level === "xhigh" || level === "max") return FLASH_HIGH_BUDGET;
    return FLASH_LOW_BUDGET;
  }
  if (level === "minimal") return 128;
  if (level === "low") return 2_048;
  if (level === "medium") return 8_192;
  return 32_768;
}

function wire_thinking_level(level: AntigravityEffort): "LOW" | "MEDIUM" | "HIGH" {
  if (level === "medium") return "MEDIUM";
  if (level === "high" || level === "xhigh" || level === "max") return "HIGH";
  return "LOW";
}

function output_token_limit(model: Model<Api>, max_tokens: number | undefined): number {
  const cap = is_antigravity_claude_model(model.id)
    ? CLAUDE_MAX_OUTPUT_TOKENS
    : GEMINI_MAX_OUTPUT_TOKENS;
  const requested = max_tokens !== undefined && max_tokens > 0 ? max_tokens : model.maxTokens;
  return Math.min(cap, Math.max(1, Math.trunc(requested > 0 ? requested : cap)));
}

function claude_thinking_beta(model_id: string, level: ThinkingLevel | undefined): boolean {
  return is_antigravity_claude_model(model_id) && level !== undefined;
}

function request_headers(
  headers: SimpleStreamOptions["headers"],
  claude_beta: boolean,
): Record<string, string> {
  const result = sanitize_antigravity_headers(headers);
  if (claude_beta) result["anthropic-beta"] = ANTIGRAVITY_CLAUDE_THINKING_BETA;
  return result;
}

function gemini_major_version(model_id: string): number | undefined {
  return gemini_family(model_id)?.major;
}

function gemini_family(
  model_id: string,
): { major: number; minor: number; kind: "flash" | "pro" | "lite" | undefined } | undefined {
  const match = /gemini(?:-live)?-(\d+)(?:\.(\d+))?-(flash|pro|lite)?/iu.exec(model_id);
  if (match?.[1] === undefined) return undefined;
  const major = Number(match[1]);
  if (!Number.isInteger(major)) return undefined;
  const kind = match[3]?.toLowerCase();
  return {
    major,
    minor: match[2] === undefined ? 0 : Number(match[2]),
    kind: kind === "flash" || kind === "pro" || kind === "lite" ? kind : undefined,
  };
}

function thought_signature(same_model: boolean, signature: string | undefined): string | undefined {
  if (!same_model || signature === undefined) return undefined;
  if (signature.length % 4 !== 0 || !BASE64_SIGNATURE.test(signature)) return undefined;
  return signature;
}

function sanitize_tool_id(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);
  return sanitized === "" ? "tool" : sanitized;
}

function first_user_text(messages: readonly Message[]): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part): part is TextContent => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    if (text.trim() !== "") return text;
  }
  return "";
}

function last_execution_id(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return typeof message.responseId === "string" && message.responseId !== ""
      ? message.responseId
      : undefined;
  }
  return undefined;
}

function stable_uuid(text: string, label: string): string {
  const digest = createHash("sha256").update(`${label}:${text}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function consume_response(
  response: Response,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  signal: AbortSignal | undefined,
): Promise<void> {
  let current: OpenBlock | null = null;
  let started = false;
  let saw_finish = false;
  let tool_sequence = 0;
  const content_index = (): number => output.content.length - 1;
  const ensure_started = (): void => {
    if (started) return;
    started = true;
    stream.push({ type: "start", partial: output });
  };
  const end_block = (): void => {
    if (current === null) return;
    const index = content_index();
    if (current.type === "text")
      stream.push({
        type: "text_end",
        contentIndex: index,
        content: current.text,
        partial: output,
      });
    else
      stream.push({
        type: "thinking_end",
        contentIndex: index,
        content: current.thinking,
        partial: output,
      });
    current = null;
  };
  const keep_signature = (block: OpenBlock, incoming: unknown): void => {
    if (typeof incoming !== "string" || incoming.length === 0) return;
    if (block.type === "text") block.textSignature = incoming;
    else block.thinkingSignature = incoming;
  };
  const append_text = (delta: string, signature: unknown, thinking: boolean): void => {
    if (thinking) {
      if (current?.type !== "thinking") {
        end_block();
        ensure_started();
        const block: ThinkingContent = { type: "thinking", thinking: "" };
        current = block;
        output.content.push(block);
        stream.push({
          type: "thinking_start",
          contentIndex: content_index(),
          partial: output,
        });
      }
      if (current?.type !== "thinking") return;
      keep_signature(current, signature);
      if (delta === "") return;
      current.thinking += delta;
      stream.push({
        type: "thinking_delta",
        contentIndex: content_index(),
        delta,
        partial: output,
      });
      return;
    }
    if (current?.type !== "text") {
      end_block();
      ensure_started();
      const block: TextContent = { type: "text", text: "" };
      current = block;
      output.content.push(block);
      stream.push({
        type: "text_start",
        contentIndex: content_index(),
        partial: output,
      });
    }
    if (current?.type !== "text") return;
    keep_signature(current, signature);
    if (delta === "") return;
    current.text += delta;
    stream.push({
      type: "text_delta",
      contentIndex: content_index(),
      delta,
      partial: output,
    });
  };
  const append_tool = (call: JsonRecord, signature: unknown): void => {
    end_block();
    ensure_started();
    const name = typeof call["name"] === "string" ? call["name"] : "";
    const provided = typeof call["id"] === "string" ? sanitize_tool_id(call["id"]) : "";
    const duplicate =
      provided !== "" &&
      output.content.some((block) => block.type === "toolCall" && block.id === provided);
    const id =
      provided === "" || duplicate
        ? sanitize_tool_id(`${name || "tool"}_${Date.now()}_${(tool_sequence += 1)}`)
        : provided;
    const tool_call: ToolCall = {
      type: "toolCall",
      id,
      name,
      arguments: json_record(call["args"]),
    };
    if (typeof signature === "string" && signature.length > 0)
      tool_call.thoughtSignature = signature;
    output.content.push(tool_call);
    const index = content_index();
    stream.push({
      type: "toolcall_start",
      contentIndex: index,
      partial: output,
    });
    stream.push({
      type: "toolcall_delta",
      contentIndex: index,
      delta: JSON.stringify(tool_call.arguments),
      partial: output,
    });
    stream.push({
      type: "toolcall_end",
      contentIndex: index,
      toolCall: tool_call,
      partial: output,
    });
  };
  try {
    for await (const payload of read_generate_payloads(response)) {
      apply_payload(payload, output, append_text, append_tool, () => {
        saw_finish = true;
      });
    }
    if (signal?.aborted === true) throw aborted_error();
    end_block();
    if (!saw_finish) throw new Error("503: Cloud Code Assist stream ended without a finish reason");
    if (
      (output.stopReason === "stop" || output.stopReason === "length") &&
      output.content.some((block) => block.type === "toolCall")
    ) {
      output.stopReason = "toolUse";
      delete output.errorMessage;
    }
  } catch (error) {
    end_block();
    throw error;
  }
}

function apply_payload(
  event: unknown,
  output: AssistantMessage,
  append_text: (delta: string, signature: unknown, thinking: boolean) => void,
  append_tool: (call: JsonRecord, signature: unknown) => void,
  mark_finish: () => void,
): void {
  if (!is_json_record(event)) return;
  if (is_json_record(event["error"])) {
    const status = typeof event["error"]["code"] === "number" ? event["error"]["code"] : undefined;
    throw create_provider_error(event, status, {
      retryable: status === 429 || (status !== undefined && status >= 500),
    });
  }
  const body = is_json_record(event["response"]) ? event["response"] : event;
  const response_id = read_text(event["responseId"]) ?? read_text(body["responseId"]);
  if (response_id !== undefined) output.responseId = response_id;
  const feedback = is_json_record(body["promptFeedback"]) ? body["promptFeedback"] : undefined;
  const candidates = body["candidates"];
  if (feedback?.["blockReason"] !== undefined && !Array.isArray(candidates)) {
    throw create_provider_error(
      read_text(feedback["blockReasonMessage"]) ?? `Blocked: ${String(feedback["blockReason"])}`,
      undefined,
      { retryable: false },
    );
  }
  if (is_json_record(body["usageMetadata"])) output.usage = map_usage(body["usageMetadata"]);
  const candidate = Array.isArray(candidates) ? candidates[0] : undefined;
  if (!is_json_record(candidate)) return;
  const content = is_json_record(candidate["content"]) ? candidate["content"] : {};
  const parts = Array.isArray(content["parts"]) ? content["parts"] : [];
  for (const part of parts) {
    if (!is_json_record(part)) continue;
    const call = part["functionCall"];
    if (typeof part["text"] === "string" && part["text"] !== "")
      append_text(part["text"], part["thoughtSignature"], part["thought"] === true);
    else if (
      part["text"] === "" &&
      read_text(part["thoughtSignature"]) !== undefined &&
      !is_json_record(call)
    )
      append_text("", part["thoughtSignature"], false);
    if (is_json_record(call)) append_tool(call, part["thoughtSignature"]);
  }
  if (typeof candidate["finishReason"] !== "string") return;
  mark_finish();
  output.rawStopReason = candidate["finishReason"];
  const mapped = mapStopReasonString(candidate["finishReason"]);
  if (
    (mapped === "stop" || mapped === "length") &&
    output.content.some((block) => block.type === "toolCall")
  ) {
    output.stopReason = "toolUse";
    delete output.errorMessage;
    return;
  }
  output.stopReason = mapped;
  if (mapped === "error")
    output.errorMessage = `Generation failed with finish reason: ${candidate["finishReason"]}`;
  else delete output.errorMessage;
}

function has_visible_output(message: AssistantMessage): boolean {
  return message.content.some(
    (block) => (block.type === "text" && block.text.trim() !== "") || block.type === "toolCall",
  );
}

function has_thinking_text(message: AssistantMessage): boolean {
  return message.content.some((block) => block.type === "thinking" && block.thinking.trim() !== "");
}

function map_usage(metadata: JsonRecord): Usage {
  const candidates = read_count(metadata["candidatesTokenCount"]);
  const thinking = read_count(metadata["thoughtsTokenCount"]);
  const total = read_count(metadata["totalTokenCount"]);
  const prompt =
    metadata["promptTokenCount"] === undefined
      ? Math.max(0, total - candidates - thinking)
      : read_count(metadata["promptTokenCount"]);
  const cache_read = Math.min(read_count(metadata["cachedContentTokenCount"]), prompt);
  // Pi 的 output 已包含 reasoning，作曲器「输出」读的就是这个数，没有单独的思考计数。
  // candidates 不含思考，所以相加后 reasoning 仍是 output 的子集。
  return {
    input: prompt - cache_read,
    output: candidates + thinking,
    cacheRead: cache_read,
    cacheWrite: 0,
    reasoning: thinking,
    totalTokens: total,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function failure_reason(error: unknown, signal: AbortSignal | undefined): "error" | "aborted" {
  return is_abort_error(error) || signal?.aborted === true ? "aborted" : "error";
}

function failure_message(error: unknown, signal: AbortSignal | undefined): string {
  if (is_abort_error(error) || signal?.aborted === true) return "Request was aborted";
  if (error instanceof AppError) {
    if (error.diagnostic_context["retryable"] !== true) return error.message;
    const status = error.diagnostic_context["status"];
    return `${typeof status === "number" ? status : 503}: ${error.message}`;
  }
  const message = error instanceof Error ? error.message : "Cloud Code Assist request failed";
  return /^(?:429|500|502|503|504)\b/u.test(message) ? message : `503: ${message}`;
}

function aborted_error(): Error {
  return Object.assign(new Error("Request was aborted"), {
    name: "AbortError",
  });
}

function is_abort_error(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function* read_generate_payloads(response: Response): AsyncGenerator<unknown> {
  if (response.body === null) {
    yield* parse_generate_body(await response.text());
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let raw = "";
  let saw_sse = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (!saw_sse) raw += chunk;
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const payload = read_sse_data(line);
        if (payload === undefined) continue;
        saw_sse = true;
        raw = "";
        yield payload;
      }
    }
    pending += decoder.decode();
    if (!saw_sse) {
      yield* parse_generate_body(raw + pending);
      return;
    }
    const tail = read_sse_data(pending);
    if (tail !== undefined) yield tail;
  } finally {
    // 提前结束时要放开 body。克隆过的响应在没读完时 cancel 可能永不返回，不能挡住已解析事件。
    await Promise.race([
      reader.cancel().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 0)),
    ]);
  }
}

function read_sse_data(line: string): unknown | undefined {
  if (!line.startsWith("data:")) return undefined;
  const data = line.slice("data:".length).trim();
  if (data === "" || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch (error) {
    throw create_provider_error(error, undefined, { retryable: true });
  }
}

function parse_generate_body(body: string): unknown[] {
  const trimmed = body.trim();
  if (trimmed === "") return [];
  if (!trimmed.startsWith("{") && !trimmed.startsWith("["))
    throw create_provider_error("Cloud Code Assist returned an unreadable response", undefined, {
      retryable: true,
    });
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    throw create_provider_error(error, undefined, { retryable: true });
  }
}

function read_count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function read_text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function json_record(value: unknown): JsonRecord {
  if (!is_json_record(value)) return {};
  const copy: unknown = JSON.parse(JSON.stringify(value));
  return is_json_record(copy) ? copy : {};
}

function to_json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function to_record(value: unknown): JsonRecord {
  const parsed = to_json(value);
  if (!is_json_record(parsed))
    throw create_provider_error("Antigravity request was not an object", undefined, {
      retryable: false,
    });
  return parsed;
}

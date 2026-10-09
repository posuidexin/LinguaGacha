import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../shared/error";
import { AppPathService } from "../app/app-path-service";
import { RuntimeOperationGate } from "../runtime-operation-gate";
import * as antigravity_oauth from "./antigravity-oauth";
import type { AntigravityCredential } from "./antigravity-oauth";
import type { ChatGPTCredential } from "./chatgpt-oauth";
import * as chatgpt_oauth from "./chatgpt-oauth";
import { OAuthCredentialStore } from "./chatgpt-credential-store";
import { ModelAuthService } from "./model-auth-service";

const services: ModelAuthService[] = [];
let root = "";

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  vi.restoreAllMocks();
  if (root !== "") fs.rmSync(root, { recursive: true, force: true });
});

describe("模型账户入口", () => {
  it("合并快照按提供方保留登录，省略提供方仍是 ChatGPT", async () => {
    const service = create_service();
    vi.spyOn(chatgpt_oauth, "start_chatgpt_login").mockImplementation(({ signal }) =>
      pending_login<ChatGPTCredential>(signal, "https://auth.openai.com/authorize"),
    );
    vi.spyOn(antigravity_oauth, "start_antigravity_login").mockImplementation(({ signal }) =>
      pending_login<AntigravityCredential>(signal, "https://accounts.google.com/o/oauth2/v2/auth"),
    );
    const initial = service.snapshot();
    expect(service.snapshot().revision).toBe(initial.revision);
    const chatgpt = await service.login(undefined);
    expect(chatgpt.url).toContain("auth.openai.com");
    expect(chatgpt.snapshot.revision).toBeGreaterThan(initial.revision);
    expect(chatgpt.snapshot.providers.chatgpt.login?.status).toBe("pending");
    const antigravity = await service.login("google-antigravity");
    expect(antigravity.snapshot.providers["google-antigravity"].login?.status).toBe("pending");
    expect(antigravity.snapshot.providers.chatgpt.login?.id).toBe(chatgpt.id);
    expect(service.snapshot().revision).toBe(antigravity.snapshot.revision);
    await service.cancel_login("chatgpt", chatgpt.id);
    const after_cancel = service.snapshot();
    expect(after_cancel.providers.chatgpt.login?.status).toBe("cancelled");
    expect(after_cancel.providers["google-antigravity"].login?.status).toBe("pending");
    await expect(service.login("other")).rejects.toMatchObject({
      code: "request.validation_failed",
    });
  });

  it("解析 Antigravity 时同时返回项目 ID", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-model-auth-"));
    const paths = new AppPathService({ appRoot: root, builtinRoot: root });
    const store = new OAuthCredentialStore<AntigravityCredential>(
      paths.get_user_data_path("auth", "antigravity.json"),
      "Google Antigravity",
    );
    await store.update((account) => {
      account.credential = {
        type: "oauth",
        access: "token",
        refresh: "refresh",
        expires: Date.now() + 60 * 60 * 1000,
        clientId: "client",
        email: "user@example.test",
        project_id: "projects/123",
        session_id: "session-1",
      };
    });
    const service = new ModelAuthService(paths, new RuntimeOperationGate(), vi.fn());
    services.push(service);
    await expect(
      service.resolve("google-antigravity", service.bind("google-antigravity")),
    ).resolves.toEqual({
      apiKey: "token",
      project_id: "projects/123",
    });
  });
});

function create_service(): ModelAuthService {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-model-auth-"));
  const service = new ModelAuthService(
    new AppPathService({ appRoot: root, builtinRoot: root }),
    new RuntimeOperationGate(),
    vi.fn(),
  );
  services.push(service);
  return service;
}

/** 地址立刻返回，完成态跟随取消，避免测试留下真实浏览器监听。 */
function pending_login<T>(
  signal: AbortSignal,
  url: string,
): Promise<{ url: string; completion: Promise<T> }> {
  const completion = new Promise<T>((_resolve, reject) => {
    const fail = (): void => {
      reject(new AppError("runtime.cancelled"));
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  void completion.catch(() => undefined);
  return Promise.resolve({ url, completion });
}

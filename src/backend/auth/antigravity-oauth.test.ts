import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  refresh_antigravity_credential,
  start_antigravity_login,
  type AntigravityCredential,
} from "./antigravity-oauth";

const real_fetch = globalThis.fetch;
const TEST_CLIENT_ID = "antigravity-test-client";
const TEST_CLIENT_SECRET = "antigravity-test-secret";
const CLIENT_ID_ENV = "LINGUAGACHA_ANTIGRAVITY_CLIENT_ID";
const CLIENT_SECRET_ENV = "LINGUAGACHA_ANTIGRAVITY_CLIENT_SECRET";

beforeEach(() => {
  load_count = 0;
  process.env[CLIENT_ID_ENV] = TEST_CLIENT_ID;
  process.env[CLIENT_SECRET_ENV] = TEST_CLIENT_SECRET;
});

afterEach(() => {
  delete process.env[CLIENT_ID_ENV];
  delete process.env[CLIENT_SECRET_ENV];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Google Antigravity 浏览器授权", () => {
  it("没有客户端环境变量时拒绝登录和刷新", async () => {
    delete process.env[CLIENT_ID_ENV];
    delete process.env[CLIENT_SECRET_ENV];
    await expect(
      start_antigravity_login({ host_id: "host", signal: new AbortController().signal, port: 0 }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(`${CLIENT_ID_ENV} and ${CLIENT_SECRET_ENV}`),
    });
    await expect(
      refresh_antigravity_credential(credential(), new AbortController().signal),
    ).rejects.toMatchObject({
      message: expect.stringContaining(CLIENT_SECRET_ENV),
    });
  });

  it("错误 state 不能结束登录，用户拒绝后只取消这一轮", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const controller = new AbortController();
    const login = await start_antigravity_login({
      host_id: "host",
      signal: controller.signal,
      port: 0,
    });
    const cancelled = expect(login.completion).rejects.toMatchObject({ code: "runtime.cancelled" });
    try {
      const authorize = new URL(login.url);
      expect(authorize.origin).toBe("https://accounts.google.com");
      expect(authorize.searchParams.get("client_id")).toBe(TEST_CLIENT_ID);
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorize.searchParams.get("access_type")).toBe("offline");
      const wrong = await post_callback(login.url, {
        state: "wrong-state",
        error: "access_denied",
      });
      expect(wrong.status).toBe(400);
      const denied = await post_callback(login.url, {
        state: authorize.searchParams.get("state") ?? "",
        error: "access_denied",
      });
      expect(denied.status).toBe(200);
      await cancelled;
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await login.completion.catch(() => undefined);
    }
  });

  it("默认回调端口是已注册的 51121，占用时说明是哪一个端口", async () => {
    const controller = new AbortController();
    const login = await start_antigravity_login({ host_id: "host", signal: controller.signal });
    try {
      const redirect = new URL(new URL(login.url).searchParams.get("redirect_uri") ?? "");
      expect(redirect.port).toBe("51121");
    } finally {
      controller.abort();
      await login.completion.catch(() => undefined);
    }

    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (blocker.address() as AddressInfo).port;
    try {
      await expect(
        start_antigravity_login({
          host_id: "host",
          signal: new AbortController().signal,
          port,
        }),
      ).rejects.toMatchObject({ message: expect.stringContaining(String(port)) });
    } finally {
      blocker.close();
    }
  });

  it("授权码换 token 后读取邮箱和 Cloud Code 项目", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => json_for(String(input), "ready")),
    );
    const controller = new AbortController();
    const login = await start_antigravity_login({
      host_id: "host",
      signal: controller.signal,
      port: 0,
    });
    try {
      const authorize = new URL(login.url);
      expect(
        (
          await post_callback(login.url, {
            state: authorize.searchParams.get("state") ?? "",
            code: "auth-code",
          })
        ).status,
      ).toBe(200);
      await expect(login.completion).resolves.toMatchObject({
        access: "access-token",
        refresh: "refresh-token",
        email: "user@example.test",
        project_id: "projects/123",
        clientId: TEST_CLIENT_ID,
      });
    } finally {
      controller.abort();
      await login.completion.catch(() => undefined);
    }
  });

  it("没有当前套餐时先开通免费档，再保存项目", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => json_for(String(input), "onboard")),
    );
    const controller = new AbortController();
    const login = await start_antigravity_login({
      host_id: "host",
      signal: controller.signal,
      port: 0,
    });
    try {
      const authorize = new URL(login.url);
      await post_callback(login.url, {
        state: authorize.searchParams.get("state") ?? "",
        code: "auth-code",
      });
      await expect(login.completion).resolves.toMatchObject({ project_id: "projects/free" });
      expect(vi.mocked(globalThis.fetch).mock.calls.map(([input]) => String(input))).toEqual(
        expect.arrayContaining([expect.stringContaining("onboardUser")]),
      );
    } finally {
      controller.abort();
      await login.completion.catch(() => undefined);
    }
  });

  it("免费档不合格时返回原因和验证地址", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => json_for(String(input), "ineligible")),
    );
    const controller = new AbortController();
    const login = await start_antigravity_login({
      host_id: "host",
      signal: controller.signal,
      port: 0,
    });
    const failed = expect(login.completion).rejects.toMatchObject({
      message: expect.stringMatching(/Verify your account[\s\S]*https:\/\/example\.test\/verify/),
      diagnostic_context: { retryable: false },
    });
    try {
      const authorize = new URL(login.url);
      await post_callback(login.url, {
        state: authorize.searchParams.get("state") ?? "",
        code: "auth-code",
      });
      await failed;
    } finally {
      controller.abort();
      await login.completion.catch(() => undefined);
    }
  });

  it("刷新保留项目和旧 refresh token", async () => {
    const fetch_mock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ""));
      expect(body.get("client_id")).toBe(TEST_CLIENT_ID);
      expect(body.get("client_secret")).toBe(TEST_CLIENT_SECRET);
      return Response.json({ access_token: "new-access", expires_in: 1200 });
    });
    vi.stubGlobal("fetch", fetch_mock);
    const next = await refresh_antigravity_credential(credential(), new AbortController().signal);
    expect(next).toMatchObject({
      access: "new-access",
      refresh: "keep-refresh",
      project_id: "projects/123",
      session_id: "session-1",
      email: "user@example.test",
      clientId: TEST_CLIENT_ID,
    });
  });

  it("invalid_grant 使刷新失效且不可重试", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "invalid_grant", error_description: "Token has been expired or revoked." },
          { status: 400 },
        ),
      ),
    );
    await expect(
      refresh_antigravity_credential(credential(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "model.provider_failed",
      message: "Token has been expired or revoked.",
      diagnostic_context: { provider_code: "invalid_grant", retryable: false, auth_invalid: true },
    });
  });
});

/** 用真实本机回调完成浏览器跳转，远端请求由测试替换。 */
function post_callback(login_url: string, params: Record<string, string>): Promise<Response> {
  const callback = new URL(new URL(login_url).searchParams.get("redirect_uri") ?? "");
  callback.search = new URLSearchParams(params).toString();
  return real_fetch(callback);
}

function credential(): AntigravityCredential {
  return {
    type: "oauth",
    access: "old-access",
    refresh: "keep-refresh",
    expires: 0,
    clientId: "client",
    email: "user@example.test",
    project_id: "projects/123",
    session_id: "session-1",
  };
}

let load_count = 0;

/** 按 URL 返回登录后续步骤需要的最小 JSON。 */
function json_for(url: string, mode: "ready" | "onboard" | "ineligible"): Response {
  if (url.includes("oauth2.googleapis.com/token"))
    return Response.json({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
    });
  if (url.includes("userinfo")) return Response.json({ email: "user@example.test" });
  if (url.includes("loadCodeAssist")) {
    load_count += 1;
    if (mode === "ineligible")
      return Response.json({
        allowedTiers: [{ id: "paid" }],
        ineligibleTiers: [
          {
            tierId: "free-tier",
            reasonMessage: "Verify your account",
            validationUrl: "https://example.test/verify",
          },
        ],
      });
    if (mode === "onboard" && load_count === 1)
      return Response.json({ allowedTiers: [{ id: "free-tier" }] });
    return Response.json({
      cloudaicompanionProject: mode === "onboard" ? "projects/free" : "projects/123",
      currentTier: { id: "free-tier" },
      paidTier: { id: "paid" },
      allowedTiers: [{ id: "free-tier" }],
    });
  }
  if (url.includes("onboardUser")) return Response.json({ done: true, response: {} });
  return new Response(`unexpected ${url}`, { status: 500 });
}

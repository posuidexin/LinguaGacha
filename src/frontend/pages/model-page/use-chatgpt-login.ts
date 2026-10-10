import { push_error_toast, push_toast } from "@frontend/app/feedback/desktop-toast";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { api_fetch, DesktopApiError, open_external_url } from "@frontend/app/desktop/desktop-api";
import { useI18n, type LocaleKey } from "@frontend/app/locale/locale-context";

import {
  apply_model_auth_snapshot,
  useModelAuthSnapshot,
} from "@frontend/app/state/model-auth-store";
import type { OAuthProvider } from "@domain/model";
import {
  OAUTH_CALLBACK_REASONS,
  type ModelAuthLoginResponse,
  type ModelAuthSnapshot,
  type OAuthCallbackReason,
  type OAuthLoginSnapshot,
} from "@shared/model-auth";

const COPIED_FEEDBACK_MS = 2_000;
const CALLBACK_ERROR_KEYS = {
  [OAUTH_CALLBACK_REASONS.empty]: "model_page.auth.paste_callback_empty",
  [OAUTH_CALLBACK_REASONS.unreadable]: "model_page.auth.paste_callback_unreadable",
  [OAUTH_CALLBACK_REASONS.state_mismatch]: "model_page.auth.paste_callback_state",
  [OAUTH_CALLBACK_REASONS.already_accepted]: "model_page.auth.paste_callback_used",
  [OAUTH_CALLBACK_REASONS.missing]: "model_page.auth.paste_callback_missing",
  [OAUTH_CALLBACK_REASONS.unsupported]: "model_page.auth.paste_callback_missing",
} as const satisfies Record<OAuthCallbackReason, LocaleKey>;
type LoginOperation = {
  provider: OAuthProvider; // 取消和结果都回到发起登录的那个账户。
  request: Promise<ModelAuthLoginResponse>; // 准备期间取消时，仍需取得后端授权 ID。
  id: string | null; // 启动响应返回后与账户快照匹配。
  cancelled: boolean; // 取消请求与快照消费之间的本地互斥。
};

/** 页面拥有一次授权交互；准备阶段取消也必须等待拿到 ID 后清理后端。 */
export function useChatGPTLogin() {
  const { t } = useI18n();
  const snapshot = useModelAuthSnapshot();
  const operation = useRef<LoginOperation | null>(null); // 取消收尾前持有操作，防止重复创建授权。
  const mounted = useRef(true); // 卸载仍清理后端授权，交互结果只交付给挂载页面。
  const [busy, set_busy] = useState(false); // 覆盖弹窗关闭后仍在等待的取消操作。
  const [provider, set_provider] = useState<OAuthProvider>("chatgpt");
  const [url, set_url] = useState<string | null>(null);
  const [open, set_open] = useState(false);
  const [copied, set_copied] = useState(false);
  const [callback_text, set_callback_text] = useState("");
  const [callback_error, set_callback_error] = useState<string | null>(null);
  const [callback_busy, set_callback_busy] = useState(false);
  const [callback_accepted, set_callback_accepted] = useState(false);

  /** 本地调用与授权失败共用项目错误文案规则。 */
  function report_error(error: unknown): void {
    push_error_toast(t("app.feedback.model_request_failed"), error);
  }

  /** 成功与失败统一反馈，主动取消静默结束。 */
  function report_result(result: OAuthLoginSnapshot): void {
    if (result.status === "succeeded") push_toast("success", t("model_page.auth.success"));
    if (result.status === "failed") report_error(new DesktopApiError(result.error));
  }

  /** 当前操作结束后释放入口，并清除该操作的页面反馈。 */
  function finish(): void {
    operation.current = null;
    if (mounted.current) {
      set_busy(false);
      set_open(false);
      set_url(null);
      set_copied(false);
      set_callback_text("");
      set_callback_error(null);
      set_callback_busy(false);
      set_callback_accepted(false);
    }
  }

  /** 启动请求与弹窗共用一次操作，URL 返回前也可以请求取消。 */
  async function start(next_provider: OAuthProvider = "chatgpt"): Promise<void> {
    if (operation.current !== null) return;
    set_provider(next_provider);
    const current: LoginOperation = {
      provider: next_provider,
      request: api_fetch<ModelAuthLoginResponse>("/api/models/auth/login", {
        provider: next_provider,
      }),
      id: null,
      cancelled: false,
    };
    operation.current = current;
    set_callback_text("");
    set_callback_error(null);
    set_callback_busy(false);
    set_callback_accepted(false);
    set_busy(true);
    set_open(true);
    try {
      const response = await current.request;
      if (current.cancelled) return;
      current.id = response.id;
      apply_model_auth_snapshot(response.snapshot);
      set_url(response.url);
    } catch (error) {
      if (!current.cancelled) {
        report_error(error);
        finish();
      }
    }
  }

  /** 取得本轮 ID 后取消，成功提交与取消竞争时消费后端最终结果。 */
  async function cancel(): Promise<void> {
    const current = operation.current;
    if (current === null || current.cancelled) return;
    current.cancelled = true;
    if (mounted.current) set_open(false);
    try {
      // 启动失败意味着后端已收尾，此处不重复报告同一失败。
      const response = await current.request.catch(() => null);
      if (response !== null) {
        const result = await api_fetch<{ snapshot: ModelAuthSnapshot }>("/api/models/auth/cancel", {
          id: response.id,
          provider: current.provider,
        });
        apply_model_auth_snapshot(result.snapshot);
        // 若提交先于取消完成，以后端结果为准，不能把已登录呈现为取消成功。
        const login = result.snapshot.providers[current.provider].login;
        if (mounted.current && login?.id === response.id) report_result(login);
      }
    } catch (error) {
      report_error(error);
    } finally {
      finish();
    }
  }

  // 快照可能先于启动响应到达，等本轮 ID 就绪后再消费结果。
  const complete = useEffectEvent(() => {
    const current = operation.current;
    const result = current === null ? null : snapshot?.providers[current.provider].login;
    if (
      current === null ||
      current.cancelled ||
      result == null ||
      current.id !== result.id ||
      result.status === "pending"
    )
      return;
    finish();
    report_result(result);
  });

  useEffect(() => {
    complete();
  }, [snapshot, url]);

  const cancel_on_unmount = useEffectEvent(() => {
    void cancel();
  });

  // 授权随页面卸载清理，语言变化继续使用当前授权。
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel_on_unmount();
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => set_copied(false), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /** 复制当前链接，迟到的剪贴板结果只更新所属操作。 */
  async function copy(): Promise<void> {
    if (url === null) return;
    const current = operation.current;
    try {
      await navigator.clipboard.writeText(url);
      if (current !== null && operation.current === current && !current.cancelled) set_copied(true);
    } catch (error) {
      report_error(error);
    }
  }

  /** 输入变化清掉上一次校验，避免旧错误贴在新内容上。 */
  function change_callback(value: string): void {
    set_callback_text(value);
    set_callback_error(null);
  }

  /** 校验失败留在弹窗里；领取成功后等登录结果关闭窗口。 */
  async function submit_callback(): Promise<void> {
    const current = operation.current;
    if (
      current === null ||
      current.cancelled ||
      current.id === null ||
      current.provider !== "google-antigravity" ||
      callback_busy ||
      callback_accepted
    )
      return;
    const text = callback_text.trim();
    if (text === "") {
      set_callback_error(t(CALLBACK_ERROR_KEYS[OAUTH_CALLBACK_REASONS.empty]));
      return;
    }
    set_callback_busy(true);
    set_callback_error(null);
    try {
      const result = await api_fetch<{ snapshot: ModelAuthSnapshot }>("/api/models/auth/callback", {
        provider: current.provider,
        id: current.id,
        callback: text,
      });
      if (operation.current !== current || current.cancelled || !mounted.current) return;
      apply_model_auth_snapshot(result.snapshot);
      set_callback_accepted(true);
    } catch (error) {
      if (operation.current !== current || current.cancelled || !mounted.current) return;
      set_callback_error(callback_error_text(error, t));
    } finally {
      if (operation.current === current && mounted.current) set_callback_busy(false);
    }
  }

  /** 系统打开失败保留当前授权，供用户重试或复制链接。 */
  async function login(): Promise<void> {
    if (url === null) return;
    try {
      await open_external_url(url);
    } catch (error) {
      report_error(error);
    }
  }

  return {
    open,
    busy,
    url,
    copied,
    provider,
    callback_text,
    callback_error,
    callback_busy,
    callback_accepted,
    start,
    cancel,
    copy,
    login,
    change_callback,
    submit_callback,
  };
}

function is_callback_reason(value: unknown): value is OAuthCallbackReason {
  return typeof value === "string" && Object.hasOwn(CALLBACK_ERROR_KEYS, value);
}

function callback_error_text(
  error: unknown,
  translate: (key: LocaleKey, params?: Record<string, string>) => string,
): string {
  if (error instanceof DesktopApiError) {
    const reason = error.details["reason"];
    if (is_callback_reason(reason)) return translate(CALLBACK_ERROR_KEYS[reason]);
    return error.message;
  }
  return error instanceof Error
    ? error.message
    : translate(CALLBACK_ERROR_KEYS[OAUTH_CALLBACK_REASONS.unreadable]);
}

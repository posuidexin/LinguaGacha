import type { JSX } from "react";
import { useI18n } from "@frontend/app/locale/locale-context";
import { Input } from "@frontend/shadcn/input";
import { AppActionDialog } from "@frontend/widgets/app-alert-dialog";
import { AppButton } from "@frontend/widgets/app-button";
import type { useChatGPTLogin } from "../use-chatgpt-login";

/** 三按钮沿用公共动作弹窗，授权结果统一由登录流程通过 Toast 反馈。 */
export function ChatGPTLoginDialog({
  login,
}: {
  login: ReturnType<typeof useChatGPTLogin>;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <AppActionDialog
      open={login.open}
      title={t(
        login.provider === "google-antigravity"
          ? "model_page.auth.provider_google_antigravity"
          : "model_page.auth.provider_chatgpt",
      )}
      description={
        <>
          {login.provider === "google-antigravity" ? (
            <p className="model-page__auth-notice">
              {t("model_page.auth.antigravity_personal_use")}
            </p>
          ) : null}
          <Input
            readOnly
            value={login.url ?? ""}
            placeholder={t("app.action.loading")}
            aria-label={t("model_page.auth.copy_link")}
            onFocus={(event) => {
              event.currentTarget.select();
              event.currentTarget.scrollLeft = 0;
            }}
          />
          {login.provider === "google-antigravity" ? (
            <div className="model-page__auth-callback">
              <label className="model-page__auth-callback-field">
                {t("model_page.auth.paste_callback")}
                <Input
                  value={login.callback_text}
                  placeholder={t("model_page.auth.paste_callback_placeholder")}
                  aria-invalid={login.callback_error !== null}
                  aria-describedby={
                    login.callback_error === null ? undefined : "model-auth-callback-error"
                  }
                  disabled={login.url === null || login.callback_busy || login.callback_accepted}
                  onChange={(event) => {
                    login.change_callback(event.currentTarget.value);
                  }}
                />
              </label>
              <p className="model-page__auth-notice">{t("model_page.auth.paste_callback_hint")}</p>
              {login.callback_error === null ? null : (
                <p
                  id="model-auth-callback-error"
                  className="model-page__auth-callback-error"
                  role="alert"
                >
                  {login.callback_error}
                </p>
              )}
              <AppButton
                type="button"
                size="sm"
                variant="outline"
                className="model-page__auth-callback-submit"
                disabled={login.url === null || login.callback_busy || login.callback_accepted}
                onClick={() => {
                  void login.submit_callback();
                }}
              >
                {t("model_page.auth.paste_callback_submit")}
              </AppButton>
            </div>
          ) : null}
        </>
      }
      onClose={() => {
        void login.cancel();
      }}
      secondaryAction={{
        label: t(login.copied ? "model_page.auth.copied" : "model_page.auth.copy_link"),
        disabled: login.url === null,
        onSelect: login.copy,
      }}
      primaryAction={{
        label: t("model_page.auth.open_login_page"),
        disabled: login.url === null,
        onSelect: login.login,
      }}
    />
  );
}

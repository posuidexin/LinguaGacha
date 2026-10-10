import type { JsonRecord } from "../../domain/json";
import type { AppPathService } from "../app/app-path-service";
import type { RuntimeOperationGate } from "../runtime-operation-gate";
import {
  refresh_antigravity_credential,
  revoke_antigravity_session,
  start_antigravity_login,
  type AntigravityCredential,
} from "./antigravity-oauth";
import { OAuthAccountService, type OAuthAccountProtocol } from "./oauth-account-service";

const ANTIGRAVITY_PROTOCOL: OAuthAccountProtocol<AntigravityCredential> = {
  file_name: "antigravity.json",
  credential_label: "Google Antigravity",
  timeout_message: "Google Antigravity sign-in timed out.",
  start_login(options) {
    return start_antigravity_login(options);
  },
  refresh(credential, signal) {
    return refresh_antigravity_credential(credential, signal);
  },
  revoke(credential, signal) {
    return revoke_antigravity_session(credential, signal);
  },
  present(credential) {
    return { apiKey: credential.access, project_id: credential.project_id };
  },
};

/** Google Antigravity 账户与 ChatGPT 分开保存，项目 ID 只存在于本文件。 */
export class AntigravityAuthService extends OAuthAccountService<AntigravityCredential> {
  /** 装配 Antigravity 协议与 `auth/antigravity.json`。 */
  public constructor(
    paths: AppPathService,
    gate: RuntimeOperationGate,
    publish: (topic: string, payload: JsonRecord) => void,
  ) {
    super(paths, gate, publish, ANTIGRAVITY_PROTOCOL);
  }
}

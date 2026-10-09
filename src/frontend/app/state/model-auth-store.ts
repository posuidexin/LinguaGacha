import { useSyncExternalStore } from "react";
import type { ModelAuthSnapshot } from "@shared/model-auth";

let snapshot: ModelAuthSnapshot | null = null;
const listeners = new Set<() => void>();

/** HTTP 回包与 SSE 使用同一合并快照，迟到回包不能覆盖新结果。 */
export function apply_model_auth_snapshot(next: ModelAuthSnapshot): boolean {
  if (snapshot?.instance_id === next.instance_id && snapshot.revision > next.revision) return false;
  snapshot = next;
  for (const listener of listeners) listener();
  return true;
}

/** 页面与条目共享同一只读账户状态，卸载时解除订阅。 */
export function useModelAuthSnapshot(): ModelAuthSnapshot | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
  );
}

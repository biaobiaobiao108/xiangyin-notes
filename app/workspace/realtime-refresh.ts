import type { WorkspaceChangeMessage } from "../../shared/realtime";

export type RealtimeRefreshPlan = {
  notebooks: boolean;
  notes: boolean;
  selected: boolean;
  noteIds: Set<string>;
};

export function emptyRealtimeRefreshPlan(): RealtimeRefreshPlan {
  return { notebooks: false, notes: false, selected: false, noteIds: new Set() };
}

/**
 * 累积一次实时变更需要执行的动作。
 *
 * 带 noteId 的笔记事件只影响这一篇，调用方可以只刷新单行，避免把已经加载的
 * 多页列表重置回第一页；不带 noteId 时（批量回收站、改名、生命周期对账）
 * 顺序或归属可能变化，必须整表刷新。笔记本变更会改变列表行里显示的名称。
 */
export function accumulateRealtimeRefresh(plan: RealtimeRefreshPlan, message?: WorkspaceChangeMessage): RealtimeRefreshPlan {
  if (!message) {
    plan.notebooks = true;
    plan.notes = true;
    plan.selected = true;
    return plan;
  }
  if (message.resource === "notebooks") {
    plan.notebooks = true;
    plan.notes = true;
    return plan;
  }
  if (message.noteId) plan.noteIds.add(message.noteId);
  else plan.notes = true;
  return plan;
}

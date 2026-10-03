import { useCallback, useEffect, useRef, useState } from "react";

export type NoticeKind = "info" | "warning" | "error";
export type NoticePauseSource = "pointer" | "focus";
export type Notice = { id: number; message: string; kind: NoticeKind };
const priority = { info: 0, warning: 1, error: 2 };

export function nextNotice(current: Notice | null, incoming: Notice): Notice {
  // One notice at a time: repeated failures don't stack or hide a more important error.
  if (current && (priority[current.kind] > priority[incoming.kind] || (current.kind === incoming.kind && current.message === incoming.message))) return current;
  return incoming;
}

export function noticeDuration(notice: Notice) {
  return Math.max(notice.kind === "error" ? 10000 : notice.kind === "warning" ? 8000 : 3500, Math.min(15000, notice.message.length * 100));
}

export function useNotices() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pause, setPause] = useState({ id: 0, pointer: false, focus: false });
  const sequence = useRef(0);
  const show = useCallback((message: string, kind: NoticeKind) => {
    const incoming = { id: ++sequence.current, message, kind };
    setNotice((current) => nextNotice(current, incoming));
  }, []);
  const notifyError = useCallback((message: string) => show(message, "error"), [show]);
  const notifyWarning = useCallback((message: string) => show(message, "warning"), [show]);
  const notifyInfo = useCallback((message: string) => show(message, "info"), [show]);
  const dismiss = useCallback(() => setNotice(null), []);
  const setPaused = useCallback((paused: boolean, source: NoticePauseSource) => {
    const id = notice?.id ?? 0;
    setPause((current) => ({ ...(current.id === id ? current : { id, pointer: false, focus: false }), [source]: paused }));
  }, [notice?.id]);
  const paused = pause.id === notice?.id && (pause.pointer || pause.focus);
  useEffect(() => {
    if (!notice || paused) return;
    const timer = setTimeout(() => setNotice((current) => current?.id === notice.id ? null : current), noticeDuration(notice));
    return () => clearTimeout(timer);
  }, [notice, paused]);
  return { notice, notifyError, notifyWarning, notifyInfo, dismiss, setPaused };
}

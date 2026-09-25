import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowLeft, Check, Clock3, Copy } from "lucide-react";
import { Link, useParams } from "react-router";
import { ApiError, api } from "./api";
import { BrandMark } from "./brand-mark";
import type { SharedNote } from "../shared/types";

const LazyReadOnlyMarkdown = lazy(() => import("./editor/read-only-markdown").then(({ ReadOnlyMarkdown }) => ({ default: ReadOnlyMarkdown })));

export function SharePage() {
  const { token = "" } = useParams();
  const [loaded, setLoaded] = useState<{ token: string; note: SharedNote } | null>(null);
  const [error, setError] = useState<{ token: string; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoaded(null);
    setError(null);
    setCopied(false);
    setCopyFailed(false);
    void api.getPublicShare(token, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setLoaded({ token, note: result.note });
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError({ token, message: reason instanceof ApiError ? reason.message : "分享链接不可用" });
      });
    return () => controller.abort();
  }, [token]);

  const note = loaded?.token === token ? loaded.note : null;

  const copyContent = async () => {
    if (!note) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(note.contentMarkdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 3000);
    }
  };

  if (error?.token === token) return <main className="share-shell share-error"><div className="share-brand"><BrandMark size="small" />象映笔记</div><div className="share-error-card"><h1>暂时无法打开这篇笔记</h1><p>{error.message}</p><Link className="text-link" to="/login"><ArrowLeft size={16} />返回登录</Link></div></main>;
  if (!note) return <main className="share-shell"><div className="share-loading"><span className="loading-ring" /><span>正在打开分享……</span></div></main>;
  return <main className="share-shell"><header className="share-header"><Link to="/login" className="share-brand"><BrandMark size="small" />象映笔记</Link><div className="share-header-actions"><button className="secondary-button share-copy-button" type="button" onClick={() => void copyContent()}>{copied ? <Check size={14} /> : <Copy size={14} />}<span>{copied ? "已复制全文" : copyFailed ? "复制失败，请手动选择正文" : "复制正文"}</span></button><span className="share-readonly">只读分享</span></div></header><article className="share-article"><p className="share-kicker"><Clock3 size={15} />分享于 {formatDate(note.createdAt)} · {formatDate(note.expiresAt)} 到期</p><h1>{note.title}</h1><Suspense fallback={<p role="status">正在渲染正文……</p>}><LazyReadOnlyMarkdown key={token} markdown={note.contentMarkdown} /></Suspense></article><footer className="share-footer">这里显示笔记的当前内容，重新打开或刷新可获取最新修改。</footer></main>;
}

function formatDate(timestamp: number) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", year: "numeric" }).format(new Date(timestamp * 1000)); }

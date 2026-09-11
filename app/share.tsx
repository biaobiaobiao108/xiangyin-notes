import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowLeft, Check, Clock3, Copy } from "lucide-react";
import { Link, useParams } from "react-router";
import { ApiError, api } from "./api";
import { BrandMark } from "./brand-mark";

const LazyReadOnlyMarkdown = lazy(() => import("./editor").then(({ ReadOnlyMarkdown }) => ({ default: ReadOnlyMarkdown })));

export function SharePage() {
  const { token = "" } = useParams();
  const [snapshot, setSnapshot] = useState<{ title: string; contentMarkdown: string; createdAt: number; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => { if (!token) return; void api.getPublicShare(token).then((result) => setSnapshot(result.snapshot)).catch((reason) => setError(reason instanceof ApiError ? reason.message : "分享链接不可用")); }, [token]);

  const copyContent = async () => {
    if (!snapshot) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(snapshot.contentMarkdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 3000);
    }
  };

  if (error) return <main className="share-shell share-error"><div className="share-brand"><BrandMark size="small" />象映笔记</div><div className="share-error-card"><h1>暂时无法打开这篇笔记</h1><p>{error}</p><Link className="text-link" to="/login"><ArrowLeft size={16} />返回登录</Link></div></main>;
  if (!snapshot) return <main className="share-shell"><div className="share-loading"><span className="loading-ring" /><span>正在打开分享……</span></div></main>;
  return <main className="share-shell"><header className="share-header"><Link to="/login" className="share-brand"><BrandMark size="small" />象映笔记</Link><div className="share-header-actions"><button className="secondary-button share-copy-button" type="button" onClick={() => void copyContent()}>{copied ? <Check size={14} /> : <Copy size={14} />}<span>{copied ? "已复制全文" : copyFailed ? "复制失败，请手动选择正文" : "复制正文"}</span></button><span className="share-readonly">只读分享</span></div></header><article className="share-article"><p className="share-kicker"><Clock3 size={15} />分享于 {formatDate(snapshot.createdAt)} · {formatDate(snapshot.expiresAt)} 到期</p><h1>{snapshot.title}</h1><Suspense fallback={<p role="status">正在渲染正文……</p>}><LazyReadOnlyMarkdown markdown={snapshot.contentMarkdown} /></Suspense></article><footer className="share-footer">这是一个不可编辑的快照，内容来自象映笔记。</footer></main>;
}

function formatDate(timestamp: number) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", year: "numeric" }).format(new Date(timestamp * 1000)); }

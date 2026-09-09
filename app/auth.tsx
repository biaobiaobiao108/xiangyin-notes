import { FormEvent, useEffect, useState } from "react";
import { ArrowRight, Eye, EyeOff, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";
import { ApiError, api } from "./api";

export function SetupPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.bootstrap().then((result) => { if (result.configured) navigate("/login", { replace: true }); }).catch(() => undefined); }, [navigate]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try { await api.setup({ username, password }); navigate("/app", { replace: true }); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : "初始化失败，请稍后重试"); }
    finally { setBusy(false); }
  };
  return <AuthLayout title="建立你的安静空间" description="创建唯一所有者账号，开始把想法放在一个可靠的地方。"><form className="auth-form" onSubmit={submit}><Field label="用户名" value={username} onChange={setUsername} placeholder="例如：lumen" autoComplete="username" /><PasswordField label="密码" value={password} onChange={setPassword} show={showPassword} onToggle={() => setShowPassword((value) => !value)} /><p className="form-hint">密码至少需要 12 个字符。</p>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button auth-submit" disabled={busy}>{busy ? "正在建立……" : "开始使用"}<ArrowRight size={18} /></button></form></AuthLayout>;
}

export function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.bootstrap().then((result) => { if (!result.configured) navigate("/setup", { replace: true }); }).catch(() => undefined); }, [navigate]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try { await api.login({ username, password }); navigate("/app", { replace: true }); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : "登录失败，请稍后重试"); }
    finally { setBusy(false); }
  };
  return <AuthLayout title="欢迎回来" description="继续记录那些值得留下的东西。"><form className="auth-form" onSubmit={submit}><Field label="用户名" value={username} onChange={setUsername} placeholder="你的用户名" autoComplete="username" /><PasswordField label="密码" value={password} onChange={setPassword} show={showPassword} onToggle={() => setShowPassword((value) => !value)} autoComplete="current-password" />{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button auth-submit" disabled={busy}>{busy ? "正在登录……" : "进入笔记"}<ArrowRight size={18} /></button></form></AuthLayout>;
}

function Field({ label, value, onChange, placeholder, autoComplete }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; autoComplete: string }) {
  const id = label === "用户名" ? "auth-username" : "auth-field";
  return <label className="field"><span>{label}</span><input id={id} required value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} autoComplete={autoComplete} /></label>;
}

function PasswordField({ label, value, onChange, show, onToggle, autoComplete = "new-password" }: { label: string; value: string; onChange: (value: string) => void; show: boolean; onToggle: () => void; autoComplete?: string }) {
  return <label className="field"><span>{label}</span><span className="password-input"><input id="auth-password" required type={show ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} placeholder="至少 12 个字符" autoComplete={autoComplete} /><button type="button" className="password-toggle" aria-label={show ? "隐藏密码" : "显示密码"} onClick={onToggle}>{show ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label>;
}

function AuthLayout({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <main className="auth-shell"><div className="auth-brand"><span className="brand-mark"><Sparkles size={21} /></span><span>Lumen Notes</span></div><div className="auth-card"><div className="auth-card-copy"><h1>{title}</h1><p>{description}</p></div>{children}</div><p className="auth-footnote">你的笔记，只属于你的空间。</p></main>;
}

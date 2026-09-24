import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { ThemeProvider } from "./theme";

const Workspace = lazy(() => import("./workspace").then((m) => ({ default: m.Workspace })));
const LoginPage = lazy(() => import("./auth").then((m) => ({ default: m.LoginPage })));
const SetupPage = lazy(() => import("./auth").then((m) => ({ default: m.SetupPage })));
const SharePage = lazy(() => import("./share").then((m) => ({ default: m.SharePage })));

function RouteLoadingFallback() {
  return (
    <main className="app-loading" role="status" aria-live="polite">
      <span className="loading-ring" aria-hidden="true" />
      <span>正在进入你的空间……</span>
    </main>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <div className="app-root">
        <Suspense fallback={<RouteLoadingFallback />}>
          <Routes>
            <Route path="/" element={<Navigate to="/app" replace />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/app" element={<Workspace />} />
            <Route path="/share/:token" element={<SharePage />} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
        </Suspense>
      </div>
    </ThemeProvider>
  );
}

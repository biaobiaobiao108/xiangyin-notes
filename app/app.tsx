import { Navigate, Route, Routes } from "react-router";
import { LoginPage, SetupPage } from "./auth";
import { SharePage } from "./share";
import { Workspace } from "./workspace";

export function App() {
  return <div className="app-root" onContextMenu={(event) => event.preventDefault()}><Routes><Route path="/" element={<Navigate to="/app" replace />} /><Route path="/setup" element={<SetupPage />} /><Route path="/login" element={<LoginPage />} /><Route path="/app" element={<Workspace />} /><Route path="/share/:token" element={<SharePage />} /><Route path="*" element={<Navigate to="/app" replace />} /></Routes></div>;
}

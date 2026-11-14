import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app";
import { registerPwa } from "./pwa";
import "./styles.css";

void registerPwa();
const root = document.getElementById("root")!;
if (typeof CSS === "undefined" || !CSS.supports("color", "light-dark(#000, #fff)")) {
  root.innerHTML =
    '<main class="browser-unsupported"><strong>请升级浏览器</strong><span>象映笔记需要 Safari 17.5+、Chrome 123+ 或 Firefox 120+。</span></main>';
} else {
  createRoot(root).render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  );
}

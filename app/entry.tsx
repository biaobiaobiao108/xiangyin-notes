import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app";
import { registerPwa } from "./pwa";
import "./styles.css";

void registerPwa();
createRoot(document.getElementById("root")!).render(<BrowserRouter><App /></BrowserRouter>);

import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import "./styles/index.css";

// No StrictMode: its development double-mount would start two WebGL contexts and two workers.
createRoot(document.getElementById("root") as HTMLElement).render(<App />);

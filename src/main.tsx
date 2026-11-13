import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyTheme } from "./theme";
import { useStore } from "./store";

// Before the first render, so a light theme never flashes dark (or the other way round).
applyTheme(useStore.getState().theme);
useStore.subscribe((s, prev) => {
  if (s.theme !== prev.theme) applyTheme(s.theme);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

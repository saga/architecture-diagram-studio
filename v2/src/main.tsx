import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import DrawioRenderLab from "./DrawioRenderLab";
import "antd/dist/reset.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.location.pathname === "/drawio-lab" ? <DrawioRenderLab /> : <App />}
  </React.StrictMode>
);
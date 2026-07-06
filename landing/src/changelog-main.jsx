import React from "react";
import { createRoot } from "react-dom/client";
import Changelog from "./Changelog.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Changelog />
  </React.StrictMode>
);

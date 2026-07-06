import React from "react";
import { createRoot } from "react-dom/client";
import DocsApp from "./docs/DocsApp.jsx";
import { slugFromPath } from "./docs/paths.js";
import "./index.css";

// Every /docs/*.html page shares this entry; the slug picks the section.
const slug = slugFromPath(window.location.pathname);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DocsApp slug={slug} />
  </React.StrictMode>
);

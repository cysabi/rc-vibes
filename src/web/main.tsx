import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./api.ts";
import { App } from "./App.tsx";
import { prepareBackdrops } from "./backdrop.ts";
import "@fontsource-variable/recursive/full.css";
import "./styles.css";

// The color editor's backdrops' tables, as the page loads rather than when a picker first opens.
void prepareBackdrops();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

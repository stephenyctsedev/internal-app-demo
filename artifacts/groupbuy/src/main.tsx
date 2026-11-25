import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WebAnalytics } from "../../shared/analytics";
import { App } from "./App";
import "./theme.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 } },
});

const rootEl = document.getElementById("root")!;
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <WebAnalytics />
    </QueryClientProvider>
  </StrictMode>,
);

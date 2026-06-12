import { QueryClient } from "@tanstack/react-query";

// ローカル単一サーバ + SSE 駆動の無効化に最適化した既定オプション。
// 時間ベースの陳腐化は不要（SSE / undo / mutation が明示的に invalidate する）。
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: false,
      },
    },
  });
}

// HMR をまたいで同一インスタンスを保持し、キャッシュ消失や「複数クライアント」を防ぐ。
// frontend.tsx の `import.meta.hot.data.root` 退避パターンに倣う。
// biome-ignore lint/suspicious/noAssignInExpressions: Bun HMR pattern
export const queryClient: QueryClient = (import.meta.hot.data.queryClient ??=
  createQueryClient());

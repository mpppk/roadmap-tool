import { useQueries, useQuery } from "@tanstack/react-query";
import { orpc } from "./orpc-client";

// クエリキー工場。配列キーにすることで接頭辞単位の部分無効化が可能。
// epicView / memberView は後続 PR（CapacityView / MembersView 移行）で使用する。
export const queryKeys = {
  visions: () => ["visions"] as const,
  strategicIntents: () => ["strategicIntents"] as const,
  initiatives: () => ["initiatives"] as const,
  epics: () => ["epics"] as const,
  quarters: () => ["quarters"] as const,
  members: () => ["members"] as const,
  epicView: (epicId: number) => ["epicView", epicId] as const,
  memberView: (memberId: number) => ["memberView", memberId] as const,
};

// 読み取り用 useQuery ラッパ。戻り値の型は oRPC クライアントの推論に任せる。
export function useVisionsQuery() {
  return useQuery({
    queryKey: queryKeys.visions(),
    queryFn: () => orpc.visions.list({}),
  });
}

export function useStrategicIntentsQuery() {
  return useQuery({
    queryKey: queryKeys.strategicIntents(),
    queryFn: () => orpc.strategicIntents.list({}),
  });
}

export function useInitiativesQuery() {
  return useQuery({
    queryKey: queryKeys.initiatives(),
    queryFn: () => orpc.initiatives.list({}),
  });
}

export function useEpicsQuery() {
  return useQuery({
    queryKey: queryKeys.epics(),
    queryFn: () => orpc.epics.list({}),
  });
}

export function useMembersQuery() {
  return useQuery({
    queryKey: queryKeys.members(),
    queryFn: () => orpc.members.list({}),
  });
}

export function useQuartersQuery() {
  return useQuery({
    queryKey: queryKeys.quarters(),
    queryFn: () => orpc.quarters.list({}),
  });
}

// per-member fan-out: 各メンバーの getMemberView を個別のキャッシュエントリとして取得する。
// 生データを返し、ビューモデルへの変換は呼び出し側の useMemo で行う。
export function useMemberViewsQueries(memberIds: number[]) {
  return useQueries({
    queries: memberIds.map((memberId) => ({
      queryKey: queryKeys.memberView(memberId),
      queryFn: () => orpc.allocations.getMemberView({ memberId }),
    })),
  });
}

// per-epic fan-out: 各 epic の getEpicView を個別のキャッシュエントリとして取得する。
// 生データを返し、ビューモデルへの変換は呼び出し側の useMemo で行う。
export function useEpicViewsQueries(epicIds: number[]) {
  return useQueries({
    queries: epicIds.map((epicId) => ({
      queryKey: queryKeys.epicView(epicId),
      queryFn: () => orpc.allocations.getEpicView({ epicId }),
    })),
  });
}

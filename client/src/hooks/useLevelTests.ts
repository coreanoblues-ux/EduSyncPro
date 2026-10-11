import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LevelTest } from "@shared/schema";

/**
 * 레벨테스트 기록 조회 (레벨테스트 화면과 상담 화면이 함께 쓴다).
 *
 * ── 왜 전역 기본값을 따르지 않고 훅으로 따로 뺐는가 ──
 *   이 앱의 queryClient 기본값은 staleTime: Infinity · 창 복귀 시 재조회 없음이다.
 *   그 기본값은 "저장도 조회도 같은 탭에서 일어난다"는 전제 위에 서 있다.
 *   수납·학생 화면은 저장 직후 invalidateQueries 로 캐시를 깨우니 성립한다.
 *
 *   레벨테스트만 전제가 다르다. 저장 버튼은 **다른 탭**(레벨테스트 앱)에 있다.
 *   다른 탭의 저장은 이 탭의 캐시를 건드릴 수 없어서, 채점을 마치고 돌아와도
 *   목록이 처음 열었을 때 그대로였다. 기록은 서버에 멀쩡히 있는데 화면만
 *   "아직 기록이 없습니다" 라고 말하는 상태 — 실제로 그렇게 신고가 들어왔다.
 *
 *   그 설정을 화면마다 복사해 두면 한쪽만 고쳐져 같은 사고가 되살아난다.
 *   그래서 한 곳에 모은다. 전역 기본값은 건드리지 않는다 (수납·결제 화면의
 *   재조회 동작까지 흔들 이유가 없다).
 */

/** 목록 응답은 결과지 원본(raw_state)을 빼고 온다 — 서버가 일부러 제외한다. */
export type LevelTestRow = Omit<LevelTest, "rawState">;

export const LEVEL_TESTS_QUERY_KEY = ["/api/level-tests"];

/**
 * 레벨테스트 앱이 저장에 성공할 때마다 이 키에 시각을 남긴다.
 * 같은 브라우저의 다른 탭들은 storage 이벤트로 그 사실을 전해 듣는다.
 * 앱(apps/level-test/index.html)과 문자열이 정확히 같아야 한다.
 */
export const LEVEL_TEST_SAVED_SIGNAL = "edusync-level-test-saved";

export function useLevelTests() {
  const qc = useQueryClient();

  // 두 창을 나란히 띄워 둔 경우에는 "창 복귀" 이벤트가 오지 않는다. 그 경우까지
  // 덮으려고 앱이 남기는 저장 신호를 같이 듣는다. storage 이벤트는 같은 출처의
  // **다른** 탭에서만 오므로 저장한 탭 자신과는 겹치지 않는다.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LEVEL_TEST_SAVED_SIGNAL) {
        qc.invalidateQueries({ queryKey: LEVEL_TESTS_QUERY_KEY });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [qc]);

  return useQuery<LevelTestRow[]>({
    queryKey: LEVEL_TESTS_QUERY_KEY,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}

/** 레벨테스트 앱을 새 탭으로 연다. 결과지 인쇄(A4 mm 단위 CSS)를 지키려고 iframe 을 쓰지 않는다. */
export function openLevelTestApp(recordId?: string) {
  const url = recordId
    ? `/level-test/app?record=${encodeURIComponent(recordId)}`
    : "/level-test/app";
  // noopener: 새 탭이 window.opener 로 이 화면을 조작하지 못하게 한다.
  window.open(url, "_blank", "noopener");
}

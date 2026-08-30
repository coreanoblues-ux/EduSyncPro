/**
 * 자동 대사(對査) — "카드는 승인됐는데 장부에 없는 건"을 사람 없이 되찾는다.
 *
 * ── 왜 이 파일이 생겼나 (2026-08-30, 원장 요청) ──
 *   원장이 말한 증상 그대로다:
 *     "실제로는 승인이 되었는데 웹앱에서는 processing 이라고 나왔다가 expired 로
 *      바뀌고, 결국 사장님앱에서 승인번호를 확인해서 수기로 눌러야 한다. 너무 번거롭다."
 *
 *   그 번거로움은 기능 부족이 아니라 구조의 구멍이었다. 지금까지 서버가 "카드가
 *   긁혔다"는 사실을 알 수 있는 통로는 **단 하나**, 플러그인이 보내 주는 confirm
 *   요청뿐이었다. 그 요청 한 번이 실패하면(와이파이 끊김·웹뷰 리로드·단말기 재시작)
 *   서버는 영영 알 방법이 없다. 만료 스위퍼는 시계만 보고 TIMEOUT 을 찍는다 —
 *   단말기에 물어보지도 않고. 그래서 돈은 나갔는데 장부는 비어 있게 된다.
 *
 * ── 무엇이 이걸 고칠 수 있게 해 주는가 ──
 *   토스플레이스 Front Plugin SDK 문서(docs.tossplace.com/reference/plugin-sdk/front/payment.html)
 *   에 정확히 이 상황을 위한 장치가 있다:
 *
 *     sdk.payment.getPayment({ paymentKey })
 *       "WebView reload, 페이지 이동, JS 런타임 재초기화 등으로 데이터를 유실했을
 *        경우 사용해요"
 *       · 단말기에 **14일** 동안 캐시된다
 *       · 최대 1,000건
 *       · **SUCCESS 결과만** 캐시된다 (CANCELED·TIMEOUT·승인실패는 캐시 안 됨)
 *       · 없으면 PAYMENT_NOT_FOUND
 *
 *   그리고 결정적으로, paymentKey 는 **우리가 만든다**:
 *     "paymentKey는 토스에서 발급하는 값이 아니라 파트너가 만들어 전달하는
 *      중복되지 않는 결제 식별자예요. 64자 이하로 만들어주세요."
 *
 *   즉 서버는 자기가 발급한 paymentKey 를 이미 알고 있으므로, 단말기에게
 *   "이 건 승인됐었니?" 하고 되물을 수 있다. 되물을 수 있으면 사람이 사장님앱을
 *   열 이유가 없다.
 *
 *   "SUCCESS 만 캐시된다"는 성질이 이 설계의 안전장치다. 진짜로 실패한 결제는
 *   단말기도 모른다고 답한다 — 그래서 없는 돈을 장부에 만들어 낼 수가 없다.
 *   270,000원짜리 진짜 실패 건이 자동으로 장부에 들어가는 일은 일어나지 않는다.
 *
 * ── 흐름 ──
 *   1. 스위퍼가 만료된 intent 를 TIMEOUT 으로 찍는다 (기존 동작, 그대로 둔다)
 *   2. 단말기가 평소처럼 /dispatch/pending 을 폴링한다
 *   3. 서버가 응답에 recover: [paymentKey...] 를 얹어 준다 ← 이 파일이 그 목록을 고른다
 *   4. 단말기가 getPayment 로 각각을 확인한다
 *        · SUCCESS      → 평소의 /payments/confirm 을 그대로 호출 (지각 승인으로 기록됨)
 *        · NOT_FOUND    → /payments/recovery-result 로 "승인 없음" 을 보고
 *   5. 서버는 "승인 없음" 을 failureReason 에 적어 두고 다시 묻지 않는다
 *
 *   새 테이블도, 새 컬럼도 필요 없다. 마이그레이션 없이 배포된다는 뜻이고,
 *   운영 DB 를 건드리지 않는다는 뜻이다.
 */

/**
 * "단말기에 물어봤더니 승인된 적 없다더라" 를 적어 두는 표식.
 *
 * 왜 failureReason 에 글자로 남기나:
 *   전용 컬럼을 새로 만들면 운영 DB 마이그레이션이 필요하다. 그 위험을 지지 않으려고
 *   이미 있는 칸을 쓴다. 부수 효과도 좋다 — 원장 화면의 실패 사유에 "단말기 확인:
 *   승인 없음" 이 그대로 보이므로, 그 건은 수기 대사를 눌러 볼 필요조차 없다는 걸
 *   사람이 바로 알 수 있다.
 */
export const VERIFIED_NO_APPROVAL = "단말기 확인: 승인 없음";

/**
 * getPayment 캐시 수명. 문서가 14일이라고 못 박았으므로 그보다 오래된 건은
 * 물어봐야 소용이 없다. 하루 여유를 두고 13일로 자른다 — 경계에서 굳이
 * 헛물을 켜지 않으려는 것뿐이다.
 */
export const RECOVERY_WINDOW_DAYS = 13;

/**
 * 한 번의 폴링에서 물어볼 최대 건수.
 *
 * 왜 제한하나: 단말기는 결제를 받는 게 본업이다. 밀린 게 50건이면 50번의
 * getPayment 가 폴링 한 번에 몰려 화면이 굳을 수 있다. 조금씩 나눠 물어도
 * 폴링은 계속 돌기 때문에 결국 다 확인된다. 급할 이유가 없다.
 */
export const RECOVERY_BATCH = 3;

export interface RecoveryCandidate {
  paymentKey: string;
  /** payment_intents.status */
  intentStatus: string;
  /** intent 가 만들어진 시각. getPayment 캐시 수명을 재는 기준. */
  createdAt: Date;
  /** 이 paymentKey 로 payments 에 양수(수입) 행이 이미 있는가. */
  alreadyLedgered: boolean;
  /** payment_intents.failure_reason (표식이 들어 있는지 본다) */
  failureReason: string | null;
}

/**
 * 단말기에게 "이거 승인됐었니?" 하고 물어볼 paymentKey 를 고른다.
 *
 * 순수 함수다 — DB 도 시계도 만지지 않는다. 돈이 걸린 판단이라 테스트로 못을
 * 박아 두려고 일부러 이렇게 갈라 놓았다. scripts/test-recovery.ts 참고.
 */
export function selectRecoveryKeys(
  candidates: RecoveryCandidate[],
  now: Date,
  limit: number = RECOVERY_BATCH
): string[] {
  const out: string[] = [];

  for (const c of candidates) {
    if (out.length >= limit) break;

    // 1) 이미 장부에 있으면 물어볼 이유가 없다. 어떤 경로로 들어왔든 돈은 적혀 있다.
    if (c.alreadyLedgered) continue;

    // 2) 아직 살아 있는 결제는 건드리지 않는다.
    //    CREATED/PROCESSING 은 지금 카드를 꽂고 있는 중일 수 있다. 그 와중에
    //    getPayment 를 시키면 결제 화면과 경합한다. 어차피 만료되면 (1)~(6) 을
    //    다시 통과해서 여기로 온다. 서두를 이유가 없다.
    //
    //    APPROVED 인데 장부에 없는 건은 confirm 이 반쯤 성공한 흔적이다. 이건
    //    단말기에 물어볼 게 아니라 수기 대사로 다뤄야 한다 — 승인 사실은 이미
    //    서버가 알고 있고, 실패한 건 장부 쓰기이기 때문이다.
    if (
      c.intentStatus === "CREATED" ||
      c.intentStatus === "PROCESSING" ||
      c.intentStatus === "APPROVED"
    ) {
      continue;
    }

    // 3) 이미 물어봤고 "승인 없음" 이라고 답을 받았으면 다시 묻지 않는다.
    //    이게 없으면 진짜 실패한 건(270,000원 같은)을 영원히 폴링마다 다시
    //    물어보게 된다. 단말기 입장에선 끝나지 않는 숙제다.
    if (c.failureReason && c.failureReason.includes(VERIFIED_NO_APPROVAL)) continue;

    // 4) 단말기 캐시가 살아 있는 기간 안의 건만. 그보다 오래됐으면 단말기도
    //    모른다 — 물어봐야 NOT_FOUND 만 돌아오고, 그 답이 "승인 안 됨" 인지
    //    "너무 오래돼서 잊었음" 인지 구분할 수 없다. 구분할 수 없는 답은
    //    장부에 반영할 근거가 못 되므로 아예 묻지 않는다.
    const ageMs = now.getTime() - new Date(c.createdAt).getTime();
    if (ageMs > RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000) continue;

    // 5) 미래에 만들어진 것처럼 보이는 건(시계 뒤틀림)은 건너뛴다.
    if (ageMs < 0) continue;

    out.push(c.paymentKey);
  }

  return out;
}

/**
 * 단말기가 "승인 없음" 이라고 답했을 때 failure_reason 에 적을 문장을 만든다.
 *
 * 기존 사유를 지우지 않고 덧붙인다. "expired" 는 그것대로 사실이고, 거기에
 * "단말기에도 없더라" 가 더해지면 원장이 그 건을 어떻게 처리해야 할지가
 * 분명해진다 — 아무것도 안 해도 된다.
 */
export function markVerifiedNoApproval(existing: string | null): string {
  if (existing && existing.includes(VERIFIED_NO_APPROVAL)) return existing;
  return existing ? `${existing} · ${VERIFIED_NO_APPROVAL}` : VERIFIED_NO_APPROVAL;
}

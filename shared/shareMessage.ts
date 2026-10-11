/**
 * 학부모에게 보낼 메시지 문구를 만든다 (카카오톡·문자에 붙여 넣는 용도).
 *
 * ════════════════════════════════════════════════════════════════════════
 * 왜 "보내기" 가 아니라 "복사" 인가 — 이 파일에서 가장 중요한 결정
 * ════════════════════════════════════════════════════════════════════════
 *   문자 발송 API(알리고·솔라피 등)를 붙이면 버튼 한 번으로 보낼 수 있다.
 *   그런데 그렇게 하면 이 프로그램이 짊어지는 것이 한꺼번에 늘어난다:
 *
 *     · 발송 실패를 누가 어떻게 알아차리는가 (실패하면 조용히 안 간다)
 *     · 문자 요금이 건당으로 붙고, 잘못 보낸 것도 요금이다
 *     · 발신번호 사전등록·광고성 메시지 규제 같은 법적 의무가 따라온다
 *     · 무엇보다 **잘못된 사람에게 보낸 것을 되돌릴 수 없다**
 *
 *   복사 방식은 이 전부를 원장이 이미 쓰는 카카오톡에 맡긴다. 보내기 전에
 *   받는 사람 얼굴을 보고 누르고, 오타는 고쳐서 보내고, 잘못 보내면 카카오톡이
 *   삭제해 준다. 자동화의 목적은 "사람 손을 없애는 것" 이 아니라 "사람이 판단할
 *   자리만 남기는 것" 이다. 보내는 순간은 판단이 필요한 자리다.
 *
 * ════════════════════════════════════════════════════════════════════════
 * 문구를 짤 때 지킨 것
 * ════════════════════════════════════════════════════════════════════════
 *   · **점수를 문구 안에 넣는다.** 링크를 안 눌러도 총점은 전달되게 한다.
 *     링크를 눌러야만 알 수 있게 만들면 안 누르는 학부모에게는 아무것도
 *     전달되지 않는다.
 *   · **기한을 적는다.** "나중에 보려니 안 열리던데요" 전화를 미리 막는다.
 *   · **전화 상담으로 유도하고 끝낸다.** 등록을 재촉하는 말은 넣지 않는다.
 *     재촉은 원장이 통화에서 할 일이고, 글로 적힌 재촉은 기록으로 남는다.
 *   · **학부모 이름을 넣지 않는다.** 상담 기록의 이름이 학생 이름인지
 *     보호자 이름인지 섞여 있어서, 틀린 호칭을 부르는 쪽이 훨씬 나쁘다.
 */

/** 문구에 필요한 값만 받는다. DB 행을 그대로 받지 않는 이유는 아래 주석 참조. */
export interface ShareMessageInput {
  academyName: string;
  studentName: string;
  /** YYYY-MM-DD */
  testDate: string;
  examTitle: string;
  totalScore: number | null;
  questionCount?: number | null;
  correctCount?: number | null;
  /** 전체 주소. 예: https://....up.railway.app/r/<토큰> */
  url: string;
  /** 링크 만료일. 없으면 기한 문장을 넣지 않는다. */
  expiresAt?: Date | string | null;
}

/** 2026-10-11 → 10월 11일 */
function shortDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? `${Number(m[2])}월 ${Number(m[3])}일` : ymd;
}

/** Date | "2026-12-10" → "12월 10일" */
function expiryDate(value: Date | string): string {
  if (typeof value === "string") return shortDate(value);
  return `${value.getMonth() + 1}월 ${value.getDate()}일`;
}

/**
 * 붙여 넣을 메시지 전문.
 *
 * ── 왜 DB 행이 아니라 값만 받는가 ──
 *   행을 그대로 받으면 나중에 누군가 편하게 `row.parentPhone` 을 문구에
 *   끼워 넣을 수 있다. 학부모에게 보내는 글에 학부모 연락처가 들어가는 건
 *   무의미하고, 단체 발송 실수 때 남의 번호가 새는 길이 된다. 애초에 이
 *   함수가 연락처를 받지 못하게 해 둔다.
 */
export function buildShareMessage(input: ShareMessageInput): string {
  const lines: string[] = [];

  lines.push(`안녕하세요, ${input.academyName}입니다.`);
  lines.push(`${input.studentName} 학생 레벨테스트 결과를 보내 드립니다.`);
  lines.push("");
  lines.push(`· 응시일: ${shortDate(input.testDate)}`);
  lines.push(`· 시험: ${input.examTitle}`);

  // 점수가 없는 기록(채점 중)은 애초에 링크를 만들 수 없게 막아 두었지만,
  // 이 함수만 따로 불릴 수도 있으니 숫자가 없으면 그 줄을 빼는 쪽으로 둔다.
  // "총점: null점" 이 학부모에게 가는 것보다 한 줄 없는 편이 낫다.
  if (input.totalScore != null) {
    const detail =
      input.questionCount != null && input.correctCount != null
        ? ` (${input.questionCount}문항 중 ${input.correctCount}문항 정답)`
        : "";
    lines.push(`· 총점: ${input.totalScore}점${detail}`);
  }

  lines.push("");
  lines.push(`결과지 자세히 보기`);
  lines.push(input.url);

  if (input.expiresAt) {
    lines.push("");
    lines.push(`※ 링크는 ${expiryDate(input.expiresAt)}까지 열어 보실 수 있습니다.`);
  }

  lines.push("");
  lines.push("결과에 대한 설명과 반 배정 안내는 전화로 상담해 드리겠습니다.");
  lines.push("궁금하신 점 있으시면 언제든 연락 주세요. 감사합니다.");

  return lines.join("\n");
}

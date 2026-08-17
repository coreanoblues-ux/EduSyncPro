/**
 * 자연어 한 줄 입력 → 구조화된 초안(draft) 변환
 *
 * 설계 원칙
 *  1. OpenAI 결과는 "초안"일 뿐이다. 저장은 원장이 확인 버튼을 누른 뒤에만 일어난다.
 *  2. 틀리면 회계가 망가지는 값(전화번호·금액·유형)은 nlpNormalize.ts의 순수 함수가
 *     원문에서 직접 다시 뽑아 AI 결과를 덮어쓴다. AI가 규칙을 어겨도 코드가 막는다.
 *  3. 다만 "무슨 일이 있었는가"(등록/결제/상담)의 판단은 AI가 문맥으로 하고,
 *     코드는 낱말이 명백할 때만 개입한다. 예전에는 전화번호 유무만으로 분류를
 *     강제했는데, 그 탓에 "정재현 숭의중1 등록 결제 28만"처럼 연락처 없는
 *     등록+결제 문장이 통째로 되물어졌다.
 *  4. 확신이 없으면 추측하지 않고 category="unclear"로 되돌려 원장에게 되묻는다.
 *
 * 의존성 없음 — Node 18+ 내장 fetch를 사용한다. (openai SDK 설치 불필요)
 */

import {
  extractPhones,
  extractAmounts,
  normalizePhone,
  normalizeMonth,
  cleanStudentName,
  isPlausibleAmount,
  AMOUNT_MIN,
  AMOUNT_MAX,
  extractDueDay,
  extractStartDate,
  extractConsultationStatus,
  extractPaymentType,
  extractPaymentMethod,
  extractClassAction,
  extractClassTime,
  extractMaxStudents,
  extractPersonAction,
  extractSubject,
  extractCommandName,
  extractLeadingName,
  extractLookupName,
  extractTeacherName,
  extractClassNameFromText,
  looksLikeInquiry,
  looksLikeTask,
  looksLikeStudentList,
  looksLikeDownload,
  extractGradeFilter,
  extractTimeFilter,
  extractTaskSlot,
  extractTaskTitle,
  extractTaskDue,
  type PersonTarget,
  type PersonAction,
  type TaskSlotHint,
} from "./nlpNormalize";
import { ymdKst } from "@shared/day";
import { canonicalGrade, expandSchoolName } from "@shared/gradePromotion";
import { parseDays, type Day } from "@shared/timetable";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/**
 * "숭의중1"은 AI가 school="숭의중", grade="1학년"으로 쪼개 준다. 그대로 두면
 * 학교는 줄임말로, 학년은 급을 알 수 없는 "1학년"으로 쌓인다. 들어오는 길목에서
 * 정식 학교명과 "중1" 꼴로 통일한다.
 */
function normalizedSchool(ai: { school?: string | null }): string | null {
  return expandSchoolName(ai.school) || null;
}

/**
 * 학년을 "중1" 꼴로 굳힌다. 학교 이름이 급을 알려주므로 같이 넘긴다
 * ("1학년" + "숭의중" → "중1"). 못 읽으면 원문을 그대로 둔다.
 */
function normalizedGrade(ai: {
  grade?: string | null;
  school?: string | null;
}): string | null {
  const raw = ai.grade?.trim() || null;
  return canonicalGrade(raw, ai.school) ?? raw;
}

export type PaymentType = "원비" | "환불" | "지출" | "기타";
export type PaymentMethod = "계좌이체" | "카드" | "현금";
export type ConsultationStatus = "상담문의" | "대기등록" | "최종등록" | "보류";

/** 등록과 동시에 받은 돈. 수강등록이 만들어진 뒤 그 enrollmentId에 붙는다. */
export interface PaymentPart {
  /**
   * null은 "결제완료라고만 적고 금액은 안 적었다"는 뜻이다.
   *
   * 예전에는 금액이 없으면 이 객체 자체를 만들지 않았는데, 그러면 원장이 분명
   * "결제완료"라고 썼는데도 조용히 미납으로 남았다. 화면에서 고른 반의 수강료로
   * 채워 준 뒤에야 저장되므로 지어낸 금액이 회계에 들어갈 일은 없다.
   */
  amount: number | null;
  type: PaymentType;
  method: PaymentMethod | null;
  paymentMonth: string; // YYYY-MM
}

/** 문장에 적힌 반 식별 재료. 실제 반은 서버가 학원 반 목록과 대조해 확정한다. */
export interface ClassHint {
  scheduleDays: string[] | null; // ["화","목"]
  teacherName: string | null; // "정우석"
  level: string | null; // "심화"
}

export interface AccountingDraft {
  category: "accounting";
  studentName: string | null;
  /**
   * 원비=양수, 환불·지출=음수.
   *
   * null은 "원장이 금액을 안 적었다"는 뜻이다. 급할 때 "김민 수납"만 치는 경우를
   * 위해 허용했고, 화면에서 그 학생의 수강료로 채워 준다. 금액이 빈 채로는
   * 저장되지 않으므로 지어낸 금액이 회계에 들어갈 일은 없다.
   */
  amount: number | null;
  type: PaymentType;
  paymentMonth: string; // YYYY-MM
  method: PaymentMethod | null;
  memo: string | null;
}

/**
 * 사람(학생·교사) 정보를 고치거나 교사를 새로 넣는 사건.
 *
 * 학생 신규 생성은 여기 없다. 신규 학생은 반 배정과 납부 기준일이 함께 잡혀야 해서
 * 기존 등록(registration) 흐름으로만 만든다.
 */
export interface PersonDraft {
  category: "person";
  target: PersonTarget;
  action: PersonAction;
  /** 대상을 찾을 이름. 부분 이름이어도 서버가 후보를 붙여 준다. */
  name: string | null;
  /** 원문에서 알아들은 값만 채운다. null은 "언급 없음" = 기존 값 유지. */
  school: string | null;
  grade: string | null;
  phone: string | null;
  subject: string | null;
  notes: string | null;
}

/**
 * 학생이 새로 수업을 시작하는 사건. 저장 시 학생 → 수강등록 → (있으면) 수납 순으로 만든다.
 * payments.enrollmentId가 필수라 순서를 뒤집을 수 없다.
 */
export interface RegistrationDraft {
  category: "registration";
  studentName: string | null;
  school: string | null;
  grade: string | null;
  /** 없으면 null. 원장이 확인 화면에서 채운다 — 없다고 등록을 막지 않는다. */
  parentPhone: string | null;
  guardianName: string | null;
  classHint: ClassHint;
  startDate: string | null; // YYYY-MM-DD
  dueDay: number | null;
  /** 등록과 동시에 결제까지 있었으면 채워진다. 등록만이면 null. */
  payment: PaymentPart | null;
  subject: string | null;
  memo: string | null;
}

export interface ContactDraft {
  category: "contact";
  /** 통화 중 입력을 위해 비어 있을 수 있다. 저장 전에 화면에서 반드시 채운다. */
  phone: string | null;
  guardianName: string | null;
  studentName: string | null;
  studentGrade: string | null;
  status: ConsultationStatus;
  subject: string | null;
  followUp: string | null;
  memo: string | null;
  /** 최종등록으로 저장할 때 수강 등록에 넣을 값. 문장에 없으면 null이고 원장이 직접 채운다. */
  dueDay: number | null;
  startDate: string | null; // YYYY-MM-DD
}

/**
 * 반 자체를 만들거나 고치는 사건. 학생이 아니라 시간표를 건드리는 말이다.
 *
 * teacherId는 여기서 정하지 않는다. 문장에는 "정우석 선생님"이라는 이름만 있고
 * 실제 강사 목록과 대조하는 것은 서버(routes.ts)의 일이다.
 */
export interface ClassDraft {
  category: "class";
  action: "create" | "update";
  /** 수정이면 대상 반을 찾을 재료, 생성이면 새 반의 재료 */
  classHint: ClassHint;
  name: string | null;
  subject: string | null;
  /** "화목 19:00-21:00" 형태. 시간이 없으면 요일만 들어간다. */
  schedule: string | null;
  teacherName: string | null;
  defaultTuition: number | null;
  maxStudents: number | null;
  memo: string | null;
}

/**
 * 이름만 덜렁 친 경우. 아무것도 만들지 않고 그 학생의 현재 상태만 보여준다.
 *
 * "정재현"만 치는 것은 등록도 수납도 아니고 "쟤 지금 어떤 상태지?"라는 질문이다.
 * 예전엔 "판단 불가"로 되물었는데, 원장이 가장 자주 하는 일이 이 조회였다.
 */
export interface LookupDraft {
  category: "lookup";
  name: string;
}

/**
 * 퇴근 전에 끝내야 하는 할 일.
 *
 * 날짜는 원장이 적지 않는다. 어차피 오늘 안에 할 일이라 기기의 오늘 날짜가
 * 자동으로 들어가는 것이 맞고, "내일"이라고 적었을 때만 밀린다.
 */
export interface TaskDraft {
  category: "task";
  title: string;
  dueDate: string; // YYYY-MM-DD
  slot: TaskSlotHint;
}

/**
 * 특정 요일·시간·강사·학년 조건에 맞는 학생 목록 조회.
 *
 * "월 수 학생 목록 보여줘", "화 목 정우석 선생님 6시 수업 학생 목록" 같은 문장을
 * 받으면 조건에 맞는 학생들을 표로 보여준다. "다운로드"가 있으면 CSV로 내보낸다.
 *
 * 실제 학생 데이터는 서버(routes.ts)에서 채운다. 여기는 필터 조건만 넘긴다.
 */
export interface StudentListDraft {
  category: "student-list";
  /** 필터 요일. null이면 전체 요일 */
  days: Day[] | null;
  /** 필터 강사 이름. null이면 전체 강사 */
  teacherName: string | null;
  /** 필터 시간(시 단위, 24시간). null이면 전체 시간 */
  timeHour: number | null;
  /** 학년 필터. "중2", "중", "고1" 등. null이면 전체 학년 */
  gradeFilter: string | null;
  /** 다운로드(CSV) 의도가 있는가 */
  download: boolean;
}

export interface UnclearDraft {
  category: "unclear";
  reason: string;
  /** 원장에게 되물을 구체적인 질문 */
  question: string;
}

export type Draft =
  | AccountingDraft
  | RegistrationDraft
  | ContactDraft
  | ClassDraft
  | PersonDraft
  | LookupDraft
  | TaskDraft
  | StudentListDraft
  | UnclearDraft;

export type ParseResult = {
  draft: Draft;
  sourceText: string;
  /** 코드 검증 단계에서 AI 결과를 고친 내역 — UI에 "이렇게 해석했습니다"로 보여준다 */
  corrections: string[];
};

// ─── OpenAI 호출 ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 EduSyncPro의 자연어 입력 분석기입니다.

## 당신이 일하는 시스템
한국 영어학원 원장이 쓰는 학원 관리 시스템입니다. 원장은 상담 전화를 받거나
학생을 등록시키거나 학원비를 받은 직후, 그 사실을 한 줄 메모처럼 적습니다.
당신의 일은 그 한 줄을 읽고, 시스템의 어느 표에 무엇을 넣어야 하는지 판단해
구조화된 초안을 만드는 것입니다.

저장은 당신이 하지 않습니다. 원장이 화면에서 확인하고 수정한 뒤 버튼을 눌러야
저장됩니다. 그러니 확신이 없으면 비워 두십시오(null). 빈칸은 원장이 1초 만에
채우지만, 그럴듯하게 지어낸 값은 그대로 저장되어 회계를 망칩니다.

## 데이터 모델
students(학생)      : name, school, grade, parentPhone, notes
classes(반)         : name, subject, schedule(예 "화목"), defaultTuition, teacherId
teachers(강사)      : name, subject
enrollments(수강등록): studentId, classId, tuition, dueDay(기본 8), startDate
payments(수납)      : enrollmentId, amount, type, method, paymentMonth
consultations(상담) : phone, guardianName, studentName, studentGrade, status
waiters(대기자)     : classId, name, phone

연결 구조가 중요합니다:
  학생 ─ 수강등록 ─ 반 ─ 강사
            └ 수납

수납은 학생에 직접 붙지 않고 반드시 "수강등록"을 통해 붙습니다. 따라서 어떤
학생이 처음 등록하면서 동시에 돈을 냈다면, 그것은 "학생 생성 → 수강등록 생성
→ 그 등록에 대한 수납" 세 가지가 한꺼번에 일어난 사건입니다. 이 경우
enroll과 payment를 둘 다 true로 표시하십시오.

## 작업 방식 — 규칙을 찾기 전에 문장을 이해하십시오

이 문장은 원장이 방금 겪은 일을 적은 것입니다. 패턴 매칭을 하지 마십시오.
사람이 메모를 읽듯이 다음 순서로 생각하십시오.

1단계. 무슨 일이 있었는가?
   새 학생이 들어왔는가, 돈이 오갔는가, 전화 문의만 왔는가, 아니면 여러 개가
   동시에 일어났는가? 먼저 사건 전체를 파악하십시오.

2단계. 문장에 등장하는 각 숫자는 무엇인가?
   숫자 하나하나에 대해 "이게 무엇의 숫자인지" 스스로 답한 뒤 배치하십시오.
   한국어에서 숫자 뒤에 붙는 글자가 그 숫자의 정체를 알려줍니다.
     · 뒤에 "월"이 오면 → 날짜(몇 월분)이거나 기간(몇 개월)입니다. 금액이 아닙니다.
       "7월"은 7원이 될 수 없습니다.
     · 뒤에 "원"·"만"·"만원"이 오면 → 금액입니다.
     · 뒤에 "일"이 오면 → 날짜 또는 납부 기준일입니다.
     · 뒤에 "학년"이 오거나 학교 이름 바로 뒤에 붙으면 → 학년입니다.
       "숭의중1"의 1은 1학년이며, 금액도 날짜도 아닙니다.
     · "010"으로 시작하는 긴 숫자 → 전화번호입니다.
   판단한 내용을 number_readings에 그대로 적으십시오. 이 항목은 당신의 추론
   과정을 검증하는 데 쓰이므로, 문장의 모든 숫자를 빠짐없이 넣어야 합니다.

3단계. 각 정보를 알맞은 자리에 넣으십시오.

## 어순에 얽매이지 마십시오
같은 뜻이면 순서가 달라도 같게 읽어야 합니다.
  "28만원 결제" = "결제 28만원" = "28만원 냈어요" = "28만원 입금 확인"
  "정재현 등록" = "등록한 학생 정재현" = "정재현이 다니기로 함"
조사가 붙거나("정재현이"), 생략되거나("정재현 숭의중1"), 구어체여도
("28만원 받았어요") 동일하게 처리하십시오.

## 사건 판정
아래 낱말은 예시일 뿐입니다. 나열되지 않았더라도 문맥상 같은 뜻이면 같게
처리하십시오.

enroll = true  (학생이 새로 수업을 시작함 → 학생·수강등록 생성 대상)
  예: 등록, 신규등록, 다니기로 함, 수업 시작, 들어옴, 반에 넣어줌, 입반

payment = true (돈을 받음 → 수납 생성 대상)
  예: 결제, 납부, 수납, 입금했어요, 카드로 냄, 계좌로 보냄, 완납

consultation = true (문의·상담 기록 대상)
  예: 문의, 상담, 알아봄, 전화 옴, 물어봄

동시 발생을 반드시 허용하십시오.
  · 등록 + 결제가 함께 있으면 → enroll=true, payment=true (둘 다입니다)
  · 문의·상담만 있고 등록도 결제도 없으면 → consultation=true만
  · 대기 의사면 → status="대기등록"
  · 보류·취소면 → status="보류"

class_action = "생성" 또는 "수정" (반 자체를 다루는 문장)
  이것은 학생에 관한 사건이 아니라 학원의 시간표를 바꾸는 사건입니다.
  "생성" 예: 반 신설, 반 개설, 새 반 만들기, 반 하나 만들어줘
  "수정" 예: 반 이름 변경, 수강료 변경, 수업 시간 변경, 담당 강사 변경, 정원 조정

  반 문장을 만나면 enroll·payment·consultation을 모두 false로 두십시오.
  반을 만드는 것과 학생을 등록시키는 것은 서로 다른 사건입니다.

  반대로 학생 이름이 나오고 그 학생이 어느 반에 들어간다는 뜻이면 그것은
  등록입니다. class_action은 null로 두십시오.
    "강단우 국어반 추가"      → enroll=true, class_action=null (학생을 반에 넣는 말)
    "국어반 하나 더 개설"     → class_action="생성" (반을 만드는 말)

  반 문장일 때 채워야 할 항목:
    class_name    반 이름. 문장에 이름이 있으면 그대로. ("중등심화반")
                  수정이면 "어느 반을 고치는지" 가리키는 이름을 넣으십시오.
    subject       과목. ("영어", "국어")
    schedule_days 요일 배열. ("화목" → ["화","목"])
    class_time    수업 시간대. ("19:00-21:00", "7시~9시" → "19:00-21:00")
    teacher_name  담당 강사 이름. 호칭은 떼십시오.
    amount        수강료. 만원 환산은 동일하게 적용합니다.
    max_students  정원. ("정원 20명" → 20)
  없는 것은 null로 두십시오. 반 이름을 지어내지 마십시오.

person_action = "학생수정" / "교사추가" / "교사수정"
  원장이 외워서 치는 고정 명령어입니다. 문장이 이 말로 시작하면 그 뒤는 전부
  "무엇을 어떻게 바꿀지"에 대한 설명입니다.
    "학생 수정 김민준 학교 숭의중으로"  → person_action="학생수정",
                                          student_name="김민준", school="숭의중"
    "교사 추가 박지훈 수학 010-1111-2222" → person_action="교사추가",
                                          teacher_name="박지훈", subject="수학",
                                          parent_phone="010-1111-2222"
    "교사 수정 정우석 과목 국어로"        → person_action="교사수정",
                                          teacher_name="정우석", subject="국어"
  이때 enroll·payment·consultation은 모두 false, class_action은 null입니다.
  바꾸라고 하지 않은 항목은 반드시 null로 두십시오. 기존 값을 지우게 됩니다.

## 금액 규칙
"만"·"만원"은 10000을 곱합니다. 28만 → 280000, 35만원 → 350000.
amount는 항상 양수로 적으십시오. 환불·지출 여부는 payment_type으로만 표현합니다.
"결제"·"납부"를 환불로 뒤집지 마십시오. 환불은 "환불"이라고 명시된 경우뿐입니다.

## 반 식별
반은 "요일 + 담당 강사 + 레벨"의 조합으로 지목됩니다. 각각을 따로 뽑으십시오.
  "정우석 선생님 화 목 심화" → schedule_days=["화","목"], teacher_name="정우석",
                                class_level="심화"
"선생님"·"쌤"·"T" 같은 호칭은 이름에서 떼어내십시오.
셋 중 일부만 있어도 있는 것만 채우고 나머지는 null로 두십시오.
실제 반 이름은 서버가 학원의 반 목록과 대조해 확정하므로, 당신은 지어내지 말고
문장에 적힌 재료만 넘기십시오.

## 전화번호가 없을 때
전화번호가 없는 것은 오류가 아닙니다. 원장이 학생 앞에서 급히 적었을 뿐입니다.
parent_phone=null로 두십시오. 원장이 확인 화면에서 직접 채웁니다.
전화번호가 없다는 이유로 등록을 문의로 낮추거나 판단을 포기하지 마십시오.

## 확신이 없을 때
문장이 너무 짧거나 무슨 말인지 알 수 없으면 needs_clarification=true로 두고
question에 원장에게 되물을 구체적인 질문을 적으십시오.
일부만 모르는 것이라면 그 필드만 null로 두고 나머지는 정상적으로 채우십시오.

## 예시

입력: 정재현 숭의중1 등록 결제 28만 정우석 선생님 화 목 심화
{
  "number_readings": [
    {"token": "1", "context": "숭의중1", "meaning": "학년"},
    {"token": "28만", "context": "결제 28만", "meaning": "금액"}
  ],
  "enroll": true, "payment": true, "consultation": false,
  "student_name": "정재현", "school": "숭의중", "grade": "1학년",
  "parent_phone": null, "guardian_name": null,
  "schedule_days": ["화","목"], "teacher_name": "정우석", "class_level": "심화",
  "class_action": null, "class_name": null, "class_time": null, "max_students": null, "person_action": null,
  "amount": 280000, "payment_type": "원비", "payment_method": null,
  "payment_month": null, "due_day": null, "start_date": null,
  "status": "최종등록", "subject": null, "follow_up": null, "memo": null,
  "needs_clarification": false, "question": null
}
(전화번호가 없어도 등록으로 처리했고, "숭의중1"의 1을 금액이 아니라 학년으로
 읽었으며, 등록과 결제를 동시에 표시했습니다.)

입력: 어제 28만원 입금했다고 연락옴 민서 어머니 010-2345-6789
{
  "number_readings": [
    {"token": "28만원", "context": "28만원 입금", "meaning": "금액"},
    {"token": "010-2345-6789", "context": "전화번호", "meaning": "전화번호"}
  ],
  "enroll": false, "payment": true, "consultation": false,
  "student_name": "민서", "school": null, "grade": null,
  "parent_phone": "010-2345-6789", "guardian_name": "민서 어머니",
  "schedule_days": null, "teacher_name": null, "class_level": null,
  "class_action": null, "class_name": null, "class_time": null, "max_students": null, "person_action": null,
  "amount": 280000, "payment_type": "원비", "payment_method": "계좌이체",
  "payment_month": null, "due_day": null, "start_date": null,
  "status": null, "subject": null, "follow_up": null, "memo": null,
  "needs_clarification": false, "question": null
}
("결제"라는 낱말이 없지만 "입금했다"가 같은 뜻이고, 어순이 금액부터
 시작하지만 동일하게 읽었으며, "입금"에서 계좌이체를 추론했습니다.)

입력: 화목 심화반 김도윤 3월부터 다니기로 함 학원비는 35만
{
  "number_readings": [
    {"token": "3월", "context": "3월부터", "meaning": "날짜"},
    {"token": "35만", "context": "학원비는 35만", "meaning": "금액"}
  ],
  "enroll": true, "payment": false, "consultation": false,
  "student_name": "김도윤", "school": null, "grade": null,
  "parent_phone": null, "guardian_name": null,
  "schedule_days": ["화","목"], "teacher_name": null, "class_level": "심화",
  "class_action": null, "class_name": null, "class_time": null, "max_students": null, "person_action": null,
  "amount": 350000, "payment_type": null, "payment_method": null,
  "payment_month": null, "due_day": null, "start_date": "3월",
  "status": "최종등록", "subject": null, "follow_up": null, "memo": null,
  "needs_clarification": false, "question": null
}
("3월"을 3원이 아닌 날짜로 읽었고, "다니기로 함"을 등록으로 이해했으며,
 금액이 있지만 아직 냈다는 말이 없으므로 payment=false로 두었습니다.
 반 정보가 문장 맨 앞에 와도 동일하게 인식했습니다.)

입력: 010-1111-2222 박서연 어머니 중2 영어 문의, 다음주 재통화
{
  "number_readings": [
    {"token": "010-1111-2222", "context": "전화번호", "meaning": "전화번호"},
    {"token": "2", "context": "중2", "meaning": "학년"}
  ],
  "enroll": false, "payment": false, "consultation": true,
  "student_name": "박서연", "school": null, "grade": "중2",
  "parent_phone": "010-1111-2222", "guardian_name": "박서연 어머니",
  "schedule_days": null, "teacher_name": null, "class_level": null,
  "class_action": null, "class_name": null, "class_time": null, "max_students": null, "person_action": null,
  "amount": null, "payment_type": null, "payment_method": null,
  "payment_month": null, "due_day": null, "start_date": null,
  "status": "상담문의", "subject": "영어", "follow_up": "다음주 재통화",
  "needs_clarification": false, "question": null
}
(등록·결제 낱말이 없으므로 상담문의로만 처리했고, "중2"의 2를 학년으로 읽었습니다.)

입력: 중등심화반 신설 정우석 선생님 화목 19:00-21:00 수강료 35만 정원 15명
{
  "number_readings": [
    {"token": "19:00-21:00", "context": "수업 시간", "meaning": "기타"},
    {"token": "35만", "context": "수강료 35만", "meaning": "금액"},
    {"token": "15명", "context": "정원 15명", "meaning": "기타"}
  ],
  "enroll": false, "payment": false, "consultation": false,
  "student_name": null, "school": null, "grade": null,
  "parent_phone": null, "guardian_name": null,
  "schedule_days": ["화","목"], "teacher_name": "정우석", "class_level": "심화",
  "class_action": "생성", "class_name": "중등심화반", "class_time": "19:00-21:00", "max_students": 15, "person_action": null,
  "amount": 350000, "payment_type": null, "payment_method": null,
  "payment_month": null, "due_day": null, "start_date": null,
  "status": null, "subject": null, "follow_up": null, "memo": null,
  "needs_clarification": false, "question": null
}
("신설"은 반을 만드는 말이므로 학생 등록이 아닙니다. enroll도 payment도
 false로 두고, 35만원을 수납이 아니라 그 반의 수강료로 넘겼습니다.)

입력: 초등A반 수강료 30만으로 변경하고 시간도 17:00-19:00으로
{
  "number_readings": [
    {"token": "30만", "context": "수강료 30만", "meaning": "금액"},
    {"token": "17:00-19:00", "context": "수업 시간", "meaning": "기타"}
  ],
  "enroll": false, "payment": false, "consultation": false,
  "student_name": null, "school": null, "grade": null,
  "parent_phone": null, "guardian_name": null,
  "schedule_days": null, "teacher_name": null, "class_level": null,
  "class_action": "수정", "class_name": "초등A반", "class_time": "17:00-19:00", "max_students": null, "person_action": null,
  "amount": 300000, "payment_type": null, "payment_method": null,
  "payment_month": null, "due_day": null, "start_date": null,
  "status": null, "subject": null, "follow_up": null, "memo": null,
  "needs_clarification": false, "question": null
}
("변경"은 이미 있는 반을 고치는 말입니다. class_name에 고칠 대상 반 이름을
 넣었고, 30만원은 누가 낸 돈이 아니라 바뀔 수강료입니다.)

입력: 교사 추가 박지훈 수학 010-1111-2222
{
  "number_readings": [
    {"token": "010-1111-2222", "context": "연락처", "meaning": "전화번호"}
  ],
  "enroll": false, "payment": false, "consultation": false,
  "student_name": null, "school": null, "grade": null,
  "parent_phone": "010-1111-2222", "guardian_name": null,
  "schedule_days": null, "teacher_name": "박지훈", "class_level": null,
  "class_action": null, "class_name": null, "class_time": null, "max_students": null, "person_action": "교사추가",
  "amount": null, "payment_type": null, "payment_method": null,
  "payment_month": null, "due_day": null, "start_date": null,
  "status": null, "subject": "수학", "follow_up": null, "memo": null,
  "needs_clarification": false, "question": null
}
(사람을 새로 넣는 말이지 상담도 등록도 아닙니다. 전화번호가 있다고 상담으로
 흘리지 마십시오.)

입력: 학생 수정 김민준 학교 숭의중으로 바꿔줘
{
  "number_readings": [],
  "enroll": false, "payment": false, "consultation": false,
  "student_name": "김민준", "school": "숭의중", "grade": null,
  "parent_phone": null, "guardian_name": null,
  "schedule_days": null, "teacher_name": null, "class_level": null,
  "class_action": null, "class_name": null, "class_time": null, "max_students": null, "person_action": "학생수정",
  "amount": null, "payment_type": null, "payment_method": null,
  "payment_month": null, "due_day": null, "start_date": null,
  "status": null, "subject": null, "follow_up": null, "memo": null,
  "needs_clarification": false, "question": null
}
(학년은 바꾸라는 말이 없으므로 grade는 null입니다. 값을 채우면 기존 학년이
 지워집니다.)`;

/** OpenAI Structured Outputs 스키마. strict 모드라 모든 필드가 required여야 한다. */
const JSON_SCHEMA = {
  name: "hagwon_input",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "number_readings",
      "enroll",
      "payment",
      "consultation",
      "student_name",
      "school",
      "grade",
      "parent_phone",
      "guardian_name",
      "schedule_days",
      "teacher_name",
      "class_level",
      "class_action",
      "class_name",
      "class_time",
      "max_students",
      "person_action",
      "amount",
      "payment_type",
      "payment_method",
      "payment_month",
      "due_day",
      "start_date",
      "status",
      "subject",
      "follow_up",
      "memo",
      "needs_clarification",
      "question",
    ],
    properties: {
      // 숫자별 판정 근거. 코드가 금액 후보를 걸러낼 때 교차검증에 쓴다.
      number_readings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["token", "context", "meaning"],
          properties: {
            token: { type: "string" },
            context: { type: "string" },
            meaning: {
              type: "string",
              enum: ["금액", "날짜", "학년", "전화번호", "기준일", "기간", "기타"],
            },
          },
        },
      },
      enroll: { type: "boolean" },
      payment: { type: "boolean" },
      consultation: { type: "boolean" },
      student_name: { type: ["string", "null"] },
      school: { type: ["string", "null"] },
      grade: { type: ["string", "null"] },
      parent_phone: { type: ["string", "null"] },
      guardian_name: { type: ["string", "null"] },
      schedule_days: { type: ["array", "null"], items: { type: "string" } },
      teacher_name: { type: ["string", "null"] },
      class_level: { type: ["string", "null"] },
      // 반 자체를 만들거나 고치는 문장일 때만 채운다. 학생 등록과 혼동하면 안 된다.
      class_action: { type: ["string", "null"], enum: ["생성", "수정", null] },
      class_name: { type: ["string", "null"] },
      class_time: { type: ["string", "null"] },
      max_students: { type: ["number", "null"] },
      // 사람 정보를 고치는 문장일 때만 채운다.
      person_action: {
        type: ["string", "null"],
        enum: ["학생수정", "교사추가", "교사수정", null],
      },
      amount: { type: ["number", "null"] },
      payment_type: { type: ["string", "null"], enum: ["원비", "환불", "지출", "기타", null] },
      payment_method: { type: ["string", "null"], enum: ["계좌이체", "카드", "현금", null] },
      payment_month: { type: ["string", "null"] },
      due_day: { type: ["number", "null"] },
      start_date: { type: ["string", "null"] },
      status: {
        type: ["string", "null"],
        enum: ["상담문의", "대기등록", "최종등록", "보류", null],
      },
      subject: { type: ["string", "null"] },
      follow_up: { type: ["string", "null"] },
      memo: { type: ["string", "null"] },
      needs_clarification: { type: "boolean" },
      question: { type: ["string", "null"] },
    },
  },
} as const;

export interface NumberReading {
  token: string;
  context: string;
  meaning: "금액" | "날짜" | "학년" | "전화번호" | "기준일" | "기간" | "기타";
}

export interface RawAiResult {
  number_readings: NumberReading[];
  enroll: boolean;
  payment: boolean;
  consultation: boolean;
  student_name: string | null;
  school: string | null;
  grade: string | null;
  parent_phone: string | null;
  guardian_name: string | null;
  schedule_days: string[] | null;
  teacher_name: string | null;
  class_level: string | null;
  class_action: string | null;
  class_name: string | null;
  class_time: string | null;
  max_students: number | null;
  person_action: string | null;
  amount: number | null;
  payment_type: string | null;
  payment_method: string | null;
  payment_month: string | null;
  due_day: number | null;
  start_date: string | null;
  status: string | null;
  subject: string | null;
  follow_up: string | null;
  memo: string | null;
  needs_clarification: boolean;
  question: string | null;
}

export class NlpConfigError extends Error {}

async function callOpenAi(text: string, signal?: AbortSignal): Promise<RawAiResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new NlpConfigError(
      "OPENAI_API_KEY가 설정되지 않았습니다. Railway 대시보드 → Variables에서 등록해주세요."
    );
  }

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: MODEL,
      temperature: 0, // 같은 문장은 항상 같은 결과가 나오도록 고정
      max_tokens: 800, // number_readings가 늘어난 만큼 여유를 준다
      response_format: { type: "json_schema", json_schema: JSON_SCHEMA },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // API 키 자체는 절대 로그에 남기지 않는다
    throw new Error(`OpenAI 호출 실패 (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as any;
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI 응답이 비어 있습니다.");
  return JSON.parse(content) as RawAiResult;
}

// ─── 검증 및 확정 ─────────────────────────────────────────────────────────

const PAYMENT_TYPES = ["원비", "환불", "지출", "기타"] as const;
const PAYMENT_METHODS = ["계좌이체", "카드", "현금"] as const;
const STATUSES = ["상담문의", "대기등록", "최종등록", "보류"] as const;

function asPaymentType(v: unknown): PaymentType | null {
  return PAYMENT_TYPES.includes(v as PaymentType) ? (v as PaymentType) : null;
}
function asPaymentMethod(v: unknown): PaymentMethod | null {
  return PAYMENT_METHODS.includes(v as PaymentMethod) ? (v as PaymentMethod) : null;
}
function asStatus(v: unknown): ConsultationStatus | null {
  return STATUSES.includes(v as ConsultationStatus) ? (v as ConsultationStatus) : null;
}

function unclear(sourceText: string, corrections: string[], reason: string, question: string): ParseResult {
  return { sourceText, corrections, draft: { category: "unclear", reason, question } };
}

/**
 * 금액을 확정한다. 원문에서 뽑은 값을 우선하되, 원문에서 못 찾으면 AI 값을 쓴다.
 *
 * 원문 우선인 이유: AI가 "만원" 환산을 틀리는 일이 잦다.
 * AI 폴백을 둔 이유: "이십팔만원"처럼 한글 수사는 정규식이 못 읽는다.
 */
function resolveAmount(
  ai: RawAiResult,
  sourceText: string,
  corrections: string[]
): number | null {
  const amounts = extractAmounts(sourceText);
  const fromAi = ai.amount != null ? Math.abs(ai.amount) : null;

  if (amounts.length === 0) {
    if (fromAi != null) {
      corrections.push(`금액을 AI 해석값 ${fromAi.toLocaleString()}원으로 사용했습니다. 확인해 주세요.`);
      return fromAi;
    }
    return null;
  }

  const fromText = amounts[0];
  if (fromAi != null && fromAi !== fromText) {
    corrections.push(
      `금액을 원문 기준 ${fromText.toLocaleString()}원으로 정정했습니다. (AI 추출값: ${fromAi.toLocaleString()}원)`
    );
  }
  if (amounts.length > 1) {
    corrections.push(
      `금액이 여러 개(${amounts.map((a) => a.toLocaleString()).join(", ")}) 발견되어 첫 번째를 사용했습니다. 확인해 주세요.`
    );
  }
  return fromText;
}

/** 결제 유형을 확정한다. 낱말이 분명하면 코드가 이긴다. */
function resolveType(ai: RawAiResult, sourceText: string, corrections: string[]): PaymentType {
  const aiType = asPaymentType(ai.payment_type);
  const fromText = extractPaymentType(sourceText);
  const type = fromText ?? aiType ?? "원비";
  if (fromText && aiType && fromText !== aiType) {
    corrections.push(`유형을 원문 기준 "${fromText}"로 정정했습니다. (AI 판단: "${aiType}")`);
  }
  return type;
}

/**
 * 반 작업 문장인지 최종 판정한다.
 *
 * 판정 근거는 원문이다. 예전에는 AI가 class_action을 채워야만 통과시켰는데,
 * 모델이 그 칸을 비우면 "중등심화반 신설"이 조용히 상담이나 판단 불가로
 * 흘러가 반 관리가 통째로 먹통이 됐다. 원장이 직접 친 지시가 그날 모델
 * 컨디션에 좌우돼서는 안 된다.
 *
 * 대신 원래 AI가 막아주던 두 가지 오인식은 원문만으로 계속 막는다.
 *  - "강단우 국어반 추가" 같은 학생 등록 → extractClassAction이 null을 준다
 *  - "수강료 변경 문의 왔어요" 같은 상담 → looksLikeInquiry가 걸러낸다
 *
 * 생성/수정이 엇갈리면 원문 쪽을 따른다. 없는 반을 하나 더 만드는 실수가
 * 있는 반을 고치는 실수보다 되돌리기 번거롭다.
 */
function resolveClassAction(
  ai: RawAiResult,
  sourceText: string,
  corrections: string[]
): "create" | "update" | null {
  const fromText = extractClassAction(sourceText);
  if (!fromText) return null;

  // 남의 말을 옮긴 문장은 지시가 아니다. 문의 한 통에 반 수강료가 바뀌면 안 된다.
  if (looksLikeInquiry(sourceText)) return null;

  const fromAi =
    ai.class_action === "생성" ? "create" : ai.class_action === "수정" ? "update" : null;

  if (fromAi && fromAi !== fromText) {
    corrections.push(
      `반 작업을 원문 기준 "${fromText === "create" ? "생성" : "수정"}"으로 정정했습니다.`
    );
  }
  return fromText;
}

/** 수강료를 뽑는다. "19:00" 같은 시간 조각이 금액으로 새지 않도록 범위로 거른다. */
function resolveTuition(ai: RawAiResult, sourceText: string): number | null {
  const fromText = extractAmounts(sourceText).find(isPlausibleAmount);
  if (fromText != null) return fromText;
  const fromAi = ai.amount != null ? Math.abs(ai.amount) : null;
  return fromAi != null && isPlausibleAmount(fromAi) ? fromAi : null;
}

/**
 * AI 결과를 코드로 재검증해 최종 초안을 만든다.
 * 이 함수는 순수 함수이므로 API 없이 단독 테스트할 수 있다.
 */
export function arbitrate(
  ai: RawAiResult,
  sourceText: string,
  now: Date = new Date()
): ParseResult {
  const corrections: string[] = [];

  const phones = extractPhones(sourceText);
  const phone = phones.length > 0 ? normalizePhone(phones[0]) : null;
  const studentName = cleanStudentName(ai.student_name);

  /*
    ── -2. 퇴근전 할 일 ──
    가장 먼저 본다. "퇴근전 미납자 전화 돌리기"에는 '미납'과 '전화'가 들어 있어
    뒤쪽 수납·상담 분기가 먼저 집어가면 엉뚱한 수납 초안이 뜬다.

    판정 근거는 오직 원문의 마커다. AI에게 맡기면 "김민준 어머니께 전화"처럼
    마커 없는 문장까지 할 일로 끌어와 상담 기록이 할 일 목록으로 새어 나간다.
  */
  if (looksLikeTask(sourceText)) {
    const today = ymdKst(now);
    const { dueDate, rest } = extractTaskDue(sourceText, today);
    const body = extractTaskTitle(rest);
    if (body) {
      const slot = extractTaskSlot(sourceText);
      // 출근전은 목록에서도 한눈에 보여야 한다. 퇴근전은 이 기능의 기본값이라
      // 제목마다 붙이면 같은 말이 모든 줄에 반복될 뿐이다.
      const title = slot === "출근전" ? `출근전 ${body}` : body;
      if (dueDate !== today) {
        corrections.push(`${dueDate} ${slot} 할 일로 두었습니다.`);
      }
      return { sourceText, corrections, draft: { category: "task", title, dueDate, slot } };
    }
    // 마커만 있고 내용이 없으면 되묻는다. 제목 없는 할 일은 나중에 못 알아본다.
    return unclear(
      sourceText,
      corrections,
      "할 일로 보이는데 무엇을 해야 하는지가 없습니다.",
      "무엇을 해야 하나요? (예: 퇴근전 김민준 어머니 전화)"
    );
  }

  /*
    ── -1.5. 학생 목록 조회 ──
    "월 수 학생 목록 보여줘", "전체 중학생 목록 다운로드" 같은 문장.
    person·lookup 보다 먼저 봐야 한다. "정우석 선생님 목록"이 lookup으로 빠지면
    학생 한 명 조회 폼이 뜨기 때문이다.
  */
  if (looksLikeStudentList(sourceText)) {
    // "목록"의 "목"이 목요일, "수업"의 "수"가 수요일로 잡히지 않도록 걷어낸다
    const dayClean = sourceText.replace(/목록|명단|리스트|수업|학생들/g, " ");
    const days = parseDays(dayClean);
    const teacherName = extractTeacherName(sourceText) ??
      ai.teacher_name?.trim().replace(/\s*(선생님|쌤|T)$/, "") ?? null;
    const timeHour = extractTimeFilter(sourceText);
    const gradeFilter = extractGradeFilter(sourceText);
    const download = looksLikeDownload(sourceText);

    const filters: string[] = [];
    if (days.length > 0) filters.push(days.join("·"));
    if (teacherName) filters.push(`${teacherName} 선생님`);
    if (timeHour !== null) filters.push(`${timeHour}시`);
    if (gradeFilter) filters.push(gradeFilter);
    if (filters.length > 0) {
      corrections.push(`조건: ${filters.join(", ")}`);
    }
    if (download) corrections.push("CSV 다운로드 준비됨");

    return {
      sourceText,
      corrections,
      draft: {
        category: "student-list",
        days: days.length > 0 ? days : null,
        teacherName: teacherName || null,
        timeHour,
        gradeFilter,
        download,
      },
    };
  }

  // ── -1. 학생·교사 정보 수정 ──
  // 가장 먼저 본다. "학생 수정 …"은 명시적 명령이므로 뒤쪽 분기가 이것을
  // 등록이나 상담으로 가로채면 안 된다. 전화번호가 섞여 있어도 마찬가지다.
  const person = extractPersonAction(sourceText);
  if (person) {
    const rawName = person.target === "teacher" ? ai.teacher_name : ai.student_name;
    // 이름은 부분만 적어도 서버가 후보를 찾아 준다. cleanStudentName의 2자 하한만 지킨다.
    // AI가 이름 칸을 비우면 명령어 바로 뒤 낱말을 이름으로 쓴다. 이름이 비면
    // 대상을 못 고르고, 대상을 못 고르면 저장 버튼이 막혀 아무것도 못 한다.
    const name =
      cleanStudentName(rawName) ??
      cleanStudentName(ai.student_name) ??
      extractCommandName(sourceText);

    return {
      sourceText,
      corrections,
      draft: {
        category: "person",
        target: person.target,
        action: person.action,
        name,
        school: person.target === "student" ? normalizedSchool(ai) : null,
        grade: person.target === "student" ? normalizedGrade(ai) : null,
        phone,
        subject:
          person.target === "teacher"
            ? ai.subject?.trim() || extractSubject(sourceText)
            : null,
        notes: ai.memo?.trim() || null,
      },
    };
  }

  // ── -0.5. 이름만 친 경우 → 학생 조회 ──
  // 뒤쪽 분기보다 먼저 본다. AI가 "정재현" 한 낱말을 상담 문의로 넘겨 버리면
  // 조회하려던 원장에게 빈 상담 폼이 뜬다. 문장 전체가 이름 하나일 때만이라
  // 다른 분기를 가로챌 여지가 없다.
  const lookupName = extractLookupName(sourceText);
  if (lookupName) {
    return { sourceText, corrections, draft: { category: "lookup", name: lookupName } };
  }

  // ── 0. 반 생성·수정 ──
  // 학생 판정보다 먼저 본다. "반 신설"에는 학생 이름이 없어야 정상이므로
  // 뒤쪽 분기까지 흘러가면 "판단 불가"로 되물어지고 만다.
  const classAction = resolveClassAction(ai, sourceText, corrections);
  if (classAction) {
    // AI가 칸을 비워도 화면은 채워져야 한다. 빈 폼이 뜨면 결국 손으로 다시 친다.
    const teacherName =
      ai.teacher_name?.trim().replace(/\s*(선생님|쌤|T)$/, "") || extractTeacherName(sourceText);
    const days = ai.schedule_days?.length ? ai.schedule_days : null;
    const time = extractClassTime(sourceText) ?? ai.class_time?.trim() ?? null;
    const schedule = [days?.join(""), time].filter(Boolean).join(" ") || null;

    return {
      sourceText,
      corrections,
      draft: {
        category: "class",
        action: classAction,
        classHint: {
          scheduleDays: days,
          teacherName,
          level: ai.class_level?.trim() || null,
        },
        name: ai.class_name?.trim() || extractClassNameFromText(sourceText),
        subject: ai.subject?.trim() || extractSubject(sourceText),
        schedule,
        teacherName,
        defaultTuition: resolveTuition(ai, sourceText),
        maxStudents: extractMaxStudents(sourceText) ?? ai.max_students ?? null,
        memo: ai.memo?.trim() || null,
      },
    };
  }

  // 낱말이 명백하면 코드 판정을 신뢰한다. AI가 "등록"을 상담문의로 흘려보내면
  // 학생·수강등록이 만들어지지 않아 학생 목록에 뜨지 않는다.
  const statusFromText = extractConsultationStatus(sourceText);
  const typeFromText = extractPaymentType(sourceText);

  // ── 사건 판정: AI 의도를 기본으로 쓰되 원문 낱말로 보강한다 ──
  const enroll =
    ai.enroll || statusFromText === "최종등록" || asStatus(ai.status) === "최종등록";
  // "환불"·"지출"은 등록과 무관한 회계 사건이므로 결제 동반으로 보지 않는다.
  const isOutflow = typeFromText === "환불" || typeFromText === "지출";
  const hasPayment = ai.payment || (typeFromText !== null && !isOutflow);

  // ── 1. 등록 (결제 동반 가능) ──
  if (enroll && !isOutflow) {
    // 이름이 없어도 폼은 연다. 원장은 "등록"까지만 치고 나머지는 화면을 보며
    // 채우는 편이 빠르다고 했다. 되물으면 한 번 더 타이핑해야 한다.
    // 이름 없이 저장되는 일은 없다 — 저장 버튼이 화면에서 막혀 있다.
    if (!studentName) {
      corrections.push("학생 이름을 찾지 못했습니다. 아래에서 입력해 주세요.");
    }

    let payment: PaymentPart | null = null;
    if (hasPayment) {
      const amount = resolveAmount(ai, sourceText, corrections);
      if (amount !== null && !isPlausibleAmount(amount)) {
        return unclear(
          sourceText,
          corrections,
          `금액 ${amount.toLocaleString()}원이 정상 범위(${AMOUNT_MIN.toLocaleString()}~${AMOUNT_MAX.toLocaleString()}원)를 벗어납니다.`,
          "금액을 다시 확인해 주세요. 자릿수가 맞나요?"
        );
      }
      // 등록과 함께 낸 돈은 등록한 달의 원비로 보는 것이 자연스럽다.
      // 여기서 되물으면 "정재현 등록 결제 28만"처럼 월을 안 적은 문장이 전부 막힌다.
      const month = normalizeMonth(ai.payment_month, sourceText, now);
      const paymentMonth = month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      if (!month) {
        corrections.push(`납부월이 없어 이번달(${paymentMonth})로 두었습니다. 다르면 고쳐주세요.`);
      }
      // 금액이 없어도 수납 자체는 살려 둔다. "결제완료"만 적은 문장을 등록만으로
      // 처리해 버리면 낸 돈이 미납으로 남는다. 금액은 화면에서 반 수강료로 채운다.
      if (amount === null) {
        corrections.push("결제했다고 적혀 있는데 금액이 없습니다. 반을 고르면 그 반 수강료로 채웁니다.");
      }
      payment = {
        amount,
        type: resolveType(ai, sourceText, corrections),
        method: asPaymentMethod(ai.payment_method) ?? extractPaymentMethod(sourceText),
        paymentMonth,
      };
    }

    const dueDay = extractDueDay(sourceText) ?? (Number.isInteger(ai.due_day) ? ai.due_day : null);
    const startDate = extractStartDate(sourceText, now);
    if (dueDay !== null) corrections.push(`납부 기준일을 매월 ${dueDay}일로 읽었습니다.`);
    if (startDate !== null) corrections.push(`등록일을 ${startDate}로 읽었습니다.`);
    if (!phone) {
      corrections.push("전화번호가 없어 비워 두었습니다. 아래에서 입력해 주세요.");
    }

    return {
      sourceText,
      corrections,
      draft: {
        category: "registration",
        studentName,
        school: normalizedSchool(ai),
        grade: normalizedGrade(ai),
        parentPhone: phone,
        guardianName: ai.guardian_name?.trim() || null,
        classHint: {
          scheduleDays: ai.schedule_days?.length ? ai.schedule_days : null,
          teacherName: ai.teacher_name?.trim().replace(/\s*(선생님|쌤|T)$/, "") || null,
          level: ai.class_level?.trim() || null,
        },
        startDate,
        dueDay: dueDay !== null && dueDay >= 1 && dueDay <= 31 ? dueDay : null,
        payment,
        subject: ai.subject?.trim() || null,
        memo: ai.memo?.trim() || null,
      },
    };
  }

  // ── 2. 순수 수납 (등록 없이 돈만 오간 경우) ──
  const amounts = extractAmounts(sourceText);
  if ((hasPayment || isOutflow || amounts.length > 0) && !ai.consultation) {
    const amount = resolveAmount(ai, sourceText, corrections);
    const type = resolveType(ai, sourceText, corrections);

    // "수찬이 7월 납부"처럼 이름만 덜렁 앞에 붙은 문장에서 AI가 이름 칸을 비우는
    // 일이 잦다. 그러면 아래에서 "학생 이름을 찾지 못했습니다"로 튕겨 나간다.
    const payerName = studentName ?? extractLeadingName(sourceText);

    // 금액을 안 적었어도 "누구의 원비인지"만 분명하면 초안까지는 만든다.
    // 급할 때 "김민 수납"만 치고 화면에서 그 학생 수강료를 확인해 누르는 흐름이다.
    // 지어낸 금액이 아니라 빈 칸으로 넘기고, 화면에서 채워지기 전에는 저장할 수 없다.
    const canDeferAmount = amount === null && type === "원비" && !!payerName;
    if (amount === null && !canDeferAmount) {
      return unclear(
        sourceText,
        corrections,
        "수납 관련 문장 같은데 금액이 없습니다.",
        "금액이 얼마인가요? (예: 김민준 35만원 이번달 원비 카드)"
      );
    }
    if (amount !== null && !isPlausibleAmount(amount)) {
      return unclear(
        sourceText,
        corrections,
        `금액 ${amount.toLocaleString()}원이 정상 범위(${AMOUNT_MIN.toLocaleString()}~${AMOUNT_MAX.toLocaleString()}원)를 벗어납니다.`,
        "금액을 다시 확인해 주세요. 자릿수가 맞나요?"
      );
    }

    // 환불·지출은 음수로 저장한다 (Payments 화면이 amount를 단순 SUM 하므로)
    const signed =
      amount === null ? null : type === "환불" || type === "지출" ? -amount : amount;
    if (signed !== null && signed < 0) {
      corrections.push(`${type}이므로 금액을 음수(${signed.toLocaleString()}원)로 기록합니다.`);
    }
    if (signed === null) {
      corrections.push("금액이 없어 비워 두었습니다. 수강료를 확인하고 저장하세요.");
    }

    const paymentMonth = normalizeMonth(ai.payment_month, sourceText, now);
    if (!paymentMonth) {
      return unclear(
        sourceText,
        corrections,
        "몇 월분 수납인지 문장에서 찾지 못했습니다.",
        "몇 월분인가요? (예: 이번달, 8월)"
      );
    }
    if (!ai.payment_month) {
      corrections.push(`월 정보가 없어 원문에서 ${paymentMonth}로 해석했습니다.`);
    }

    // 원비/환불은 어느 학생인지 모르면 저장할 수 없다 (enrollmentId를 못 찾음)
    if (!payerName && (type === "원비" || type === "환불")) {
      return unclear(
        sourceText,
        corrections,
        "학생 이름을 찾지 못했습니다.",
        "어느 학생의 수납인가요?"
      );
    }

    return {
      sourceText,
      corrections,
      draft: {
        category: "accounting",
        studentName: payerName,
        amount: signed,
        type,
        paymentMonth,
        method: asPaymentMethod(ai.payment_method) ?? extractPaymentMethod(sourceText),
        memo: ai.memo?.trim() || null,
      },
    };
  }

  // ── 3. 상담/문의 ──
  // 예전엔 번호가 없으면 "연락처를 적어주세요"로 되물었다. 그런데 원장은 통화
  // 중에 "신규상담 중1 김찬우"까지만 치고 번호는 화면에서 보며 누르는 편이 빠르다.
  // 그래서 상담·대기 낱말이 보이면 번호가 없어도 폼까지는 열어 준다.
  // 저장 자체는 화면에서 번호가 채워질 때까지 막히므로 빈 상담이 쌓이지는 않는다.
  if (phone || statusFromText || asStatus(ai.status) || ai.consultation) {
    const status: ConsultationStatus = statusFromText ?? asStatus(ai.status) ?? "상담문의";
    if (!phone) {
      corrections.push("전화번호가 없어 비워 두었습니다. 아래에서 입력해야 저장됩니다.");
    }
    if (statusFromText && asStatus(ai.status) && statusFromText !== asStatus(ai.status)) {
      corrections.push(
        `상태를 원문 기준 "${statusFromText}"로 정정했습니다. (AI 판단: "${asStatus(ai.status)}")`
      );
    }

    const dueDay = extractDueDay(sourceText);
    const startDate = extractStartDate(sourceText, now);
    if (dueDay !== null) corrections.push(`납부 기준일을 매월 ${dueDay}일로 읽었습니다.`);
    if (startDate !== null) corrections.push(`등록일을 ${startDate}로 읽었습니다.`);

    return {
      sourceText,
      corrections,
      draft: {
        category: "contact",
        phone,
        guardianName: ai.guardian_name?.trim() || null,
        studentName,
        studentGrade: normalizedGrade(ai),
        status,
        subject: ai.subject?.trim() || null,
        followUp: ai.follow_up?.trim() || null,
        memo: ai.memo?.trim() || null,
        dueDay,
        startDate,
      },
    };
  }

  // ── 4. 판단 불가 ──
  if (ai.needs_clarification && ai.question) {
    return unclear(sourceText, corrections, "입력 내용을 확실히 이해하지 못했습니다.", ai.question);
  }
  return unclear(
    sourceText,
    corrections,
    "등록·수납·상담 중 어느 것인지 판단할 수 없습니다.",
    "수납 건이면 금액을, 상담 건이면 연락처를, 등록 건이면 학생 이름과 '등록'을 적어주세요."
  );
}

/** 자연어 문장 하나를 초안으로 변환한다. */
export async function parseInput(
  text: string,
  opts: { now?: Date; signal?: AbortSignal } = {}
): Promise<ParseResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      sourceText: text,
      corrections: [],
      draft: { category: "unclear", reason: "입력이 비어 있습니다.", question: "내용을 입력해 주세요." },
    };
  }

  // 이름 한 낱말은 AI에게 물을 것이 없다. 왕복 한 번을 아끼면 조회가 즉시 뜬다.
  const lookupName = extractLookupName(trimmed);
  if (lookupName) {
    return { sourceText: trimmed, corrections: [], draft: { category: "lookup", name: lookupName } };
  }

  // 학생 목록 조회도 AI에게 물을 것이 없다. 필터 조건은 코드가 원문에서 직접 뽑는다.
  if (looksLikeStudentList(trimmed)) {
    const now = opts.now ?? new Date();
    const corrections: string[] = [];
    const dayClean = trimmed.replace(/목록|명단|리스트|수업|학생들/g, " ");
    const days = parseDays(dayClean);
    const teacherName = extractTeacherName(trimmed);
    const timeHour = extractTimeFilter(trimmed);
    const gradeFilter = extractGradeFilter(trimmed);
    const download = looksLikeDownload(trimmed);

    const filters: string[] = [];
    if (days.length > 0) filters.push(days.join("·"));
    if (teacherName) filters.push(`${teacherName} 선생님`);
    if (timeHour !== null) filters.push(`${timeHour}시`);
    if (gradeFilter) filters.push(gradeFilter);
    if (filters.length > 0) corrections.push(`조건: ${filters.join(", ")}`);
    if (download) corrections.push("CSV 다운로드 준비됨");

    return {
      sourceText: trimmed,
      corrections,
      draft: {
        category: "student-list",
        days: days.length > 0 ? days : null,
        teacherName: teacherName || null,
        timeHour,
        gradeFilter,
        download,
      },
    };
  }

  const ai = await callOpenAi(trimmed, opts.signal);
  return arbitrate(ai, trimmed, opts.now ?? new Date());
}

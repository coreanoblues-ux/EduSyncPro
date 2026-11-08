import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, decimal, boolean, pgEnum, jsonb, customType } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Enums
export const userRoleEnum = pgEnum("user_role", ["owner", "teacher", "superadmin"]);
export const tenantStatusEnum = pgEnum("tenant_status", ["pending", "active", "expired", "suspended"]);
export const paymentStatusEnum = pgEnum("payment_status", ["paid", "overdue", "pending"]);

// 결제 수단 / 거래 종류 (자연어 입력 기능에서 사용)
export const paymentMethodEnum = pgEnum("payment_method", ["계좌이체", "카드", "현금"]);
export const paymentTypeEnum = pgEnum("payment_type", ["원비", "환불", "지출", "기타"]);

// ─── Toss Front 2 통합 관련 enum ────────────────────────────────────────────
// 결제 의도(payment intent)의 상태 머신. 프론트 SDK → 서버 confirm → 웹훅 재검증까지의
// 흐름에서 상태가 잘못 바뀌면 이중 납부 또는 미납 오탐이 생긴다. 그래서 enum으로 강제한다.
// CREATED → PROCESSING → APPROVED (성공 경로)
// CREATED → PROCESSING → CANCELED / TIMEOUT / FAILED (실패 경로)
export const paymentIntentStatusEnum = pgEnum("payment_intent_status", [
  "CREATED",
  "PROCESSING",
  "APPROVED",
  "CANCELED",
  "TIMEOUT",
  "FAILED",
]);

// 웹훅 처리 상태. FAILED는 서명 검증 실패 또는 서버 오류로 처리 못 한 이벤트.
// IGNORED는 우리 시스템에서 다루지 않는 이벤트라 의도적으로 건너뛴 것.
export const webhookStatusEnum = pgEnum("toss_webhook_status", [
  "RECEIVED",
  "PROCESSED",
  "IGNORED",
  "FAILED",
]);

// 결제 방법 (SDK 응답 기반). CARD가 압도적으로 많지만 현금영수증·바코드도 온다.
export const tossPaymentMethodEnum = pgEnum("toss_payment_method", [
  "CARD",
  "CASH",
  "BARCODE",
]);

// 외부 결제 제공자. 지금은 TOSSPLACE 하나지만, 나중에 KIS 등이 추가될 수 있어 enum으로 둔다.
export const externalProviderEnum = pgEnum("external_provider", ["TOSSPLACE"]);

// 결제가 어느 경로로 들어왔는지. TOSS_FRONT는 로비 무인 결제, MANUAL은 원장이 관리자 화면에서 수기 입력.
export const paidViaEnum = pgEnum("paid_via", ["MANUAL", "TOSS_FRONT"]);

// 출석 체크가 어느 경로로 들어왔는지. KIOSK = Toss Front, MANUAL = 원장/강사 수기.
export const attendanceSourceEnum = pgEnum("attendance_source", ["MANUAL", "KIOSK"]);

// ─── Toss "결제 단말기 모드"용 dispatch 상태 ───────────────────────────
// 태블릿(학생용 키오스크 웹)이 서버에 결제요청을 보내면, 서버가 특정 프론트 단말기에
// dispatch 레코드를 만들고 SSE로 밀어낸다. 프론트가 실제 승인까지 성공하면
// 이 dispatch도 APPROVED로 마감된다. payment_intents.status와는 별도 트랙:
//   - payment_intents: paymentKey 관점 (한 결제 시도의 승인 여부)
//   - payment_dispatches: 태블릿-프론트 라우팅 관점 (전달·수신·응답 상태)
// 두 상태가 항상 1:1로 도는 이유는 dispatch 하나가 정확히 하나의 paymentKey에 묶이기 때문.
export const paymentDispatchStatusEnum = pgEnum("payment_dispatch_status", [
  "PENDING",   // 서버가 큐에 담음, 프론트가 아직 수신 안 함
  "DELIVERED", // 프론트가 SSE 또는 폴링으로 받아감
  "APPROVED",  // 결제 승인 완료 (프론트가 결과 업로드)
  "CANCELED",  // 사용자가 태블릿에서 취소 or 프론트에서 취소
  "TIMEOUT",   // 만료(3분)까지 아무 응답 없음
  "FAILED",    // 프론트가 결제 실패 응답을 업로드
]);

// ─── 카드 취소 dispatch 상태 ───────────────────────────────────────────
// 결제 dispatch 와 상태 집합이 다르다. 일부러 다르게 뒀다 — 취소는 "모르는 상태"를
// 결제와 똑같이 다루면 안 되기 때문이다.
//
//   결제가 TIMEOUT 이면: 다시 시도해도 된다. 중복 승인돼도 우리가 환불하면 된다.
//   취소가 TIMEOUT 이면: 다시 시도하면 안 된다. 카드가 이미 취소됐을 수 있고,
//                        중복 취소는 학부모 카드로 돈이 두 번 들어가는 사고다.
//                        되돌릴 API 도 우리에게 없다.
//
// 그래서 재시도가 허용되는 상태는 FAILED 하나뿐이다 (cardCancel.ts 참고).
export const cancelDispatchStatusEnum = pgEnum("payment_cancel_dispatch_status", [
  "PENDING",   // 큐에 담김. 단말기가 아직 안 집어감 → 카드는 그대로다
  "DELIVERED", // 단말기가 집어감 → ⚠️ 카드 상태를 알 수 없는 구간
  "SUCCEEDED", // 취소 성공 + 장부 반영 완료
  "FAILED",    // 단말기가 명시적 실패 보고 → 카드는 취소되지 않았다 (재시도 가능)
  "TIMEOUT",   // 만료까지 무응답 → ⚠️ 카드 상태를 알 수 없다 (사람이 확인해야 함)
]);

// 상담 진행 상태
// 흐름: 상담문의 → 레벨테스트예정 → 레벨테스트완료 → 반배정상담 → 최종등록 / 대기등록 / 보류
// 레벨테스트 3단계를 명시적으로 트래킹해서 원장이 "지금 어느 단계에 몇 명 있는지"를
// 대시보드에서 바로 알 수 있게 만든다. 각 단계에서 원생이 사라지지 않게 하는 게 매출과 직결된다.
export const consultationStatusEnum = pgEnum("consultation_status", [
  "상담문의",
  "레벨테스트예정",
  "레벨테스트완료",
  "반배정상담",
  "대기등록",
  "최종등록",
  "보류",
]);

// 할 일을 언제까지 끝내야 하는지. 기본값이자 대부분인 "퇴근전"이 이 기능의 본체다.
export const taskSlotEnum = pgEnum("task_slot", ["퇴근전", "출근전"]);

// Tenant table (학원)
export const tenants = pgTable("tenants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accountNumber: varchar("account_number").notNull().unique(),
  name: text("name").notNull(), // 학원명
  ownerName: text("owner_name").notNull(), // 대표자명
  ownerPhone: text("owner_phone").notNull(), // 대표자 연락처
  /**
   * 학부모에게 보여 주는 학원 대표 전화번호.
   *
   * ── 왜 ownerPhone 을 그대로 쓰지 않는가 ──
   *   ownerPhone 은 가입할 때 적은 **대표자 개인 연락처**다(보통 원장 휴대폰).
   *   학부모용 결과지 링크 맨 아래의 "학원에 전화하기" 버튼에 그 번호가 찍히면
   *   원장 개인 번호가 모든 학부모에게 나간다. 학원 유선번호(062-456-0990 같은)
   *   와 개인 번호는 다른 칸이어야 한다.
   *
   *   비어 있으면 결과지는 ownerPhone 으로 돌아간다 — 전화 버튼이 아예
   *   사라지는 것보다는 낫다(학부모가 결과를 본 직후가 전화가 걸리는 순간이다).
   *   원장은 레벨테스트 화면에서 이 번호를 직접 고친다.
   *
   *   nullable 이다. drizzle-kit push 가 데이터 손실 없이 칼럼만 더한다.
   */
  sharePhone: text("share_phone"),
  status: tenantStatusEnum("status").default("pending").notNull(),
  activeUntil: timestamp("active_until"),
  // 학년 자동 진급을 어느 학년도까지 반영했는가. 3월이 지나 이 값보다 학년도가
  // 커지면 한 번 올리고 갱신한다. 이게 없으면 서버가 재시작될 때마다 학년이
  // 계속 올라간다. NULL이면 "아직 한 번도 안 돌았다"는 뜻이고, 이때는 올리지
  // 않고 현재 학년도를 적어 두기만 한다 (기능을 켠 날 전원이 진급해 버리는 사고 방지).
  lastGradePromotionYear: integer("last_grade_promotion_year"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// User table (사용자)
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  name: text("name").notNull(),
  role: userRoleEnum("role").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Teacher table (교사)
export const teachers = pgTable("teachers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  subject: text("subject").notNull(), // 담당 과목
  phone: text("phone"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Class table (반)
export const classes = pgTable("classes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  teacherId: varchar("teacher_id").references(() => teachers.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(), // 반 이름
  subject: text("subject").notNull(), // 과목
  schedule: text("schedule").notNull(), // 수업 일정 (월수금, 화목토, 주말 등)
  defaultTuition: integer("default_tuition").notNull(), // 기본 수강료
  maxStudents: integer("max_students").default(20),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Student table (학생)
export const students = pgTable("students", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  school: text("school"),
  grade: text("grade"), // "중1", "고2" 등
  gender: text("gender"), // "남", "여"
  parentPhone: text("parent_phone"),
  siblingGroup: text("sibling_group"), // 형제 그룹 (같은 보호자)
  notes: text("notes"), // 특이사항
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Enrollment table (수강 등록)
export const enrollments = pgTable("enrollments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  tuition: integer("tuition"), // 개별 수강료 (없으면 반의 기본 수강료 사용)
  dueDay: integer("due_day").default(8), // 납입 기준일
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Payment table (수납)
export const payments = pgTable("payments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  // 원비/환불은 수강 등록에 연결되지만, 학원 운영 지출은 연결할 등록이 없으므로 nullable.
  enrollmentId: varchar("enrollment_id").references(() => enrollments.id, { onDelete: "cascade" }),
  // ⚠️ 부호 규칙: 원비는 양수, 환불·지출은 음수로 저장한다.
  // Payments 화면이 amount를 단순 SUM 하므로, 이렇게 해야 합계가 자동으로 순액이 된다.
  amount: integer("amount").notNull(),
  type: paymentTypeEnum("type").default("원비").notNull(),
  method: paymentMethodEnum("method"), // 계좌이체/카드/현금 (모르면 null)
  paymentMonth: text("payment_month").notNull(), // YYYY-MM 형식
  paidDate: timestamp("paid_date").notNull(),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  notes: text("notes"),
  // 자연어 입력으로 생성된 건지 표시 (원본 문장 보관 → 나중에 오분류 추적용)
  sourceText: text("source_text"),
  // ─── 외부 결제 시스템 연결 (Toss Front 2 등) ──────────────────────────
  // 이 결제가 외부 승인망을 통해 들어온 경우, 어떤 제공자·어떤 결제키로 왔는지 기록한다.
  // manual 수기 입력은 세 컬럼 모두 null이고 paidVia="MANUAL".
  // 웹훅 재수신 시 external_payment_key로 원거래를 되짚어 상태를 되돌린다.
  externalProvider: externalProviderEnum("external_provider"),
  // Toss paymentKey.
  //
  // ⚠️ 여기 오래 적혀 있던 "(unique index로 중복 승인 차단)" 은 사실이 아니었다.
  //    그 인덱스는 만들어진 적이 없다. 실제 중복 방어는
  //    toss_payment_transactions.payment_key 의 UNIQUE 였고, 승인·웹훅·수기대사
  //    세 경로가 모두 그 행을 먼저 넣은 뒤 성공했을 때만 여기 넣는 규칙으로만
  //    유지되고 있었다 — 즉 코드 안에만 있는 방어였다.
  //
  //    이제 진짜 인덱스를 만든다: scripts/migrate-add-payment-idempotency.ts
  //      UNIQUE (external_payment_key) WHERE external_payment_key IS NOT NULL AND amount > 0
  //    수입 행만 대상이라 환불 음수 행은 자유롭고, 부분결제는 결제키 자체가
  //    달라서 걸리지 않는다.
  //
  //    drizzle 스키마에 .unique() 로 적지 않는 이유: 부분 유니크(WHERE 조건)를
  //    표현할 수 없어서, 적으면 drizzle-kit 이 환불까지 막는 전체 UNIQUE 로
  //    바꾸려 든다. 제약은 마이그레이션 스크립트가 단독으로 소유한다.
  externalPaymentKey: text("external_payment_key"),
  externalTransactionId: varchar("external_transaction_id"), // toss_payment_transactions.id
  paidVia: paidViaEnum("paid_via").default("MANUAL").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Consultation table (상담/문의)
export const consultations = pgTable("consultations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  // 원장이 학생 앞에서 급히 적은 등록 건은 연락처가 없을 수 있다.
  // NOT NULL이던 시절엔 그런 입력이 저장 단계에서 통째로 막혔다.
  phone: text("phone"),
  guardianName: text("guardian_name"), // 보호자명
  studentName: text("student_name"),
  school: text("school"),              // "숭의중" 등 — 통화 자동등록 또는 수동 입력
  studentGrade: text("student_grade"), // "중1", "고2" 등
  status: consultationStatusEnum("status").default("상담문의").notNull(),
  subject: text("subject"), // 문의 과목
  followUp: text("follow_up"), // 후속 조치 (예: "다음주 화요일 재통화")
  memo: text("memo"),
  // 최종등록으로 전환되면 아래 두 필드가 채워진다
  classId: varchar("class_id").references(() => classes.id, { onDelete: "set null" }),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "set null" }),
  // 레벨테스트 관련 (상담 흐름: 상담문의 → 레벨테스트예정 → 레벨테스트완료 → 반배정상담 → 최종등록/대기등록/보류)
  levelTestDate: timestamp("level_test_date"), // 레벨테스트 예정/완료 일시
  levelTestScore: text("level_test_score"),    // 점수 또는 등급 문자열 (예: "85점", "B+")
  levelTestNotes: text("level_test_notes"),    // 레벨테스트 결과 메모
  recommendedClassId: varchar("recommended_class_id").references(() => classes.id, { onDelete: "set null" }), // 반배정상담 단계에서 추천된 반
  // 통화 자동 등록(/api/call-intake)이 만든 건은 AI가 쓴 초안이라 원장 확인이 필요하다.
  // 상태(status)에 섞지 않고 플래그로 둔다 — 퍼널 7단계에 의존하는 대시보드·퇴근전
  // 할일·상담 필터를 건드리지 않기 위해서다. 원장이 내용을 확인하면 false 로 끈다.
  needsReview: boolean("needs_review").default(false).notNull(),
  sourceText: text("source_text"),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

/**
 * LevelTest table (레벨테스트 결과지 누적 보관)
 *
 * 왜 consultations 에 더 붓지 않고 별도 표를 만드는가:
 *   consultations 에는 이미 levelTestDate / levelTestScore / levelTestNotes 가
 *   있지만 그건 "상담 한 건에 딸린 요약 한 줄"이다. 레벨테스트 앱은 한 학생에게
 *   12개월치 시험(m1~m12)을 여러 번 치르게 하고, 회차마다 영역별 점수와 문항별
 *   채점 원본을 남긴다. 상담 행에 욱여넣으면 회차가 덮어쓰기된다.
 *
 * 연동 고리(consultationId / studentId)는 지금은 비어 있다. 원장이 레벨테스트를
 * 먼저 치르고 나중에 등록으로 이어지는 순서가 실제 현장 순서이기 때문이다.
 * 나중에 상담·학생과 이어붙일 때 이 두 칼럼만 채우면 된다 — 그래서 NOT NULL 이
 * 아니고, 상담/학생이 지워져도 시험 기록은 남도록 set null 이다.
 */
export const levelTests = pgTable("level_tests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),

  // 시험 당시 적어 둔 값 그대로 보관한다. 나중에 students 행과 이어져도
  // 이 칼럼을 지우지 않는다 — 그때의 학교·학년이 결과지 재출력에 필요하다.
  studentName: text("student_name").notNull(),
  school: text("school"),
  grade: text("grade"),           // "중1", "고2" 등
  parentPhone: text("parent_phone"),

  // 연동 고리 (지금은 null)
  consultationId: varchar("consultation_id").references(() => consultations.id, { onDelete: "set null" }),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "set null" }),

  // YYYY-MM-DD 문자열. timestamp 로 두면 UTC 변환 때문에 저녁에 치른 시험이
  // 전날로 뜬다 (tasks.dueDate 와 같은 이유).
  testDate: text("test_date").notNull(),
  examCode: text("exam_code").notNull(),    // "m1" ~ "m12"
  examTitle: text("exam_title").notNull(),  // "Level 1 ..." 표시용 문자열

  // 점수는 모두 100점 환산값. 미채점이 남아 있으면 null 일 수 있다.
  totalScore: integer("total_score"),
  readingScore: integer("reading_score"),
  grammarScore: integer("grammar_score"),
  vocabScore: integer("vocab_score"),
  writingScore: integer("writing_score"),

  questionCount: integer("question_count"), // 평가 문항 수
  correctCount: integer("correct_count"),   // 정답 수
  pendingCount: integer("pending_count"),   // 미채점 수
  skippedCount: integer("skipped_count"),   // 미응시 수

  teacherName: text("teacher_name"),
  notes: text("notes"), // 상담 메모

  // 결과지 재출력·재채점용 원본(문항별 채점 상태 등). 화면 구성이 바뀌어도
  // 과거 결과지를 그대로 다시 뽑을 수 있게 앱 상태를 통째로 남긴다.
  rawState: jsonb("raw_state"),

  /**
   * 앱이 만든 기록 식별자 (앱 내부의 consultationId + ':' + exam).
   * upsert 키다 — 같은 학생의 같은 회차를 다시 저장하면 새 행이 아니라
   * 덮어쓰기가 되어야 한다 (엑셀 누적 저장이 하던 동작과 동일).
   *
   * drizzle 스키마에 .unique() 로 적지 않는 이유: 유니크는 (tenant_id,
   * client_record_id) 복합이어야 하는데, 여기에 단일 .unique() 를 적으면
   * drizzle-kit 이 테넌트를 무시한 전역 유니크로 만들어 다른 학원의 기록과
   * 충돌한다. 제약은 scripts/migrate-add-level-tests.ts 가 단독으로 소유한다.
   */
  clientRecordId: text("client_record_id").notNull(),

  /**
   * ── 학부모용 결과지 링크 (3층) ─────────────────────────────────────────
   *
   * 로그인 없이 열리는 주소다. 원장이 카카오톡으로 보내고 학부모가 그냥 누른다.
   * 규칙과 "왜 이렇게 했는지" 는 server/lib/shareLink.ts 에 모아 뒀다.
   *
   * ── 왜 토큰을 해시하지 않고 원문으로 두는가 (중요) ──
   *   단말기 키(toss-front/deviceAuth.ts)는 해시해서 저장한다. 그 키는 **결제를
   *   일으킬 수 있는** 권한이고, DB 가 유출되면 키 자체가 새 피해를 만든다.
   *
   *   이 토큰은 성격이 다르다. 토큰이 지키는 것은 **같은 행에 있는 점수** 뿐이다.
   *   이 칸을 읽을 수 있는 사람은 바로 옆 total_score 도 읽을 수 있으므로,
   *   해시해도 DB 유출에 대해 지켜 주는 것이 하나도 없다. 대신 해시로 두면
   *   원장이 이미 보낸 링크를 다시 복사할 수 없어, "링크 다시 보기" 를 누를 때마다
   *   학부모가 받은 링크가 조용히 죽는다. 지키는 것 없이 사고만 만드는 선택이라
   *   원문으로 둔다.
   */
  shareToken: text("share_token"),
  /**
   * 링크를 만든 시각.
   *
   * 파기(토큰 값 삭제)의 기준 시계다. 이 시각으로부터 6개월이 지나면
   * share_token 을 NULL 로 지운다(server/lib/shareLink.ts 의 SHARE_PURGE_DAYS).
   * **이 칸 자체는 지우지 않는다** — "그 학생에게 결과지를 보냈다" 는
   * 상담 이력이고, 비밀이 아니다.
   */
  shareCreatedAt: timestamp("share_created_at"),
  /** 이 시각이 지나면 링크가 안 열린다. 발급할 때 정한다(기본 5일). */
  shareExpiresAt: timestamp("share_expires_at"),
  /** 원장이 직접 끈 시각. 값이 있으면 만료 전이라도 안 열린다. */
  shareRevokedAt: timestamp("share_revoked_at"),
  /**
   * 학부모가 링크를 연 횟수·마지막 시각.
   *
   * 이 두 칸이 이 기능의 절반이다. "보냈는데 봤는지 모르겠다" 가 사라진다 —
   * 0회면 아직 안 본 것이고, 그 사실이 전화할 이유가 된다.
   */
  shareViewCount: integer("share_view_count").default(0).notNull(),
  shareLastViewedAt: timestamp("share_last_viewed_at"),

  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// LessonLog table (반별 일지)
export const lessonLogs = pgTable("lesson_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  date: timestamp("date").notNull(),
  progress: text("progress"), // 진도
  homework: text("homework"), // 숙제
  notes: text("notes"), // 특이사항
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Waiter table (대기자)
export const waiters = pgTable("waiters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Task table (퇴근전 할 일)
export const tasks = pgTable("tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  // YYYY-MM-DD. timestamp를 쓰면 UTC로 저장되어 한국 시각 오후 9시에 적은 할 일이
  // 전날 것으로 뜬다. 하루 단위 기능이라 날짜 문자열이 맞다.
  dueDate: text("due_date").notNull(),
  slot: taskSlotEnum("slot").default("퇴근전").notNull(),
  // 완료 시각. null이면 아직 안 끝난 일이다.
  completedAt: timestamp("completed_at"),
  // 며칠 미뤘는지. 미루기 한 번이 하루이므로 이 값이 곧 밀린 날수다.
  // 화면에서 숫자가 커질수록 빨갛게 만들어 경고하는 근거가 된다.
  deferCount: integer("defer_count").default(0).notNull(),
  notes: text("notes"),
  sourceText: text("source_text"),
  // 설명회 역산으로 생긴 할 일이면 그 프로젝트를 가리킨다. 손으로 적은 일은 null.
  // 할 일 테이블을 따로 두지 않은 이유: 설명회 준비도 결국 "퇴근 전에 할 일"이고,
  // 나누면 원장이 화면 두 개를 봐야 한다.
  projectId: varchar("project_id").references(() => projects.id, { onDelete: "cascade" }),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Project tables (설명회·광고 프로젝트) ──────────────────────────────
// D-day 하나를 넣으면 역산 템플릿이 준비 할 일을 날짜별로 깔아 준다.
//
// kind / 연락 상태 같은 구분값에 pgEnum 을 쓰지 않았다. pgEnum 은 값을 하나 더할 때마다
// drizzle-kit push 가 데이터 손실 우려로 대화형 확인을 요구해 배포가 멈춘다
// (railway.toml 주석 1번). text + zod 검증이면 종류를 늘려도 마이그레이션이 필요 없다.
export type ProjectTemplateItem = {
  /** D-day 기준 며칠 전인가. D-21 이면 -21, 당일이면 0 */
  offsetDays: number;
  title: string;
  slot: "퇴근전" | "출근전";
};

export const PROJECT_KINDS = [
  "설명회",
  "신규반",
  "신규학생모집",
  "교차수업",
  "합동모의고사",
  "전단",
  "온라인광고",
  "기타",
] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

/**
 * 스케쥴러 화면의 탭 구성. 탭 하나가 종류 몇 개를 맡는다.
 *
 * 종류를 탭과 1:1 로 두지 않은 이유: 원장에게 "전단"과 "온라인광고"는 따로 관리할 일이
 * 아니라 둘 다 광고다. 반대로 "신규반"과 "신규학생모집"은 D-day 의 의미 자체가 달라서
 * (개강일 vs 모집 마감일) 한 탭에 섞으면 역산 템플릿이 엉킨다.
 */
export const SCHEDULER_TABS = [
  {
    key: "promo",
    label: "설명회 & 광고",
    // 신규학생모집을 따로 떼지 않았다. 원장에게 광고는 곧 모집이라 탭을 나누면
    // 같은 달의 설명회와 모집 광고가 두 화면으로 갈라져 오히려 안 보인다.
    kinds: ["설명회", "신규학생모집", "합동모의고사", "전단", "온라인광고", "기타"],
  },
  { key: "newclass", label: "신규반 형성 프로젝트", kinds: ["신규반"] },
  { key: "cross", label: "타학원 교차수업", kinds: ["교차수업"] },
] as const satisfies readonly { key: string; label: string; kinds: readonly ProjectKind[] }[];

/**
 * 종류별 기본 역산 묶음. 그 종류의 템플릿이 하나도 없을 때만 깔린다.
 * 원장이 설정 화면에서 고치면 그 뒤로는 고친 것이 쓰인다 — 여기 값은 다시 덮어쓰지 않는다.
 *
 * ⚠️ 어떤 종류의 템플릿을 **전부** 지우면 다음 방문에 기본값이 다시 깔린다.
 *    "빈 탭을 보여 주느니 기본값이라도 있는 편이 낫다"는 쪽을 택한 결과다.
 *    기본값이 싫으면 지우지 말고 **내용을 고쳐** 두면 된다.
 */
export const DEFAULT_PROJECT_TEMPLATES: { kind: ProjectKind; name: string; items: ProjectTemplateItem[] }[] = [
  {
    kind: "설명회",
    name: "설명회 기본",
    items: [
      { offsetDays: -21, title: "장소 확정", slot: "퇴근전" },
      { offsetDays: -14, title: "홍보물 제작", slot: "퇴근전" },
      { offsetDays: -10, title: "학부모 문자 1차", slot: "출근전" },
      { offsetDays: -3, title: "학부모 문자 2차", slot: "출근전" },
      { offsetDays: -1, title: "자료 인쇄", slot: "퇴근전" },
    ],
  },
  {
    // D-day 는 **개강일**이다. 모집 마감이 아니다 — 마감을 D-day 로 잡으면
    // 개강 준비(교재·출석부)가 역산에서 빠진다.
    kind: "신규반",
    name: "신규반 형성 기본",
    items: [
      { offsetDays: -30, title: "반 구성안 확정 (학년·레벨·정원)", slot: "퇴근전" },
      { offsetDays: -21, title: "시간표·강의실 확정", slot: "퇴근전" },
      { offsetDays: -21, title: "담당 교사 배정", slot: "퇴근전" },
      { offsetDays: -14, title: "대기 학생 명단 확인·연락", slot: "출근전" },
      { offsetDays: -10, title: "학부모 공지 문자", slot: "출근전" },
      { offsetDays: -7, title: "모집 마감·최종 인원 확정", slot: "퇴근전" },
      { offsetDays: -3, title: "교재 주문 확인", slot: "퇴근전" },
      { offsetDays: -1, title: "출석부·자리 배치 준비", slot: "퇴근전" },
    ],
  },
  {
    // D-day 는 **모집 마감일**이다.
    kind: "신규학생모집",
    name: "신규학생 모집 기본",
    items: [
      { offsetDays: -30, title: "모집 대상·정원 확정", slot: "퇴근전" },
      { offsetDays: -21, title: "홍보 문구·이미지 제작", slot: "퇴근전" },
      { offsetDays: -14, title: "네이버·블로그 광고 집행", slot: "퇴근전" },
      { offsetDays: -10, title: "기존 학부모 소개 요청 문자", slot: "출근전" },
      { offsetDays: -7, title: "상담 예약 현황 점검", slot: "출근전" },
      { offsetDays: -3, title: "미등록 상담자 재연락", slot: "출근전" },
    ],
  },
  {
    // 타 과목 학원과 묶어서 여는 수업. D-day 는 첫 수업일이다.
    kind: "교차수업",
    name: "교차수업 기본",
    items: [
      { offsetDays: -30, title: "제휴 학원 접촉·미팅", slot: "퇴근전" },
      { offsetDays: -21, title: "수업 일정·장소 협의", slot: "퇴근전" },
      { offsetDays: -14, title: "수강료·정산 방식 합의", slot: "퇴근전" },
      { offsetDays: -10, title: "양쪽 학부모 공지", slot: "출근전" },
      { offsetDays: -7, title: "신청 마감·명단 확정", slot: "퇴근전" },
      { offsetDays: -1, title: "교재·출석부 준비", slot: "퇴근전" },
    ],
  },
];

export const projects = pgTable("projects", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  /** 설명회 | 합동모의고사 | 전단 | 온라인광고 | 기타 */
  kind: text("kind").notNull(),
  // YYYY-MM-DD. tasks.dueDate 와 같은 이유로 문자열이다 — timestamp 로 두면 UTC 로 저장되어
  // 한국 시각 밤에 넣은 날짜가 전날로 뜬다.
  dDay: text("d_day").notNull(),
  place: text("place"),
  /** 파트너 학원 */
  partner: text("partner"),
  budget: integer("budget"),
  notes: text("notes"),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// 종류별 역산 묶음. 설정 화면에서 편집한다.
// items 예: [{ offsetDays: -21, title: "장소 확정", slot: "퇴근전" }, ...]
// offsetDays 는 D-day 기준 음수다 (D-21 = -21, 당일 = 0).
export const projectTemplates = pgTable("project_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  items: jsonb("items").$type<ProjectTemplateItem[]>().notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// 설명회 참석 신청자. 상담으로 넘기면 consultationId 가 채워지고,
// 그때부터 화면의 버튼이 "상담으로 넘기기"에서 "상담 보기"로 바뀐다.
export const projectAttendees = pgTable("project_attendees", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  projectId: varchar("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  notes: text("notes"),
  consultationId: varchar("consultation_id").references(() => consultations.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── 학부모 학습 리포트 ────────────────────────────────────────────────
// 설계와 "왜" 는 docs/PARENT_REPORT_PLAN.md. 테이블은 scripts/migrate-add-learning-report.ts 가 만든다.
//
// 기존 테이블에는 칼럼을 하나도 더하지 않았다 (tenants.share_phone 사고, railway.toml 주석 5).
// 복합·부분 유니크는 여기 적지 않고 마이그레이션 스크립트가 단독으로 소유한다 —
// .unique() 로 적으면 drizzle-kit 이 테넌트·조건을 무시한 단일 유니크로 바꾸려 든다
// (payments.externalPaymentKey, levelTests.clientRecordId 와 같은 이유).
//
// 상태값은 pgEnum 이 아니라 text + 아래 상수로 검증한다 (railway.toml 주석 1).

export const HOMEWORK_STATUSES = ["done", "partial", "none", "pending"] as const;
export type HomeworkStatus = (typeof HOMEWORK_STATUSES)[number];
export const HOMEWORK_COUNT_UNITS = ["문항", "단어", "회", "쪽"] as const;

export const EXAM_KINDS = ["weekly", "monthly", "unit", "retest"] as const;
export type ExamKind = (typeof EXAM_KINDS)[number];

export const MAKEUP_REASONS = ["retest", "homework", "absence", "other"] as const;
export type MakeupReason = (typeof MAKEUP_REASONS)[number];
export const MAKEUP_STUDENT_STATUSES = ["scheduled", "done", "noshow"] as const;
export type MakeupStudentStatus = (typeof MAKEUP_STUDENT_STATUSES)[number];

/**
 * 과목별 시험 영역 기본값. classes.subject 로 고른다.
 * 영역 이름은 시험마다 exams.areas 에 저장되므로, 여기는 "새 시험을 만들 때 미리 채워 줄 값" 일 뿐이다.
 * 과목을 늘릴 때 테이블을 바꿀 필요가 없다.
 */
export const DEFAULT_EXAM_AREAS: Record<string, string[]> = {
  영어: ["어휘", "문법", "독해"],
  수학: ["연산", "개념이해", "문제해결"],
  국어: ["문학", "비문학", "문법"],
};

/** 사진이 6개월 지나면 원본(note_photo_files)을 지운다. 원장 결정 2026-11-07. */
export const NOTE_PHOTO_RETENTION_DAYS = 183;

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// 반 × 주 하나. 진도와 "공개" 스위치를 가진다. 숙제·시험·사진은 전부 이 행에 매달린다.
// 공개를 항목마다가 아니라 반의 한 주 전체에 한 번 거는 것이 선생님에게 실수가 적다.
// UNIQUE (class_id, week_start) — 스크립트 소유.
export const reportWeeks = pgTable("report_weeks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  // 그 주 월요일 YYYY-MM-DD. timestamp 면 UTC 로 저장돼 한국 월요일 새벽이 전주로 넘어간다.
  weekStart: text("week_start").notNull(),
  textbook: text("textbook"),
  unit: text("unit"),
  topic: text("topic"),
  progressPct: integer("progress_pct"),
  // NULL = 작성 중. 부모님 화면은 이 값이 있는 주만 읽는다.
  publishedAt: timestamp("published_at"),
  publishedBy: varchar("published_by").references(() => users.id),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// 반 전체에 낸 숙제. totalCount 가 NULL 이면 완료·일부·안함만 고르는 숙제다.
export const homeworkItems = pgTable("homework_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  reportWeekId: varchar("report_week_id").references(() => reportWeeks.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  totalCount: integer("total_count"),
  countUnit: text("count_unit"),
  dueDate: text("due_date"),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// 학생별 숙제 검사. "6문항 모자랍니다" 는 저장하지 않고 totalCount - doneCount 로 그때 계산한다.
// UNIQUE (homework_item_id, student_id) — 스크립트 소유.
export const homeworkChecks = pgTable("homework_checks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  homeworkItemId: varchar("homework_item_id").references(() => homeworkItems.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  status: text("status").default("pending").notNull(),
  doneCount: integer("done_count"),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// 시험 한 번. 영역 이름을 시험마다 저장해 두면 과목이 늘어도 테이블을 바꿀 필요가 없다.
export const exams = pgTable("exams", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  reportWeekId: varchar("report_week_id").references(() => reportWeeks.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  kind: text("kind").default("weekly").notNull(),
  examDate: text("exam_date").notNull(),
  passScore: integer("pass_score"),
  areas: jsonb("areas").$type<string[]>().notNull(),
  // 재시험이면 원래 시험. 원래 시험을 지워도 재시 기록은 남긴다.
  retestOf: varchar("retest_of"),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// 학생별 점수. 반 평균·상위 %·통과 여부는 저장하지 않는다 — 점수를 고치면 저절로 맞아야 해서
// 읽을 때 계산한다. total 만 저장하는 이유는 정렬·평균 계산을 매번 jsonb 에서 꺼내지 않으려는 것.
// UNIQUE (exam_id, student_id) — 스크립트 소유.
export const examScores = pgTable("exam_scores", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  examId: varchar("exam_id").references(() => exams.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  areaScores: jsonb("area_scores").$type<Record<string, number>>().notNull(),
  total: integer("total"),
  absent: boolean("absent").default(false).notNull(),
  // 부모님 화면에 그대로 나가는 글이다. 교사용 메모를 여기 적지 않도록 화면에서 안내한다.
  comment: text("comment"),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// 보강·재시 일정. 학생 여럿이 붙으므로 학생은 makeup_students 에 따로 둔다.
// 일정은 급한 정보라 report_weeks 공개를 기다리지 않고 등록 즉시 부모님께 보인다.
export const makeupSessions = pgTable("makeup_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "set null" }),
  date: text("date").notNull(),
  startTime: text("start_time"),
  minutes: integer("minutes"),
  reason: text("reason").default("other").notNull(),
  content: text("content").notNull(),
  examId: varchar("exam_id").references(() => exams.id, { onDelete: "set null" }),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// UNIQUE (makeup_id, student_id) — 스크립트 소유.
export const makeupStudents = pgTable("makeup_students", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  makeupId: varchar("makeup_id").references(() => makeupSessions.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  status: text("status").default("scheduled").notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// 노트 사진 정보. 이미지 본체는 note_photo_files 에 따로 둔다 — 목록·리포트는 이 행만 읽고
// 이미지는 <img> 가 따로 부르므로, 한 테이블에 두면 목록 한 번에 사진 수십 장이 딸려 온다.
// studentId 가 NULL 이면 반 전체에게 보인다.
export const notePhotos = pgTable("note_photos", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  reportWeekId: varchar("report_week_id").references(() => reportWeeks.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  takenDate: text("taken_date").notNull(),
  width: integer("width"),
  height: integer("height"),
  bytes: integer("bytes"),
  // 보관 기간(NOTE_PHOTO_RETENTION_DAYS)이 지나 원본을 지운 시각. 행은 남겨 "보관 기간이 지난 사진" 으로 표시한다.
  purgedAt: timestamp("purged_at"),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const notePhotoFiles = pgTable("note_photo_files", {
  photoId: varchar("photo_id").primaryKey().references(() => notePhotos.id, { onDelete: "cascade" }),
  mime: text("mime").notNull(),
  data: bytea("data").notNull(),
});

// 단어시험 — 학생 × 날짜 한 줄. 페이지원은 본수업·클리닉 상관없이 올 때마다 단어시험을 본다(주 2~3회).
// 문항 수가 학생마다 조금씩 달라 total 도 줄마다 저장한다. 통과·반복쓰기·재시험 판정은 저장하지 않고
// shared/learningReport.ts 의 vocabResult 로 그때 계산한다(기준이 바뀌어도 기록을 고칠 필요가 없다).
// 기록은 그 날짜가 속한 주(report_weeks)에 매달려, 주를 공개해야 부모님께 보인다.
// UNIQUE (class_id, student_id, test_date) — 스크립트 소유.
export const vocabScores = pgTable("vocab_scores", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  reportWeekId: varchar("report_week_id").references(() => reportWeeks.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  testDate: text("test_date").notNull(),
  total: integer("total").notNull(),
  wrong: integer("wrong").notNull(),
  // 재시험 판정을 받은 뒤 다시 봐서 통과했는가. NULL = 아직(또는 재시 대상이 아님).
  retestPassed: boolean("retest_passed"),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── 주간 클리닉 시험 ──────────────────────────────────────────────────
// 페이지원의 금(토) 클리닉 = 단계별 주간 시험 (원장 설명 2026-11-08).
//   듣기(약 17문항, 다른 교실) / 브릿지 모의고사(100점) / 고1 모의고사 / 고2·3 모의고사(100점, 등급 자동)
// 브릿지·모의고사는 **여러 반 학생이 한 교실에 섞여** 각자 단계를 푼다 → 반이 아니라 학생 단위로 기록한다.
// 선택 수강이라 안 듣는 학생(중학생 약 15%, 고등부 전원)은 단계를 "none" 으로 둔다.

export const CLINIC_LEVELS = ["listening", "bridge", "mock1", "mock23"] as const;
export type ClinicLevel = (typeof CLINIC_LEVELS)[number];
export const CLINIC_LEVEL_CHOICES = [...CLINIC_LEVELS, "none"] as const;
export type ClinicLevelChoice = (typeof CLINIC_LEVEL_CHOICES)[number];

// 학생별 클리닉 단계. 학생당 한 줄. 기존 students 에 칸을 더하지 않으려고 따로 둔다(share_phone 사고).
// UNIQUE (student_id) — 스크립트 소유.
export const studentClinicLevels = pgTable("student_clinic_levels", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  level: text("level").notNull(),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// 클리닉 하루. 그날 단계별로 푼 시험지 이름과 **공개 스위치**를 가진다.
// 반이 섞여서 반의 주 공개(report_weeks)를 따를 수 없으므로 클리닉 날마다 따로 공개한다.
// UNIQUE (tenant_id, date) — 스크립트 소유.
export const clinicDays = pgTable("clinic_days", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  date: text("date").notNull(),
  // { listening: "듣기 12회", mock1: "2024년 9월 고1" } — 부모님 화면에 시험 이름으로 나간다
  papers: jsonb("papers").$type<Partial<Record<ClinicLevel, string>>>().default(sql`'{}'::jsonb`).notNull(),
  publishedAt: timestamp("published_at"),
  publishedBy: varchar("published_by").references(() => users.id),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// 클리닉 점수 — 학생 × 클리닉 날 한 줄. 듣기는 맞은 개수/총 문항, 브릿지·모의는 100점 만점 점수.
// level 은 그날 푼 단계를 그대로 남긴다(나중에 학생 단계가 올라가도 그날 기록은 그날 단계로 보인다).
// UNIQUE (clinic_day_id, student_id) — 스크립트 소유.
export const clinicScores = pgTable("clinic_scores", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  clinicDayId: varchar("clinic_day_id").references(() => clinicDays.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  level: text("level").notNull(),
  score: integer("score"),
  correct: integer("correct"),
  total: integer("total"),
  reviewDone: boolean("review_done").default(false).notNull(),
  updatedBy: varchar("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// 부모님 링크. 학생당 살아 있는 링크는 하나(revoked_at IS NULL) — 부분 유니크, 스크립트 소유.
// 토큰 규칙은 server/lib/shareLink.ts 와 같다(12자). 확인 번호(보호자 번호 뒤 4자리)는 저장하지 않고
// 그때그때 students.parent_phone 과 비교한다 — 보호자 번호를 고치면 확인 번호도 저절로 따라간다.
// 레벨테스트 링크와 달리 기한이 없다. 대신 퇴원(students.is_active=false)·재발급으로 닫힌다.
export const parentLinks = pgTable("parent_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  token: text("token").notNull(),
  revokedAt: timestamp("revoked_at"),
  // 4자리는 1만 가지라 링크별 잠금이 핵심 방어선이다. IP 제한은 그 위의 한 겹.
  failedAttempts: integer("failed_attempts").default(0).notNull(),
  lockedUntil: timestamp("locked_until"),
  lastViewedAt: timestamp("last_viewed_at"),
  viewCount: integer("view_count").default(0).notNull(),
  createdBy: varchar("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// AI Audit Log table (AI 자연어 처리 감사 로그)
export const aiAuditLogs = pgTable("ai_audit_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  sourceText: text("source_text").notNull(),
  intent: text("intent"),
  toolsCalled: text("tools_called"),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  result: text("result"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Attendance table (출석) ───────────────────────────────────────────
// 학생이 학원 로비 태블릿(Toss Front 또는 자체 키오스크)에서 등원 체크한 기록.
// 원장·강사가 관리자 화면에서 수기 입력한 것도 여기 쌓인다.
// unique(studentId, classId, date)로 같은 수업의 하루 이중 출석을 DB에서 막는다.
export const attendance = pgTable("attendance", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }).notNull(),
  classId: varchar("class_id").references(() => classes.id, { onDelete: "cascade" }).notNull(),
  // 출석 대상 수업의 날짜 (YYYY-MM-DD). timestamp가 아니라 문자열로 두는 이유는
  // "18시 수업에 밤 9시에 체크인해도 그날 출석"으로 계산해야 하는데 UTC로 저장하면
  // 자정 근처 체크인이 다음날 기록으로 넘어간다. 하루 단위 기능이라 날짜 문자열이 맞다.
  attendedDate: text("attended_date").notNull(),
  // 실제 체크인이 일어난 시각. 정각 출석/지각 판정에 쓴다.
  checkedInAt: timestamp("checked_in_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  source: attendanceSourceEnum("source").default("MANUAL").notNull(),
  // 키오스크 체크인이면 어느 기기에서 왔는지. MANUAL은 null.
  deviceId: varchar("device_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Toss Front devices (등록된 로비 단말기) ──────────────────────────
// 학원마다 로비에 한두 대씩 배치되는 Toss Front 2 태블릿을 여기서 관리한다.
// 원장이 관리자 화면에서 페어링 코드로 등록하면 이 테이블에 행이 생기고,
// 이후 기기가 서버에 접근할 때 deviceKeyHash로 인증한다.
export const tossFrontDevices = pgTable("toss_front_devices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  // 토스 가맹점 ID. 학원마다 한 개이며 tenants와 1:1이지만 여기 중복 저장해 조회 편의성 확보.
  merchantId: text("merchant_id").notNull(),
  // 기기 인증용 장기키의 해시(bcrypt 또는 sha256). 원본 키는 기기에만 존재.
  // 서버가 원본을 갖지 않아야 DB 유출 시에도 기기 위조가 불가능하다.
  deviceKeyHash: text("device_key_hash").notNull().unique(),
  displayName: text("display_name").notNull(), // "페이지원 로비 프론트" 등
  isActive: boolean("is_active").default(true).notNull(),
  lastSeenAt: timestamp("last_seen_at"),
  // ─── 짧은 페어링 코드 (0.3.2~) ────────────────────────────────────────
  // 태블릿에서 44자 raw deviceKey 를 손으로 치는 것은 실수 유발. 대신 사람이
  // 외울 수 있는 6자 매장코드 + 4자리 PIN 을 발급하고, 온보딩 시 서버가
  // {매장코드, PIN, serialNumber} 를 받아 raw deviceKey 를 응답으로 돌려준다.
  //   pairingCode: 6자 대문자+숫자 (혼동 문자 O/0, I/1 제외), 발급 후 unique
  //   pairingPinHash: PIN(문자열 4자리)의 SHA-256 hex — 원문은 서버에 안 남긴다
  //   pairingRawKeyEncrypted: 발급 시 raw deviceKey 를 AES-256-GCM 으로 감싼 값.
  //     교환 완료 시 이 컬럼을 NULL 로 밀어 서버에서 raw 를 완전히 잊는다.
  //   pairingExpiresAt: 24h TTL. 지나면 exchange 가 거절한다.
  //   serialNumber: 최초 exchange 때 단말기 SDK 가 알려주는 시리얼. 이 값이 채워지면
  //     그 이후 exchange 는 같은 시리얼이 아닌 이상 거절한다 (도난·재사용 방어).
  pairingCode: text("pairing_code").unique(),
  pairingPinHash: text("pairing_pin_hash"),
  pairingRawKeyEncrypted: text("pairing_raw_key_encrypted"),
  pairingExpiresAt: timestamp("pairing_expires_at"),
  serialNumber: text("serial_number"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Payment intents (결제 의도) ───────────────────────────────────────
// 학생이 "결제하기"를 누른 시점에 서버가 미리 만드는 예약 레코드.
// paymentKey를 여기서 생성해 프론트로 넘기고, SDK 승인 후 confirm으로 되돌아온다.
// 같은 청구에 대해 여러 번 시도가 있을 수 있어 unique(paymentKey)만 유지.
export const paymentIntents = pgTable("payment_intents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  paymentKey: text("payment_key").notNull().unique(),
  /**
   * 누구의 결제인가.
   *
   * ⚠️ 0.3.21 까지 NOT NULL 이었다. 0.3.22 에서 **기타 결제**(학생으로 등록되지
   * 않은 건 — 아직 등록 안 한 학생, 교재·자료 판매 등)를 받으려고 NULL 을 허용했다.
   * payments.enrollment_id 가 "학원 운영 지출은 연결할 등록이 없으므로 nullable"
   * 인 것과 정확히 같은 이유다. 장부에는 이미 그런 행이 들어갈 수 있었는데
   * 결제 요청만 학생을 강제하고 있었다.
   *
   * NULL = 학생과 연결되지 않은 결제. 실수로 빠뜨린 게 아니라 **연결할 학생이
   * 없다는 사실**이다. 읽는 쪽은 반드시 두 경우를 구분해서 다뤄야 한다.
   */
  studentId: varchar("student_id").references(() => students.id, { onDelete: "cascade" }),
  // 어떤 수강 등록에 대한 결제인가. invoice 테이블이 없어서 enrollment + paymentMonth로 대체.
  // 기타 결제는 NULL — 위 studentId 주석 참고. 이 값이 NULL 이면 미납 상계 대상이
  // 아니고, 확정 시 payments.type 도 "원비" 가 아니라 "기타" 로 적힌다.
  enrollmentId: varchar("enrollment_id").references(() => enrollments.id, { onDelete: "cascade" }),
  /**
   * 기타 결제일 때 무엇을 받은 돈인지 (예: "교재비", "3월 모의고사"). 학생 결제는 NULL.
   *
   * 이게 없으면 장부에 "Toss Front · 12345678" 만 남아 원장이 몇 달 뒤에 그 돈이
   * 무엇이었는지 알 방법이 전혀 없다. 금액만 있고 이유가 없는 행은 장부가 아니다.
   */
  customLabel: text("custom_label"),
  // 청구월 (YYYY-MM). enrollment + 이 값이 논리적 청구 건을 특정한다.
  // 기타 결제도 이 값은 채운다 — "돈이 들어온 달" 은 언제나 있기 때문이다.
  paymentMonth: text("payment_month").notNull(),
  deviceId: varchar("device_id").references(() => tossFrontDevices.id, { onDelete: "set null" }),
  // 금액 필드는 확정 시점의 값을 그대로 저장한다. 프론트가 조작한 금액을 신뢰하지 않기 위해
  // confirm 시 이 값과 SDK 응답 금액을 대조한다.
  amount: integer("amount").notNull(),
  tax: integer("tax").default(0).notNull(),
  supplyValue: integer("supply_value").default(0).notNull(),
  taxExemptValue: integer("tax_exempt_value").default(0).notNull(),
  /**
   * 태블릿에서 학부모가 **고른** 할부 개월 (0 = 일시불).
   *
   * ── 왜 승인된 값과 따로 두는가 ──
   *   여기 적힌 건 "요청" 이다. 실제로 몇 개월로 승인됐는지는 카드사와 VAN 이
   *   정한다 — 카드사마다 받아 주는 개월이 다르고, 6개월을 요청해도 3개월로
   *   내려오거나 아예 거절될 수 있다. 승인된 값은 단말기가 돌려준
   *   toss_payment_transactions.installment 에 따로 저장한다.
   *
   *   이 둘을 한 칸에 몰아 쓰면 나중에 취소할 때 근거가 사라진다. 취소는
   *   **승인된 개월수**로 걸어야 하고(요청값이 아니다), 그 값은 승인 응답에만
   *   있다. 두 칸으로 나눠 두면 장부가 스스로 어긋남을 드러낸다.
   *
   * nullable 인 이유: 이 컬럼이 생기기 전에 만들어진 intent 가 이미 있다.
   * 그것들을 0 으로 덮어쓰지 않는다 — "일시불이었다" 와 "모른다" 는 다른 사실이다.
   * 읽는 쪽은 null 을 0(일시불)으로 취급한다.
   */
  requestedInstallment: integer("requested_installment"),
  status: paymentIntentStatusEnum("status").default("CREATED").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  approvedAt: timestamp("approved_at"),
  cancelledAt: timestamp("cancelled_at"),
  // 실패·타임아웃 원인 요약 (디버깅용, 개인정보 없음)
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Toss payment transactions (승인 결과 원본) ─────────────────────────
// 실제 카드 승인 결과를 그대로 보관하는 감사 테이블. 세금계산·환불·영수증 재발행에 쓴다.
// 승인번호·TID·van transaction key는 pgcrypto로 암호화 저장하는 것이 이상적이지만
// 1차 버전에서는 text로 두고, 애플리케이션 레이어에서 접근을 최소화한다.
// 카드 원본번호는 절대 저장하지 않으며, 마스킹된 번호만 저장한다.
export const tossPaymentTransactions = pgTable("toss_payment_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  paymentKey: text("payment_key").notNull().unique(),
  intentId: varchar("intent_id").references(() => paymentIntents.id, { onDelete: "cascade" }).notNull().unique(),
  paymentMethod: tossPaymentMethodEnum("payment_method").notNull(),
  van: text("van"),
  tid: text("tid"), // 거래 TID (취소 시 필요). 앱 레이어에서 접근 제한.
  vanTransactionKey: text("van_transaction_key"), // 무카드 취소용
  approvalNumber: text("approval_number").notNull(),
  approvedTimestamp: text("approved_timestamp").notNull(), // SDK가 준 timestamp (밀리초, 정밀도 보존 위해 text)
  maskedCardNumber: text("masked_card_number"),
  issuerName: text("issuer_name"),
  acquirerName: text("acquirer_name"),
  cardType: text("card_type"),
  installment: integer("installment").default(0).notNull(),
  // SDK 원본 응답의 최소 필드만 JSON으로 감사용 저장. 카드 원본번호 필드는 저장 전에 삭제.
  rawResponseJson: text("raw_response_json"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Toss webhook events (수신한 웹훅 감사) ──────────────────────────────
// TossPlace Open API가 보내는 결제 승인/취소 웹훅을 여기 먼저 원문 그대로 저장한다.
// x-toss-webhook-id를 PK로 두어 재전송 시 자동 중복 방지.
// 서명 검증 실패도 status=FAILED로 저장해 공격 시도를 로그로 남긴다.
export const tossWebhookEvents = pgTable("toss_webhook_events", {
  webhookId: text("webhook_id").primaryKey(), // x-toss-webhook-id
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  eventId: text("event_id"),      // x-toss-event-id
  deliveryId: text("delivery_id"), // x-toss-delivery-id (재전송마다 달라짐)
  eventType: text("event_type"),
  signatureValid: boolean("signature_valid").default(false).notNull(),
  status: webhookStatusEnum("status").default("RECEIVED").notNull(),
  // 원문 body 그대로 (JSON 문자열). 사후 대사에 필요.
  payloadJson: text("payload_json"),
  errorMessage: text("error_message"),
  receivedAt: timestamp("received_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  processedAt: timestamp("processed_at"),
});

// ─── Kiosk devices (학생용 태블릿 웹앱 인증) ────────────────────────────
// 이건 Toss Front 하드웨어가 아니다. 학원 로비에 세워두는 일반 태블릿의 브라우저에서
// 여는 EduSyncPro 학생 키오스크 웹페이지 전용 인증 토큰이다.
// 원장이 관리자 화면에서 발급 → 태블릿 setup 페이지에 한 번 붙여넣기 → localStorage 저장.
// 이후 이 태블릿은 로그인 없이 학생 검색·청구서 조회·결제요청 만 할 수 있다.
export const kioskDevices = pgTable("kiosk_devices", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  // 태블릿이 지닌 장기키의 해시. Toss Front device와 같은 방식.
  kioskKeyHash: text("kiosk_key_hash").notNull().unique(),
  displayName: text("display_name").notNull(), // "로비 태블릿 1" 등
  // 이 태블릿에서 만든 dispatch를 어느 Toss Front로 보낼지. NULL이면 tenant 내 첫 활성 프론트로 자동 라우팅.
  // 실무: 학원에 프론트 1대뿐이면 NULL이 편하고, 여러 대면 명시적으로 매핑.
  pairedFrontDeviceId: varchar("paired_front_device_id").references(() => tossFrontDevices.id, { onDelete: "set null" }),
  isActive: boolean("is_active").default(true).notNull(),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Payment dispatches (태블릿 → 프론트 라우팅 큐) ────────────────────
// "결제 단말기 모드"의 핵심 테이블. 태블릿 웹에서 결제하기를 눌렀을 때 서버가 이 행을 만들고
// SSE로 프론트에 밀어낸다. 프론트가 실패해도 재시도할 수 있게 감사기록으로 남긴다.
//
// paymentKey를 UNIQUE로 두는 이유: 같은 결제요청이 두 번 dispatch되면 안 된다.
// 프론트 재시작 후 폴백 폴링으로 다시 받아도 이 UNIQUE가 방어.
export const paymentDispatches = pgTable("payment_dispatches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  paymentKey: text("payment_key").notNull().unique(),
  intentId: varchar("intent_id").references(() => paymentIntents.id, { onDelete: "cascade" }).notNull().unique(),
  // 어느 태블릿에서 시작됐는가 (감사·화면 표시)
  kioskDeviceId: varchar("kiosk_device_id").references(() => kioskDevices.id, { onDelete: "set null" }),
  // 어느 프론트로 보냈는가 (SSE 채널 라우팅 키)
  tossDeviceId: varchar("toss_device_id").references(() => tossFrontDevices.id, { onDelete: "set null" }).notNull(),
  amount: integer("amount").notNull(),
  // sdk.payment.requestPayment 에 그대로 넘길 두 값. 프론트 폴링 응답에도 포함되어야 하므로 여기에 저장한다.
  orderId: text("order_id").notNull(),
  orderName: text("order_name").notNull(),
  status: paymentDispatchStatusEnum("status").default("PENDING").notNull(),
  // 프론트가 실제로 받아간 시각. NULL이면 아직 전달 안 됨.
  deliveredAt: timestamp("delivered_at"),
  // 프론트가 결과를 업로드한 시각.
  respondedAt: timestamp("responded_at"),
  // 만료 시각 (기본 3분). intent expiresAt과 정렬.
  expiresAt: timestamp("expires_at").notNull(),
  // 실패·취소 원인 요약 (개인정보 없음)
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// ─── Payment cancel dispatches (원장 → 프론트 카드취소 큐) ──────────────
// 원장이 웹에서 "카드 취소"를 누르면 서버가 이 행을 만들고, 프론트 단말기가 폴링으로
// 집어가 sdk.payment.requestPaymentCancel 을 호출한다. 성공 보고가 돌아오면 그때
// 비로소 payments 에 음수 행을 쓴다.
//
// ── 왜 payment_dispatches 를 재사용하지 않았나 ──
//   그 테이블은 payment_key 와 intent_id 가 **둘 다 UNIQUE** 다. 취소는 원결제와
//   같은 키를 가리키므로 넣는 순간 23505 가 난다. 그리고 그 UNIQUE 들은 같은 결제가
//   두 번 dispatch 되는 걸 막는 방어선이라 풀 수 없다. 그래서 테이블을 나눈다.
//
// ── 중복 취소 방어 ──
//   payment_key 에 **부분 유니크 인덱스**를 건다 (WHERE status <> 'FAILED').
//   FAILED 만 재시도를 허용한다는 규칙을 DB 층에서도 강제하기 위해서다.
//   애플리케이션 판정(classifyCardCancel)이 뚫려도 DB 가 마지막으로 막는다.
//   인덱스는 migrate-add-card-cancel.ts 에서 만든다 (drizzle 부분 인덱스 미지원).
export const paymentCancelDispatches = pgTable("payment_cancel_dispatches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: varchar("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  // 원결제의 paymentKey. UNIQUE 가 아니다 — 실패한 시도가 기록으로 남고 재시도가
  // 새 행을 만들기 때문. 동시성 방어는 위의 부분 유니크 인덱스가 한다.
  paymentKey: text("payment_key").notNull(),
  intentId: varchar("intent_id").references(() => paymentIntents.id, { onDelete: "cascade" }).notNull(),
  // 어느 단말기로 보내는가. 원승인이 일어난 그 단말기여야 한다
  // (payment_intents.device_id). 다른 단말기에 보내면 취소 결과 캐시도 그쪽에 없다.
  tossDeviceId: varchar("toss_device_id").references(() => tossFrontDevices.id, { onDelete: "set null" }).notNull(),
  // 카드에서 되돌리는 금액 = 원승인 전액. SDK 가 부분 취소를 지원하지 않는다.
  cancelAmount: integer("cancel_amount").notNull(),
  // 성공 시 장부에 적을 금액. 원장이 이미 일부를 수기 환불해 뒀다면 이게 더 작다.
  // 요청 시점의 계산값이며, 실제 반영 때 다시 계산해서 더 작은 쪽을 쓴다 (이중 계상 방지).
  ledgerAmount: integer("ledger_amount").notNull(),
  status: cancelDispatchStatusEnum("status").default("PENDING").notNull(),
  // 누가 눌렀는가. 돈을 되돌리는 결정이므로 감사 기록이 반드시 필요하다.
  requestedBy: varchar("requested_by").references(() => users.id, { onDelete: "set null" }),
  reason: text("reason"),
  deliveredAt: timestamp("delivered_at"),
  respondedAt: timestamp("responded_at"),
  expiresAt: timestamp("expires_at").notNull(),
  // 단말기가 돌려준 취소 승인번호·TID. 사장님 앱과 대조할 때 쓴다.
  cancelApprovalNumber: text("cancel_approval_number"),
  cancelTid: text("cancel_tid"),
  // 실패·타임아웃 원인 (개인정보 없음)
  failureReason: text("failure_reason"),
  // 단말기 응답 원문 최소 필드. 카드 원본번호는 저장 전에 제거한다.
  rawResponseJson: text("raw_response_json"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Relations
export const tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  teachers: many(teachers),
  classes: many(classes),
  students: many(students),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [users.tenantId],
    references: [tenants.id],
  }),
  teacher: one(teachers),
  payments: many(payments),
  lessonLogs: many(lessonLogs),
}));

export const teachersRelations = relations(teachers, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [teachers.tenantId],
    references: [tenants.id],
  }),
  user: one(users, {
    fields: [teachers.userId],
    references: [users.id],
  }),
  classes: many(classes),
}));

export const classesRelations = relations(classes, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [classes.tenantId],
    references: [tenants.id],
  }),
  teacher: one(teachers, {
    fields: [classes.teacherId],
    references: [teachers.id],
  }),
  enrollments: many(enrollments),
  lessonLogs: many(lessonLogs),
  waiters: many(waiters),
}));

export const studentsRelations = relations(students, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [students.tenantId],
    references: [tenants.id],
  }),
  enrollments: many(enrollments),
}));

export const enrollmentsRelations = relations(enrollments, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [enrollments.tenantId],
    references: [tenants.id],
  }),
  student: one(students, {
    fields: [enrollments.studentId],
    references: [students.id],
  }),
  class: one(classes, {
    fields: [enrollments.classId],
    references: [classes.id],
  }),
  payments: many(payments),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  tenant: one(tenants, {
    fields: [payments.tenantId],
    references: [tenants.id],
  }),
  enrollment: one(enrollments, {
    fields: [payments.enrollmentId],
    references: [enrollments.id],
  }),
  createdBy: one(users, {
    fields: [payments.createdBy],
    references: [users.id],
  }),
}));

export const lessonLogsRelations = relations(lessonLogs, ({ one }) => ({
  tenant: one(tenants, {
    fields: [lessonLogs.tenantId],
    references: [tenants.id],
  }),
  class: one(classes, {
    fields: [lessonLogs.classId],
    references: [classes.id],
  }),
  createdBy: one(users, {
    fields: [lessonLogs.createdBy],
    references: [users.id],
  }),
}));

export const consultationsRelations = relations(consultations, ({ one }) => ({
  tenant: one(tenants, {
    fields: [consultations.tenantId],
    references: [tenants.id],
  }),
  class: one(classes, {
    fields: [consultations.classId],
    references: [classes.id],
  }),
  student: one(students, {
    fields: [consultations.studentId],
    references: [students.id],
  }),
  createdBy: one(users, {
    fields: [consultations.createdBy],
    references: [users.id],
  }),
}));

export const waitersRelations = relations(waiters, ({ one }) => ({
  tenant: one(tenants, {
    fields: [waiters.tenantId],
    references: [tenants.id],
  }),
  class: one(classes, {
    fields: [waiters.classId],
    references: [classes.id],
  }),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  tenant: one(tenants, {
    fields: [tasks.tenantId],
    references: [tenants.id],
  }),
  createdBy: one(users, {
    fields: [tasks.createdBy],
    references: [users.id],
  }),
}));

export const aiAuditLogsRelations = relations(aiAuditLogs, ({ one }) => ({
  tenant: one(tenants, {
    fields: [aiAuditLogs.tenantId],
    references: [tenants.id],
  }),
  user: one(users, {
    fields: [aiAuditLogs.userId],
    references: [users.id],
  }),
}));

// Insert schemas
export const insertTenantSchema = createInsertSchema(tenants).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTeacherSchema = createInsertSchema(teachers).omit({ id: true, createdAt: true, updatedAt: true });
export const insertClassSchema = createInsertSchema(classes).omit({ id: true, createdAt: true, updatedAt: true });
export const insertStudentSchema = createInsertSchema(students).omit({ id: true, createdAt: true, updatedAt: true });
export const insertEnrollmentSchema = createInsertSchema(enrollments).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPaymentSchema = createInsertSchema(payments).omit({ id: true, createdAt: true });
export const insertLessonLogSchema = createInsertSchema(lessonLogs).omit({ id: true, createdAt: true, updatedAt: true }).extend({
  date: z.coerce.date(), // 문자열을 자동으로 Date 객체로 변환
});
export const insertWaiterSchema = createInsertSchema(waiters).omit({ id: true, createdAt: true });
export const insertConsultationSchema = createInsertSchema(consultations)
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({
    // JSON으로 들어오는 ISO 문자열/Date 모두 허용
    levelTestDate: z.coerce.date().optional().nullable(),
  });

// POST /api/payments 본문 검증용.
// enrollmentId가 nullable이 되었으므로, 원비/환불일 때만 필수라는 규칙을 코드로 강제한다.
// (insertPaymentSchema 자체는 .omit()을 쓰는 기존 코드가 있어 ZodObject로 남겨둔다)
export const createPaymentBodySchema = insertPaymentSchema
  .omit({ tenantId: true, createdBy: true })
  .refine(
    (d) => d.type === "지출" || d.type === "기타" || !!d.enrollmentId,
    { message: "원비/환불은 수강 등록(enrollmentId)이 필요합니다.", path: ["enrollmentId"] }
  )
  .refine(
    (d) => (d.type === "환불" || d.type === "지출" ? d.amount < 0 : d.amount > 0),
    { message: "환불·지출은 음수, 원비는 양수로 입력해야 합니다.", path: ["amount"] }
  );

export const createConsultationBodySchema = insertConsultationSchema
  .omit({ tenantId: true, createdBy: true });

export const insertTaskSchema = createInsertSchema(tasks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertAiAuditLogSchema = createInsertSchema(aiAuditLogs).omit({ id: true, createdAt: true });
export const insertLevelTestSchema = createInsertSchema(levelTests).omit({ id: true, createdAt: true, updatedAt: true });

// ─── Toss Front 통합 insert 스키마 ───────────────────────────────────────
export const insertAttendanceSchema = createInsertSchema(attendance).omit({ id: true, createdAt: true });
export const insertTossFrontDeviceSchema = createInsertSchema(tossFrontDevices).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertPaymentIntentSchema = createInsertSchema(paymentIntents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  expiresAt: z.coerce.date(),
});
export const insertTossPaymentTransactionSchema = createInsertSchema(tossPaymentTransactions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertTossWebhookEventSchema = createInsertSchema(tossWebhookEvents).omit({
  receivedAt: true,
});

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다.");

export const createTaskBodySchema = insertTaskSchema
  .omit({ tenantId: true, createdBy: true, completedAt: true, deferCount: true })
  .extend({
    title: z.string().trim().min(1, "할 일 내용이 필요합니다.").max(200),
    dueDate: ymd,
  });

/**
 * 할 일 갱신. 완료 토글과 미루기 두 가지에만 쓴다.
 *
 * deferCount를 클라이언트가 정하지 않는다. 미루기를 누른 횟수는 서버가 세야
 * "3일 밀림"이라는 경고가 화면 조작으로 지워지지 않는다.
 */
export const updateTaskBodySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().nullable().optional(),
  completed: z.boolean().optional(),
  /** "하루 미루기"(퇴근전) 또는 "출근전 하기" — 둘 다 하루 뒤로 넘긴다 */
  defer: z.enum(["퇴근전", "출근전"]).optional(),
});

// ─── 설명회·광고 프로젝트 ────────────────────────────────────────────────
export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertProjectTemplateSchema = createInsertSchema(projectTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertProjectAttendeeSchema = createInsertSchema(projectAttendees).omit({
  id: true,
  createdAt: true,
});

// ─── 학부모 학습 리포트 ──────────────────────────────────────────────────
export const insertReportWeekSchema = createInsertSchema(reportWeeks).omit({ id: true, createdAt: true, updatedAt: true });
export const insertHomeworkItemSchema = createInsertSchema(homeworkItems).omit({ id: true, createdAt: true });
export const insertHomeworkCheckSchema = createInsertSchema(homeworkChecks).omit({ id: true, updatedAt: true });
export const insertExamSchema = createInsertSchema(exams).omit({ id: true, createdAt: true, updatedAt: true });
export const insertExamScoreSchema = createInsertSchema(examScores).omit({ id: true, updatedAt: true });
export const insertMakeupSessionSchema = createInsertSchema(makeupSessions).omit({ id: true, createdAt: true, updatedAt: true });
export const insertMakeupStudentSchema = createInsertSchema(makeupStudents).omit({ id: true, updatedAt: true });
export const insertNotePhotoSchema = createInsertSchema(notePhotos).omit({ id: true, createdAt: true, purgedAt: true });
export const insertParentLinkSchema = createInsertSchema(parentLinks).omit({ id: true, createdAt: true });

// 화면에서 오는 요청 본문. 학생·반 id 가 우리 학원 것인지는 라우트가 따로 확인한다(여기는 모양만).
const lrYmd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다.");
const lrId = z.string().uuid("유효하지 않은 ID 형식입니다.");
const lrScore = z.number().int().min(0, "점수는 0 이상이어야 합니다.").max(100, "점수는 100 이하여야 합니다.");

export const updateReportWeekBodySchema = z.object({
  textbook: z.string().trim().max(120).nullable().optional(),
  unit: z.string().trim().max(120).nullable().optional(),
  topic: z.string().trim().max(200).nullable().optional(),
  progressPct: z.number().int().min(0).max(100).nullable().optional(),
});

export const homeworkItemBodySchema = z.object({
  title: z.string().trim().min(1, "숙제 내용이 필요합니다.").max(200),
  totalCount: z.number().int().min(1).max(1000).nullable().optional(),
  countUnit: z.enum(HOMEWORK_COUNT_UNITS).nullable().optional(),
  dueDate: lrYmd.nullable().optional(),
  sortOrder: z.number().int().min(0).max(100).optional(),
});
export const updateHomeworkItemBodySchema = homeworkItemBodySchema.partial();

export const homeworkChecksBodySchema = z.object({
  checks: z
    .array(
      z.object({
        studentId: lrId,
        status: z.enum(HOMEWORK_STATUSES).optional(),
        doneCount: z.number().int().min(0).max(1000).nullable().optional(),
      })
    )
    .min(1)
    .max(100),
});

export const examBodySchema = z.object({
  name: z.string().trim().min(1, "시험 이름이 필요합니다.").max(120),
  kind: z.enum(EXAM_KINDS).optional(),
  examDate: lrYmd,
  passScore: lrScore.nullable().optional(),
  // 비우면 반 과목의 기본 영역(DEFAULT_EXAM_AREAS)을 쓴다.
  areas: z.array(z.string().trim().min(1).max(20)).min(1).max(6).optional(),
  retestOf: lrId.nullable().optional(),
});
export const updateExamBodySchema = examBodySchema.partial();

export const examScoresBodySchema = z.object({
  scores: z
    .array(
      z.object({
        studentId: lrId,
        // null 은 "이 영역 점수 지우기" — 칸을 비웠을 때 화면이 보낸다.
        areaScores: z.record(z.string(), lrScore.nullable()).optional(),
        absent: z.boolean().optional(),
        comment: z.string().max(300).nullable().optional(),
      })
    )
    .min(1)
    .max(100),
});

const makeupFields = {
  date: lrYmd,
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "시간은 HH:MM 형식이어야 합니다.").nullable().optional(),
  minutes: z.number().int().min(10).max(480).nullable().optional(),
  reason: z.enum(MAKEUP_REASONS).optional(),
  content: z.string().trim().min(1, "부모님께 보일 내용이 필요합니다.").max(200),
};
export const makeupBodySchema = z.object({
  ...makeupFields,
  classId: lrId.nullable().optional(),
  examId: lrId.nullable().optional(),
  studentIds: z.array(lrId).min(1, "학생을 한 명 이상 골라 주세요.").max(100),
});
export const updateMakeupBodySchema = z.object(makeupFields).partial();
export const makeupStudentStatusBodySchema = z.object({ status: z.enum(MAKEUP_STUDENT_STATUSES) });

/**
 * 단어시험 일괄 저장. wrong 이 null 이면 그 칸 지우기(그날 시험 기록 없음).
 * testDate 가 그 주 안인지, 학생이 반 명단에 있는지는 라우트가 확인한다.
 */
export const vocabScoresBodySchema = z.object({
  entries: z
    .array(
      z.object({
        studentId: lrId,
        testDate: lrYmd,
        total: z.number().int().min(1, "총 문항은 1 이상이어야 합니다.").max(300),
        wrong: z.number().int().min(0).max(300).nullable(),
        retestPassed: z.boolean().nullable().optional(),
      })
    )
    .min(1)
    .max(200),
});

export const clinicLevelsBodySchema = z.object({
  items: z.array(z.object({ studentId: lrId, level: z.enum(CLINIC_LEVEL_CHOICES) })).min(1).max(300),
});

export const clinicDayBodySchema = z.object({
  papers: z.record(z.enum(CLINIC_LEVELS), z.string().trim().max(60)).optional(),
});

/**
 * 클리닉 점수 일괄 저장. 듣기는 correct/total, 브릿지·모의는 score. 둘 다 null 이면 그 학생 기록 지우기.
 * 학생의 단계는 저장 시점의 단계(student_clinic_levels)를 서버가 남긴다.
 */
export const clinicScoresBodySchema = z.object({
  entries: z
    .array(
      z.object({
        studentId: lrId,
        score: lrScore.nullable().optional(),
        correct: z.number().int().min(0).max(100).nullable().optional(),
        total: z.number().int().min(1).max(100).nullable().optional(),
        reviewDone: z.boolean().optional(),
      })
    )
    .min(1)
    .max(300),
});

/** 올린 사진의 제목·보일 사람 고치기. studentId 가 null 이면 반 전체. */
export const updateNotePhotoBodySchema = z.object({
  title: z.string().trim().min(1, "사진 제목이 필요합니다.").max(60).optional(),
  studentId: lrId.nullable().optional(),
});

/** 재시 일괄 등록. studentIds 를 비우면 통과 못 한 학생 전원. */
export const retestBodySchema = z.object({
  date: lrYmd,
  startTime: makeupFields.startTime,
  minutes: makeupFields.minutes,
  content: z.string().trim().max(200).optional(),
  studentIds: z.array(lrId).max(100).optional(),
});

const projectTemplateItemSchema = z.object({
  offsetDays: z.number().int().min(-365).max(365),
  title: z.string().trim().min(1, "할 일 내용이 필요합니다.").max(200),
  slot: z.enum(["퇴근전", "출근전"]),
});

export const createProjectBodySchema = insertProjectSchema
  .omit({ tenantId: true, createdBy: true })
  .extend({
    name: z.string().trim().min(1, "프로젝트 이름이 필요합니다.").max(120),
    kind: z.enum(PROJECT_KINDS),
    dDay: ymd,
    place: z.string().trim().max(200).nullable().optional(),
    partner: z.string().trim().max(120).nullable().optional(),
    budget: z.number().int().min(0).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  });

export const updateProjectBodySchema = createProjectBodySchema.partial();

export const projectTemplateBodySchema = z.object({
  kind: z.enum(PROJECT_KINDS),
  name: z.string().trim().min(1).max(120),
  items: z.array(projectTemplateItemSchema).max(50),
});

export const createAttendeeBodySchema = z.object({
  name: z.string().trim().min(1, "이름이 필요합니다.").max(60),
  phone: z.string().trim().max(30).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

/**
 * 역산 할 일 생성.
 *
 * replace 는 "이미 깔린 할 일을 지우고 다시"다. D-day 를 미뤘을 때 쓴다.
 * 기본값이 false 인 이유: 이미 체크해 둔 완료 표시가 조용히 사라지면 안 된다.
 */
export const generateTasksBodySchema = z.object({
  templateId: z.string().uuid().optional(),
  replace: z.boolean().optional(),
});

/**
 * 레벨테스트 저장 본문 (POST /api/level-tests).
 *
 * tenantId / createdBy 는 서버가 토큰에서 채운다 — 클라이언트가 보내면
 * 다른 학원 기록으로 넣을 수 있으므로 받지 않는다.
 *
 * 점수는 0~100 환산값만 허용한다. 앱이 계산해서 보내지만, 채점이 덜 끝난
 * 상태로 저장하는 경우가 실제로 있어 null 을 막지는 않는다.
 */
const score100 = z.number().int().min(0).max(100).nullable().optional();
const countField = z.number().int().min(0).max(1000).nullable().optional();

export const saveLevelTestBodySchema = insertLevelTestSchema
  /**
   * studentId 는 본문으로 받지 않는다.
   *
   * 앱은 이 값을 보내지 않고, 외래키는 "그 학생이 존재하는가" 만 보므로
   * 어느 학원 학생인지 확인해 주지 않는다. 받아 두면 남의 학원 학생에게
   * 성적을 붙일 수 있는 입구가 열린 채로 남는다. 학생 연결은 나중에
   * 서버가 직접 채울 때 열면 된다.
   *
   * consultationId 는 받되, 라우터에서 같은 학원 상담인지 확인한다
   * (server/level-test/routes.ts 의 POST 핸들러 주석 참조).
   *
   * ── share* 칸을 전부 막는 이유 (보안) ──
   *   학부모용 링크(3층)의 칸들이다. 본문으로 받으면 저장 요청 한 번으로
   *   · 토큰을 공격자가 고른 값으로 바꾸거나(= 링크 주소를 미리 알아낸다)
   *   · 만료 시각을 100년 뒤로 밀거나
   *   · 끊어 둔 링크(revoked)를 되살리거나
   *   · 열어 본 횟수를 0 으로 되돌려 "학부모가 봤는지" 기록을 지울 수 있다.
   *   이 칸들은 전용 라우터(server/level-test/shareRoutes.ts)만 건드린다.
   *   레벨테스트 앱은 이 값을 보내지도 않는다.
   */
  .omit({
    tenantId: true,
    createdBy: true,
    studentId: true,
    shareToken: true,
    shareCreatedAt: true,
    shareExpiresAt: true,
    shareRevokedAt: true,
    shareViewCount: true,
    shareLastViewedAt: true,
  })
  .extend({
    studentName: z.string().trim().min(1, "학생 이름이 필요합니다.").max(60),
    school: z.string().trim().max(60).nullable().optional(),
    grade: z.string().trim().max(20).nullable().optional(),
    parentPhone: z.string().trim().max(30).nullable().optional(),
    testDate: ymd,
    examCode: z.string().trim().min(1, "시험 종류가 필요합니다.").max(20),
    examTitle: z.string().trim().min(1).max(120),
    totalScore: score100,
    readingScore: score100,
    grammarScore: score100,
    vocabScore: score100,
    writingScore: score100,
    questionCount: countField,
    correctCount: countField,
    pendingCount: countField,
    skippedCount: countField,
    teacherName: z.string().trim().max(60).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    /**
     * 결과지 재출력용 원본(채점 표시 + 입력값). 구조가 앱 버전마다 달라질 수
     * 있으므로 형태는 검증하지 않지만, **크기는 반드시 막는다.**
     *
     * 왜: 레벨테스트 앱의 state 안에는 로고 base64(한 개가 11만 자)와 교재
     * 이미지가 들어 있다. state 를 그대로 보내면 한 건이 수백 KB가 되어
     *   · express.json 기본 한도(100kb)에 걸려 저장이 통째로 실패하고,
     *   · 통과해도 DB 가 이미지 사본으로 부풀어 목록 조회가 느려진다.
     * 앱은 반드시 이미지·브랜드 자산을 뺀 allowlist payload 만 보낸다.
     * 이 한도는 그 규칙이 깨졌을 때 서버가 바로 알려 주는 안전망이다.
     */
    rawState: z
      .any()
      .nullable()
      .optional()
      .refine(
        (v) => v == null || JSON.stringify(v).length <= 60_000,
        {
          message:
            "결과지 원본이 너무 큽니다(60KB 초과). 이미지·로고가 섞여 들어간 경우입니다.",
        }
      ),
    clientRecordId: z.string().trim().min(1, "기록 ID가 필요합니다.").max(200),
  });

// Update schemas
export const updateEnrollmentSchema = z.object({
  studentId: z.string().optional(),
  classId: z.string().optional(),
  startDate: z.string().optional(), // YYYY-MM-DD 문자열로 받기
  tuition: z.number().optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
  endDate: z.string().optional(), // YYYY-MM-DD 문자열로 받기
  isActive: z.boolean().optional(),
});

// Types
export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type Teacher = typeof teachers.$inferSelect;
export type Class = typeof classes.$inferSelect;
export type Student = typeof students.$inferSelect;
export type Enrollment = typeof enrollments.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type LessonLog = typeof lessonLogs.$inferSelect;
export type Waiter = typeof waiters.$inferSelect;
export type Consultation = typeof consultations.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskSlot = Task["slot"];
export type Project = typeof projects.$inferSelect;
export type ProjectTemplate = typeof projectTemplates.$inferSelect;
export type ProjectAttendee = typeof projectAttendees.$inferSelect;
export type ReportWeek = typeof reportWeeks.$inferSelect;
export type HomeworkItem = typeof homeworkItems.$inferSelect;
export type HomeworkCheck = typeof homeworkChecks.$inferSelect;
export type Exam = typeof exams.$inferSelect;
export type ExamScore = typeof examScores.$inferSelect;
export type MakeupSession = typeof makeupSessions.$inferSelect;
export type MakeupStudent = typeof makeupStudents.$inferSelect;
export type NotePhoto = typeof notePhotos.$inferSelect;
export type ParentLink = typeof parentLinks.$inferSelect;
export type VocabScore = typeof vocabScores.$inferSelect;
export type ClinicDay = typeof clinicDays.$inferSelect;
export type ClinicScore = typeof clinicScores.$inferSelect;
export type AiAuditLog = typeof aiAuditLogs.$inferSelect;
export type LevelTest = typeof levelTests.$inferSelect;
export type Attendance = typeof attendance.$inferSelect;
export type TossFrontDevice = typeof tossFrontDevices.$inferSelect;
export type PaymentIntent = typeof paymentIntents.$inferSelect;
export type PaymentIntentStatus = PaymentIntent["status"];
export type TossPaymentTransaction = typeof tossPaymentTransactions.$inferSelect;
export type TossWebhookEvent = typeof tossWebhookEvents.$inferSelect;
export type KioskDevice = typeof kioskDevices.$inferSelect;
export type PaymentDispatch = typeof paymentDispatches.$inferSelect;
export type PaymentDispatchStatus = PaymentDispatch["status"];

export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertTeacher = z.infer<typeof insertTeacherSchema>;
export type InsertClass = z.infer<typeof insertClassSchema>;
export type InsertStudent = z.infer<typeof insertStudentSchema>;
export type InsertEnrollment = z.infer<typeof insertEnrollmentSchema>;
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type InsertLessonLog = z.infer<typeof insertLessonLogSchema>;
export type InsertWaiter = z.infer<typeof insertWaiterSchema>;
export type InsertConsultation = z.infer<typeof insertConsultationSchema>;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type InsertProjectTemplate = z.infer<typeof insertProjectTemplateSchema>;
export type InsertProjectAttendee = z.infer<typeof insertProjectAttendeeSchema>;
export type InsertReportWeek = z.infer<typeof insertReportWeekSchema>;
export type InsertHomeworkItem = z.infer<typeof insertHomeworkItemSchema>;
export type InsertHomeworkCheck = z.infer<typeof insertHomeworkCheckSchema>;
export type InsertExam = z.infer<typeof insertExamSchema>;
export type InsertExamScore = z.infer<typeof insertExamScoreSchema>;
export type InsertMakeupSession = z.infer<typeof insertMakeupSessionSchema>;
export type InsertMakeupStudent = z.infer<typeof insertMakeupStudentSchema>;
export type InsertNotePhoto = z.infer<typeof insertNotePhotoSchema>;
export type InsertParentLink = z.infer<typeof insertParentLinkSchema>;
export type InsertAiAuditLog = z.infer<typeof insertAiAuditLogSchema>;
export type InsertLevelTest = z.infer<typeof insertLevelTestSchema>;
export type SaveLevelTestBody = z.infer<typeof saveLevelTestBodySchema>;

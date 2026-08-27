/**
 * 출석 체크인 API.
 *
 * 왜 attendance 테이블을 이번 커밋에서 처음 쓰나:
 *   EduSyncPro는 지금까지 출석을 lesson_logs 안에 자유 텍스트로 남기고 있었다.
 *   원장이 직접 적는 흐름이라 그걸로 충분했다. 단말기 체크인은 초 단위 시각과
 *   기기 정보가 확실히 남아야 하고, 나중에 그날 결석·지각을 자동 집계할 여지가
 *   있어서 별도 스키마를 뒀다. 기존 lesson_logs 흐름은 손대지 않는다.
 *
 * 왜 attendedDate가 문자열인가:
 *   저녁 8시 수업에 학생이 밤 10시에 체크인해도 그건 "그날 출석"이다. UTC
 *   timestamp로 저장하면 자정 근처에 하루가 밀리는 실수를 자동으로 유발한다.
 *   KST 하루 단위로 다루므로 YYYY-MM-DD 문자열이 가장 안전하다.
 *
 * 왜 (student, class, date) 유니크 인덱스로 두 번 눌러도 중복이 안 생기나:
 *   학생이 태블릿을 두 번 눌러도 하나만 기록돼야 한다. INSERT ON CONFLICT DO
 *   NOTHING로 처리해서 "두 번째 체크인"은 조용히 성공 응답을 준다.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { attendance, enrollments, classes } from "@shared/schema";
import { deviceGuard } from "./deviceAuth";
import { todayKst } from "@shared/day";

const router = Router();

// ─── 체크인 ────────────────────────────────────────────────────────────
/**
 * 학생이 태블릿에서 "왔어요" 버튼을 누르면 여기로 온다.
 *
 * classId를 함께 받는 이유:
 *   한 학생이 여러 반에 등록돼 있을 수 있어서, 어느 반 수업에 온 건지 명확히
 *   해 두어야 나중에 집계가 맞다. 태블릿 화면에서 오늘 그 학생의 예정된 반을
 *   먼저 골라 준다.
 *
 * 서버가 다시 확인하는 것:
 *   - 그 학생·반 조합이 활성 수강인지 (isActive)
 *   - 학생이 이 학원(tenant) 소속인지 (교차 학원 방지)
 *   - 날짜는 서버 시각으로 정한다. 프론트가 임의 날짜를 보내는 걸 막는다.
 */
const checkInBodySchema = z.object({
  studentId: z.string().uuid("studentId가 필요합니다."),
  classId: z.string().uuid("classId가 필요합니다."),
});

router.post(
  "/attendance/check-in",
  deviceGuard,
  async (req: Request, res: Response) => {
    const parsed = checkInBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message });
    }
    const tenantId = req.device!.tenantId;
    const { studentId, classId } = parsed.data;

    // 활성 수강 확인. 반이 지워졌거나 학생이 그 반에서 빠졌으면 체크인 불가.
    const enrollmentRows = await db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.studentId, studentId),
          eq(enrollments.classId, classId),
          eq(enrollments.isActive, true)
        )
      )
      .limit(1);
    if (enrollmentRows.length === 0) {
      return res.status(404).json({ error: "이 반의 활성 수강이 아닙니다." });
    }

    const attendedDate = todayKst(); // 서버 기준 KST YYYY-MM-DD

    // ON CONFLICT DO NOTHING 로 이중 체크인을 조용히 흡수.
    // 유니크 인덱스 (student, class, attended_date)는 마이그레이션에서 생성.
    // student_id에 tenant scope가 이미 걸려 있어(같은 학생 id는 한 테넌트에만 속한다)
    // tenant_id를 제약 컬럼에 넣지 않아도 안전하다.
    const result = await db.execute(sql`
      INSERT INTO attendance (tenant_id, student_id, class_id, attended_date, source, device_id)
      VALUES (${tenantId}, ${studentId}, ${classId}, ${attendedDate}, 'KIOSK', ${req.device!.id})
      ON CONFLICT (student_id, class_id, attended_date) DO NOTHING
      RETURNING id, checked_in_at
    `);

    const inserted = (result.rows as any[])[0];
    if (!inserted) {
      // 이미 오늘 그 반에 출석했다 — 정상 응답으로 흘려보낸다.
      return res.json({ ok: true, alreadyCheckedIn: true, attendedDate });
    }
    return res.json({
      ok: true,
      alreadyCheckedIn: false,
      attendanceId: inserted.id,
      attendedDate,
      checkedInAt: inserted.checked_in_at,
    });
  }
);

// ─── 오늘 예정된 반 목록 (단말기) ──────────────────────────────────────
/**
 * 특정 학생의 오늘 예정된 반들을 반환한다.
 *
 * classes.schedule은 "월수", "화목", "주말" 등 자유 텍스트라 이 필드로
 * 요일 매칭을 한다. schedule에 오늘 요일이 포함돼 있고 활성 수강이면 반환.
 * 애매한 표기(예: "매일")도 포함시켜 학생이 놓치는 걸 막는다.
 */
router.get(
  "/students/:id/today-classes",
  deviceGuard,
  async (req: Request, res: Response) => {
    const tenantId = req.device!.tenantId;
    const studentId = req.params.id;

    // 오늘 요일 (한글 한 글자)
    const now = new Date();
    // toLocaleString은 시간대 인자를 받아 KST로 강제한다. Railway는 UTC 위에서 돈다.
    const kstNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
    const dayIndex = kstNow.getDay(); // 0=일 ... 6=토
    const dayChar = "일월화수목금토"[dayIndex];

    const enrollmentRows = await db
      .select({
        enrollmentId: enrollments.id,
        classId: classes.id,
        className: classes.name,
        subject: classes.subject,
        schedule: classes.schedule,
      })
      .from(enrollments)
      .innerJoin(classes, eq(enrollments.classId, classes.id))
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.studentId, studentId),
          eq(enrollments.isActive, true)
        )
      );

    const isWeekend = dayIndex === 0 || dayIndex === 6;
    const todays = enrollmentRows.filter((r) => {
      const s = (r.schedule ?? "").trim();
      if (!s) return false;
      if (s.includes(dayChar)) return true;
      if (isWeekend && (s.includes("주말") || s.includes("토") || s.includes("일"))) return true;
      if (s.includes("매일")) return true;
      return false;
    });

    // 오늘 이미 체크인한 반은 표시할 수 있게 알려 준다.
    const attendedDate = todayKst();
    const attended = await db
      .select({ classId: attendance.classId })
      .from(attendance)
      .where(
        and(
          eq(attendance.tenantId, tenantId),
          eq(attendance.studentId, studentId),
          eq(attendance.attendedDate, attendedDate)
        )
      );
    const attendedSet = new Set(attended.map((a) => a.classId));

    return res.json({
      studentId,
      today: attendedDate,
      classes: todays.map((c) => ({
        enrollmentId: c.enrollmentId,
        classId: c.classId,
        className: c.className,
        subject: c.subject,
        schedule: c.schedule,
        alreadyCheckedIn: attendedSet.has(c.classId),
      })),
    });
  }
);

export default router;

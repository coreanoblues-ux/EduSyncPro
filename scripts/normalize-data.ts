/**
 * 학생 학년 + 수업 스케줄 데이터 정규화 스크립트
 *
 * 실행: npx tsx scripts/normalize-data.ts [--dry-run]
 *
 * --dry-run 시 변경 사항만 보여주고 실제 DB 수정은 하지 않는다.
 */

import "dotenv/config";
import { Pool } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ────────────────────────────────────────────────────────────────────────
// 1. 학생 학년 정규화
// ────────────────────────────────────────────────────────────────────────

interface GradeFixResult {
  id: string;
  name: string;
  oldGrade: string | null;
  newGrade: string | null;
  oldSchool: string | null;
  newSchool: string | null;
}

/**
 * 학년 문자열에서 학교급+학년을 뽑아낸다.
 * 예: "동성중3" → { grade: "중3", school: "동성중학교" }
 *     "6학년"  → { grade: null, levelHint: "6" }  (급을 모르면 null)
 *     "중학생" → { grade: null, levelPrefix: "중" }
 */
function parseGradeString(raw: string): {
  grade: string | null;
  school: string | null;
} {
  const s = raw.trim();

  // 이미 정상 포맷 "초5", "중1", "고2"
  if (/^[초중고]\d$/.test(s)) return { grade: s, school: null };

  // "삼육중 중3" — 학교이름 + 공백 + 급학년 (공백 포함 패턴을 먼저 체크)
  {
    const m = s.match(/^(.+?)\s+([초중고]\d)$/);
    if (m) {
      const schoolBase = m[1];
      const suffix = schoolBase.endsWith("중") ? "학교"
        : schoolBase.endsWith("초") ? "등학교"
        : schoolBase.endsWith("고") ? "등학교" : "";
      return {
        grade: m[2],
        school: schoolBase + suffix,
      };
    }
  }

  // "삼육중2" — 학교이름(중 포함) + 학년 숫자만
  {
    const m = s.match(/^(.+?중)(\d)$/);
    if (m) {
      return { grade: `중${m[2]}`, school: m[1] + "학교" };
    }
  }
  {
    const m = s.match(/^(.+?고)(\d)$/);
    if (m) {
      return { grade: `고${m[2]}`, school: m[1] + "등학교" };
    }
  }
  {
    const m = s.match(/^(.+?초)(\d)$/);
    if (m) {
      return { grade: `초${m[2]}`, school: m[1] + "등학교" };
    }
  }

  // "6학년" → "초6" (학원에서 6학년은 초등 6학년)
  {
    const m = s.match(/^(\d)학년$/);
    if (m) {
      const y = parseInt(m[1]);
      if (y <= 6) return { grade: `초${y}`, school: null };
      return { grade: null, school: null }; // 모호
    }
  }

  // "설월 1학년" — 학교이름 + n학년
  {
    const m = s.match(/^(.+?)\s*(\d)학년$/);
    if (m) {
      const schoolBase = m[1].trim();
      const y = parseInt(m[2]);
      // 학교이름에서 급을 추론
      if (schoolBase.endsWith("중") || schoolBase.includes("중학")) {
        return { grade: `중${y}`, school: schoolBase.endsWith("학교") ? schoolBase : schoolBase + "학교" };
      }
      if (schoolBase.endsWith("고") || schoolBase.includes("고등")) {
        return { grade: `고${y}`, school: schoolBase.endsWith("학교") ? schoolBase : schoolBase + "등학교" };
      }
      if (schoolBase.endsWith("초") || schoolBase.includes("초등")) {
        return { grade: `초${y}`, school: schoolBase.endsWith("학교") ? schoolBase : schoolBase + "등학교" };
      }
      // 급 모르면 학년 숫자만으로 추정 (1~6 초, 7~9 중 식은 위험하니 그냥 null)
      return { grade: null, school: schoolBase };
    }
  }

  // "중학생" → 급만 알고 학년을 모름
  if (/^중학생?$/.test(s)) return { grade: null, school: null };
  if (/^고등학생?$/.test(s)) return { grade: null, school: null };
  if (/^초등학생?$/.test(s)) return { grade: null, school: null };

  // "1학년" 패턴 (앞에 학교 없이)
  {
    const m = s.match(/^(\d)$/);
    if (m) {
      return { grade: null, school: null };
    }
  }

  return { grade: null, school: null };
}

async function fixStudentGrades(): Promise<GradeFixResult[]> {
  const { rows: students } = await pool.query(
    "SELECT id, name, grade, school FROM students"
  );

  const fixes: GradeFixResult[] = [];

  for (const s of students) {
    const raw = (s.grade ?? "").trim();
    if (!raw) continue; // 미입력은 나중에 수업으로 추론

    // 이미 정상 포맷이면 스킵
    if (/^[초중고]\d$/.test(raw)) continue;

    const parsed = parseGradeString(raw);
    if (!parsed.grade && !parsed.school) continue; // 파싱 실패 → 수동 처리 대상

    const fix: GradeFixResult = {
      id: s.id,
      name: s.name,
      oldGrade: s.grade,
      newGrade: parsed.grade ?? s.grade,
      oldSchool: s.school,
      newSchool: parsed.school ?? s.school,
    };

    // 변경이 있을 때만
    if (fix.newGrade !== s.grade || (parsed.school && fix.newSchool !== s.school)) {
      fixes.push(fix);
    }
  }

  return fixes;
}

// ────────────────────────────────────────────────────────────────────────
// 2. 수업 스케줄 정규화
// ────────────────────────────────────────────────────────────────────────

interface ScheduleFixResult {
  id: string;
  className: string;
  teacherName: string;
  oldSchedule: string;
  newSchedule: string;
}

/**
 * 한국어 시간("7시", "5시30분")을 분 단위로 변환한다.
 * 학원 맥락: 1~12시 중 1~5시는 13:00~17:00 (오후)으로,
 * 6~11시는 18:00~23:00으로 해석한다 (평일 기준).
 */
function parseKoreanTime(str: string, isWeekend: boolean): number | null {
  // "오전 9:00" → strip 오전/오후
  const cleaned = str.replace(/오전\s*/g, "AM").replace(/오후\s*/g, "PM");

  let hour: number;
  let min = 0;
  let amPm: "AM" | "PM" | null = null;

  if (cleaned.includes("AM")) amPm = "AM";
  if (cleaned.includes("PM")) amPm = "PM";
  const numStr = cleaned.replace(/AM|PM/g, "").trim();

  // "7시30분", "7시", "19:00", "6:30"
  const mKor = numStr.match(/(\d+)시\s*(\d+)?분?/);
  const mColon = numStr.match(/(\d+):(\d+)/);
  const mBare = numStr.match(/^(\d+)$/);

  if (mKor) {
    hour = parseInt(mKor[1]);
    min = mKor[2] ? parseInt(mKor[2]) : 0;
  } else if (mColon) {
    hour = parseInt(mColon[1]);
    min = parseInt(mColon[2]);
  } else if (mBare) {
    hour = parseInt(mBare[1]);
  } else {
    return null;
  }

  // 오전/오후 명시된 경우
  if (amPm === "AM" && hour >= 1 && hour <= 12) {
    if (hour === 12) hour = 0;
  } else if (amPm === "PM" && hour >= 1 && hour <= 12) {
    if (hour !== 12) hour += 12;
  } else if (hour >= 13) {
    // 이미 24시간제
  } else {
    // 맥락 추론: 학원 기준
    if (isWeekend) {
      // 주말: 9~12시는 오전, 1~6시는 오후
      if (hour >= 1 && hour <= 6) hour += 12;
      // 7~12시는 그대로 (오전~정오)
    } else {
      // 평일: 1~12시는 모두 오후 (학원은 방과 후)
      if (hour >= 1 && hour <= 12) hour += 12;
    }
  }

  return hour * 60 + min;
}

function formatTime(totalMin: number): string {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function expandDays(text: string): string[] {
  const days: string[] = [];
  const allDays = ["월", "화", "수", "목", "금", "토", "일"];

  // "월~금" → 월화수목금
  if (text.includes("~")) {
    const m = text.match(/(월|화|수|목|금|토|일)\s*~\s*(월|화|수|목|금|토|일)/);
    if (m) {
      const start = allDays.indexOf(m[1]);
      const end = allDays.indexOf(m[2]);
      if (start >= 0 && end >= 0) {
        for (let i = start; i <= end; i++) days.push(allDays[i]);
        return days;
      }
    }
  }

  // "주말" → 토 일
  if (/주말/.test(text)) return ["토", "일"];

  // "토-일", "토일"
  if (/토\s*[-]?\s*일/.test(text)) return ["토", "일"];

  // 개별 요일 추출
  for (const d of allDays) {
    if (text.includes(d)) days.push(d);
  }

  return days;
}

function normalizeSchedule(schedule: string, className: string): string {
  const raw = schedule.trim();
  if (!raw) return raw;

  // 이미 정규화된 형태인지 체크 (요일 HH:MM~HH:MM)
  if (/^[월화수목금토일](\s[월화수목금토일])*\s\d{2}:\d{2}~\d{2}:\d{2}$/.test(raw)) {
    return raw;
  }

  // 복수 스케줄 분리 (쉼표 기준)
  // "화 목 8:00~10:00, 토 11:30~13:00" → ["화 목 8:00~10:00", "토 11:30~13:00"]
  const segments = raw.split(/,\s*/).map((s) => s.trim()).filter(Boolean);

  // 단순한 경우가 아니면 세그먼트별 처리
  const normalizedParts: string[] = [];

  for (const seg of segments) {
    // 요일 추출
    let days = expandDays(seg);

    // 요일을 못 찾으면 반 이름에서 추론
    if (days.length === 0) {
      days = expandDays(className);
    }

    // 그래도 못 찾으면 세그먼트 자체가 시간만인 경우 (이전 세그먼트의 요일 사용)
    if (days.length === 0 && normalizedParts.length > 0) {
      // 이전 파트에서 요일 추출
      const prevDays = expandDays(normalizedParts[normalizedParts.length - 1]);
      if (prevDays.length > 0) days = prevDays;
    }

    const isWeekend = days.every((d) => d === "토" || d === "일");

    // 시간 추출 — 다양한 패턴 처리
    // 대괄호 안의 시간: [7:00~9:00]
    const bracketMatch = seg.match(/\[([^\]]+)\]/);
    const timeStr = bracketMatch ? bracketMatch[1] : seg;

    // "시작~끝" 패턴 찾기
    const timeRange = timeStr.match(
      /(오전\s*|오후\s*)?(\d+(?:시\s*\d*분?|\:\d+)?)\s*[~\-]\s*(오전\s*|오후\s*)?(\d+(?:시\s*\d*분?|\:\d+)?)/
    );

    if (timeRange) {
      const startStr = (timeRange[1] ?? "") + timeRange[2];
      const endStr = (timeRange[3] ?? "") + timeRange[4];
      const startMin = parseKoreanTime(startStr, isWeekend);
      const endMin = parseKoreanTime(endStr, isWeekend);

      if (startMin !== null && endMin !== null) {
        normalizedParts.push(`${days.join(" ")} ${formatTime(startMin)}~${formatTime(endMin)}`);
        continue;
      }
    }

    // 시간 하나만 있는 경우 (예: "토일 3시30분") — 끝 시간 +1.5시간 추정
    const singleTime = timeStr.match(/(오전\s*|오후\s*)?(\d+(?:시\s*\d*분?|\:\d+))/);
    if (singleTime && days.length > 0) {
      const startStr = (singleTime[1] ?? "") + singleTime[2];
      const startMin = parseKoreanTime(startStr, isWeekend);
      if (startMin !== null) {
        normalizedParts.push(`${days.join(" ")} ${formatTime(startMin)}~${formatTime(startMin + 90)}`);
        continue;
      }
    }

    // 요일만 있고 시간이 없는 경우 → 요일만이라도 정규화
    if (days.length > 0) {
      normalizedParts.push(days.join(" "));
    } else {
      // 파싱 실패 → 원문 유지
      normalizedParts.push(seg);
    }
  }

  return normalizedParts.join(", ");
}

async function fixClassSchedules(): Promise<ScheduleFixResult[]> {
  const { rows: classes } = await pool.query(`
    SELECT c.id, c.name, c.schedule, t.name as teacher_name
    FROM classes c LEFT JOIN teachers t ON c.teacher_id = t.id
    WHERE c.is_active = true
  `);

  const fixes: ScheduleFixResult[] = [];

  for (const c of classes) {
    const newSchedule = normalizeSchedule(c.schedule, c.name);
    if (newSchedule !== c.schedule) {
      fixes.push({
        id: c.id,
        className: c.name,
        teacherName: c.teacher_name,
        oldSchedule: c.schedule,
        newSchedule,
      });
    }
  }

  return fixes;
}

// ────────────────────────────────────────────────────────────────────────
// 3. 미입력 학년 추론 — 수강 중인 반에서 힌트
// ────────────────────────────────────────────────────────────────────────

async function inferMissingGrades(): Promise<GradeFixResult[]> {
  const { rows } = await pool.query(`
    SELECT s.id, s.name, s.grade, s.school, c.name as class_name
    FROM students s
    JOIN enrollments e ON e.student_id = s.id AND e.is_active = true
    JOIN classes c ON c.id = e.class_id AND c.is_active = true
    WHERE s.is_active = true AND (s.grade IS NULL OR s.grade = '')
  `);

  // 학생별로 수강 반 수집
  const studentClasses = new Map<string, { name: string; school: string | null; classes: string[] }>();
  for (const r of rows) {
    if (!studentClasses.has(r.id)) {
      studentClasses.set(r.id, { name: r.name, school: r.school, classes: [] });
    }
    studentClasses.get(r.id)!.classes.push(r.class_name);
  }

  const fixes: GradeFixResult[] = [];

  for (const [id, data] of studentClasses) {
    const allClassNames = data.classes.join(" ");

    let inferredGrade: string | null = null;

    // 반 이름에서 학년 힌트
    if (/고등|고\d|고1|고2|고3/.test(allClassNames)) {
      // 더 구체적인 학년은 모르므로 급만
      // 반 이름에서 학년 숫자 추출 시도
      const m = allClassNames.match(/고(\d)/);
      inferredGrade = m ? `고${m[1]}` : null; // 구체적 학년 모르면 건너뜀
    } else if (/중등|중\d|중1|중2|중3/.test(allClassNames)) {
      const m = allClassNames.match(/중(\d)/);
      inferredGrade = m ? `중${m[1]}` : null;
    } else if (/초등|초\d/.test(allClassNames)) {
      const m = allClassNames.match(/초(\d)/);
      inferredGrade = m ? `초${m[1]}` : null;
    }

    if (inferredGrade) {
      fixes.push({
        id,
        name: data.name,
        oldGrade: null,
        newGrade: inferredGrade,
        oldSchool: data.school,
        newSchool: data.school,
      });
    }
  }

  return fixes;
}

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? "🔍 DRY RUN — 변경 사항만 보여줍니다\n" : "⚡ LIVE RUN — DB를 실제로 수정합니다\n");

  // 1. 학년 정규화
  console.log("=== 학생 학년 정규화 ===");
  const gradeFixes = await fixStudentGrades();
  for (const f of gradeFixes) {
    console.log(`  ${f.name}: "${f.oldGrade}" → "${f.newGrade}"` +
      (f.newSchool !== f.oldSchool ? ` | 학교: "${f.oldSchool}" → "${f.newSchool}"` : ""));
  }
  console.log(`  총 ${gradeFixes.length}명 수정 대상\n`);

  // 2. 미입력 학년 추론
  console.log("=== 미입력 학년 추론 (수강 반 기반) ===");
  const inferredFixes = await inferMissingGrades();
  for (const f of inferredFixes) {
    console.log(`  ${f.name}: (없음) → "${f.newGrade}"`);
  }
  console.log(`  총 ${inferredFixes.length}명 추론 대상\n`);

  // 3. 수업 스케줄 정규화
  console.log("=== 수업 스케줄 정규화 ===");
  const scheduleFixes = await fixClassSchedules();
  for (const f of scheduleFixes) {
    console.log(`  ${f.teacherName} | ${f.className}`);
    console.log(`    "${f.oldSchedule}" → "${f.newSchedule}"`);
  }
  console.log(`  총 ${scheduleFixes.length}개 수정 대상\n`);

  if (DRY_RUN) {
    console.log("✋ --dry-run 모드이므로 실제 DB 수정은 하지 않았습니다.");
    await pool.end();
    return;
  }

  // 실제 적용
  let updated = 0;

  for (const f of gradeFixes) {
    await pool.query(
      "UPDATE students SET grade = $1, school = COALESCE($2, school), updated_at = NOW() WHERE id = $3",
      [f.newGrade, f.newSchool, f.id]
    );
    updated++;
  }

  for (const f of inferredFixes) {
    await pool.query(
      "UPDATE students SET grade = $1, updated_at = NOW() WHERE id = $2",
      [f.newGrade, f.id]
    );
    updated++;
  }

  for (const f of scheduleFixes) {
    await pool.query(
      "UPDATE classes SET schedule = $1, updated_at = NOW() WHERE id = $2",
      [f.newSchedule, f.id]
    );
    updated++;
  }

  console.log(`✅ 완료: 학생 ${gradeFixes.length + inferredFixes.length}명, 수업 ${scheduleFixes.length}개 수정됨 (총 ${updated}건)`);
  await pool.end();
}

main().catch((err) => {
  console.error("❌ 오류:", err);
  pool.end();
  process.exit(1);
});

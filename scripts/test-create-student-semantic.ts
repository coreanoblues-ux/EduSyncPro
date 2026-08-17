/**
 * 신규학생 등록 semantic validation 테스트.
 *
 * 실행: npx tsx scripts/test-create-student-semantic.ts
 *
 * DB 상태를 변경하지 않는다 (모든 정상 케이스는 rollback).
 */

import "dotenv/config";
import { Pool } from "pg";
import { executeTool, type ToolContext } from "../server/lib/aiTools";
import { storage } from "../server/storage";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

async function main() {
  const results: TestResult[] = [];

  // 첫 번째 tenant + 활성 교사 하나를 골라 테스트 컨텍스트로 사용
  const tenantRes = await pool.query(
    "SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1",
  );
  if (tenantRes.rows.length === 0) {
    console.error("❌ tenants가 없습니다. 테스트 불가.");
    await pool.end();
    process.exit(1);
  }
  const tenantId = tenantRes.rows[0].id;

  const teachersRes = await pool.query(
    "SELECT id, name FROM teachers WHERE tenant_id = $1 AND is_active = true LIMIT 1",
    [tenantId],
  );
  if (teachersRes.rows.length === 0) {
    console.error("❌ 활성 교사가 없습니다. 테스트 불가.");
    await pool.end();
    process.exit(1);
  }
  const teacher = teachersRes.rows[0];

  const userRes = await pool.query(
    "SELECT id FROM users WHERE tenant_id = $1 LIMIT 1",
    [tenantId],
  );
  const userId = userRes.rows[0]?.id ?? "test-user";

  const ctx: ToolContext = { tenantId, userId };

  console.log(`✅ 테스트 준비 완료 — tenant=${tenantId}, teacher="${teacher.name}"\n`);

  // ─── Test 1: 강사 이름을 student_name으로 보내면 거부돼야 한다 ───
  {
    const result: any = await executeTool(
      "create_student",
      { student_name: teacher.name, school: "테스트중", grade: "중1" },
      ctx,
    );
    const passed = !!result.error && typeof result.error === "string" && result.error.includes("강사");
    results.push({
      name: `TC1: 강사 이름("${teacher.name}")을 student_name으로 넣으면 거부되어야 함`,
      passed,
      detail: passed
        ? `✅ 정상 거부: ${result.error.slice(0, 80)}...`
        : `❌ 잘못 등록됨: ${JSON.stringify(result).slice(0, 200)}`,
    });

    // 혹시라도 실수로 삽입됐으면 즉시 정리
    if (result.success && result.student?.id) {
      await pool.query("DELETE FROM students WHERE id = $1", [result.student.id]);
    }
  }

  // ─── Test 2: student_name 이 비어 있으면 거부 ───
  {
    const result: any = await executeTool(
      "create_student",
      { student_name: "" },
      ctx,
    );
    const passed = !!result.error && result.error.includes("student_name");
    results.push({
      name: `TC2: 빈 student_name은 거부되어야 함`,
      passed,
      detail: passed
        ? `✅ 정상 거부`
        : `❌ ${JSON.stringify(result).slice(0, 200)}`,
    });
  }

  // ─── Test 3: teacher_name 지정 시 resolvedTeacher 반환 ───
  {
    const uniqueName = `테스트학생_${Date.now()}`;
    const result: any = await executeTool(
      "create_student",
      {
        student_name: uniqueName,
        school: "테스트중",
        grade: "중1",
        teacher_name: teacher.name,
      },
      ctx,
    );
    const passed =
      result.success === true &&
      result.resolvedTeacher?.id === teacher.id &&
      result.student?.name === uniqueName;
    results.push({
      name: `TC3: teacher_name이 실제 강사면 resolvedTeacher를 반환하고 학생은 정상 등록`,
      passed,
      detail: passed
        ? `✅ student="${result.student.name}", teacher="${result.resolvedTeacher.name}"`
        : `❌ ${JSON.stringify(result).slice(0, 300)}`,
    });
    // 정리
    if (result.student?.id) {
      await pool.query("DELETE FROM students WHERE id = $1", [result.student.id]);
    }
  }

  // ─── Test 4: 존재하지 않는 강사 이름은 teacherNotFound 힌트 반환 ───
  {
    const uniqueName = `테스트학생B_${Date.now()}`;
    const bogusTeacher = "존재하지않는강사999";
    const result: any = await executeTool(
      "create_student",
      {
        student_name: uniqueName,
        teacher_name: bogusTeacher,
      },
      ctx,
    );
    const passed = result.success === true && !!result.teacherNotFound;
    results.push({
      name: `TC4: 존재하지 않는 teacher_name은 teacherNotFound 힌트를 반환`,
      passed,
      detail: passed
        ? `✅ ${result.teacherNotFound.slice(0, 80)}`
        : `❌ ${JSON.stringify(result).slice(0, 300)}`,
    });
    if (result.student?.id) {
      await pool.query("DELETE FROM students WHERE id = $1", [result.student.id]);
    }
  }

  // ─── Test 5: 하위 호환 (구 name 필드) — 정상 이름이면 등록됨 ───
  {
    const uniqueName = `테스트학생C_${Date.now()}`;
    const result: any = await executeTool(
      "create_student",
      { name: uniqueName, grade: "중2" },
      ctx,
    );
    const passed = result.success === true && result.student?.name === uniqueName;
    results.push({
      name: `TC5: 하위 호환 — 구 name 필드도 정상 동작`,
      passed,
      detail: passed
        ? `✅ 등록됨: ${result.student.name}`
        : `❌ ${JSON.stringify(result).slice(0, 300)}`,
    });
    if (result.student?.id) {
      await pool.query("DELETE FROM students WHERE id = $1", [result.student.id]);
    }
  }

  // ─── Test 6: 하위 호환 — name에 강사 이름을 넣어도 거부 ───
  {
    const result: any = await executeTool(
      "create_student",
      { name: teacher.name },
      ctx,
    );
    const passed = !!result.error && result.error.includes("강사");
    results.push({
      name: `TC6: 하위 호환 — 구 name 필드에 강사 이름을 넣어도 거부되어야 함`,
      passed,
      detail: passed
        ? `✅ 정상 거부`
        : `❌ ${JSON.stringify(result).slice(0, 300)}`,
    });
    if (result.success && result.student?.id) {
      await pool.query("DELETE FROM students WHERE id = $1", [result.student.id]);
    }
  }

  // ─── 결과 출력 ───
  console.log("=== 테스트 결과 ===\n");
  let passedCount = 0;
  for (const r of results) {
    console.log(`${r.passed ? "✅" : "❌"} ${r.name}`);
    console.log(`   ${r.detail}\n`);
    if (r.passed) passedCount++;
  }

  console.log(`총 ${passedCount}/${results.length} 통과`);

  await pool.end();
  process.exit(passedCount === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ 테스트 실행 오류:", err);
  pool.end();
  process.exit(1);
});

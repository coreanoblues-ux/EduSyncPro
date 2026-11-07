/**
 * 설명회·광고 프로젝트 API 검증. `npm run test:projects`
 *
 * ════════════════════════════════════════════════════════════════════════
 * 무엇을 못 박는가
 * ════════════════════════════════════════════════════════════════════════
 *   · 문단속 — 토큰 없이는 401, 다른 학원 프로젝트는 404
 *   · 역산 — D-day 하나로 템플릿 날짜가 정확히 깔리는가 (D-21 → dDay-21)
 *   · 두 번 눌러도 안 늘어나는가 (제목 중복 방지)
 *   · replace 가 **완료한 할 일은 남기는가** — 이미 보낸 문자를 되돌리면
 *     원장이 학부모에게 문자를 두 번 보낸다. 이게 이 파일의 핵심 단정이다.
 *
 * ════════════════════════════════════════════════════════════════════════
 * ⚠️ 이 테스트는 실제 DB 에 쓴다
 * ════════════════════════════════════════════════════════════════════════
 *   로컬 DB 가 따로 없어 운영 DB 를 그대로 쓴다. 그래서 규칙이 있다:
 *     · 만드는 것은 "[TEST]" 로 시작하는 프로젝트 하나와 그 자식들뿐이다.
 *     · 끝나면 finally 에서 반드시 지운다 (실패해도, 중간에 던져도).
 *     · 결제·학생·상담 테이블은 읽지도 쓰지도 않는다.
 *     · 시작·끝의 tasks 총 개수를 세어 **한 줄도 남지 않았음**을 증명한다.
 */

import "dotenv/config";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, sql } from "drizzle-orm";
import { db } from "../server/db";
import { users, tasks } from "@shared/schema";
import { addDays } from "@shared/day";
import { generateToken } from "../server/middleware/auth";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message}\n`);
  }
}

const TEST_PREFIX = "[TEST] 설명회 API 검증";

async function countTasks(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(tasks);
  return row.n;
}

async function main() {
  console.log("\n설명회·광고 프로젝트 API 테스트\n");

  const [owner] = await db.select().from(users).where(eq(users.role, "owner")).limit(1);
  if (!owner || !owner.tenantId) {
    console.error("원장 계정을 찾지 못했습니다. DATABASE_URL 이 맞는 DB 를 가리키는지 확인하세요.");
    process.exit(1);
  }
  console.log(`  대상: ${owner.name} (${owner.email}) / tenant ${owner.tenantId}\n`);

  const tasksBefore = await countTasks();

  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const { default: projectsRouter } = await import("../server/projects/routes");

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(projectsRouter);

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  const token = generateToken({
    id: owner.id,
    email: owner.email,
    name: owner.name,
    role: owner.role as "owner",
    tenantId: owner.tenantId,
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  let projectId: string | null = null;

  try {
    /* ── 문단속 ───────────────────────────────────────────────────────── */
    console.log("문단속:");

    await test("토큰 없이 목록 조회는 401", async () => {
      const r = await fetch(`${base}/api/projects`);
      assert.equal(r.status, 401, `401 이어야 하는데 ${r.status}`);
    });

    await test("토큰 없이 생성도 401", async () => {
      const r = await fetch(`${base}/api/projects`, { method: "POST" });
      assert.equal(r.status, 401, `401 이어야 하는데 ${r.status}`);
    });

    await test("없는 프로젝트 id 는 404 (존재 여부도 알려주지 않음)", async () => {
      const r = await call("GET", "/api/projects/00000000-0000-4000-8000-000000000000");
      assert.equal(r.status, 404, `404 이어야 하는데 ${r.status}`);
    });

    await test("uuid 가 아닌 id 는 400", async () => {
      const r = await call("GET", "/api/projects/not-a-uuid");
      assert.equal(r.status, 400, `400 이어야 하는데 ${r.status}`);
    });

    /* ── 템플릿 ───────────────────────────────────────────────────────── */
    console.log("\n역산 템플릿:");

    let templateItems = 0;
    await test("템플릿 목록에 설명회 기본이 있다 (없으면 깔아 준다)", async () => {
      const r = await call("GET", "/api/project-templates");
      assert.equal(r.status, 200, `200 이어야 하는데 ${r.status}`);
      const list = await r.json();
      assert.ok(Array.isArray(list) && list.length > 0, "템플릿이 비어 있습니다");
      const seminar = list.find((t: any) => t.kind === "설명회");
      assert.ok(seminar, "설명회 템플릿이 없습니다");
      assert.ok(Array.isArray(seminar.items) && seminar.items.length >= 5,
        `설명회 템플릿 항목이 ${seminar.items?.length}개 — 5개 이상이어야 합니다`);
      templateItems = seminar.items.length;
    });

    /* ── 프로젝트 + 역산 ──────────────────────────────────────────────── */
    console.log("\n프로젝트 생성과 역산:");

    const dDay = "2026-11-19";

    await test("설명회 프로젝트 생성 → 201", async () => {
      const r = await call("POST", "/api/projects", {
        name: TEST_PREFIX,
        kind: "설명회",
        dDay,
        place: "학원 2층",
      });
      const body = await r.json();
      assert.equal(r.status, 201, `201 이어야 하는데 ${r.status}: ${JSON.stringify(body)}`);
      assert.ok(body.id, "id 가 없습니다");
      assert.equal(body.tenantId, owner.tenantId, "다른 테넌트로 저장됐습니다");
      projectId = body.id;
    });

    assert.ok(projectId, "프로젝트가 안 만들어져 이후 테스트를 돌릴 수 없습니다");

    await test(`역산 할 일 ${templateItems}개가 깔린다`, async () => {
      const r = await call("POST", `/api/projects/${projectId}/generate-tasks`, {});
      const body = await r.json();
      assert.equal(r.status, 201, `201 이어야 하는데 ${r.status}: ${JSON.stringify(body)}`);
      assert.equal(body.created, templateItems, `${templateItems}개여야 하는데 ${body.created}개`);
    });

    await test("날짜가 D-day 역산과 정확히 맞는다", async () => {
      const tr = await call("GET", "/api/project-templates");
      const seminar = (await tr.json()).find((t: any) => t.kind === "설명회");
      const r = await call("GET", `/api/projects/${projectId}`);
      const detail = await r.json();
      for (const item of seminar.items) {
        const task = detail.tasks.find((t: any) => t.title === item.title);
        assert.ok(task, `"${item.title}" 할 일이 없습니다`);
        const want = addDays(dDay, item.offsetDays);
        assert.equal(task.dueDate, want,
          `"${item.title}" 는 ${want} 여야 하는데 ${task.dueDate}`);
        assert.equal(task.slot, item.slot, `"${item.title}" 시간대가 다릅니다`);
        assert.equal(task.projectId, projectId, `"${item.title}" 가 프로젝트를 안 가리킵니다`);
      }
    });

    await test("두 번 눌러도 안 늘어난다 (제목 중복 방지)", async () => {
      const r = await call("POST", `/api/projects/${projectId}/generate-tasks`, {});
      const body = await r.json();
      assert.equal(body.created, 0, `0개여야 하는데 ${body.created}개가 또 깔렸습니다`);
      const detail = await (await call("GET", `/api/projects/${projectId}`)).json();
      assert.equal(detail.tasks.length, templateItems,
        `${templateItems}개여야 하는데 ${detail.tasks.length}개`);
    });

    await test("replace 는 완료한 할 일을 남긴다 (문자 두 번 보내기 방지)", async () => {
      // 할 일 하나를 "이미 보낸 문자" 로 만든다.
      const detail = await (await call("GET", `/api/projects/${projectId}`)).json();
      const done = detail.tasks[0];
      await db.update(tasks).set({ completedAt: new Date() }).where(eq(tasks.id, done.id));

      // D-day 를 미루고 다시 깐다.
      const newDDay = "2026-11-26";
      await call("PATCH", `/api/projects/${projectId}`, { dDay: newDDay });
      const r = await call("POST", `/api/projects/${projectId}/generate-tasks`, { replace: true });
      const body = await r.json();
      assert.equal(r.status, 201, `201 이어야 하는데 ${r.status}: ${JSON.stringify(body)}`);
      assert.equal(body.created, templateItems - 1,
        `완료 1개는 빼고 ${templateItems - 1}개여야 하는데 ${body.created}개`);

      const after = await (await call("GET", `/api/projects/${projectId}`)).json();
      assert.equal(after.tasks.length, templateItems,
        `총 ${templateItems}개여야 하는데 ${after.tasks.length}개 — 중복이 생겼습니다`);

      const kept = after.tasks.find((t: any) => t.id === done.id);
      assert.ok(kept, "완료한 할 일이 지워졌습니다 — 문자를 두 번 보내게 됩니다");
      assert.equal(kept.dueDate, done.dueDate, "완료한 할 일의 날짜가 바뀌었습니다");

      // 완료가 아닌 것들은 새 D-day 로 다시 깔렸는가
      const moved = after.tasks.filter((t: any) => t.id !== done.id);
      const tr = await call("GET", "/api/project-templates");
      const seminar = (await tr.json()).find((t: any) => t.kind === "설명회");
      for (const t of moved) {
        const item = seminar.items.find((i: any) => i.title === t.title);
        assert.equal(t.dueDate, addDays(newDDay, item.offsetDays),
          `"${t.title}" 가 새 D-day 로 안 옮겨졌습니다`);
      }
    });

    /* ── 참석자 ───────────────────────────────────────────────────────── */
    console.log("\n참석 신청자:");

    let attendeeId: string | null = null;
    await test("참석자 등록 → 201", async () => {
      const r = await call("POST", `/api/projects/${projectId}/attendees`, {
        name: "테스트 학부모",
        phone: "010-0000-0000",
      });
      const body = await r.json();
      assert.equal(r.status, 201, `201 이어야 하는데 ${r.status}: ${JSON.stringify(body)}`);
      assert.equal(body.projectId, projectId, "다른 프로젝트에 붙었습니다");
      attendeeId = body.id;
    });

    await test("참석자 목록에 보인다", async () => {
      const r = await call("GET", `/api/projects/${projectId}/attendees`);
      const list = await r.json();
      assert.equal(list.length, 1, `1명이어야 하는데 ${list.length}명`);
    });

    await test("참석자 삭제", async () => {
      const r = await call("DELETE", `/api/projects/${projectId}/attendees/${attendeeId}`);
      assert.equal(r.status, 200, `200 이어야 하는데 ${r.status}`);
      const list = await (await call("GET", `/api/projects/${projectId}/attendees`)).json();
      assert.equal(list.length, 0, `0명이어야 하는데 ${list.length}명`);
    });

    /* ── 뒷정리가 깨끗한가 ────────────────────────────────────────────── */
    console.log("\n뒷정리:");

    await test("프로젝트를 지우면 역산 할 일도 함께 사라진다", async () => {
      const deleted = projectId!;
      const r = await call("DELETE", `/api/projects/${deleted}`);
      assert.equal(r.status, 200, `200 이어야 하는데 ${r.status}`);
      projectId = null;
      const left = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(tasks)
        .where(eq(tasks.projectId, deleted));
      assert.equal(left[0].n, 0, `${left[0].n}개가 남았습니다 — 외래키 CASCADE 가 안 걸렸습니다`);
    });

    await test("tasks 총 개수가 시작 때와 같다 (운영 데이터 무변동)", async () => {
      const after = await countTasks();
      assert.equal(after, tasksBefore, `${tasksBefore}개였는데 ${after}개 — 테스트 데이터가 남았습니다`);
    });
  } finally {
    // 중간에 던져도 테스트 프로젝트는 반드시 치운다.
    if (projectId) {
      const { storage } = await import("../server/storage");
      await storage.deleteProject(projectId);
      console.log(`\n  (정리) 테스트 프로젝트 ${projectId} 삭제`);
    }
    server.close();
  }

  const finalCount = await countTasks();
  console.log(`\n  tasks: 시작 ${tasksBefore}개 → 끝 ${finalCount}개`);
  console.log(`\n결과: 통과 ${passed} · 실패 ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\n테스트 실행 실패:", e);
  process.exit(1);
});

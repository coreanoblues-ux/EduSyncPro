/**
 * 반배정 추천·정원 규칙 검증. `npm run test:recommend`
 *
 * 아래 반 이름은 2026-08-16 운영 DB 에서 그대로 가져온 것이다 (반 이름 표기
 * 테스트와 같은 자료다). 지어낸 이름으로 만든 규칙은 실제 이름에서 깨진다 —
 * 이 학원의 반 이름은 "[정]화 목 심화 A-F" 처럼 접두사·공백·영문이 섞여 있다.
 *
 * ── 이 테스트가 지키려는 선 ──
 *   추천은 **결정이 아니라 근거 제시**다. 그래서 "1등이 무엇인가" 만 보지 않고
 *   · 학년이 다른 반이 추천 목록에 끼지 않는지
 *   · 정원이 찬 반을 "추천"이라고 부르지 않는지
 *   · 모르는 것(학년 미입력, 정원 미설정)을 안다고 말하지 않는지
 *   를 같이 본다. 마지막 항목이 가장 중요하다 — 틀린 확신이 빈 화면보다 나쁘다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  recommendClasses,
  topCandidates,
  gradeFromClassName,
  weakestDomain,
  type RecommendClass,
  type RecommendMember,
  type RecommendStudent,
} from "../shared/classRecommend";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message}\n`);
  }
}

// ─── 실제 반 이름 ───────────────────────────────────────────────────────

function cls(over: Partial<RecommendClass> & { id: string; name: string }): RecommendClass {
  return { maxStudents: 10, isActive: true, schedule: "월수", ...over };
}

const REAL = [
  cls({ id: "c1", name: "[란]중1 기본 - 월수금", schedule: "월 수 금" }),
  cls({ id: "c2", name: "[란]화 목 중1 기본", schedule: "화 목" }),
  cls({ id: "c3", name: "[정]월 수 심화A", schedule: "월 수" }),
  cls({ id: "c4", name: "[정]화 목 심화 A-F", schedule: "화 목" }),
  cls({ id: "c5", name: "[정]주말 고1 오전", schedule: "주말" }),
  cls({ id: "c6", name: "[정]주말 고3 오후", schedule: "주말" }),
  cls({ id: "c7", name: "[국어-이]주중-중등반", schedule: "월 수 금" }),
];

function mem(classId: string, grade: string | null, isActive = true): RecommendMember {
  return { classId, grade, isActive };
}

function stu(over: Partial<RecommendStudent> = {}): RecommendStudent {
  return { grade: "중2", totalScore: 72, ...over };
}

const names = (list: { name: string }[]) => list.map((c) => c.name);
const find = (list: { classId: string }[], id: string) => list.find((c) => c.classId === id)!;

function main() {
  console.log("─── 반 이름에서 학년 읽기 ───");

  test("접두사가 붙은 실제 반 이름에서 학년을 읽는다", () => {
    assert.equal(gradeFromClassName("[란]중1 기본 - 월수금")?.year, 1);
    assert.equal(gradeFromClassName("[란]중1 기본 - 월수금")?.level, "중");
    assert.equal(gradeFromClassName("[정]주말 고1 오전")?.level, "고");
    assert.equal(gradeFromClassName("[정]주말 고3 오후")?.year, 3);
  });

  test("학년이 안 적힌 반 이름은 모른다고 한다", () => {
    assert.equal(gradeFromClassName("[정]월 수 심화A"), null);
    assert.equal(gradeFromClassName("[정]화 목 심화 A-F"), null);
    assert.equal(gradeFromClassName("[국어-이]주중-중등반"), null, "'중등'만으로는 학년을 모른다");
  });

  console.log("\n─── 학년이 순서를 정한다 ───");

  test("중1 학생은 중1 반이 위로 온다", () => {
    const all = recommendClasses({ student: stu({ grade: "중1" }), classes: REAL, members: [] });
    assert.ok(
      all[0].name.includes("중1"),
      "1등: " + all[0].name + " / " + JSON.stringify(names(all))
    );
    assert.equal(all[0].fit, "추천");
  });

  test("중2 학생에게 고등부 반은 '학년이 다름' 으로 밀린다", () => {
    const all = recommendClasses({ student: stu({ grade: "중2" }), classes: REAL, members: [] });
    assert.equal(find(all, "c5").fit, "학년이 다름");
    assert.equal(find(all, "c6").fit, "학년이 다름");
    assert.ok(
      find(all, "c5").cautions.some((c) => c.includes("학교급이 다릅니다")),
      JSON.stringify(find(all, "c5").cautions)
    );
  });

  test("학년이 다른 반은 추천 목록(위 3개)에 끼지 않는다", () => {
    const all = recommendClasses({ student: stu({ grade: "중2" }), classes: REAL, members: [] });
    const top = topCandidates(all, 3);
    assert.ok(!top.some((c) => c.fit === "학년이 다름"), JSON.stringify(names(top)));
  });

  test("고1 학생에게는 고1 반이 1등이다", () => {
    const all = recommendClasses({
      student: stu({ grade: "고1", totalScore: 85 }),
      classes: REAL,
      members: [],
    });
    assert.equal(all[0].classId, "c5", "1등: " + all[0].name);
  });

  test("같은 학교급이면 학년이 달라도 후보로 남는다", () => {
    const all = recommendClasses({ student: stu({ grade: "중2" }), classes: REAL, members: [] });
    const c1 = find(all, "c1"); // 중1 반
    assert.equal(c1.fit, "가능", JSON.stringify(c1));
    assert.ok(c1.reasons.some((r) => r.includes("같은 중학교 과정")), JSON.stringify(c1.reasons));
  });

  test("반 이름에 학년이 없으면 다니는 학생들의 학년으로 본다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중2" }),
      classes: [cls({ id: "c3", name: "[정]월 수 심화A" })],
      members: [mem("c3", "중2"), mem("c3", "중2"), mem("c3", "중3")],
    });
    assert.equal(all[0].fit, "추천");
    assert.ok(
      all[0].reasons.some((r) => r.includes("대부분이 중2")),
      JSON.stringify(all[0].reasons)
    );
  });

  test("반 학년이 반반으로 갈리면 판단을 포기한다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중2" }),
      classes: [cls({ id: "c3", name: "[정]월 수 심화A" })],
      members: [mem("c3", "중2"), mem("c3", "중3")],
    });
    assert.ok(
      all[0].cautions.some((c) => c.includes("학년을 알 수 없습니다")),
      JSON.stringify(all[0].cautions)
    );
  });

  test("퇴원생 학년은 반 분위기에 넣지 않는다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중2" }),
      classes: [cls({ id: "c3", name: "[정]월 수 심화A" })],
      members: [mem("c3", "중2"), mem("c3", "고1", false), mem("c3", "고1", false)],
    });
    assert.ok(
      all[0].reasons.some((r) => r.includes("대부분이 중2")),
      JSON.stringify(all[0].reasons)
    );
  });

  console.log("\n─── 정원 ───");

  test("남은 자리를 세어 근거에 적는다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중1" }),
      classes: [cls({ id: "c1", name: "[란]중1 기본 - 월수금", maxStudents: 8 })],
      members: [mem("c1", "중1"), mem("c1", "중1"), mem("c1", "중1")],
    });
    assert.deepEqual(all[0].seats, { max: 8, taken: 3, left: 5 });
    assert.ok(all[0].reasons.some((r) => r.includes("자리 5개")), JSON.stringify(all[0].reasons));
  });

  test("정원이 찬 반은 '추천' 이라고 부르지 않는다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중1" }),
      classes: [cls({ id: "c1", name: "[란]중1 기본 - 월수금", maxStudents: 2 })],
      members: [mem("c1", "중1"), mem("c1", "중1")],
    });
    assert.equal(all[0].fit, "정원초과");
    assert.ok(all[0].cautions.some((c) => c.includes("정원이 찼습니다")));
  });

  test("정원을 이미 넘긴 반은 몇 명 넘었는지 말한다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중1" }),
      classes: [cls({ id: "c1", name: "[란]중1 기본 - 월수금", maxStudents: 2 })],
      members: [mem("c1", "중1"), mem("c1", "중1"), mem("c1", "중1")],
    });
    assert.equal(all[0].seats.left, -1);
    assert.ok(
      all[0].cautions.some((c) => c.includes("1명 넘었습니다")),
      JSON.stringify(all[0].cautions)
    );
  });

  test("자리가 찬 반도 목록에는 남는다 (대기 등록을 결정하려면 보여야 한다)", () => {
    const all = recommendClasses({
      student: stu({ grade: "중1" }),
      classes: [cls({ id: "c1", name: "[란]중1 기본 - 월수금", maxStudents: 1 })],
      members: [mem("c1", "중1")],
    });
    assert.equal(topCandidates(all, 3).length, 1);
  });

  test("정원을 정하지 않은 반은 자리를 판단하지 않는다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중1" }),
      classes: [cls({ id: "c1", name: "[란]중1 기본 - 월수금", maxStudents: null })],
      members: [],
    });
    assert.equal(all[0].seats.left, null);
    assert.ok(all[0].cautions.some((c) => c.includes("정원을 정하지 않은")));
    assert.notEqual(all[0].fit, "정원초과", "모르는 것을 '초과' 라고 단정하면 안 된다");
  });

  test("닫힌 반은 아예 후보가 아니다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중1" }),
      classes: [cls({ id: "c1", name: "[란]중1 기본 - 월수금", isActive: false })],
      members: [],
    });
    assert.deepEqual(all, []);
  });

  test("자리가 더 많은 반이 같은 조건에서 위로 온다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중1" }),
      classes: [
        cls({ id: "few", name: "[란]중1 기본 가", maxStudents: 10 }),
        cls({ id: "many", name: "[란]중1 기본 나", maxStudents: 10 }),
      ],
      members: [mem("few", "중1"), mem("few", "중1"), mem("few", "중1")],
    });
    assert.equal(all[0].classId, "many", names(all).join(","));
  });

  console.log("\n─── 점수로 보는 난이도 (가장 약한 근거) ───");

  test("총점이 높으면 심화반 쪽에 힘을 준다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중2", totalScore: 88 }),
      classes: [
        cls({ id: "adv", name: "[정]중2 심화 A" }),
        cls({ id: "bas", name: "[정]중2 기본 A" }),
      ],
      members: [],
    });
    assert.equal(all[0].classId, "adv", names(all).join(","));
    assert.ok(
      all[0].reasons.some((r) => r.includes("심화반 기준(80점 이상)")),
      "기준 숫자를 문장에 밝혀야 원장이 뒤집을 수 있다: " + JSON.stringify(all[0].reasons)
    );
  });

  test("총점이 낮으면 기본반 쪽에 힘을 준다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중2", totalScore: 48 }),
      classes: [
        cls({ id: "adv", name: "[정]중2 심화 A" }),
        cls({ id: "bas", name: "[정]중2 기본 A" }),
      ],
      members: [],
    });
    assert.equal(all[0].classId, "bas", names(all).join(","));
    assert.ok(
      find(all, "adv").cautions.some((c) => c.includes("심화반인데 총점이 48점")),
      JSON.stringify(find(all, "adv").cautions)
    );
  });

  test("점수가 없으면 난이도로 줄 세우지 않는다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중2", totalScore: null }),
      classes: [
        cls({ id: "adv", name: "[정]중2 심화 A" }),
        cls({ id: "bas", name: "[정]중2 기본 A" }),
      ],
      members: [],
    });
    assert.equal(all[0].rank, all[1].rank, "점수가 없는데 난이도를 가르면 짐작이다");
  });

  test("난이도 표시가 없는 반에는 점수를 쓰지 않는다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중2", totalScore: 95 }),
      classes: [cls({ id: "c", name: "[정]중2 A반" })],
      members: [],
    });
    assert.ok(
      !all[0].reasons.some((r) => r.includes("기준")),
      JSON.stringify(all[0].reasons)
    );
  });

  test("학년이 맞는 기본반이 학년 다른 심화반보다 위다", () => {
    const all = recommendClasses({
      student: stu({ grade: "중2", totalScore: 95 }),
      classes: [
        cls({ id: "right", name: "[정]중2 기본 A" }),
        cls({ id: "wrong", name: "[정]고2 심화 A" }),
      ],
      members: [],
    });
    assert.equal(all[0].classId, "right", "학년 실수가 난이도 실수보다 훨씬 나쁘다");
  });

  console.log("\n─── 약한 영역은 근거가 아니라 참고다 ───");

  test("가장 약한 영역을 집어 준다", () => {
    const w = weakestDomain({
      grade: "중2",
      readingScore: 80,
      grammarScore: 70,
      vocabScore: 52,
      writingScore: 65,
    });
    assert.deepEqual(w, { name: "어휘", score: 52 });
  });

  test("점수가 하나뿐이면 약한 영역을 말하지 않는다", () => {
    assert.equal(weakestDomain({ grade: "중2", readingScore: 80 }), null);
    assert.equal(weakestDomain({ grade: "중2" }), null);
  });

  test("약한 영역은 참고 사항(cautions)에만 들어간다", () => {
    const all = recommendClasses({
      student: {
        grade: "중2",
        totalScore: 70,
        readingScore: 80,
        grammarScore: 70,
        vocabScore: 52,
        writingScore: 65,
      },
      classes: [cls({ id: "c", name: "[정]중2 A반" })],
      members: [],
    });
    assert.ok(
      all[0].cautions.some((c) => c.includes("어휘") && c.includes("52점")),
      JSON.stringify(all[0].cautions)
    );
    assert.ok(!all[0].reasons.some((r) => r.includes("어휘")), "약점은 추천 근거가 아니다");
  });

  console.log("\n─── 모르는 것을 안다고 하지 않는다 ───");

  test("학생 학년이 비어 있으면 그렇다고 말한다", () => {
    const all = recommendClasses({
      student: stu({ grade: null }),
      classes: [cls({ id: "c1", name: "[란]중1 기본 - 월수금" })],
      members: [],
    });
    assert.ok(
      all[0].cautions.some((c) => c.includes("학생 학년이 비어 있어")),
      JSON.stringify(all[0].cautions)
    );
    assert.notEqual(all[0].fit, "추천", "근거가 없는데 추천이라고 하면 안 된다");
  });

  test("후보가 없으면 빈 목록이다 (억지로 하나 고르지 않는다)", () => {
    assert.deepEqual(recommendClasses({ student: stu(), classes: [], members: [] }), []);
    assert.deepEqual(topCandidates([], 3), []);
  });

  test("모든 후보에 근거나 참고 문장이 하나는 붙는다", () => {
    const all = recommendClasses({ student: stu({ grade: "중2" }), classes: REAL, members: [] });
    for (const c of all) {
      assert.ok(
        c.reasons.length + c.cautions.length > 0,
        `${c.name} 에 아무 설명이 없다 — 원장이 판단할 근거가 없다`
      );
    }
  });

  test("같은 입력이면 순서가 같다 (화면이 흔들리지 않는다)", () => {
    const input = { student: stu({ grade: "중2" }), classes: REAL, members: [] };
    assert.deepEqual(
      names(recommendClasses(input)),
      names(recommendClasses(input))
    );
  });

  /*
    ── 화면에 실제로 붙어 있는지 ──

    규칙이 맞아도 화면이 부르지 않으면 원장에게는 없는 기능이다. 여기서는
    글자로만 확인한다(브라우저를 띄우지 않는다) — 그래도 "추천을 계산해 두고
    화면에 안 걸어 둔" 상태는 확실히 잡힌다.

    같이 보는 선: 결제 화면이 의지하는 전역 캐시 설정을 이 화면이 건드리지
    않는지. 상담 화면에서 staleTime/refetchInterval 을 손대면 수납 화면까지
    같이 흔들린다.
  */
  console.log("\n─── 상담 화면에 붙어 있는지 (글자 확인) ───");
  const page = readFileSync(
    join(process.cwd(), "client", "src", "pages", "Consultations.tsx"),
    "utf8"
  );

  test("상담 화면이 추천 규칙을 직접 쓴다", () => {
    assert.ok(page.includes("recommendClasses({"), "recommendClasses 호출이 없다");
    assert.ok(page.includes("topCandidates("), "topCandidates 호출이 없다");
  });

  test("계산한 후보를 카드에 실제로 그린다", () => {
    assert.ok(page.includes("function ClassFitPanel("), "ClassFitPanel 정의가 없다");
    assert.ok(page.includes("<ClassFitPanel"), "ClassFitPanel 을 그리는 곳이 없다");
    assert.ok(
      page.includes("candidatesByConsultation.get(c.id)"),
      "카드가 자기 상담 건의 후보를 받아 가지 않는다"
    );
  });

  test("정원·반 분위기를 실제 재원생으로 센다", () => {
    assert.ok(page.includes('queryKey: ["/api/students"]'), "학생 목록을 읽지 않는다");
    assert.ok(page.includes('queryKey: ["/api/enrollments"]'), "수강 목록을 읽지 않는다");
    assert.ok(page.includes("maxStudents"), "정원 칸을 넘기지 않는다");
  });

  test("채점이 끝난 가장 최근 결과지만 점수로 쓴다", () => {
    assert.ok(
      /totalScore != null && \(r\.pendingCount \?\? 0\) === 0/.test(page),
      "미채점이 남은 결과지를 걸러내지 않는다"
    );
    assert.ok(
      page.includes("String(b.testDate).localeCompare(String(a.testDate))"),
      "재테스트를 봤을 때 최신 결과지를 고르지 않는다"
    );
  });

  test("반을 고르면 상담 상태도 같이 옮긴다", () => {
    assert.ok(page.includes("recommendedClassId: classId"), "추천반을 적지 않는다");
    assert.ok(
      page.includes('status === "레벨테스트완료" ? { status: "반배정상담"'),
      "반을 골랐는데 단계가 그대로면 자동 할 일이 계속 재촉한다"
    );
  });

  test("자리가 없으면 대기자 표에 적을 수 있다", () => {
    assert.ok(page.includes('apiRequest("POST", "/api/waiters"'), "대기 등록 호출이 없다");
    assert.ok(page.includes('status: "대기등록"'), "상담 단계를 대기등록으로 옮기지 않는다");
  });

  test("권한이 없는 사람에게는 고르는 버튼을 띄우지 않는다", () => {
    assert.ok(
      /canEdit && \(\s*<ClassFitPanel/.test(page),
      "ClassFitPanel 이 canEdit 밖에서 그려진다"
    );
  });

  test("결제 화면이 쓰는 전역 캐시 설정을 건드리지 않는다", () => {
    for (const forbidden of ["staleTime", "refetchInterval", "refetchOnWindowFocus"]) {
      assert.ok(
        !page.includes(forbidden),
        `상담 화면에 ${forbidden} 이 생겼다 — 전역 캐시 설정은 수납 화면과 공유한다`
      );
    }
  });

  console.log(`\n통과 ${passed} · 실패 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();

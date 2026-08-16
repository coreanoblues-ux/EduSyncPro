/**
 * 학년 자동 진급 테스트. `npm run test:grade`
 *
 * 케이스는 지어낸 게 아니라 2026-08-16 운영 DB의 students.grade 실제 분포에서
 * 뽑았다. "삼육중 중3", "불로초6", "설월 1학년" 같은 값이 실제로 들어 있다.
 */

import {
  parseGrade,
  promoteGrade,
  schoolYearOf,
} from "../shared/gradePromotion";

let pass = 0;
const failures: string[] = [];

function eq(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    failures.push(
      `${label}\n    기대: ${JSON.stringify(expected)}\n    실제: ${JSON.stringify(actual)}`
    );
  }
}

// ─── 학년도 경계 ────────────────────────────────────────────────────────────
// 3월 1일이 경계다. 2월까지는 아직 지난 학년도다.
eq("학년도 2026-08-16", schoolYearOf("2026-08-16"), 2026);
eq("학년도 2027-02-28", schoolYearOf("2027-02-28"), 2026);
eq("학년도 2027-03-01", schoolYearOf("2027-03-01"), 2027);
eq("학년도 2027-12-31", schoolYearOf("2027-12-31"), 2027);

// ─── 원장이 말한 두 가지 ────────────────────────────────────────────────────
eq("중1 → 중2", promoteGrade("중1", null), "중2");
eq("중3 → 고1", promoteGrade("중3", null), "고1");

// ─── 같은 학교급 안에서의 진급 ──────────────────────────────────────────────
eq("초1 → 초2", promoteGrade("초1", null), "초2");
eq("중2 → 중3", promoteGrade("중2", null), "중3");
eq("고1 → 고2", promoteGrade("고1", null), "고2");
eq("고2 → 고3", promoteGrade("고2", null), "고3");

// ─── 학교급이 바뀌는 진급 ───────────────────────────────────────────────────
eq("초6 → 중1", promoteGrade("초6", null), "중1");

// 고3은 졸업이다. 고4를 만들지 않고 그대로 둔다(= 변경 없음).
eq("고3은 그대로", promoteGrade("고3", null), null);

// ─── 학교 이름이 붙은 실제 값 ───────────────────────────────────────────────
// 같은 학교에 계속 다니므로 이름을 살린다.
eq("삼육중2 → 삼육중3", promoteGrade("삼육중2", null), "삼육중3");
eq("문성고1 → 문성고2", promoteGrade("문성고1", "문성고"), "문성고2");

// 급이 바뀌면 학교도 바뀐다. 이제 틀린 학교 이름은 버린다.
eq("동성중3 → 고1", promoteGrade("동성중3", null), "고1");
eq("불로초6 → 중1", promoteGrade("불로초6", null), "중1");

// 급 글자가 두 번 나오면 뒤엣것이 학년이다.
eq("삼육중 중3 → 고1", promoteGrade("삼육중 중3", null), "고1");
eq("삼육중 중1 → 삼육중 중2", promoteGrade("삼육중 중1", null), "삼육중 중2");

// ─── 학교 이름으로 학교급을 보완하는 경우 ───────────────────────────────────
eq("6학년 + 조봉초 → 중1", promoteGrade("6학년", "조봉초"), "중1");
eq("1학년 + 숭의중학교 → 중2", promoteGrade("1학년", "숭의중학교"), "중2");
eq("1학년 + 동아여고 → 고2", promoteGrade("1학년", "동아여고"), "고2");
// 학교 이름에 급 글자가 둘 다 있어도 마지막 것을 택한다.
eq("2학년 + 고려중학교 → 중3", promoteGrade("2학년", "고려중학교"), "중3");
eq("2학년 + 중앙고등학교 → 고3", promoteGrade("2학년", "중앙고등학교"), "고3");

// ─── 건드리면 안 되는 값 ────────────────────────────────────────────────────
// 추측해서 올리면 반 배정이 어긋난다. 애매하면 그대로 두는 게 옳다.
eq("빈 값", promoteGrade("", null), null);
eq("null", promoteGrade(null, null), null);
eq("공백만", promoteGrade("   ", null), null);
eq("중학생(학년 없음)", promoteGrade("중학생", null), null);
eq("설월 1학년(급 모름)", promoteGrade("설월 1학년", null), null);
eq("1학년 + 학교 없음", promoteGrade("1학년", null), null);
eq("중5(있을 수 없는 학년)", promoteGrade("중5", null), null);

// ─── 여러 해 밀린 경우 (서버가 오래 꺼져 있었을 때) ─────────────────────────
eq("중1에서 2년 → 중3", promoteGrade("중1", null, 2), "중3");
eq("중1에서 3년 → 고1", promoteGrade("중1", null, 3), "고1");
eq("중2에서 4년 → 고3에서 멈춤", promoteGrade("중2", null, 4), "고3");
eq("중2에서 10년 → 고3에서 멈춤", promoteGrade("중2", null, 10), "고3");
eq("초1에서 6년 → 중1", promoteGrade("초1", null, 6), "중1");

// ─── 파싱 세부 ──────────────────────────────────────────────────────────────
eq("삼육중2 파싱", parseGrade("삼육중2", null), {
  prefix: "삼육",
  level: "중",
  year: 2,
});
eq("중1 파싱", parseGrade("중1", null), { prefix: "", level: "중", year: 1 });
eq("6학년+조봉초 파싱", parseGrade("6학년", "조봉초"), {
  prefix: "",
  level: "초",
  year: 6,
});

// ─── 결과 ───────────────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n❌ ${failures.length}/${total} 실패\n`);
  for (const f of failures) console.error("  " + f + "\n");
  process.exit(1);
}
console.log(`✅ 학년 진급 ${total}케이스 전부 통과`);

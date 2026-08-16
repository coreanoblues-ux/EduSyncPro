/**
 * 반 이름 표기·정렬 검증. `npm run test:class`
 *
 * 아래 교사·반 목록은 2026-08-16 운영 DB에서 그대로 가져온 것이다. 지어낸 예시로
 * 만든 규칙은 실제 데이터에서 깨지기 쉬워서, 여기서는 진짜 이름으로만 검증한다.
 */

import {
  teacherPrefixes,
  classLabel,
  groupClassesByTeacher,
  labelClassesByTeacher,
} from "@shared/classLabel";

const T = {
  정우석: { id: "t-정우석", name: "정우석" },
  김명근: { id: "t-김명근", name: "김명근" },
  이홍석: { id: "t-이홍석", name: "이홍석" },
  정경란: { id: "t-정경란", name: "정경란" },
  홍담: { id: "t-홍담", name: "홍담" },
  고은채: { id: "t-고은채", name: "고은채" },
};
const teachers = Object.values(T);

const classes = [
  { id: "c1", name: "[정]월 수 심화A", teacherId: T.정우석.id },
  { id: "c2", name: "[정]월 수 심화 B", teacherId: T.정우석.id },
  { id: "c3", name: "[정]주말 고등부 고2 오전 ", teacherId: T.정우석.id },
  { id: "c4", name: "[정]주말 고1 오후", teacherId: T.정우석.id },
  { id: "c5", name: "[국어-이]주중-중등반", teacherId: T.이홍석.id },
  { id: "c6", name: "[국어-이]주중-고등반", teacherId: T.이홍석.id },
  { id: "c7", name: "[국어-이]주중-초등반", teacherId: T.이홍석.id },
  { id: "c8", name: "[국어-이]주말-고등반", teacherId: T.이홍석.id },
  { id: "c9", name: "[정]주말 고3 오후", teacherId: T.정우석.id },
  { id: "c10", name: "[정]화 목 심화 A-F", teacherId: T.정우석.id },
  { id: "c11", name: "[정]화 목 심화 C", teacherId: T.정우석.id },
  { id: "c12", name: "[란]중1 기본 - 월수금", teacherId: T.정경란.id },
  { id: "c13", name: "[정]화목 - 기본심화 B", teacherId: T.정우석.id },
  { id: "c14", name: "[란]화 목 중1 기본", teacherId: T.정경란.id },
  { id: "c15", name: "[정]주말 고1 오전", teacherId: T.정우석.id },
  { id: "c16", name: "김명근 중등영어", teacherId: T.김명근.id },
  { id: "c17", name: "김명근 고등영어", teacherId: T.김명근.id },
  { id: "c18", name: "중1 심화반 [월수B]", teacherId: T.정우석.id },
  { id: "c19", name: "화 목 A", teacherId: T.고은채.id },
  { id: "c20", name: "화 목 B", teacherId: T.고은채.id },
  { id: "c21", name: "월 수 금 A", teacherId: T.고은채.id },
  { id: "c22", name: "삼육중B", teacherId: T.정우석.id },
  { id: "c23", name: "삼육중A반", teacherId: T.정우석.id },
];

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, why: string) {
  if (ok) {
    pass++;
    console.log(`✅ ${label}`);
  } else {
    fail++;
    console.log(`❌ ${label}\n   ${why}`);
  }
}

const prefixes = teacherPrefixes(teachers, classes);
const labelOf = (id: string) => {
  const c = classes.find((x) => x.id === id)!;
  return classLabel(c.name, prefixes.get(c.teacherId));
};

// ─── 표기 정하기 ──────────────────────────────────────────────────────────
check(
  "쓰던 표기가 있으면 그대로 물려받는다",
  prefixes.get(T.정우석.id) === "정" &&
    prefixes.get(T.정경란.id) === "란" &&
    prefixes.get(T.이홍석.id) === "국어-이",
  `원장이 정해 둔 표기를 무시하고 성으로 새로 만들면 한 선생님 반이 ` +
    `[정]과 [정우석]으로 갈라진다 — 정우석=${prefixes.get(T.정우석.id)}, ` +
    `정경란=${prefixes.get(T.정경란.id)}, 이홍석=${prefixes.get(T.이홍석.id)}`
);
check(
  "성이 같아도 쓰던 표기가 다르면 안 겹친다",
  prefixes.get(T.정우석.id) !== prefixes.get(T.정경란.id),
  "정우석·정경란이 둘 다 [정]이 되면 어느 분 반인지 구분할 수 없다",
);
check(
  "쓰던 표기가 없으면 성 한 글자",
  prefixes.get(T.고은채.id) === "고" && prefixes.get(T.김명근.id) === "김",
  `고은채=${prefixes.get(T.고은채.id)}, 김명근=${prefixes.get(T.김명근.id)}`
);
check(
  "성이 이미 임자가 있으면 이름 전체를 쓴다",
  (() => {
    const p = teacherPrefixes([...teachers, { id: "t-정민호", name: "정민호" }], classes);
    return p.get("t-정민호") === "정민호" && p.get(T.정우석.id) === "정";
  })(),
  "새 정 선생님이 오면 이미 [정]을 쓰던 정우석 선생님과 겹쳐서는 안 된다"
);
check(
  "표기가 없던 반에 성이 붙는다",
  labelOf("c19") === "[고]화 목 A" && labelOf("c21") === "[고]월 수 금 A",
  `${labelOf("c19")} / ${labelOf("c21")}`
);
check(
  "이미 붙어 있는 표기는 그대로 둔다",
  labelOf("c1") === "[정]월 수 심화A" && labelOf("c12") === "[란]중1 기본 - 월수금",
  `원장이 손수 정한 [정]·[란]·[국어-이] 표기를 코드가 덮어쓰면 안 된다 — ${labelOf("c1")} / ${labelOf("c12")}`
);
check(
  "과목까지 담은 표기도 그대로 둔다",
  labelOf("c5") === "[국어-이]주중-중등반",
  labelOf("c5")
);
check(
  "대괄호가 뒤에 있으면 일정 표기지 교사 표기가 아니다",
  labelOf("c18") === "[정]중1 심화반 [월수B]",
  `'중1 심화반 [월수B]'의 [월수B]는 일정이라 앞에 교사 표기가 따로 붙어야 한다 — ${labelOf("c18")}`
);
check(
  "표기 없던 반이 쓰던 표기를 따라간다",
  labelOf("c22") === "[정]삼육중B" && labelOf("c23") === "[정]삼육중A반",
  `한 선생님 반인데 [정]과 [정우석]으로 갈라지면 묶어 놓은 뜻이 없다 — ` +
    `${labelOf("c22")} / ${labelOf("c23")}`
);
check(
  "교사 이름이 앞에 적힌 반도 표기가 붙는다",
  labelOf("c16") === "[김]김명근 중등영어",
  `조금 겹쳐 보여도 [김]끼리 붙어 있어야 목록에서 찾을 수 있다 — ${labelOf("c16")}`
);

// ─── 정렬 ────────────────────────────────────────────────────────────────
const groups = groupClassesByTeacher(classes, teachers);
check(
  "반이 제일 많은 교사가 맨 위",
  groups[0].teacher?.name === "정우석" && groups[0].classes.length === 12,
  `맨 위 = ${groups[0].teacher?.name} (${groups[0].classes.length}개)`
);
check(
  "그 다음은 반 개수 순",
  groups.map((g) => g.teacher?.name).join(",") === "정우석,이홍석,고은채,김명근,정경란",
  groups.map((g) => `${g.teacher?.name}(${g.classes.length})`).join(",")
);
check(
  "반이 없는 교사는 목록에 나오지 않는다",
  !groups.some((g) => g.teacher?.name === "홍담"),
  "홍담 선생님은 개설 반이 없는데 빈 묶음이 뜨면 안 된다"
);

const flat = labelClassesByTeacher(classes, teachers);
check(
  "같은 교사의 반은 끊기지 않고 붙어 나온다",
  (() => {
    const seen = new Set<string>();
    let prev = "";
    for (const c of flat) {
      if (c.teacherId !== prev) {
        // 한 번 끝난 교사가 나중에 다시 나오면 목록이 흩어진 것이다
        if (seen.has(c.teacherId)) return false;
        seen.add(c.teacherId);
        prev = c.teacherId;
      }
    }
    return true;
  })(),
  "교사별로 뭉쳐 있지 않으면 스크롤하며 눈으로 찾아야 한다"
);
check(
  "묶음 안에서는 표기를 뗀 이름순",
  groups[2].classes.map((c) => c.label).join(",") === "[고]월 수 금 A,[고]화 목 A,[고]화 목 B",
  groups[2].classes.map((c) => c.label).join(",")
);
check(
  "전체 개수는 변하지 않는다",
  flat.length === classes.length,
  `${flat.length} vs ${classes.length}`
);

// ─── 담당 교사가 사라진 반 ─────────────────────────────────────────────────
const orphaned = groupClassesByTeacher(
  [...classes, { id: "c99", name: "옛날반", teacherId: "t-없음" }],
  teachers
);
check(
  "담당 교사가 없는 반은 맨 아래에 남는다",
  orphaned[orphaned.length - 1].teacher === null &&
    orphaned[orphaned.length - 1].classes[0].label === "옛날반",
  "교사를 지워도 반이 목록에서 사라지면 그 반 학생들의 수강 등록을 손댈 수 없다"
);

console.log(`\n${pass}건 통과 / ${fail}건 실패`);
process.exit(fail === 0 ? 0 : 1);

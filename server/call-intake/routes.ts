/**
 * 통화 상담 자동 등록 — POST /api/call-intake
 *
 * 학부모 통화가 끝나고 원장이 폰을 흔들면, 매크로드로이드가 통화 녹음 파일을
 * 여기로 올린다. 음성인식 → AI 정보 추출 → 상담문의(확인 필요)로 저장.
 *
 * ── 반드시 지키는 규칙 ──
 *   · 녹음 파일은 디스크·DB 어디에도 저장하지 않는다. 메모리(버퍼)에서
 *     음성인식으로 보내고 응답 전에 참조를 끊는다. multer 도 memoryStorage 만.
 *   · 음성 원문(전사 텍스트)도 로그에 남기지 않는다. 로그는 시각·번호 뒤 4자리·
 *     결과 상태·크기·추정 비용뿐이다.
 *   · AI 추출 결과는 "초안"이다. needsReview=true 로 저장되어 상담 화면에
 *     "확인 필요" 배지가 붙고, 원장이 내용을 확인해야 배지가 꺼진다.
 *
 * ── 인증 (둘 중 하나) ──
 *   ① X-Intake-Token 헤더 == 환경변수 CALL_INTAKE_TOKEN
 *      → 작성자는 CALL_INTAKE_OWNER_EMAIL 계정(원장)으로 기록된다.
 *        이 앱은 다중 학원 구조라 토큰만으로는 어느 학원인지 알 수 없어서다.
 *   ② 로그인 쿠키 (웹앱에서 직접 업로드할 때 — 폰 브라우저에 로그인돼 있으면
 *      토큰 없이 그대로 올릴 수 있다)
 *
 * ── 전화번호 ──
 *   ?phone= 쿼리 또는 X-Caller-Phone 헤더. 통화 상대 번호가 기준 키다.
 *   AI 가 전사 텍스트에서 번호를 "듣고" 적게 하지 않는다 — 오인식되면
 *   엉뚱한 연락처가 생기기 때문이다.
 */

import { Router, Request, Response, NextFunction } from "express";
import express from "express";
import crypto from "crypto";
import multer from "multer";
import { storage } from "../storage";
import { authGuard, type AuthUser } from "../middleware/auth";
import { normalizePhone } from "../lib/nlpNormalize";
import { canonicalGrade, expandSchoolName } from "@shared/gradePromotion";

const router = Router();

const MAX_BYTES = 25 * 1024 * 1024; // 25MB — 통화 30~40분 분량. 넘으면 413.

/* ── 인증: 토큰이 맞으면 원장 계정으로, 아니면 로그인 쿠키로 ───────────── */

function tokenMatches(given: string | undefined): boolean {
  const expected = process.env.CALL_INTAKE_TOKEN;
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // timingSafeEqual 은 길이가 다르면 던지므로 먼저 길이를 맞춘다.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function intakeAuth(req: Request, res: Response, next: NextFunction) {
  try {
    if (tokenMatches(req.header("x-intake-token"))) {
      const email = process.env.CALL_INTAKE_OWNER_EMAIL?.trim();
      if (!email) {
        return res.status(503).json({ error: "서버에 CALL_INTAKE_OWNER_EMAIL 이 설정되지 않았습니다." });
      }
      const user = await storage.getUserByEmail(email);
      if (!user || !user.isActive || !user.tenantId) {
        return res.status(503).json({ error: "CALL_INTAKE_OWNER_EMAIL 계정을 찾을 수 없습니다." });
      }
      req.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
      } as AuthUser;
      return next();
    }
    // 토큰이 없거나 틀리면 로그인 쿠키로 시도한다. (웹앱에서 직접 업로드)
    return authGuard(req, res, () => {
      if (!req.user?.tenantId || req.user.role === "superadmin") {
        return res.status(403).json({ error: "학원 계정으로 로그인해야 합니다." });
      }
      next();
    });
  } catch (e) {
    console.error("call-intake auth error:", e);
    return res.status(500).json({ error: "인증 처리 중 오류가 발생했습니다." });
  }
}

/* ── 본문: 원본 바이너리(audio/*) 또는 multipart 의 file 필드 ───────────── */

const rawBody = express.raw({
  type: ["audio/*", "video/*", "application/octet-stream"],
  limit: MAX_BYTES,
});

// 디스크 저장 금지 규칙 때문에 memoryStorage 외 다른 storage 를 쓰면 안 된다.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

/* ── 음성인식 ──────────────────────────────────────────────────────────── */

const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";

/** 모델은 환경변수로 바꿀 수 있다 (나중에 gpt-4o-transcribe 로 승격 가능). */
function transcribeModel(): string {
  return process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
}

async function transcribeOnce(buf: Buffer, filename: string, model: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(buf)]), filename);
  fd.append("model", model);
  fd.append("language", "ko");
  const r = await fetch(TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: fd,
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    throw new Error(`음성인식 실패 (${model}, HTTP ${r.status}): ${detail}`);
  }
  const j = (await r.json()) as { text?: string };
  if (!j.text || !j.text.trim()) throw new Error(`음성인식 결과가 비어 있습니다 (${model})`);
  return j.text;
}

async function transcribe(buf: Buffer, filename: string): Promise<string> {
  try {
    return await transcribeOnce(buf, filename, transcribeModel());
  } catch (e) {
    console.warn("call-intake: 1차 음성인식 실패, whisper-1 재시도:", (e as Error).message);
    return await transcribeOnce(buf, filename, "whisper-1");
  }
}

/* ── 정보 추출 ─────────────────────────────────────────────────────────── */

const CHAT_URL = "https://api.openai.com/v1/chat/completions";

interface Extracted {
  is_consultation: boolean;
  student_name: string | null;
  school: string | null;
  grade: string | null;
  purpose: string | null;
  follow_up: string | null;
  summary: string | null;
}

/** 한국 시각을 "2026-10-19 (월) 14:30" 꼴로. 상대 날짜(모레 등) 해석의 기준점. */
export function kstNowLabel(d: Date = new Date()): string {
  const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())}` +
    ` (${days[k.getUTCDay()]}) ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`
  );
}

/**
 * 광주 봉선동 인근에서 자주 나오는 학교들. 음성인식이 비슷한 발음으로 틀리게
 * 적어도 이 목록으로 교정하게 한다. (2026-10-19 원장 확인을 받은 목록)
 */
const LOCAL_SCHOOLS =
  "조봉초, 불로초, " +
  "봉선중, 주월중, 숭의중, 문성중, 동아여중, 서광중, 대성여중, 동성여중, 동성중, " +
  "문성고, 인성고, 석산고, 광덕고, 서석고, 동아여고, 수피아여고, 조대부고, 조대여고, 살레시오여고, 대성여고, 동성고, 대동고, 설월여고";

const LOCAL_SCHOOL_LIST = LOCAL_SCHOOLS.split(", ");

/* 음성인식이 학교명을 비슷한 발음으로 틀리게 적는 일이 잦다 (예: "승인중학교"→"숭의중").
   AI 교정만으로는 놓치는 경우가 있어, 서버에서 자모(ㅅㅜㅇ…) 단위 편집거리로
   목록의 학교와 충분히 비슷하면 목록 이름으로 바꿔 준다. */
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG = "\0ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";

function toJamo(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) {
      out += ch;
      continue;
    }
    out += CHO[Math.floor(code / 588)] + JUNG[Math.floor((code % 588) / 28)];
    const jong = JONG[code % 28];
    if (jong !== "\0") out += jong;
  }
  return out;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return dp[a.length];
}

export function correctSchoolName(raw: string | null): string | null {
  if (!raw) return null;
  const base = raw
    .replace(/\s+/g, "")
    .replace(/초등학교$/, "초")
    .replace(/중학교$/, "중")
    .replace(/고등학교$/, "고")
    .replace(/학교$/, "");
  if (!base) return raw;
  if (LOCAL_SCHOOL_LIST.includes(base)) return base;

  const jamo = toJamo(base);
  let bestName: string | null = null;
  let bestDist = Infinity;
  for (const cand of LOCAL_SCHOOL_LIST) {
    if (cand.slice(-1) !== base.slice(-1)) continue; // 초/중/고 급이 같은 것만 비교
    const d = editDistance(jamo, toJamo(cand));
    if (d < bestDist) {
      bestDist = d;
      bestName = cand;
    }
  }
  // 자모 3개 이내 차이(짧은 이름은 2개)면 같은 학교의 발음 오인으로 본다
  const limit = Math.min(3, Math.max(2, Math.floor(jamo.length / 3)));
  return bestName && bestDist <= limit ? bestName : raw;
}

export function buildExtractionPrompt(nowLabel: string): string {
  return `당신은 영어학원 원장의 통화 녹음 전사 텍스트에서 상담 정보를 추출합니다.

지금 시각(한국): ${nowLabel} — 통화가 방금 끝난 시점입니다.

규칙:
1. is_consultation: 학원 상담·문의·등록 관련 통화면 true. 택배, 지인, 광고, 스팸, 업무와 무관한 통화면 false.
2. student_name/school/grade: 확실히 들린 것만. 불확실하면 null. 절대 추측하지 마십시오.
   - 학교명은 이 지역 학교일 가능성이 높습니다: ${LOCAL_SCHOOLS}.
     발음이 비슷하게 잘못 전사됐으면 (예: "성의중"→"숭의중", "승인중학교"→"숭의중") 목록의 이름으로 교정하십시오.
   - grade 는 "중1", "고2" 같은 꼴로.
3. follow_up: 통화에서 약속한 후속 조치. 상대 날짜는 지금 시각 기준으로 절대 날짜로 바꿔
   "YYYY-MM-DD (요일) HH:MM" 을 포함해 적으십시오.
   예: 지금이 2026-10-19 (월)일 때 "모레 오후 5시 방문" → "2026-10-21 (수) 17:00 방문 예약".
   - 이 학원의 예약 시간 규칙 (모호한 시각 해석에 사용):
     · 평일: 오전 예약 없음. 주로 오후 4시~오후 10시. "5시"는 17:00 입니다.
     · 주말: 오전 9시~오후 6시 이전. "10시"는 10:00, "5시"는 17:00 입니다.
   - 날짜·시각이 아예 언급되지 않았으면 조치 내용만 적고, 아무 약속도 없으면 null.
4. purpose: 상담 목적 한 줄 (예: "중2 내신 대비 수강 문의").
5. summary: 통화 내용 3줄 이내 요약. 학부모가 한 질문과 원장이 한 약속을 중심으로.
6. 전화번호는 추출하지 마십시오 — 시스템이 통화 기록에서 직접 받습니다.`;
}

const EXTRACT_SCHEMA = {
  name: "call_intake_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      is_consultation: { type: "boolean" },
      student_name: { type: ["string", "null"] },
      school: { type: ["string", "null"] },
      grade: { type: ["string", "null"] },
      purpose: { type: ["string", "null"] },
      follow_up: { type: ["string", "null"] },
      summary: { type: ["string", "null"] },
    },
    required: ["is_consultation", "student_name", "school", "grade", "purpose", "follow_up", "summary"],
  },
} as const;

async function extractInfo(transcript: string, nowLabel: string): Promise<Extracted> {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini"; // 기존 자연어 파싱과 같은 모델
  const r = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: buildExtractionPrompt(nowLabel) },
        { role: "user", content: transcript.slice(0, 24_000) },
      ],
      response_format: { type: "json_schema", json_schema: EXTRACT_SCHEMA },
    }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    throw new Error(`정보 추출 실패 (HTTP ${r.status}): ${detail}`);
  }
  const j = (await r.json()) as any;
  return JSON.parse(j.choices[0].message.content) as Extracted;
}

/* ── 저장 ─────────────────────────────────────────────────────────────── */

interface SaveResult {
  status: "created" | "updated";
  message: string;
}

async function saveConsultation(
  user: AuthUser,
  phone: string | null,
  ai: Extracted,
  nowLabel: string
): Promise<SaveResult> {
  const tenantId = user.tenantId!;
  const correctedSchool = correctSchoolName(ai.school);
  const school = expandSchoolName(correctedSchool) || correctedSchool || null;
  const grade = canonicalGrade(ai.grade, school) ?? ai.grade ?? null;
  const name = ai.student_name?.trim() || null;

  const noteLines = [
    `[통화 자동등록 ${nowLabel}]`,
    school ? `학교: ${school}` : null,
    ai.summary ? `요약: ${ai.summary}` : null,
    ai.follow_up ? `후속: ${ai.follow_up}` : null,
  ].filter(Boolean);
  const note = noteLines.join("\n");

  const label = [name ?? "이름 미확인", school, grade].filter(Boolean).join(" · ");

  // 전화번호가 기준 키. 같은 번호의 기존 건을 찾는다.
  const normPhone = phone ? normalizePhone(phone) : null;
  const rows = normPhone
    ? (await storage.getConsultationsByTenant(tenantId)).filter(
        (c) => c.phone && normalizePhone(c.phone) === normPhone
      )
    : [];

  // 학생명이 같거나(또는 어느 한쪽이 비어 있으면 같은 학생으로 보고) 기존 건에 덧붙인다.
  const match = rows.find(
    (c) => !name || !c.studentName || c.studentName.trim() === name
  );

  if (match) {
    await storage.updateConsultation(match.id, {
      memo: match.memo ? `${match.memo}\n\n${note}` : note,
      followUp: ai.follow_up ?? match.followUp,
      studentName: match.studentName || name,
      school: match.school || school,
      studentGrade: match.studentGrade || grade,
      subject: match.subject || ai.purpose,
      needsReview: true,
    });
    return { status: "updated", message: `${label} — 기존 상담에 통화 내용 추가(확인 필요)` };
  }

  // 같은 번호인데 학생명이 다르면 형제일 수 있다 — 새 줄로 만들고 메모에 표시한다.
  const siblingNote = rows.length
    ? `\n같은 번호의 기존 상담: ${rows.map((c) => c.studentName || "이름 미입력").join(", ")} (형제 가능)`
    : "";

  await storage.createConsultation({
    tenantId,
    createdBy: user.id,
    phone: normPhone,
    studentName: name,
    school,
    studentGrade: grade,
    status: "상담문의",
    subject: ai.purpose,
    followUp: ai.follow_up,
    memo: note + siblingNote,
    needsReview: true,
  });
  return { status: "created", message: `${label} — 상담문의 등록(확인 필요)` };
}

/* ── 엔드포인트 ────────────────────────────────────────────────────────── */

router.post(
  "/api/call-intake",
  intakeAuth,
  rawBody,
  upload.single("file"),
  async (req: Request, res: Response) => {
    let buf: Buffer | null =
      req.file?.buffer ?? (Buffer.isBuffer(req.body) && req.body.length ? req.body : null);
    const startedAt = Date.now();
    try {
      if (!buf || buf.length < 1024) {
        return res.status(400).json({ error: "오디오 파일이 없거나 너무 작습니다." });
      }
      if (!process.env.OPENAI_API_KEY) {
        return res.status(503).json({ error: "서버에 OPENAI_API_KEY 가 없습니다." });
      }

      const phone =
        (typeof req.query.phone === "string" ? req.query.phone : null) ||
        req.header("x-caller-phone") ||
        null;

      const filename = req.file?.originalname || "call.m4a";
      const nowLabel = kstNowLabel();
      const bytes = buf.length;

      const transcript = await transcribe(buf, filename);
      buf = null; // 규칙: 응답 전에 오디오 버퍼 참조 해제. 어디에도 저장하지 않았다.

      const ai = await extractInfo(transcript, nowLabel);

      // 처리 로그 — 음성 원문·전체 텍스트는 절대 남기지 않는다.
      const last4 = phone ? normalizePhone(phone)?.slice(-4) : "----";
      const estSeconds = Math.round(bytes / 12_000); // m4a ≈ 96kbps 가정한 추정치
      const estCostUsd = ((estSeconds / 60) * 0.003 + 0.001).toFixed(4); // 전사+추출 추정
      const logResult = ai.is_consultation ? "처리" : "skipped";
      console.log(
        `📞 call-intake ${nowLabel} · ***${last4} · ${logResult} · 약 ${estSeconds}초 · ~$${estCostUsd} · ${Math.round(bytes / 1024)}KB · ${Date.now() - startedAt}ms`
      );

      if (!ai.is_consultation) {
        return res.json({
          status: "skipped",
          message: "상담 통화가 아니어서 저장하지 않았습니다.",
          summary: ai.summary ?? "",
        });
      }

      const saved = await saveConsultation(req.user!, phone, ai, nowLabel);
      return res.json({ status: saved.status, message: saved.message, summary: ai.summary ?? "" });
    } catch (e) {
      buf = null;
      console.error("call-intake error:", (e as Error).message);
      return res.status(500).json({
        status: "error",
        message: "등록 실패 — 웹앱에서 수동 입력해 주세요.",
        error: (e as Error).message.slice(0, 200),
      });
    }
  }
);

/** 크기 초과(413)와 multer 오류를 지시서 형식으로 돌려준다. */
router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err?.type === "entity.too.large" || err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "녹음 파일이 25MB 를 넘습니다." });
  }
  next(err);
});

export default router;

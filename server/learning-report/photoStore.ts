/**
 * 노트 사진 저장소. 사진 원본을 어디에 두는지는 **이 파일만** 안다.
 *
 * 지금은 DB(note_photo_files.data, bytea)에 둔다 — 원장 결정 2026-11-07,
 * 근거와 비용 계산은 docs/PARENT_REPORT_PLAN.md §5. 사진이 크게 늘어 Railway
 * Object Storage 로 옮길 때는 이 파일의 함수 넷만 바꾸면 된다. 라우트는 그대로다.
 *
 * ⚠️ 스스로 자료를 지우는 장치(purgeOldPhotos)가 들어 있다. 지우는 것은 **원본 이미지뿐**이고,
 *    note_photos 행(제목·날짜·누구 것인지)은 남겨서 리포트에 "보관 기간이 지난 사진" 으로 보인다.
 */

import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { notePhotos, notePhotoFiles, NOTE_PHOTO_RETENTION_DAYS, type InsertNotePhoto, type NotePhoto } from "@shared/schema";
import { addDays, todayKst } from "@shared/day";

/**
 * 한 장의 상한. 화면이 올리기 전에 긴 변 1600px · JPEG 로 줄이므로 보통 200~300KB 다.
 * 상한은 그 몇 배로 넉넉히 두되, 원본 폰 사진(5~10MB)이 줄이기를 건너뛰고 그대로 들어오는 것은 막는다.
 */
export const MAX_PHOTO_BYTES = 1_500_000;

const SIGNATURES: { mime: string; test: (b: Buffer) => boolean }[] = [
  { mime: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", test: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
];

/**
 * 파일 앞머리로 진짜 이미지인지 본다. 요청 헤더의 Content-Type 은 보내는 쪽 마음대로라 믿지 않는다.
 * 여기서 정한 mime 이 나중에 이미지를 돌려줄 때 그대로 쓰인다 — HTML 을 이미지라고 올려
 * 우리 주소에서 스크립트로 열리게 하는 길을 막는다.
 */
export function detectImageMime(buf: Buffer): string | null {
  return SIGNATURES.find((s) => s.test(buf))?.mime ?? null;
}

export async function savePhoto(meta: InsertNotePhoto, data: Buffer, mime: string): Promise<NotePhoto> {
  return await db.transaction(async (tx) => {
    const [row] = await tx.insert(notePhotos).values({ ...meta, bytes: data.length }).returning();
    await tx.insert(notePhotoFiles).values({ photoId: row.id, mime, data });
    return row;
  });
}

export async function readPhoto(photoId: string): Promise<{ mime: string; data: Buffer } | null> {
  const [row] = await db
    .select({ mime: notePhotoFiles.mime, data: notePhotoFiles.data })
    .from(notePhotoFiles)
    .where(eq(notePhotoFiles.photoId, photoId));
  return row ?? null;
}

/** 행과 원본을 함께 지운다(선생님이 잘못 올린 사진을 지울 때). 원본은 FK cascade 로 따라간다. */
export async function deletePhoto(photoId: string): Promise<void> {
  await db.delete(notePhotos).where(eq(notePhotos.id, photoId));
}

/** 이 날짜보다 먼저 찍은 사진의 원본을 지운다. */
export function photoPurgeCutoff(today: string = todayKst()): string {
  return addDays(today, -NOTE_PHOTO_RETENTION_DAYS);
}

/**
 * 보관 기간이 지난 사진의 **원본만** 지운다. 지운 장 수를 돌려준다.
 *
 * 안전장치:
 *   · note_photos 행은 지우지 않는다 — purged_at 만 찍는다
 *   · taken_date 가 YYYY-MM-DD 모양이 아니면 건너뛴다 ("모르겠으면 지우지 않는다")
 *   · 한 번에 200장까지만. 무언가 잘못돼 기준이 어긋나도 한 번에 다 날아가지 않는다
 */
export async function purgeOldPhotos(today: string = todayKst()): Promise<number> {
  const cutoff = photoPurgeCutoff(today);
  const due = await db
    .select({ id: notePhotos.id })
    .from(notePhotos)
    .where(
      and(
        isNull(notePhotos.purgedAt),
        lt(notePhotos.takenDate, cutoff),
        sql`${notePhotos.takenDate} ~ '^\\d{4}-\\d{2}-\\d{2}$'`
      )
    )
    .limit(200);
  if (due.length === 0) return 0;
  const ids = due.map((r) => r.id);
  await db.transaction(async (tx) => {
    await tx.delete(notePhotoFiles).where(inArray(notePhotoFiles.photoId, ids));
    await tx.update(notePhotos).set({ purgedAt: new Date() }).where(inArray(notePhotos.id, ids));
  });
  return ids.length;
}

/** 6시간마다. 학년 승급·링크 파기 장치와 같은 모양으로 둔다(server/lib/sharePurge.ts). */
export function startPhotoPurgeScheduler() {
  const tick = () => {
    purgeOldPhotos()
      .then((n) => {
        if (n > 0) console.log(`🧹 보관 기간(${NOTE_PHOTO_RETENTION_DAYS}일)이 지난 노트 사진 원본 ${n}장을 지웠습니다. 제목·날짜는 남겨 둡니다.`);
      })
      .catch((err) => {
        // 실패해도 서버는 계속 돈다. 손해는 "사진이 DB 에 조금 더 오래 남는다" 뿐이다.
        console.error("❌ 노트 사진 보관 기간 정리 실패:", err);
      });
  };
  tick();
  setInterval(tick, 6 * 60 * 60 * 1000);
}

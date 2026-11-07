/**
 * ④ 노트 사진 탭.
 *
 * 올리기 전에 **브라우저에서 줄인다**(긴 변 1600px · JPEG). 폰 원본은 5~10MB 라 서버 상한(1.5MB)에
 * 걸리고, 부모님 폰에서 열 때도 느리다. 줄인 사진은 보통 200~300KB 다(PLAN §5 비용 계산의 전제).
 *
 * 사진은 그 주 기록에 매달린다. 주를 공개해야 부모님께 보인다. 찍은 지 6개월이 지나면 원본은
 * 자동으로 지워지고 제목·날짜만 남는다(server/learning-report/photoStore.ts).
 */

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, ImageOff, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { addDays, todayKst } from "@shared/day";
import { API, bundleKey, usePatchBundle, type PhotoRow, type Track, type WeekBundle } from "./shared";
import LocalInput from "./LocalInput";

type Props = { bundle: WeekBundle; track: Track; schedule: (key: string, fn: () => void) => void };

const MAX_SIDE = 1600;
/** 서버 상한 1.5MB 보다 조금 작게. 넘으면 화질을 낮춰 한 번 더 줄인다. */
const TARGET_BYTES = 1_200_000;
const ALL = "__all__";

/** 사진을 긴 변 1600px · JPEG 로 줄인다. 폰 사진의 회전 정보(EXIF)는 브라우저가 반영해 그린다. */
async function shrink(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  let source: CanvasImageSource;
  let w: number;
  let h: number;
  try {
    const bmp = await createImageBitmap(file);
    source = bmp;
    w = bmp.width;
    h = bmp.height;
  } catch {
    const img = new Image();
    const url = URL.createObjectURL(file);
    try {
      img.src = url;
      await img.decode();
    } finally {
      URL.revokeObjectURL(url);
    }
    source = img;
    w = img.naturalWidth;
    h = img.naturalHeight;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; // 투명 PNG 가 JPEG 로 바뀔 때 검게 나오지 않게
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(source, 0, 0, cw, ch);
  const toBlob = (q: number) => new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("사진을 줄이지 못했습니다."))), "image/jpeg", q));
  let blob = await toBlob(0.82);
  if (blob.size > TARGET_BYTES) blob = await toBlob(0.6);
  return { blob, width: cw, height: ch };
}

export default function PhotoTab({ bundle, track, schedule }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const classId = bundle.class.id;
  const weekPath = `${API}/classes/${classId}/weeks/${bundle.weekStart}`;
  const patchBundle = usePatchBundle(classId, bundle.weekStart);
  const refetch = () => qc.invalidateQueries({ queryKey: bundleKey(classId, bundle.weekStart) });
  const fileInput = useRef<HTMLInputElement>(null);

  const today = todayKst();
  const weekEnd = addDays(bundle.weekStart, 6);
  const [title, setTitle] = useState("수업 노트");
  const [takenDate, setTakenDate] = useState(today < bundle.weekStart ? bundle.weekStart : today > weekEnd ? weekEnd : today);
  const [target, setTarget] = useState<string>(ALL);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const names = Object.fromEntries(bundle.students.map((s) => [s.id, s.name]));

  const upload = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
    if (images.length === 0) return toast({ title: "사진 파일만 올릴 수 있습니다" });
    setBusy({ done: 0, total: images.length });
    let ok = 0;
    for (const file of images) {
      try {
        const { blob, width, height } = await shrink(file);
        const q = new URLSearchParams({ title: title.trim() || "수업 노트", takenDate, width: String(width), height: String(height) });
        if (target !== ALL) q.set("studentId", target);
        const r = await track(
          fetch(`${weekPath}/photos?${q}`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob, credentials: "include" }).then(async (res) => {
            if (!res.ok) {
              const j = await res.json().catch(() => ({}));
              throw new Error(j.error ?? `${res.status}`);
            }
            return res;
          })
        );
        if (r) ok++;
      } catch (e) {
        // 아이폰 HEIC 처럼 이 브라우저가 못 여는 형식은 여기서 걸린다.
        toast({ title: `${file.name} 을(를) 올리지 못했습니다`, description: "JPG·PNG 사진으로 다시 시도해 주세요. 아이폰은 '사진 앱에서 보내기' 로 올리면 JPG 로 바뀝니다." });
      }
      setBusy((b) => (b ? { ...b, done: b.done + 1 } : b));
    }
    setBusy(null);
    if (ok) {
      toast({ title: `사진 ${ok}장을 올렸습니다`, description: "이번 주 리포트를 공개하면 부모님께 보입니다." });
      refetch();
    }
  };

  const updatePhoto = (p: PhotoRow, patch: { title?: string; studentId?: string | null }) => {
    patchBundle((b) => ({ ...b, photos: b.photos.map((x) => (x.id === p.id ? { ...x, ...patch } : x)) }));
    if (patch.title !== undefined) {
      if (!patch.title.trim()) return; // 빈 제목은 저장하지 않는다(칸을 비운 채 떠나면 원래 제목으로 돌아간다)
      schedule(`photo:${p.id}:title`, () => track(apiRequest("PATCH", `${API}/photos/${p.id}`, { title: patch.title!.trim() })));
    } else {
      track(apiRequest("PATCH", `${API}/photos/${p.id}`, patch));
    }
  };

  const remove = async (p: PhotoRow) => {
    if (!window.confirm(`"${p.title}" 사진을 지울까요?`)) return;
    if (await track(apiRequest("DELETE", `${API}/photos/${p.id}`))) refetch();
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[380px_1fr]">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">사진 올리기</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div
            data-testid="dropzone-photo"
            role="button"
            tabIndex={0}
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (!busy) upload(Array.from(e.dataTransfer.files));
            }}
            className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition ${
              dragOver ? "border-orange-500 bg-orange-50" : "border-orange-300 bg-orange-50/40 hover:bg-orange-50"
            }`}
          >
            <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-orange-400 to-orange-600 text-white">
              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
            </div>
            <div className="text-sm font-extrabold">{busy ? `올리는 중… ${busy.done}/${busy.total}` : "사진을 여기에 끌어다 놓기"}</div>
            <div className="mt-1 text-xs text-muted-foreground">또는 눌러서 고르기 · 폰에서는 바로 찍기 · 여러 장 한 번에</div>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = ""; // 같은 사진을 다시 고를 수 있게
                if (files.length && !busy) upload(files);
              }}
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">사진 제목 (부모님께 보임)</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 문법 개념 정리" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">수업 날짜</Label>
              <Input type="date" min={bundle.weekStart} max={weekEnd} value={takenDate} onChange={(e) => setTakenDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">누구에게 보일까요?</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>반 전체 ({bundle.students.length}명)</SelectItem>
                  {bundle.students.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}만
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">올린 사진은 찍은 날부터 6개월 동안 보관되고, 그 뒤에는 자동으로 지워집니다.</p>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            이번 주 노트 <span className="ml-1 text-xs font-normal text-muted-foreground">{bundle.photos.length}장</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {bundle.photos.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">아직 올린 사진이 없습니다.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-4">
              {bundle.photos.map((p) => (
                <div key={p.id} className="overflow-hidden rounded-xl border bg-background" data-testid={`photo-${p.id}`}>
                  {p.purged ? (
                    <div className="flex h-36 flex-col items-center justify-center gap-1 bg-muted text-xs text-muted-foreground">
                      <ImageOff className="h-5 w-5" />
                      보관 기간이 지난 사진
                    </div>
                  ) : (
                    <a href={`${API}/photos/${p.id}/image`} target="_blank" rel="noreferrer">
                      <img src={`${API}/photos/${p.id}/image`} alt={p.title} loading="lazy" className="h-36 w-full object-cover" />
                    </a>
                  )}
                  <div className="space-y-1.5 p-2">
                    <LocalInput className="h-7 text-xs font-bold" value={p.title} onValueChange={(v) => updatePhoto(p, { title: v })} />
                    <div className="flex items-center gap-1">
                      <Select value={p.studentId ?? ALL} onValueChange={(v) => updatePhoto(p, { studentId: v === ALL ? null : v })}>
                        <SelectTrigger className="h-7 flex-1 text-[11px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ALL}>반 전체</SelectItem>
                          {bundle.students.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}만
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-[10px] text-muted-foreground">{p.takenDate.slice(5).replace("-", ".")}</span>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => remove(p)} aria-label="사진 삭제">
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                    {p.studentId && !names[p.studentId] && <p className="text-[10px] text-red-600">이 반 명단에 없는 학생입니다</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

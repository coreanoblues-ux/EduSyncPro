/**
 * 전화번호 빠른 검색
 *
 * 전화가 오면 번호 뒷자리 4자리만 치면 학생 정보가 즉시 뜬다.
 * 대시보드에 이미 올라와 있는 students·enrollments·classes·payments·
 * consultations·teachers 데이터를 클라이언트에서 필터하므로 API 호출 없이 즉시 반응한다.
 */

import { useMemo, useRef, useState } from "react";
import { Phone, Search, User, BookOpen, CreditCard, MessageSquare, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { Class, Consultation, Enrollment, Payment, Student, Teacher } from "@shared/schema";

interface Props {
  students: Student[];
  enrollments: Enrollment[];
  classes: Class[];
  payments: Payment[];
  consultations: Consultation[];
  teachers: Teacher[];
}

interface MatchedStudent {
  student: Student;
  /** 활성 수강 반 목록 (반이름 + 선생님) */
  classList: { className: string; teacherName: string; isPaid: boolean; unpaidCount: number }[];
  /** 상담 기록 */
  consultationCount: number;
}

interface MatchedConsultation {
  consultation: Consultation;
}

function normalizePhone(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

export default function PhoneSearch({
  students,
  enrollments,
  classes,
  payments,
  consultations,
  teachers,
}: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const digits = normalizePhone(query);

  const results = useMemo(() => {
    if (digits.length < 4) return null;

    const currentMonth = new Date().toISOString().slice(0, 7);
    const classById = new Map(classes.map((c) => [c.id, c]));
    const teacherById = new Map(teachers.map((t) => [t.id, t]));

    // 학생 검색 — parentPhone 뒷자리 매칭
    const matchedStudents: MatchedStudent[] = [];
    for (const s of students) {
      const phone = normalizePhone(s.parentPhone || "");
      if (!phone || !phone.endsWith(digits)) continue;

      const studentEnrollments = enrollments.filter(
        (e) => e.studentId === s.id && e.isActive
      );

      const classList = studentEnrollments.map((e) => {
        const cls = classById.get(e.classId);
        const teacher = cls ? teacherById.get(cls.teacherId) : undefined;

        // 이번 달 납부 여부
        const monthPayments = payments.filter(
          (p) => p.enrollmentId === e.id && p.paymentMonth === currentMonth
        );
        const netAmount = monthPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
        const isPaid = netAmount > 0;

        // 전체 미납 개월 수 (간단 계산)
        const start = new Date(e.startDate);
        const now = new Date();
        let unpaidCount = 0;
        const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
        const endMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        while (cursor <= endMonth) {
          const monthStr = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
          const monthNet = payments
            .filter((p) => p.enrollmentId === e.id && p.paymentMonth === monthStr)
            .reduce((sum, p) => sum + (p.amount || 0), 0);
          if (monthNet <= 0) unpaidCount++;
          cursor.setMonth(cursor.getMonth() + 1);
        }

        return {
          className: cls?.name || "알 수 없는 반",
          teacherName: teacher?.name || "담당 미정",
          isPaid,
          unpaidCount,
        };
      });

      const consultationCount = consultations.filter(
        (c) => c.studentId === s.id
      ).length;

      matchedStudents.push({ student: s, classList, consultationCount });
    }

    // 상담 기록 중 아직 학생이 되지 않은 것 — phone 뒷자리 매칭
    const matchedConsultations: MatchedConsultation[] = [];
    for (const c of consultations) {
      const phone = normalizePhone(c.phone || "");
      if (!phone || !phone.endsWith(digits)) continue;
      // 이미 학생으로 매칭된 상담은 제외
      if (c.studentId && matchedStudents.some((m) => m.student.id === c.studentId)) continue;
      matchedConsultations.push({ consultation: c });
    }

    return { matchedStudents, matchedConsultations };
  }, [digits, students, enrollments, classes, payments, consultations, teachers]);

  const hasResults =
    results &&
    (results.matchedStudents.length > 0 || results.matchedConsultations.length > 0);
  const noResults = results && !hasResults;

  return (
    <Card className="border-primary/20 shadow-sm">
      <CardContent className="pt-4 pb-3">
        {/* 검색 입력 */}
        <div className="relative">
          <Phone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            type="tel"
            inputMode="numeric"
            placeholder="전화번호 뒷자리 4자리 입력 (수신 전화 빠른 조회)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9 pr-9 text-base"
            data-testid="phone-search-input"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* 4자리 미만이면 안내 */}
        {digits.length > 0 && digits.length < 4 && (
          <p className="mt-2 text-xs text-muted-foreground">
            <Search className="mr-1 inline h-3 w-3" />
            4자리 이상 입력하면 검색합니다
          </p>
        )}

        {/* 결과 없음 */}
        {noResults && (
          <p className="mt-3 text-center text-sm text-muted-foreground">
            "{digits}" 뒷자리와 일치하는 연락처가 없습니다
          </p>
        )}

        {/* 학생 결과 */}
        {results && results.matchedStudents.length > 0 && (
          <div className="mt-3 space-y-2">
            {results.matchedStudents.map((m) => (
              <div
                key={m.student.id}
                className="rounded-lg border bg-background p-3"
                data-testid={`phone-result-${m.student.id}`}
              >
                {/* 이름 + 학년 + 상태 */}
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4 text-primary" />
                  <span className="font-semibold">{m.student.name}</span>
                  {m.student.grade && (
                    <Badge variant="outline" className="text-xs">
                      {m.student.grade}
                    </Badge>
                  )}
                  {m.student.isActive === false && (
                    <Badge variant="secondary" className="text-xs">휴원</Badge>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    <Phone className="mr-1 inline h-3 w-3" />
                    {m.student.parentPhone}
                  </span>
                </div>

                {/* 반 목록 + 수납 */}
                {m.classList.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    {m.classList.map((c, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 text-sm"
                      >
                        <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="truncate">{c.className}</span>
                        <span className="text-xs text-muted-foreground">
                          ({c.teacherName})
                        </span>
                        <span className="ml-auto flex items-center gap-1">
                          <CreditCard className="h-3 w-3" />
                          {c.isPaid ? (
                            <Badge className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 text-[10px]">
                              납부완료
                            </Badge>
                          ) : (
                            <Badge variant="destructive" className="text-[10px]">
                              {c.unpaidCount}개월 미납
                            </Badge>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">수강 중인 반 없음</p>
                )}

                {/* 상담 이력 */}
                {m.consultationCount > 0 && (
                  <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <MessageSquare className="h-3 w-3" />
                    상담 기록 {m.consultationCount}건
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 상담만 매칭 (아직 학생이 아닌 경우) */}
        {results && results.matchedConsultations.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              상담 문의 (미등록)
            </p>
            {results.matchedConsultations.map((m) => (
              <div
                key={m.consultation.id}
                className="rounded-lg border border-dashed bg-background p-3"
                data-testid={`phone-result-consultation-${m.consultation.id}`}
              >
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-blue-500" />
                  <span className="font-medium">
                    {m.consultation.studentName || m.consultation.guardianName || "이름 미상"}
                  </span>
                  {m.consultation.studentGrade && (
                    <Badge variant="outline" className="text-xs">
                      {m.consultation.studentGrade}
                    </Badge>
                  )}
                  {m.consultation.subject && (
                    <Badge variant="secondary" className="text-xs">
                      {m.consultation.subject}
                    </Badge>
                  )}
                  <Badge variant="outline" className="ml-auto text-[10px]">
                    {m.consultation.status}
                  </Badge>
                </div>
                {m.consultation.followUp && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {m.consultation.followUp}
                  </p>
                )}
                <div className="mt-1 text-xs text-muted-foreground">
                  <Phone className="mr-1 inline h-3 w-3" />
                  {m.consultation.phone}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

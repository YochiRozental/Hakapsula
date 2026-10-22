"use client";

import { useEffect, useState } from "react";
import type { BookingTrack, ResolvedDay } from "@/lib/opening-hours";

/**
 * שעות הפעילות ליום מסוים מהמקור המרכזי (/api/opening-hours) — לשימוש מסך ההזמנה, יומן המנהל וטופס התור הידני.
 * day = null בזמן הטעינה או בכשל. userTrack = מסלול המשתמש המחובר (null = אין); undefined עד שנטען לראשונה,
 * ונשמר בין תאריכים כדי שלא יהיה הבהוב בבורר המסלול.
 */
export function useDayHours(date: string): { day: ResolvedDay | null; userTrack: BookingTrack | null | undefined } {
  const [state, setState] = useState<{ date: string; day: ResolvedDay } | null>(null);
  const [userTrack, setUserTrack] = useState<BookingTrack | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/opening-hours?date=${date}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: (ResolvedDay & { userTrack: BookingTrack | null }) | null) => {
        if (cancelled || !data) return;
        setState({ date, day: data });
        setUserTrack(data.userTrack ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [date]);

  // תוצאה של תאריך קודם לא מוצגת כשהתאריך הנבחר השתנה (ללא setState סינכרוני באפקט)
  return { day: state?.date === date ? state.day : null, userTrack };
}

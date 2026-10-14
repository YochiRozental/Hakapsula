import type { RoomKey } from "@/generated/prisma/client";
import { DURATION_OPTIONS } from "@/lib/slots";

/** מיפוי בין ספרה שהמתקשר מקיש לבין מפתח החדר במערכת */
export const ROOM_DIGIT_MAP: Record<string, RoomKey> = {
  "1": "ROOM1",
  "2": "ROOM2",
  "5": "ROOM3",
  "6": "ROOM4",
  "3": "WORKSHOP",
  "4": "ROOM1_2",
};

/** מיפוי בין ספרה שהמתקשר מקיש לבין משך התור בדקות (תואם לסדר DURATION_OPTIONS ולסדר תפריט ההקשה המוקלט - ראו BOOKING_FILES.DURATION_MENU ב-prompts.ts) */
export const DURATION_DIGIT_MAP: Record<string, number> = Object.fromEntries(
  DURATION_OPTIONS.map((opt, i) => [String(i + 1), opt.minutes])
);

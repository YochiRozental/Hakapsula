import { RoomKey } from "@/generated/prisma/client";

export const ROOM_LABELS: Record<RoomKey, string> = {
  ROOM1: "קפסולה 1",
  ROOM2: "קפסולה 2",
  ROOM3: "קפסולה 3",
  ROOM4: "קפסולה 4",
  WORKSHOP: "קפסולת סדנאות",
  ROOM1_2: "קפסולה 1+2 (2 חדרים נפרדים עם חיבור פנימי ודיסקרטי בינהם)",
};

export const ROOM_SEED: {
  key: RoomKey;
  name: string;
  description: string;
  isCombo: boolean;
}[] = [
  {
    key: "ROOM1",
    name: "קפסולה 1",
    description: "קפסולה טיפולים 1",
    isCombo: false,
  },
  {
    key: "ROOM2",
    name: "קפסולה 2",
    description: "קפסולה טיפולים 2",
    isCombo: false,
  },
  {
    key: "ROOM3",
    name: "קפסולה 3",
    description: "קפסולה טיפולים 3",
    isCombo: false,
  },
  {
    key: "ROOM4",
    name: "קפסולה 4",
    description: "קפסולה טיפולים 4",
    isCombo: false,
  },
  {
    key: "WORKSHOP",
    name: "קפסולת סדנאות",
    description: "קפסולה המיועדת לסדנאות עד 20 איש מאובזר כנדרש לנוחיותכם",
    isCombo: false,
  },
  {
    key: "ROOM1_2",
    name: "קפסולה 1+2 (2 חדרים נפרדים עם חיבור פנימי ודיסקרטי בינהם)",
    description:
      "ניתן להזמין את שני החדרים עם דלת משותפת ביניהם עבור מטפלים הזקוקים לחיבור ביניהם",
    isCombo: true,
  },
];

/** רשימת מפתחות החדרים לפי סדר התצוגה — נגזרת מ-ROOM_SEED */
export const ROOM_KEYS: RoomKey[] = ROOM_SEED.map((r) => r.key);

/**
 * חדר 1 וחדר 2 מחוברים פיזית וניתן לחבר אותם לחדר 1+2 אחד.
 * הזמנה של ROOM1_2 חוסמת גם ROOM1 וגם ROOM2 ולהפך, כדי למנוע התנגשות פיזית.
 * חדרים 3 ו-4 וחדר הסדנאות עצמאיים לחלוטין ואינם משפיעים על אף חדר אחר.
 */
export const CONFLICTING_ROOM_KEYS: Record<RoomKey, RoomKey[]> = {
  ROOM1: ["ROOM1", "ROOM1_2"],
  ROOM2: ["ROOM2", "ROOM1_2"],
  ROOM3: ["ROOM3"],
  ROOM4: ["ROOM4"],
  ROOM1_2: ["ROOM1", "ROOM2", "ROOM1_2"],
  WORKSHOP: ["WORKSHOP"],
};

/**
 * אזור נעילה לכל חדר, ליצירת הזמנות: חדרים שיכולים להתנגש זה בזה (לפי CONFLICTING_ROOM_KEYS) חולקים אזור,
 * כך ש-createAppointment מסדרת אותם בטור. חדר 1, חדר 2 וחדר 1+2 באזור אחד; כל חדר עצמאי באזור משלו.
 * התאמה לחוקי ההתנגשות נבדקת בבדיקות.
 */
export const ROOM_LOCK_ZONE: Record<RoomKey, number> = {
  ROOM1: 1,
  ROOM2: 1,
  ROOM1_2: 1,
  ROOM3: 2,
  ROOM4: 3,
  WORKSHOP: 4,
};

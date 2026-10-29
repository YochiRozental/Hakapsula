import type { Call, Msg } from "yemot-router2";
import { prisma } from "@/lib/prisma";
import { createAppointment, BookingError } from "@/lib/booking";
import { hashPassword } from "@/lib/password";
import { unusablePasswordHash } from "@/lib/ivr-pin/service";
import { text } from "@/ivr/messages";
import { isIvrPaymentsEnabled } from "@/ivr/payments-flag";
import { runPaidBooking } from "@/ivr/payment-flow";
import { getRuntimeProvider } from "@/lib/payments/runtime";
import { identifyCaller, type CallerIdentity } from "@/ivr/identify";
import { ROOM_DIGIT_MAP, DURATION_DIGIT_MAP } from "@/ivr/ivr-options";
import { ROOM_LABELS } from "@/lib/rooms";
import { DURATION_OPTIONS } from "@/lib/slots";
import { bookingFile, notRegisteredFile, BOOKING_FILES, NOT_REGISTERED_FILES } from "@/ivr/prompts";

/**
 * מבצע read עם ולידציה + ניסיונות חוזרים. אם המתקשר לא נותן קלט תקין אחרי maxAttempts,
 * הפונקציה מנתקת את השיחה בעצמה (id_list_message זורק שגיאת יציאה פנימית של הספרייה, וזו התנהגות מכוונת).
 * prompt/invalidMessage/noInputMessage הן הודעות קובץ (ראו prompts.ts) - נמסרות מבחוץ כי כל שלוחה מחזיקה קבצים משלה.
 */
async function readValidated<T>(
  call: Call,
  prompt: Msg,
  parse: (raw: string) => T | null,
  invalidMessage: Msg,
  digits: number,
  noInputMessage: Msg,
  maxAttempts = 3
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const messages = attempt === 0 ? [prompt] : [invalidMessage, prompt];
    const raw = await call.read(messages, "tap", {
      max_digits: digits,
      min_digits: digits,
      sec_wait: 12,
    });
    const parsed = parse(raw);
    if (parsed !== null) return parsed;
  }
  call.id_list_message([noInputMessage]);
  throw new Error("unreachable");
}

function parseDdMm(raw: string): { day: number; month: number } | null {
  if (!/^\d{4}$/.test(raw)) return null;
  const day = Number(raw.slice(0, 2));
  const month = Number(raw.slice(2, 4));
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return { day, month };
}

function parseHhMm(raw: string): { hour: number; minute: number } | null {
  if (!/^\d{4}$/.test(raw)) return null;
  const hour = Number(raw.slice(0, 2));
  const minute = Number(raw.slice(2, 4));
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** בונה תאריך יעד מיום/חודש, גולש לשנה הבאה אם התאריך בשנה הנוכחית כבר עבר */
function resolveTargetDate(day: number, month: number): Date {
  const now = new Date();
  let year = now.getFullYear();
  let candidate = new Date(year, month - 1, day);
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (candidate < todayMidnight) {
    year += 1;
    candidate = new Date(year, month - 1, day);
  }
  return candidate;
}

function parsePin(raw: string): string | null {
  return /^\d{4}$/.test(raw) ? raw : null;
}

/**
 * שלוחות יעד ל-go_to_folder, לפי מבנה השלוחות שהוגדר בפאנל ימות המשיח.
 * נתיבים מוחלטים (מתחילים ב-/) כדי שהניווט יעבוד מכל עומק בעץ השלוחות.
 */
const MEMBERS_EXTENSION = "/9/1";
const NOT_REGISTERED_EXTENSION = "/9/2";
const EXPLANATION_EXTENSION = "/9/3";

/** מבקש מהמתקשר שם מלא באמצעות זיהוי דיבור, עם ניסיונות חוזרים */
async function readSpokenName(call: Call): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt = notRegisteredFile(
      attempt === 0 ? NOT_REGISTERED_FILES.ASK_NAME : NOT_REGISTERED_FILES.ASK_NAME_RETRY
    );
    const raw = await call.read([prompt], "stt");
    const name = raw?.trim();
    if (name && name.length >= 2 && !/^\d+$/.test(name)) return name;
  }
  call.id_list_message([notRegisteredFile(NOT_REGISTERED_FILES.NAME_FAILURE)]);
  throw new Error("unreachable");
}

/** מבקש קוד סודי בן 4 ספרות פעמיים ומוודא שהם תואמים, עם ניסיונות חוזרים */
async function readNewPin(call: Call): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const pin = await readValidated(
      call,
      notRegisteredFile(NOT_REGISTERED_FILES.ASK_PIN),
      parsePin,
      notRegisteredFile(NOT_REGISTERED_FILES.INVALID_PIN),
      4,
      notRegisteredFile(NOT_REGISTERED_FILES.NO_INPUT)
    );
    const confirmPin = await readValidated(
      call,
      notRegisteredFile(NOT_REGISTERED_FILES.CONFIRM_PIN),
      parsePin,
      notRegisteredFile(NOT_REGISTERED_FILES.INVALID_PIN),
      4,
      notRegisteredFile(NOT_REGISTERED_FILES.NO_INPUT)
    );
    if (pin === confirmPin) return pin;
  }
  call.id_list_message([notRegisteredFile(NOT_REGISTERED_FILES.PIN_MISMATCH)]);
  throw new Error("unreachable");
}

/**
 * קולט שם + קוד סודי ויוצר משתמש חדש (בסטטוס PENDING - ממתין לאישור מנהל, כברירת המחדל בסכימה).
 * מניח שהמתקשר כבר ביקש להירשם (הכוונה נעשית לפני הקריאה לכאן).
 * מודיע למתקשר שההרשמה ממתינה לאישור ומנתק - לא ממשיכים ישירות לקביעת תור.
 */
async function performRegistration(call: Call, phone: string) {
  const name = await readSpokenName(call);
  const pin = await readNewPin(call);
  // הקוד הטלפוני נשמר רק ב-ivrPinHash. passwordHash (שדה חובה) מקבל hash של סיסמה אקראית שאיש אינו מכיר, כך שהקוד
  // הטלפוני לעולם אינו סיסמת אתר, גם אם בעתיד יתווסף אימייל לחשבון
  const ivrPinHash = await hashPassword(pin);
  const passwordHash = await unusablePasswordHash();

  try {
    await prisma.user.create({ data: { name, phone, passwordHash, ivrPinHash, ivrPinUpdatedAt: new Date() } });
  } catch {
    return call.id_list_message([notRegisteredFile(NOT_REGISTERED_FILES.REGISTRATION_ERROR)]);
  }
  return call.id_list_message([notRegisteredFile(NOT_REGISTERED_FILES.REGISTRATION_PENDING)]);
}

async function runBookingDialog(call: Call, user: { id: string; name: string }) {
  // השם נקרא בהקראת TTS אחת רציפה עם "שלום" (ולא כקטע קול נפרד בין שני קבצים מוקלטים) - כך הוא נשמע טבעי ולא מובלע
  const roomDigit = await call.read(
    [text(`שלום ${user.name}`), bookingFile(BOOKING_FILES.ROOM_MENU)],
    "tap",
    { max_digits: 1, min_digits: 1, digits_allowed: [1, 2, 3, 4], sec_wait: 10 }
  );
  const roomKey = ROOM_DIGIT_MAP[roomDigit];

  const dateDigit = await call.read([bookingFile(BOOKING_FILES.DATE_MENU)], "tap", {
    max_digits: 1,
    min_digits: 1,
    digits_allowed: [1, 2, 3, 4],
    sec_wait: 10,
  });

  let targetDate: Date;
  if (dateDigit === "4") {
    const { day, month } = await readValidated(
      call,
      bookingFile(BOOKING_FILES.CUSTOM_DATE_PROMPT),
      parseDdMm,
      bookingFile(BOOKING_FILES.INVALID_DATE),
      4,
      bookingFile(BOOKING_FILES.NO_INPUT)
    );
    targetDate = resolveTargetDate(day, month);
  } else {
    const now = new Date();
    const offset = { "1": 0, "2": 1, "3": 2 }[dateDigit] ?? 0;
    targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  }

  const { hour, minute } = await readValidated(
    call,
    bookingFile(BOOKING_FILES.TIME_PROMPT),
    parseHhMm,
    bookingFile(BOOKING_FILES.INVALID_TIME),
    4,
    bookingFile(BOOKING_FILES.NO_INPUT)
  );

  const durationDigit = await call.read([bookingFile(BOOKING_FILES.DURATION_MENU)], "tap", {
    max_digits: 1,
    min_digits: 1,
    digits_allowed: [1, 2, 3, 4, 5, 6, 7],
    sec_wait: 10,
  });
  const durationMinutes = DURATION_DIGIT_MAP[durationDigit];

  const startTime = new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate(),
    hour,
    minute
  );
  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);

  // שער תשלום בטלפון (סגור כברירת מחדל): כשהוא פתוח וקיים ספק תשלום תקף, ההזמנה עוברת החזקה + תשלום מאומת בקוד.
  // כשהוא סגור, ממשיכים בדיוק במסלול הקיים למטה, ללא שינוי.
  if (isIvrPaymentsEnabled() && getRuntimeProvider()) {
    return runPaidBooking(call, user, { roomKey, startTime, endTime });
  }

  // הודעת אישור זו נכשלה שוב ושוב כשהורכבה משרשור ארוך של 12 קטעי קול נפרדים (קבצים+טקסט מתחלפים).
  // חוזרים לתבנית היחידה שהוכחה כעובדת בפועל בקו האמיתי: משפט TTS אחד + קובץ מוקלט אחד (בדיוק כמו הברכה).
  const roomLabel = ROOM_LABELS[roomKey];
  const durationLabel = DURATION_OPTIONS.find((o) => o.minutes === durationMinutes)?.label ?? "";
  const confirmDigit = await call.read(
    [
      text(
        `נקבע תור ל${roomLabel}, בתאריך ${startTime.getDate()} ל${startTime.getMonth() + 1}, בשעה ${hour} ${minute}, למשך ${durationLabel}`
      ),
      bookingFile(BOOKING_FILES.CONFIRM_SUFFIX),
    ],
    "tap",
    { max_digits: 1, min_digits: 1, digits_allowed: [1, 2], sec_wait: 10 }
  );

  if (confirmDigit !== "1") {
    return call.id_list_message([bookingFile(BOOKING_FILES.CANCELLED)]);
  }

  // חשוב: call.id_list_message זורק שגיאת יציאה פנימית בכוונה (ראו readValidated למעלה) -
  // הוא לא יכול לשבת בתוך אותו try שתופס שגיאות אמיתיות מ-createAppointment, אחרת ה-catch
  // "יתפוס" את היציאה הזו בטעות וישלח תגובה שנייה וסותרת (בפועל נשמע כ"שגיאה" מיד אחרי הצלחה)
  try {
    await createAppointment({
      userId: user.id,
      roomKey,
      startTime,
      endTime,
      source: "IVR",
    });
  } catch (err) {
    const message = err instanceof BookingError ? err.message : "אירעה שגיאה בקביעת התור, נסו שוב מאוחר יותר";
    return call.id_list_message([text(message)]);
  }
  return call.id_list_message([bookingFile(BOOKING_FILES.SUCCESS)]);
}

/** הודעות שאין להן קובץ מוקלט בפאנל (מספר חסוי, תקלה) — נשארות טקסט עד שיוקלטו קבצים ייעודיים */
const PRIVATE_NUMBER_TEXT = "לא ניתן לזהות את מספר הטלפון שממנו התקשרתם. אנא התקשרו שוב ממספר גלוי. תודה ולהתראות";
const SYSTEM_FAULT_TEXT = "אירעה תקלה זמנית במערכת. אנא נסו שוב מאוחר יותר. תודה ולהתראות";

/** זיהוי המתקשר — החיפוש היחיד ב-IVR. בוחר רק id/name/status, לעולם לא את passwordHash */
function identifyCurrentCaller(call: Call) {
  return identifyCaller(call.phone, (last9) =>
    prisma.user.findMany({
      where: { phone: { endsWith: last9 } },
      select: { id: true, name: true, status: true },
      take: 2,
    })
  );
}

/** מסיים את השיחה בהודעה מתאימה למצבי הזיהוי שאינם מובילים לשלוחה: חסוי / תקלה / ממתין / חסום */
function endCallForIdentity(call: Call, identity: Extract<CallerIdentity, { kind: "PRIVATE" | "ERROR" | "PENDING" | "BLOCKED" }>) {
  switch (identity.kind) {
    case "PRIVATE":
      return call.id_list_message([text(PRIVATE_NUMBER_TEXT)]);
    case "ERROR":
      return call.id_list_message([text(SYSTEM_FAULT_TEXT)]);
    case "PENDING":
      return call.id_list_message([bookingFile(BOOKING_FILES.PENDING_APPROVAL)]);
    case "BLOCKED":
      return call.id_list_message([bookingFile(BOOKING_FILES.BLOCKED)]);
  }
}

/**
 * שלוחת הבדיקה — הכניסה הראשונית לשיחה. מזהה את המתקשר פעם אחת ומנתבת:
 * APPROVED -> 9/1, לא רשום -> 9/2, ממתין/חסום/חסוי/תקלה -> הודעה וסיום (בלי ניתוב).
 */
export async function handleCheckCall(call: Call) {
  const identity = await identifyCurrentCaller(call);
  console.log(`[ivr] caller identity=${identity.kind} callId=${call.callId}`);
  switch (identity.kind) {
    case "APPROVED":
      return call.go_to_folder(MEMBERS_EXTENSION);
    case "NOT_FOUND":
      return call.go_to_folder(NOT_REGISTERED_EXTENSION);
    default:
      return endCallForIdentity(call, identity);
  }
}

/**
 * שלוחה 9/1 — "מחוברים". מזהה את המתקשר מחדש בכל כניסה (גם כניסה ישירה, בלי לסמוך על שלוחת הבדיקה),
 * ומריצה את שיחת קביעת התור רק למשתמש APPROVED. כל מצב אחר מקבל הודעה/ניתוב מתאים.
 */
export async function handleMembersCall(call: Call) {
  const identity = await identifyCurrentCaller(call);
  switch (identity.kind) {
    case "APPROVED":
      return runBookingDialog(call, identity.user);
    case "NOT_FOUND":
      return call.go_to_folder(NOT_REGISTERED_EXTENSION);
    default:
      return endCallForIdentity(call, identity);
  }
}

/**
 * שלוחה 9/2 — מספר לא רשום: הרשמה / הסבר על המערכת (שלוחה 9/3) / ניתוק.
 * גם כאן מזהים מחדש בכניסה: רשום מאושר מנותב ל-9/1, וחסוי/ממתין/חסום/תקלה לא מגיעים לתפריט ההרשמה.
 */
export async function handleNotRegisteredCall(call: Call) {
  const identity = await identifyCurrentCaller(call);
  if (identity.kind === "APPROVED") return call.go_to_folder(MEMBERS_EXTENSION);
  if (identity.kind !== "NOT_FOUND") return endCallForIdentity(call, identity);

  const choice = await call.read([notRegisteredFile(NOT_REGISTERED_FILES.MAIN_MENU)], "tap", {
    max_digits: 1,
    min_digits: 1,
    digits_allowed: [1, 2, 3],
    sec_wait: 10,
  });

  if (choice === "2") return call.go_to_folder(EXPLANATION_EXTENSION);
  if (choice !== "1") return call.hangup();

  // performRegistration מסיימת את השיחה בעצמה (הודעת המתנה לאישור, או שגיאה) - לא ממשיכים לקביעת תור.
  // נשמר המספר המנורמל והמאומת מהזיהוי, לא call.phone הגולמי
  return performRegistration(call, identity.phone);
}

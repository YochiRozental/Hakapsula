import nodemailer from "nodemailer";

/**
 * הודעה שנשלחת למשתמש כשהחשבון שלו עובר לסטטוס "מאושר" (מהרשמה ראשונית, או ביטול חסימה).
 * משתמש שנרשם באתר (יש לו אימייל) מקבל מייל; משתמש שנרשם דרך ה-IVR (רק טלפון, בלי אימייל) מקבל שיחת טלפון.
 * כשל בשליחה לא אמור להפיל את פעולת האישור באדמין - קוראים לפונקציה הזו מתוך try/catch שם.
 */
export async function sendApprovalNotification(user: {
  name: string;
  email: string | null;
  phone: string | null;
}) {
  if (user.email) {
    await sendApprovalEmail(user.email, user.name);
  } else if (user.phone) {
    await sendApprovalCallViaYemot(user.phone, user.name);
  }
}

/**
 * שולח מייל אישור דרך שרת SMTP. יש להגדיר את משתני הסביבה הבאים ב-.env:
 * SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM ("כתובת השולח, לדוגמה "קליניקות <no-reply@example.com>").
 * ללא הגדרת SMTP_HOST הפונקציה רק רושמת אזהרה ל-console ולא שולחת בפועל (כדי לא לשבור פיתוח מקומי).
 */
async function sendApprovalEmail(email: string, name: string) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
    console.warn(
      `[notifications] SMTP אינו מוגדר (SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM) - לא נשלח מייל אישור ל-${email}`,
    );
    return;
  }

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const text = `שלום ${name},\n\nהחשבון שלך במערכת קביעת התורים אושר על ידי מנהל המערכת.\nניתן כעת להתחבר ולקבוע תורים בקליניקות.\n\nאם היית מחובר/ת בעת האישור, יש להתנתק ולהתחבר מחדש כדי שהאישור ייכנס לתוקף.`;

  await transport.sendMail({
    from: SMTP_FROM,
    to: email,
    subject: "החשבון שלך אושר - ניתן לקבוע תורים",
    text,
    html: `<div dir="rtl" style="text-align: right; font-family: Arial, sans-serif;">${text
      .split("\n")
      .map((line) => (line ? `<p style="margin: 0 0 12px;">${line}</p>` : ""))
      .join("")}</div>`,
  });
}

/**
 * מפעיל שיחת טלפון יוצאת דרך ה-API של ימות המשיח, למשתמשים שנרשמו דרך הטלפון (אין להם אימייל).
 *
 * ⚠️ דורש השלמת הגדרות מצד המשתמש לפני שזה יעבוד בפועל:
 * 1. להקליט הודעת "אושרת/החשבון אושר" בפאנל ימות המשיח (באותו אופן שבו הוקלטו קבצי ה-IVR הקיימים,
 *    ראו src/ivr/prompts.ts), ולהגדיר אותה כשלוחת יעד לשיחה היוצאת.
 * 2. ליצור "תבנית הפצה"/קמפיין בפאנל ימות המשיח שמפנה שיחות יוצאות לאותה שלוחה, ולוודא את מזהה
 *    התבנית (templateId).
 * 3. להנפיק טוקן API (קבוע, מהגדרות פיירוול בפאנל, או זמני דרך פקודת Login) ולהגדיר אותו כ-YEMOT_API_TOKEN.
 * 4. להגדיר את מזהה התבנית כ-YEMOT_APPROVAL_TEMPLATE_ID.
 * מסמכי ה-API המלאים: https://f2.freeivr.co.il (פורום "הגדרות מתקדמות - API").
 * ללא הגדרת המשתנים האלו הפונקציה רק רושמת אזהרה ל-console ולא מבצעת שיחה בפועל.
 */
async function sendApprovalCallViaYemot(phone: string, name: string) {
  const { YEMOT_API_TOKEN, YEMOT_APPROVAL_TEMPLATE_ID } = process.env;

  if (!YEMOT_API_TOKEN || !YEMOT_APPROVAL_TEMPLATE_ID) {
    console.warn(
      `[notifications] YEMOT_API_TOKEN/YEMOT_APPROVAL_TEMPLATE_ID אינם מוגדרים - לא בוצעה שיחת אישור ל-${phone} (${name})`,
    );
    return;
  }

  const response = await fetch(
    "https://www.call2all.co.il/ym/api/RunCampaign",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: YEMOT_API_TOKEN,
        templateId: YEMOT_APPROVAL_TEMPLATE_ID,
        phone,
      }),
    },
  );

  const data = await response.json().catch(() => null);
  if (!response.ok || data?.responseStatus !== "OK") {
    throw new Error(`Yemot RunCampaign failed: ${JSON.stringify(data)}`);
  }
}

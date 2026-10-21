import { after, NextResponse } from "next/server";
import { z } from "zod";
import { sendContactMessage } from "@/lib/notifications";

const contactSchema = z
  .object({
    name: z.string().trim().max(80, "השם ארוך מדי").optional(),
    email: z.union([z.literal(""), z.string().trim().email("כתובת אימייל לא תקינה").max(120)]).optional(),
    phone: z.string().trim().max(30, "מספר טלפון ארוך מדי").optional(),
    message: z.string().trim().max(2000, "ההודעה ארוכה מדי").optional(),
    // שדה פיתיון נגד בוטים - משתמש אמיתי לא ימלא אותו
    website: z.string().optional(),
  })
  .refine((d) => d.email || d.phone, { message: "יש להזין טלפון או אימייל", path: ["phone"] });

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = contactSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים לא תקינים" }, { status: 400 });
  }

  const { website, ...data } = parsed.data;
  if (website) return NextResponse.json({ ok: true });

  // המייל נשלח אחרי שהתשובה חזרה ללקוח, כדי שלא יחכה לחיבור ה-SMTP (איטי)
  after(async () => {
    try {
      await sendContactMessage({
        name: data.name || undefined,
        email: data.email || undefined,
        phone: data.phone || undefined,
        message: data.message || undefined,
      });
    } catch (error) {
      console.error("[contact] failed to send message:", error);
    }
  });

  return NextResponse.json({ ok: true });
}

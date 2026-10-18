import { NextResponse } from "next/server";
import { z } from "zod";
import { sendContactMessage } from "@/lib/notifications";

const contactSchema = z.object({
  name: z.string().trim().min(2, "יש להזין שם").max(80, "השם ארוך מדי"),
  email: z.string().trim().email("כתובת אימייל לא תקינה").max(120),
  phone: z.string().trim().max(30, "מספר טלפון ארוך מדי").optional(),
  message: z.string().trim().min(5, "יש לכתוב הודעה").max(2000, "ההודעה ארוכה מדי"),
  // שדה פיתיון נגד בוטים - משתמש אמיתי לא ימלא אותו
  website: z.string().optional(),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = contactSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים לא תקינים" }, { status: 400 });
  }

  const { website, ...data } = parsed.data;
  if (website) return NextResponse.json({ ok: true });

  try {
    await sendContactMessage({ ...data, phone: data.phone || undefined });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[contact] failed to send message:", error);
    return NextResponse.json({ error: "שליחת ההודעה נכשלה, נסו שוב מאוחר יותר" }, { status: 500 });
  }
}

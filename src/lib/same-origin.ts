/**
 * הגנת CSRF לפעולות רגישות שמבוססות Session בעוגייה. בנוסף ל-SameSite של עוגיית Auth.js ולדרישת Content-Type מסוג JSON
 * (שטופס חוצה-אתרים אינו יכול לשלוח), בודקים שהבקשה הגיעה מאותו מקור: Sec-Fetch-Site אם קיים, אחרת Origin מול המארח.
 * בקשה בלי אף אחד מהם (לקוח שאינו דפדפן) נדחית: הנתיבים האלה משמשים רק את ממשק האתר.
 */
export function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin";

  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function isJsonRequest(request: Request): boolean {
  return (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}

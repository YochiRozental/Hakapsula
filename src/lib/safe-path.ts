/** מאפשר רק נתיב פנימי באתר (מונע הפניה לאתר חיצוני דרך callbackUrl / next) */
export function safeInternalPath(value: string | null | undefined, fallback: string): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

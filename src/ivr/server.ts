import "dotenv/config";
import { createIvrApp } from "@/ivr/app";
import { handleCheckCall, handleMembersCall, handleNotRegisteredCall } from "@/ivr/booking-flow";

const secret = process.env.IVR_SHARED_SECRET;
if (!secret) {
  throw new Error(
    "IVR_SHARED_SECRET לא מוגדר ב-.env. יש להגדיר מחרוזת סודית אקראית כדי שרק ימות המשיח יוכל לקרוא לנתיב הזה."
  );
}

const app = createIvrApp({
  secret,
  handlers: { check: handleCheckCall, members: handleMembersCall, notRegistered: handleNotRegisteredCall },
});

const port =
  Number(process.env.PORT) ||
  Number(process.env.IVR_PORT) ||
  3001;
app.listen(port, () => {
  console.log(`[ivr] Yemot IVR server listening on port ${port}`);
  // הנתיבים כוללים את IVR_SHARED_SECRET, ולכן לא מודפסים ללוג. מציגים רק את התבנית
  console.log(`[ivr] שלוחת הבדיקה (הכניסה לשיחה) -> http://<your-domain>:${port}/check-<IVR_SHARED_SECRET>`);
  console.log(`[ivr] שלוחה 9/1, "מחוברים" -> http://<your-domain>:${port}/booking-<IVR_SHARED_SECRET>`);
  console.log(`[ivr] שלוחה 9/2, "לא רשום" -> http://<your-domain>:${port}/not-registered-<IVR_SHARED_SECRET>`);
  console.log(`[ivr] שלוחה 9/3, "הסבר על המערכת" -> קיימת כבר בפאנל, אין צורך ב-URL`);
  console.log(`[ivr] הנתיבים מקבלים גם GET וגם POST (api_url_post=yes), באותה לוגיקה`);
});

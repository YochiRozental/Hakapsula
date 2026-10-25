import "dotenv/config";
import express from "express";
import { YemotRouter } from "yemot-router2";
import { handleCheckCall, handleMembersCall, handleNotRegisteredCall } from "@/ivr/booking-flow";

const app = express();

const router = YemotRouter({
  printLog: true,
  defaults: {
    removeInvalidChars: true,
  },
  uncaughtErrorHandler: (error, call) => {
    console.error(`[ivr] uncaught error for call ${call.callId}:`, error);
    // נשאר טקסט (ולא קובץ מוקלט) בכוונה: זו נפילת חירום גלובלית שיכולה לקרות בכל שלוחה,
    // ואין שלוחת-בית אחת שבה אפשר להקליט לה קובץ.
    return call.id_list_message([
      { type: "text", data: "אירעה שגיאה במערכת, אנא נסו שוב מאוחר יותר. תודה ולהתראות" },
    ]);
  },
});

router.events.on("new_call", (call) => {
  // בכוונה בלי מספר הטלפון של המתקשר בלוג
  console.log(`[ivr] new call ${call.callId} extension=${call.extension}`);
});
router.events.on("call_hangup", (call) => {
  console.log(`[ivr] call ${call.callId} hung up`);
});

const secret = process.env.IVR_SHARED_SECRET;
if (!secret) {
  throw new Error(
    "IVR_SHARED_SECRET לא מוגדר ב-.env. יש להגדיר מחרוזת סודית אקראית כדי שרק ימות המשיח יוכל לקרוא לנתיב הזה."
  );
}
const checkPath = `/check-${secret}`;
const membersPath = `/booking-${secret}`;
const notRegisteredPath = `/not-registered-${secret}`;

router.get(checkPath, handleCheckCall);
router.get(membersPath, handleMembersCall);
router.get(notRegisteredPath, handleNotRegisteredCall);

app.use(express.urlencoded({ extended: true }));
app.use(router.asExpressRouter);

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
});

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Call } from "yemot-router2";
import { createIvrApp } from "@/ivr/app";
import { captureConsole, nextValName, send, startApp, type Method, type RunningApp } from "@/ivr/test-harness";

// בדיקות פרוטוקול ה-IVR (GET ו-POST) מול בקשות HTTP אמיתיות לנתב האמיתי של ימות המשיח, עם מטפלי שיחה מדומים
// (בלי מסד נתונים). בדיקות הזרימה האמיתית מול המסד נמצאות ב-booking-flow.http.test.ts.

const SECRET = "test-secret-abc123";
const PHONE = "0501234567";
const PIN = "4321";

const runs = { check: 0, members: 0, notRegistered: 0 };
let app: RunningApp;

/** זרימה מדומה בצורת השלוחה האמיתית: שני read ואז הודעת סיום המשקפת מה התקבל */
async function members(call: Call) {
  runs.members++;
  const room = await call.read([{ type: "text", data: "שלום בחרו חדר" }], "tap", { max_digits: 1, min_digits: 1, sec_wait: 10 });
  const secret = await call.read([{ type: "text", data: "הקישו קוד" }], "tap", { max_digits: 4, min_digits: 4, sec_wait: 10 });
  if (secret === "boom") throw new Error(`failure for phone ${PHONE} pin ${PIN}`);
  return call.id_list_message([{ type: "text", data: `room ${room} codelen ${secret.length} extension ${call.extension}` }]);
}

before(async () => {
  const handlers = {
    check: async (call: Call) => {
      runs.check++;
      return call.go_to_folder("/9/1");
    },
    members,
    notRegistered: async (call: Call) => {
      runs.notRegistered++;
      const choice = await call.read([{ type: "text", data: "תפריט" }], "tap", { max_digits: 1, min_digits: 1, sec_wait: 10 });
      return choice === "2" ? call.go_to_folder("/9/3") : call.hangup();
    },
  };
  app = await startApp(createIvrApp({ secret: SECRET, handlers }));
});

after(() => app.close());

let callCounter = 0;
const newCallId = () => `call-${Date.now()}-${callCounter++}`;
const base = (callId: string, ext = "9/1"): [string, string][] => [
  ["ApiPhone", PHONE],
  ["ApiDID", "035551234"],
  ["ApiExtension", ext],
  ["ApiCallId", callId],
];
const path = (name: string) => `/${name}-${SECRET}`;

/** מריץ שיחה שלמה בשיטה נתונה ומחזיר את כל התשובות לפי הסדר */
async function runCall(method: Method, callId = newCallId(), pin = PIN) {
  const replies: string[] = [];
  const r1 = await send(app.base, path("booking"), method, base(callId));
  replies.push(r1.text);
  const v1 = nextValName(r1.text)!;
  const r2 = await send(app.base, path("booking"), method, [...base(callId), [v1, "5"]]);
  replies.push(r2.text);
  const v2 = nextValName(r2.text)!;
  const r3 = await send(app.base, path("booking"), method, [...base(callId), [v1, "5"], [v2, pin]]);
  replies.push(r3.text);
  return replies;
}

describe("פרוטוקול IVR: GET ו-POST", () => {
  test("GET ממשיך לפעול: שיחה שלמה עם הקשות בפרמטרי query", async () => {
    const r = await runCall("GET");
    assert.match(r[0], /^read=/);
    assert.equal(nextValName(r[0]), "val_1");
    assert.equal(nextValName(r[1]), "val_2");
    assert.match(r[2], /room 5 codelen 4 extension 9\/1/);
  });

  test("POST (urlencoded בגוף) נותן תשובות זהות ל-GET בכל שלב", async () => {
    const viaGet = await runCall("GET");
    const viaPost = await runCall("POST");
    assert.deepEqual(viaPost, viaGet);
  });

  test("הקוד שהוקש ב-POST נקרא בגוף ולא מופיע בכתובת", async () => {
    const callId = newCallId();
    const r1 = await send(app.base, path("booking"), "POST", base(callId));
    const v1 = nextValName(r1.text)!;
    const r2 = await send(app.base, path("booking"), "POST", [...base(callId), [v1, "5"]]);
    const v2 = nextValName(r2.text)!;
    // הקוד נשלח רק בגוף; ה-URL נקי מפרמטרים
    const r3 = await send(app.base, path("booking"), "POST", [...base(callId), [v1, "5"], [v2, PIN]]);
    assert.match(r3.text, /codelen 4/);
  });

  test("שלושת המסלולים (בדיקה, מחוברים, לא-רשום) עובדים בשתי השיטות", async () => {
    for (const method of ["GET", "POST"] as Method[]) {
      const check = await send(app.base, path("check"), method, base(newCallId(), "9"));
      assert.equal(check.text, "go_to_folder=/9/1", method);
      const callId = newCallId();
      const menu = await send(app.base, path("not-registered"), method, base(callId, "9/2"));
      assert.match(menu.text, /^read=/);
      const explain = await send(app.base, path("not-registered"), method, [...base(callId, "9/2"), [nextValName(menu.text)!, "2"]]);
      assert.equal(explain.text, "go_to_folder=/9/3", method);
      const c2 = newCallId();
      const m2 = await send(app.base, path("not-registered"), method, base(c2, "9/2"));
      const bye = await send(app.base, path("not-registered"), method, [...base(c2, "9/2"), [nextValName(m2.text)!, "3"]]);
      assert.equal(bye.text, "go_to_folder=hangup", method);
    }
  });

  test("חזרה/כניסה מחדש באמצע שיחה (אותו callId בלי הקשה) זהה בשתי השיטות ואינה פותחת שיחה נוספת", async () => {
    const transcripts: Record<string, string[]> = {};
    for (const method of ["GET", "POST"] as Method[]) {
      const callId = newCallId();
      const before = runs.members;
      const first = await send(app.base, path("booking"), method, base(callId));
      const again = await send(app.base, path("booking"), method, base(callId)); // כניסה חוזרת אחרי כוכבית
      const againAgain = await send(app.base, path("booking"), method, base(callId));
      assert.equal(runs.members, before + 1, `${method}: המטפל רץ פעם אחת בלבד`);
      assert.match(again.text, /^read=/, `${method}: נשלחת מחדש בקשת קלט`);
      transcripts[method] = [first.text, again.text, againAgain.text];
    }
    assert.deepEqual(transcripts.POST, transcripts.GET);
  });

  test("ניתוק באמצע שיחה (hangup=yes) לא קורס ולא משאיר מצב, בשתי השיטות", async () => {
    for (const method of ["GET", "POST"] as Method[]) {
      const callId = newCallId();
      await send(app.base, path("booking"), method, base(callId));
      const hang = await send(app.base, path("booking"), method, [...base(callId), ["hangup", "yes"]]);
      assert.equal(hang.status, 200);
      const fresh = await runCall(method, callId); // אותו מזהה שיחה אחרי ניתוק מתחיל מחדש
      assert.match(fresh[2], /room 5/);
    }
  });
});

describe("הקשחת POST", () => {
  test("פרמטרי חובה חסרים: לא מפעיל מטפל, בשתי השיטות", async () => {
    for (const method of ["GET", "POST"] as Method[]) {
      const before = { ...runs };
      const r = await send(app.base, path("booking"), method, [["ApiPhone", PHONE]]);
      assert.equal(r.status, 200);
      assert.match(r.text, /not valid yemot request/);
      assert.deepEqual(runs, before, method);
    }
  });

  test("ערכי identity ב-query של POST אינם מחליפים גוף חסר", async () => {
    const before = { ...runs };
    const r = await send(app.base, path("booking"), "POST", [], { extraQuery: base(newCallId()) });
    assert.match(r.text, /not valid yemot request/);
    assert.deepEqual(runs, before);
  });

  test("ערך שסותר בין query לגוף נדחה (400) ואינו מפעיל מטפל", async () => {
    const before = { ...runs };
    const callId = newCallId();
    const r = await send(app.base, path("booking"), "POST", base(callId), { extraQuery: [["ApiPhone", "0529999999"]] });
    assert.equal(r.status, 400);
    assert.deepEqual(runs, before);
  });

  test("ערך זהה ב-query ובגוף אינו עמום ומתקבל", async () => {
    const callId = newCallId();
    const r = await send(app.base, path("booking"), "POST", base(callId), { extraQuery: [["ApiPhone", PHONE]] });
    assert.equal(r.status, 200);
    assert.match(r.text, /^read=/);
  });

  test("ערך הקשה סותר בשיחה פעילה לא משנה את ההתקדמות", async () => {
    const callId = newCallId();
    const r1 = await send(app.base, path("booking"), "POST", base(callId));
    const v1 = nextValName(r1.text)!;
    const bad = await send(app.base, path("booking"), "POST", [...base(callId), [v1, "5"]], { extraQuery: [[v1, "6"]] });
    assert.equal(bad.status, 400);
    const ok = await send(app.base, path("booking"), "POST", [...base(callId), [v1, "5"]]);
    assert.equal(nextValName(ok.text), "val_2", "השיחה המשיכה נקי מהקשה 5");
  });

  test("פרמטר כפול בגוף נדחה (הספרייה הייתה בוחרת בשקט את האחרון)", async () => {
    const before = { ...runs };
    const callId = newCallId();
    const r = await send(app.base, path("booking"), "POST", [...base(callId), ["ApiPhone", "0529999999"]]);
    assert.equal(r.status, 400);
    assert.deepEqual(runs, before);
  });

  test("פורמט גוף לא נתמך (JSON, טקסט) נדחה 415", async () => {
    const callId = newCallId();
    for (const contentType of ["application/json", "text/plain", "multipart/form-data; boundary=x"]) {
      const r = await send(app.base, path("booking"), "POST", [], {
        contentType,
        rawBody: JSON.stringify(Object.fromEntries(base(callId))),
      });
      assert.equal(r.status, 415, contentType);
    }
  });

  test("גוף גדול מדי וגוף פגום נדחים בלי לקרוס, והשרת ממשיך לשרת", async () => {
    const huge = await send(app.base, path("booking"), "POST", [], { rawBody: "a=" + "x".repeat(50_000) });
    assert.equal(huge.status, 413);
    const nested = await send(app.base, path("booking"), "POST", [], { rawBody: "a[b]=1&c[]=2&%E0%A4%A=3" });
    assert.ok([200, 400].includes(nested.status));
    const empty = await send(app.base, path("booking"), "POST", [], { rawBody: "" });
    assert.equal(empty.status, 200);
    assert.match(empty.text, /not valid yemot request/);
    assert.match((await runCall("POST"))[2], /room 5/);
  });

  test("נתיב שגוי, סוד שגוי, ושיטות אחרות מחזירים 404 בלי להפעיל מטפל", async () => {
    const before = { ...runs };
    for (const method of ["GET", "POST"] as Method[]) {
      assert.equal((await send(app.base, "/booking-wrong", method, base(newCallId()))).status, 404);
      assert.equal((await send(app.base, "/booking", method, base(newCallId()))).status, 404);
    }
    for (const m of ["PUT", "DELETE", "PATCH"]) {
      const res = await fetch(app.base + path("booking"), { method: m });
      assert.equal(res.status, 404, m);
    }
    assert.deepEqual(runs, before);
  });
});

describe("לוגים", () => {
  test("אין בלוגים קוד, מספר טלפון, גוף בקשה או הסוד בנתיב: גם בזרימה תקינה וגם בשגיאה", async () => {
    const { output } = await captureConsole(async () => {
      for (const method of ["GET", "POST"] as Method[]) {
        await runCall(method);
        // שגיאה לא צפויה במטפל, שהודעתה כוללת טלפון וקוד
        const callId = newCallId();
        const r1 = await send(app.base, path("booking"), method, base(callId));
        const v1 = nextValName(r1.text)!;
        const r2 = await send(app.base, path("booking"), method, [...base(callId), [v1, "5"]]);
        const v2 = nextValName(r2.text)!;
        await send(app.base, path("booking"), method, [...base(callId), [v1, "5"], [v2, "boom"]]);
      }
      await send(app.base, path("booking"), "POST", [], { rawBody: "x=" + "y".repeat(40_000) });
      await send(app.base, path("booking"), "POST", base(newCallId()), { extraQuery: [["ApiPhone", "0529999999"]] });
    });
    assert.ok(output.includes("[ivr] new call"), "לוג תפעולי של שיחה חדשה קיים");
    assert.ok(output.includes("uncaught error"), "שגיאה נרשמת (סוג בלבד)");
    for (const secretValue of [PHONE.slice(1), PIN, SECRET, "0529999999", "boom", "failure for phone"]) {
      assert.ok(!output.includes(secretValue), `הלוג לא אמור לכלול: ${secretValue}\n${output}`);
    }
  });
});

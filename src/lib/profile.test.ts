import { test } from "node:test";
import assert from "node:assert/strict";
import { getMissingBookingDetails, profileFieldSchemas, type BookingDetails } from "@/lib/profile";

const FULL_DETAILS: BookingDetails = {
  firstName: "דנה",
  lastName: "כהן",
  phone: "0501234567",
  idNumber: "000000018",
  gender: "MALE",
  cardLast4: "4242",
  cardExpiry: "12/40",
};

test("getMissingBookingDetails: משתמש בלי מגדר אינו יכול להזמין תור (גם דרך ה-API, שבודק פונקציה זו)", () => {
  assert.deepEqual(getMissingBookingDetails(FULL_DETAILS), []); // כל הפרטים קיימים — אין חסר
  assert.deepEqual(getMissingBookingDetails({ ...FULL_DETAILS, gender: null }), ["gender"]);
  // מגדר הוא לא השדה היחיד שנבדק, אבל הוא נבדק גם כשכל שאר הפרטים תקינים
  const onlyGenderMissing = getMissingBookingDetails({ ...FULL_DETAILS, gender: null });
  assert.equal(onlyGenderMissing.length, 1);
  assert.equal(onlyGenderMissing[0], "gender");
});

test("profileFieldSchemas.gender: מקבל רק זכר/נקבה — זה האימות שעמוד הפרופיל משתמש בו לשמירה", () => {
  assert.equal(profileFieldSchemas.gender.safeParse("MALE").success, true);
  assert.equal(profileFieldSchemas.gender.safeParse("FEMALE").success, true);
  assert.equal(profileFieldSchemas.gender.safeParse("OTHER").success, false);
  assert.equal(profileFieldSchemas.gender.safeParse(undefined).success, false); // חובה בעמוד הפרופיל (לא עטוף ב-optionalField)
  assert.equal(profileFieldSchemas.gender.safeParse("").success, false);
});

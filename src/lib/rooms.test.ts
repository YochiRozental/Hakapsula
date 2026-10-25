import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFLICTING_ROOM_KEYS, ROOM_KEYS, ROOM_LOCK_ZONE } from "@/lib/rooms";
import type { RoomKey } from "@/generated/prisma/client";

/** קבוצות חדרים שקשורות בהתנגשות (ישירה או דרך חדר אחר) — לפי חוקי ההתנגשות הקיימים */
function conflictGroups(): RoomKey[][] {
  const seen = new Set<RoomKey>();
  const groups: RoomKey[][] = [];
  for (const start of ROOM_KEYS) {
    if (seen.has(start)) continue;
    const group: RoomKey[] = [];
    const queue = [start];
    while (queue.length > 0) {
      const key = queue.pop()!;
      if (seen.has(key)) continue;
      seen.add(key);
      group.push(key);
      for (const other of ROOM_KEYS) {
        if (CONFLICTING_ROOM_KEYS[key].includes(other) || CONFLICTING_ROOM_KEYS[other].includes(key)) queue.push(other);
      }
    }
    groups.push(group);
  }
  return groups;
}

test("אזורי נעילה: מוגדרים לכל חדר", () => {
  assert.deepEqual(Object.keys(ROOM_LOCK_ZONE).sort(), [...ROOM_KEYS].sort());
});

test("אזורי נעילה: חדרים מתנגשים באותו אזור, וחדרים עצמאיים באזורים נפרדים", () => {
  const groups = conflictGroups();
  for (const group of groups) {
    assert.equal(new Set(group.map((k) => ROOM_LOCK_ZONE[k])).size, 1, `אזור אחד לקבוצה ${group.join(",")}`);
  }
  const zones = groups.map((g) => ROOM_LOCK_ZONE[g[0]]);
  assert.equal(new Set(zones).size, groups.length, "קבוצות שונות באזורים שונים");
});

test("אזורי נעילה: המיפוי הקבוע כפי שהוסכם", () => {
  assert.equal(ROOM_LOCK_ZONE.ROOM1, ROOM_LOCK_ZONE.ROOM2);
  assert.equal(ROOM_LOCK_ZONE.ROOM1, ROOM_LOCK_ZONE.ROOM1_2);
  const independent = [ROOM_LOCK_ZONE.ROOM3, ROOM_LOCK_ZONE.ROOM4, ROOM_LOCK_ZONE.WORKSHOP, ROOM_LOCK_ZONE.ROOM1];
  assert.equal(new Set(independent).size, 4);
});

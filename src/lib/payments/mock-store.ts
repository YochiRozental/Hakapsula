import type { Prisma, PrismaClient } from "@/generated/prisma/client";

/**
 * אחסון המצב של ספק ה-Mock ("הצד של הספק"). ספק אמיתי שומר מצב אצלו; ה-Mock מדמה זאת.
 * לשימוש באפליקציה יש PrismaMockStore (שורד הפעלה מחדש ובקשות נפרדות). InMemoryMockStore לבדיקות יחידה בלבד.
 */
export interface MockStore {
  get<T>(key: string): Promise<T | undefined>;
  /** יוצר רק אם המפתח לא קיים. מחזיר false אם כבר היה קיים (בטוח תחת בקשות מקבילות) */
  putIfAbsent<T>(key: string, value: T): Promise<boolean>;
  put<T>(key: string, value: T): Promise<void>;
}

export class InMemoryMockStore implements MockStore {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string) {
    return this.data.get(key) as T | undefined;
  }

  async putIfAbsent<T>(key: string, value: T) {
    if (this.data.has(key)) return false;
    this.data.set(key, value);
    return true;
  }

  async put<T>(key: string, value: T) {
    this.data.set(key, value);
  }
}

export class PrismaMockStore implements MockStore {
  constructor(private readonly db: PrismaClient) {}

  async get<T>(key: string) {
    const row = await this.db.mockProviderRecord.findUnique({ where: { key } });
    return row ? (row.data as T) : undefined;
  }

  async putIfAbsent<T>(key: string, value: T) {
    const { count } = await this.db.mockProviderRecord.createMany({
      data: [{ key, data: value as Prisma.InputJsonValue }],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async put<T>(key: string, value: T) {
    const data = value as Prisma.InputJsonValue;
    await this.db.mockProviderRecord.upsert({ where: { key }, create: { key, data }, update: { data } });
  }
}

import type { ReactNode } from "react";
import { ROOM_LABELS } from "@/lib/rooms";
import { EmptyState, Icon, SectionTitle } from "@/components/ui";
import type { AppointmentStatus, Gender, Role, RoomKey, UserStatus } from "@/generated/prisma/client";

export const STATUS_LABELS: Record<UserStatus, string> = {
  PENDING: "ממתין לאישור",
  APPROVED: "מאושר",
  BLOCKED: "חסום",
};

const GENDER_LABELS: Record<Gender, string> = { MALE: "זכר", FEMALE: "נקבה" };

const STATUS_CLASSES: Record<UserStatus, string> = {
  PENDING: "bg-gold-100 text-gold-600",
  APPROVED: "bg-brand-50 text-brand-700",
  BLOCKED: "bg-red-50 text-red-700",
};

export type UserCardData = {
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  idNumber: string | null;
  gender: Gender | null;
  cardLast4: string | null;
  cardExpiry: string | null;
  role: Role;
  status: UserStatus;
  createdAt: Date;
  appointments: {
    id: string;
    startTime: Date;
    endTime: Date;
    status: AppointmentStatus;
    notes: string | null;
    room: { key: RoomKey; name: string };
  }[];
};

const dateFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeZone: "Asia/Jerusalem" });
const timeFmt = new Intl.DateTimeFormat("he-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });

function Detail({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-stone-400 mb-1">{label}</dt>
      <dd className="text-sm font-semibold text-stone-800 break-words">{children || "—"}</dd>
    </div>
  );
}

/** כרטיס לקוח: פרטים אישיים, אשראי (4 ספרות אחרונות בלבד) והיסטוריית תורים */
export function UserCard({ user, now, actions }: { user: UserCardData; now: number; actions?: ReactNode }) {
  const confirmed = user.appointments.filter((a) => a.status === "CONFIRMED");
  const upcoming = confirmed.filter((a) => a.endTime.getTime() >= now).length;

  return (
    <div className="space-y-6">
      <div className="card p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="w-16 h-16 rounded-full bg-linear-to-b from-bronze-50 to-bronze-100 text-bronze-700 ring-1 ring-bronze-200 text-2xl font-bold flex items-center justify-center shrink-0">
              {user.name.trim().charAt(0)}
            </span>
            <div>
              <h2 className="font-display text-2xl font-bold text-stone-900">{user.name}</h2>
              <div className="flex flex-wrap gap-2 mt-2">
                <span className={`badge ${user.role === "ADMIN" ? "bg-brand-50 text-brand-700" : "bg-cream-100 text-stone-600"}`}>
                  {user.role === "ADMIN" ? "מנהל" : "לקוח"}
                </span>
                <span className={`badge ${STATUS_CLASSES[user.status]}`}>{STATUS_LABELS[user.status]}</span>
              </div>
            </div>
          </div>
          {actions}
        </div>

        <div className="hairline-bronze my-6" />

        <SectionTitle index="1">פרטים אישיים</SectionTitle>
        <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="שם פרטי">{user.firstName}</Detail>
          <Detail label="שם משפחה">{user.lastName}</Detail>
          <Detail label="מספר זהות">
            {user.idNumber && <span dir="ltr" className="tabular-nums">{user.idNumber}</span>}
          </Detail>
          <Detail label="מגדר">{user.gender && GENDER_LABELS[user.gender]}</Detail>
          <Detail label="אימייל">{user.email && <span dir="ltr">{user.email}</span>}</Detail>
          <Detail label="פלאפון">{user.phone && <span dir="ltr" className="tabular-nums">{user.phone}</span>}</Detail>
          <Detail label="תאריך הצטרפות">{dateFmt.format(user.createdAt)}</Detail>
        </dl>

        <div className="hairline-bronze my-6" />

        <SectionTitle index="2" hint="מספר הכרטיס המלא וה-CVV אינם נשמרים במערכת">
          אשראי
        </SectionTitle>
        <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="כרטיס">
            {user.cardLast4 && (
              <span dir="ltr" className="tabular-nums inline-flex items-center gap-2">
                <Icon name="card" className="w-4 h-4 text-stone-400" />
                •••• {user.cardLast4}
              </span>
            )}
          </Detail>
          <Detail label="תוקף">
            {user.cardExpiry && <span dir="ltr" className="tabular-nums">{user.cardExpiry}</span>}
          </Detail>
        </dl>
      </div>

      <div className="card p-6 sm:p-8">
        <SectionTitle
          index="3"
          aside={
            <span className="text-xs text-stone-500 tabular-nums">
              {confirmed.length} תורים מאושרים · {upcoming} קרובים
            </span>
          }
        >
          היסטוריית תורים
        </SectionTitle>
        {user.appointments.length === 0 ? (
          <EmptyState>אין תורים עדיין.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>תאריך</th>
                  <th>שעות</th>
                  <th>חדר</th>
                  <th>סטטוס</th>
                </tr>
              </thead>
              <tbody>
                {user.appointments.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap">{dateFmt.format(a.startTime)}</td>
                    <td className="tabular-nums whitespace-nowrap">
                      {timeFmt.format(a.startTime)} – {timeFmt.format(a.endTime)}
                    </td>
                    <td>{ROOM_LABELS[a.room.key] ?? a.room.name}</td>
                    <td>
                      <span className={`badge ${a.status === "CANCELLED" ? "bg-red-50 text-red-700" : "bg-brand-50 text-brand-700"}`}>
                        {a.status === "CANCELLED" ? "בוטל" : "מאושר"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

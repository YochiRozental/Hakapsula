import type { NextAuthConfig } from "next-auth";

/**
 * תצורה שאינה תלויה ב-Prisma/Node runtime, כדי שניתן יהיה להשתמש בה גם ב-Edge Middleware.
 * ה-provider עם גישה למסד הנתונים מוגדר רק ב-src/auth.ts (שרץ ב-Node runtime).
 */
export const authConfig: NextAuthConfig = {
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [],
  callbacks: {
    jwt: async ({ token, user }) => {
      if (user) {
        token.id = user.id as string;
        token.role = (user as { role: string }).role;
        token.status = (user as { status: "PENDING" | "APPROVED" | "BLOCKED" }).status;
        token.mustChangePassword = (user as { mustChangePassword?: boolean }).mustChangePassword ?? false;
      }
      return token;
    },
    session: async ({ session, token }) => {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as "CLIENT" | "ADMIN";
        session.user.status = token.status as "PENDING" | "APPROVED" | "BLOCKED";
        session.user.mustChangePassword = !!token.mustChangePassword;
      }
      return session;
    },
  },
};

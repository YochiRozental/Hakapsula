import type { Metadata } from "next";
import { Assistant, Frank_Ruhl_Libre } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Navbar } from "@/components/navbar";

const assistant = Assistant({
  variable: "--font-assistant",
  subsets: ["hebrew", "latin"],
});

const frankRuhl = Frank_Ruhl_Libre({
  variable: "--font-frank",
  subsets: ["hebrew", "latin"],
  weight: ["500", "700"],
});

export const metadata: Metadata = {
  title: "מערכת ניהול קליניקות | קביעת תורים",
  description: "מערכת קביעת תורים לחדרי הקליניקה",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="he"
      dir="rtl"
      className={`${assistant.variable} ${frankRuhl.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col text-stone-800 font-sans">
        <Providers>
          <Navbar />
          <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-10">
            {children}
          </main>
          <footer className="mt-8 border-t border-cream-200/80 bg-white/40">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-stone-400">
              <span className="font-display text-sm text-stone-600">הקפסולה</span>
              <span>הבית שלך לפגישות עסקיות · מערכת ניהול קליניקות</span>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}

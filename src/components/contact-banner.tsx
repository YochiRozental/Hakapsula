"use client";

import { useState } from "react";
import { Alert, Icon, type IconName } from "@/components/ui";

const CONTACT_DETAILS: {
  icon: IconName;
  label: string;
  value: string;
  href?: string;
  external?: boolean;
}[] = [
  {
    icon: "mail",
    label: "מייל",
    value: "hakapsula@gmail.com",
    href: "mailto:hakapsula@gmail.com",
  },
  { icon: "phone", label: "טלפון", value: "083130541", href: "tel:083130541" },
  {
    icon: "pin",
    label: "כתובת",
    value: 'הריטב"א, מודיעין עילית',
    href:
      "https://www.google.com/maps/search/?api=1&query=" +
      encodeURIComponent('הריטב"א, מודיעין עילית'),
    external: true,
  },
];

const inputClass =
  "w-full rounded-xl border border-white/15 bg-white/10 px-4 py-2.5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-bronze-300/60";

export function ContactBanner() {
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setStatus("sending");
    setError("");

    const res = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    }).catch(() => null);

    if (res?.ok) {
      form.reset();
      setStatus("sent");
    } else {
      const data = await res?.json().catch(() => null);
      setError(data?.error ?? "שליחת ההודעה נכשלה, נסו שוב");
      setStatus("idle");
    }
  }

  return (
    <section id="contact" className="panel-brand mt-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 grid gap-10 md:grid-cols-[1fr_1.3fr]">
        <div>
          <p className="text-xs font-bold tracking-[0.14em] text-bronze-300 mb-2">
            צור קשר
          </p>
          <h2 className="font-display text-2xl sm:text-3xl font-bold">
            נשמח לשמוע מכם
          </h2>
          <p className="text-white/70 text-sm mt-2">
            השאירו הודעה ונחזור אליכם בהקדם, או פנו אלינו ישירות:
          </p>
          <ul className="mt-6 space-y-4">
            {CONTACT_DETAILS.map(({ icon, label, value, href, external }) => (
              <li key={label} className="flex items-center gap-3">
                <span className="w-10 h-10 rounded-full bg-white/10 ring-1 ring-white/15 flex items-center justify-center shrink-0">
                  <Icon name={icon} className="w-5 h-5 text-bronze-300" />
                </span>
                <span>
                  <span className="block text-xs text-white/50">{label}</span>
                  {href ? (
                    <a
                      href={href}
                      className="text-sm hover:text-bronze-200"
                      dir={external ? undefined : "ltr"}
                      {...(external
                        ? { target: "_blank", rel: "noopener noreferrer" }
                        : {})}
                    >
                      {value}
                    </a>
                  ) : (
                    <span className="text-sm">{value}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              name="name"
              maxLength={80}
              placeholder="שם מלא"
              aria-label="שם מלא"
              className={inputClass}
            />
            <input
              name="phone"
              type="tel"
              maxLength={30}
              placeholder="טלפון *"
              aria-label="טלפון"
              className={inputClass}
            />
          </div>
          <input
            name="email"
            type="email"
            maxLength={120}
            placeholder="אימייל *"
            aria-label="אימייל"
            className={inputClass}
            dir="ltr"
          />
          <textarea
            name="message"
            maxLength={2000}
            rows={4}
            placeholder="הודעה"
            aria-label="הודעה"
            className={inputClass}
          />
          <input
            name="website"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            className="hidden"
          />
          {error && <Alert tone="error">{error}</Alert>}
          {status === "sent" && (
            <Alert tone="success">ההודעה נשלחה, נחזור אליכם בהקדם.</Alert>
          )}
          <button
            type="submit"
            disabled={status === "sending"}
            className="rounded-xl bg-bronze-400 hover:bg-bronze-300 text-stone-900 font-bold text-sm px-6 py-2.5 transition disabled:opacity-60"
          >
            {status === "sending" ? "שולח..." : "שליחת הודעה"}
          </button>
        </form>
      </div>
    </section>
  );
}

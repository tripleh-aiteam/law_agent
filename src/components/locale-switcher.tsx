"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { Languages } from "lucide-react";

import { usePathname, useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LOCALES = ["ko", "en"] as const;
type AppLocale = (typeof LOCALES)[number];

export function LocaleSwitcher({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const locale = useLocale() as AppLocale;
  const t = useTranslations("common");
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onDocClick(event: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const switchTo = (next: AppLocale) => {
    if (next === locale) {
      setOpen(false);
      return;
    }
    router.replace(pathname, { locale: next });
    setOpen(false);
  };

  const label = (l: AppLocale) => (l === "ko" ? t("korean") : t("english"));

  return (
    <div ref={wrapRef} className={cn("relative inline-block", className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("language")}
        onClick={() => setOpen((v) => !v)}
        className="h-8 gap-1.5 px-2.5"
      >
        <Languages className="h-3.5 w-3.5" aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wide">
          {locale}
        </span>
      </Button>
      {open && (
        <ul
          role="listbox"
          aria-label={t("language")}
          className="absolute right-0 z-50 mt-1 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {LOCALES.map((l) => (
            <li key={l}>
              <button
                type="button"
                role="option"
                aria-selected={l === locale}
                onClick={() => switchTo(l)}
                className={cn(
                  "flex w-full items-center justify-between rounded-sm px-2.5 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:outline-none",
                  l === locale && "font-medium",
                )}
              >
                <span>{label(l)}</span>
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {l}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

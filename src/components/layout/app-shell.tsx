"use client";

import * as React from "react";

import { CasesProvider } from "@/components/cases/cases-context";
import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";

/**
 * App shell — sidebar + header + main scroll area.
 *
 * Responsive behavior:
 *   - md+ (≥768px): sidebar is in-flow at 280px, always visible.
 *   - mobile (<768px): sidebar is off-canvas; tapping the hamburger
 *     button in the header slides it in over a dark backdrop. Tapping
 *     the backdrop or selecting a case auto-closes the drawer.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  // Close the drawer whenever the viewport crosses back to desktop so
  // users don't end up with stale state when rotating a tablet.
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setSidebarOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Close on Escape — better keyboard / accessibility story.
  React.useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  return (
    <CasesProvider>
      <div className="flex h-screen w-full overflow-hidden bg-slate-50">
        {/* Mobile backdrop — only renders when drawer is open */}
        {sidebarOpen && (
          <div
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-sm md:hidden"
            aria-hidden
          />
        )}
        <Sidebar
          mobileOpen={sidebarOpen}
          onCloseMobile={() => setSidebarOpen(false)}
        />
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <Header onOpenSidebar={() => setSidebarOpen(true)} />
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-3 py-4 sm:px-6 sm:py-8">
              {children}
            </div>
          </main>
        </div>
      </div>
    </CasesProvider>
  );
}

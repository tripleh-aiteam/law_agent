"use client";

import * as React from "react";

import { CasesProvider } from "@/components/cases/cases-context";
import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <CasesProvider>
      <div className="flex h-screen w-full overflow-hidden bg-slate-50">
        <Sidebar />
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <Header />
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-6 py-8">
              {children}
            </div>
          </main>
        </div>
      </div>
    </CasesProvider>
  );
}

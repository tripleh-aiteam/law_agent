import { setRequestLocale } from "next-intl/server";

import { CaseDashboard } from "@/components/dashboard/case-dashboard";
import { ChatInput } from "@/components/chat/chat-input";
import { AppShell } from "@/components/layout/app-shell";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <AppShell>
      <div className="space-y-8">
        <CaseDashboard />
        <ChatInput />
      </div>
    </AppShell>
  );
}

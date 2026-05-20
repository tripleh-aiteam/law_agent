import { setRequestLocale } from "next-intl/server";

import { ChatInput } from "@/components/chat/chat-input";
import { ConversationThread } from "@/components/chat/conversation-thread";
import { AppShell } from "@/components/layout/app-shell";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  // Manus-style layout: the conversation thread fills the page and scrolls,
  // while the chat input is anchored to the bottom of the content column.
  // AppShell already provides the sidebar; here we control the main column.
  return (
    <AppShell>
      {/* Manus-style layout: thread stacks vertically, chat input sticks to
          the bottom of the AppShell's scrolling <main>. The empty-bottom
          gradient lets the last turn fade behind the input on overflow. */}
      <div className="space-y-6 pb-32">
        <ConversationThread />
      </div>
      <div className="sticky bottom-0 -mx-6 mt-4 border-t border-slate-100 bg-gradient-to-t from-slate-50 via-slate-50 to-slate-50/70 px-6 pt-4 pb-6 backdrop-blur">
        <div className="mx-auto w-full max-w-4xl">
          <ChatInput />
        </div>
      </div>
    </AppShell>
  );
}

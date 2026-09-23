import { IntakeChatWidget } from "@/components/intake/IntakeChatWidget";

// Board card c23. Per ADR-0001 §D3 this stays a plain Next.js page for
// now — see IntakeChatWidget's own comment for why the actual chat logic
// lives in a framework-agnostic component instead of here, which is the
// boundary that keeps a future standalone-embeddable rewrite cheap.
export default function ChatHome() {
  return (
    <div className="mx-auto flex h-screen max-w-lg flex-col">
      <header className="border-b border-slate-200 px-4 py-3">
        <p className="text-sm font-semibold text-slate-900">Talk to our intake team</p>
      </header>
      <div className="flex-1 overflow-hidden">
        <IntakeChatWidget />
      </div>
    </div>
  );
}

// Client-facing intake chat (board card c23). Real path segment
// (/chat/...), separate from /admin/.... Per ADR-0001 §D3: for the demo,
// this is fine as a Next.js page served directly; before any real firm
// embeds it on their own site, it needs rewriting as a standalone
// embeddable bundle (iframe or script), not this layout. Keep that
// rewrite boundary in mind — avoid coupling this surface tightly to
// Next.js-only features that would make that rewrite harder later.
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white">
      {children}
    </div>
  );
}

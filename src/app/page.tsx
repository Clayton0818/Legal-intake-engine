// Placeholder root route. The real surfaces here are c23 (client-facing
// intake chat) and c24 (admin/staff console) — this page exists only so
// `next build` has something to render and the deployed service isn't a
// bare 404 at "/". Replace when either of those cards lands.
export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>Legal Intake Engine</h1>
      <p>Scaffold stage — see the project board for what&apos;s built so far.</p>
      <p>
        Health check: <code>/api/health</code>
      </p>
    </main>
  );
}

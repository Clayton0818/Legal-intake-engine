import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDevTenantId } from "@/tenancy/devTenant";
import { intakeSessions } from "@/db/schema";
import { getPrompt } from "@/lib/intakeEntryFlow/engine";
import type { CollectedAnswers, IntakeNodeId } from "@/lib/intakeEntryFlow/types";

// Returns the current state of an intake session — used by the chat widget
// to resume a session (e.g. after a page reload) without re-asking
// questions already answered.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenantId = getDevTenantId();
  // See src/app/api/intake/sessions/route.ts's comment on why this is a
  // dynamic import rather than a static top-level one.
  const { withTenant } = await import("@/tenancy/withTenant");

  const session = await withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(intakeSessions)
      // Defense in depth (ADR-0001 §D5): filter by tenantId explicitly on
      // top of RLS rather than relying on RLS alone, even though RLS is
      // the actual enforcement mechanism here.
      .where(and(eq(intakeSessions.id, id), eq(intakeSessions.tenantId, tenantId)))
      .limit(1);
    return row ?? null;
  });

  if (!session) {
    return NextResponse.json({ error: "Intake session not found." }, { status: 404 });
  }

  const currentNode = session.currentNode as IntakeNodeId;
  const collectedAnswers = (session.collectedAnswers ?? {}) as CollectedAnswers;

  return NextResponse.json({
    id: session.id,
    currentNode: session.currentNode,
    terminalState: session.terminalState,
    collectedAnswers,
    prompt: getPrompt(currentNode, collectedAnswers),
  });
}

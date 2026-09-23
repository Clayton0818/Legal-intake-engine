import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDevTenantId } from "@/tenancy/devTenant";
import { intakeEvents, intakeSessions } from "@/db/schema";
import { advance } from "@/lib/intakeEntryFlow/engine";
import { IntakeValidationError, PARKED_NODES, TERMINAL_NODES } from "@/lib/intakeEntryFlow/types";
import type { CollectedAnswers, IntakeNodeId } from "@/lib/intakeEntryFlow/types";

class NotFoundError extends Error {}
class SessionEndedError extends Error {}

// Advances an intake session by exactly one caller turn: validates input
// for the session's current node, updates intake_sessions, appends
// intake_events for each transition, and returns the next prompt.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenantId = getDevTenantId();
  // See src/app/api/intake/sessions/route.ts's comment on why this is a
  // dynamic import rather than a static top-level one.
  const { withTenant } = await import("@/tenancy/withTenant");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const input =
    body && typeof body === "object" ? (body as Record<string, unknown>).input : undefined;

  try {
    const result = await withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(intakeSessions)
        .where(and(eq(intakeSessions.id, id), eq(intakeSessions.tenantId, tenantId)))
        .limit(1);

      if (!row) {
        throw new NotFoundError();
      }

      const currentNode = row.currentNode as IntakeNodeId;
      const collectedAnswers = (row.collectedAnswers ?? {}) as CollectedAnswers;

      if (TERMINAL_NODES.has(currentNode) || PARKED_NODES.has(currentNode)) {
        throw new SessionEndedError();
      }

      const step = advance(currentNode, collectedAnswers, input);

      await tx
        .update(intakeSessions)
        .set({
          currentNode: step.nextNode,
          collectedAnswers: step.collectedAnswers,
          terminalState: step.terminalState ?? row.terminalState,
          completedAt: step.terminalState ? new Date() : row.completedAt,
        })
        .where(and(eq(intakeSessions.id, id), eq(intakeSessions.tenantId, tenantId)));

      for (const draft of step.events) {
        await tx.insert(intakeEvents).values({
          tenantId,
          intakeSessionId: id,
          eventType: draft.eventType,
          ruleName: draft.ruleName,
          actorType: "caller",
          payload: draft.payload,
          firmConfigVersionId: row.firmConfigVersionId,
        });
      }

      return step;
    });

    return NextResponse.json({
      id,
      currentNode: result.nextNode,
      collectedAnswers: result.collectedAnswers,
      terminalState: result.terminalState ?? null,
      sessionEnded: result.sessionEnded,
      prompt: result.prompt,
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: "Intake session not found." }, { status: 404 });
    }
    if (err instanceof SessionEndedError) {
      return NextResponse.json(
        { error: "This intake is already complete; no further input is accepted." },
        { status: 409 }
      );
    }
    if (err instanceof IntakeValidationError) {
      return NextResponse.json(
        { error: "Invalid input.", fieldErrors: err.fieldErrors },
        { status: 400 }
      );
    }
    throw err;
  }
}

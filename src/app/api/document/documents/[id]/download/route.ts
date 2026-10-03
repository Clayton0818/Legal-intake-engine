import { documentRoute } from "@/app/api/document/_lib/route";
import { assertUuidParam, contentDisposition } from "@/engines/document/http";
import { downloadDocument } from "@/engines/document/store/service";

export const dynamic = "force-dynamic";

/** c84 — the bytes of one version, checksum-verified. Logged as 'download' (or a denial). ?inline=1 to view in the browser. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inline = new URL(req.url).searchParams.get("inline") === "1";
  return documentRoute("GET /api/document/documents/[id]/download", async (c) => {
    const file = await downloadDocument(c.tx, c, assertUuidParam(id, "document id"));
    return new Response(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        "content-type": file.mimeType,
        "content-disposition": contentDisposition(file.filename, inline),
        "content-length": String(file.bytes.length),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "x-document-sha256": file.sha256,
        ...(file.scanStatus === "not_scanned" ? { "x-document-warning": "not-virus-scanned" } : {}),
      },
    });
  });
}

import { documentRoute } from "@/app/api/document/_lib/route";
import { assertUuidParam } from "@/engines/document/http";
import { runSearch } from "@/engines/document/search/service";

export const dynamic = "force-dynamic";

/**
 * c84 — full-text search across one matter (?matterId=) or the whole firm.
 * ?q= words, "phrases", -exclude, a OR b, type:<x> tag:<x> folder:<key>;
 * ?allVersions=1 includes older versions; ?page=N. Screened matters and
 * restricted tags are never searched. Every search is logged.
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const matterId = sp.get("matterId");
  return documentRoute("GET /api/document/search", (c) =>
    runSearch(c.tx, c, {
      text: sp.get("q") ?? "",
      matterId: matterId ? assertUuidParam(matterId, "matter id") : null,
      allVersions: sp.get("allVersions") === "1",
      page: Number(sp.get("page") ?? "1") || 1,
    })
  );
}

import { IMPORT_RECORD_TYPES, IMPORT_TEMPLATE_HEADER } from "@/engines/conflict-check/historyImport";

export const dynamic = "force-static";

/** A blank CSV template for the history import (c96). Contains no firm data. */
export function GET(): Response {
  const example = [
    "client,Jane Doe,person,Janie Doe,Jane Miller,,,1985-04-12,jane@example.com,512-555-0100,,M-1001,Doe divorce,closed,family,2019-03-01,2020-01-15,,",
    "opposing_party,John Doe,person,,,,,,,,,M-1001,Doe divorce,closed,family,,,former_spouse,yes",
    "declined_consultation,Pat Prospect,person,,,,,,,,,C-2044,,,family,2024-06-02,,,",
  ].join("\n");
  const body = `${IMPORT_TEMPLATE_HEADER}\n${example}\n`;
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="conflicts-history-template.csv"',
      "x-record-types": IMPORT_RECORD_TYPES.join(","),
    },
  });
}

// Bank feeds are an external vendor (statement data from the bank / an
// aggregator). The engine talks to them only through this interface; the
// only adapter shipped is a STUB that fetches nothing. The real call is gated
// on 'vendor.billing-trust.bank_feed' (vendor DPA + CPA) by the service
// before any adapter is invoked. Until then statements are entered by hand or
// imported from the bank's CSV.

import type { Cents } from "./money";
import type { StatementLineInput } from "./statementIo";

export interface BankFeedRequest {
  tenantId: string;
  trustAccountId: string;
  bankName: string;
  accountNumberLast4: string;
  period: string;
}

export type BankFeedResult =
  | {
      status: "ok";
      openingBalance: Cents;
      closingBalance: Cents;
      lines: StatementLineInput[];
      /** SHA-256 of the raw payload, stored with the statement. */
      payloadSha256: string;
      provider: string;
    }
  | { status: "unavailable"; provider: string; message: string };

export interface BankFeedAdapter {
  readonly name: string;
  fetchStatement(req: BankFeedRequest): Promise<BankFeedResult>;
}

/** Records the request and returns 'unavailable': no data ever leaves or enters. */
export class StubBankFeedAdapter implements BankFeedAdapter {
  readonly name = "stub";
  readonly requests: BankFeedRequest[] = [];

  async fetchStatement(req: BankFeedRequest): Promise<BankFeedResult> {
    this.requests.push({ ...req });
    return {
      status: "unavailable",
      provider: this.name,
      message: "No bank-feed vendor is connected. Enter the statement by hand or import the bank's CSV.",
    };
  }
}

let adapter: BankFeedAdapter = new StubBankFeedAdapter();

export function getBankFeedAdapter(): BankFeedAdapter {
  return adapter;
}

/** Tests / future wiring. A real adapter is installed only after the vendor gate is approved. */
export function setBankFeedAdapter(next: BankFeedAdapter | null): void {
  adapter = next ?? new StubBankFeedAdapter();
}

# llm/

The model-vendor adapter (ADR-0001 §D9): "all model calls go through one internal interface, with the vendor swappable behind it." This is where `c13`'s `ClassifyOutput` interface (`docs/product/spec/llm-triage-classifier.md`) gets a real implementation.

**Do not add a vendor SDK call anywhere outside this directory.** ADR-0001 §D9's gate — no real client data reaches a model vendor until `c1`/`c2`/`c26` and a signed DPA all clear — is only enforceable if every model call is forced through one place that can check `firms.is_production` first.

## Layout (c35)

| File | What it is |
|---|---|
| `types.ts` | The `ClassifyOutput` contract from the spec (§2) plus an internal-only `ClassifyTrace`. |
| `classifier.ts` | `classify()` — the synchronous deterministic path (keyword pre-filter + safety triggers). Same signature the flow engine calls today. |
| `classify.ts` | `classifyTriage()` — the real classifier: model call gated on `vendor.ai_model` **and** `copy.platform.triage_system_prompt`, strict output validation, per-class thresholds, `safetyFlag = model OR rules`, fallback to `classify()`. |
| `model.ts` | `TriageModel` interface, `StubTriageModel` (records, never sends), `AnthropicTriageModel` (plain fetch, no SDK). Selected by `LLM_PROVIDER=anthropic` + `LLM_API_KEY` + `LLM_MODEL`; anything else is the stub. |
| `protocol.ts` | Prompt wrapping (`<caller_text>` data wrapper, tag neutralising), strict reply parsing, provisional per-class thresholds. |
| `safetyRules.ts` | Safety trigger matching. The list lives in the `rules.platform.safety_triggers` gate (attorney-owned); its draft applies while pending because detection only ever escalates to a human. |
| `prefilter.ts` | Deterministic keyword floor (spec §5). |
| `eval.ts` | Per-class precision/recall, macro/weighted F1, confusion matrix, reliability table, synthetic eval set. |

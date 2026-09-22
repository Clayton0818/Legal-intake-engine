# llm/

The model-vendor adapter (ADR-0001 §D9): "all model calls go through one internal interface, with the vendor swappable behind it." This is where `c13`'s `ClassifyOutput` interface (`docs/product/spec/llm-triage-classifier.md`) gets a real implementation.

**Do not add a vendor SDK call anywhere outside this directory.** ADR-0001 §D9's gate — no real client data reaches a model vendor until `c1`/`c2`/`c26` and a signed DPA all clear — is only enforceable if every model call is forced through one place that can check `firms.is_production` first.

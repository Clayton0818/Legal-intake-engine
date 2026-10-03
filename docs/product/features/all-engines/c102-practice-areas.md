# c102 — Practice areas chosen in firm settings

**Code:** `src/engines/all-engines/packs/{types,registry,validate,copy,questions}.ts`, `practiceAreas/{plan,published,service}.ts`, `worker.ts`.

## Settings flow
- `PUT /api/all-engines/practice-areas { areas, reason }` (needs `practice_areas.manage`: owner/admin by default). Validation (`planAreaChange`): known ids only; **at least one area on**; an area can be switched **on** only when its pack exists (Immigration/PI wait for c104/c105); an area already on is never broken.
- **Off never deletes:** matters are untouched; the response and the log record how many open matters continue. New inquiries in an off area are declined by intake (c73 practice-area rule + c62 letter).
- Every change is logged to `access_change_log` (`practice_area.enabled|disabled`) and `audit_events`; `updateFirmSettings` adds its own core audit row.
- Page: `/admin/all-engines/practice-areas`.

## Pack registry and interface
`PracticeAreaPack` (packs/types.ts) describes what an area contributes to each engine:
- **Intake:** matter types (mapped to classifier labels), ordered questions with groups (safety, parties, children, existing orders, case, finances), safety/urgent signal answers, conditional `askWhen`, safety handling (route to c66, mark DV-sensitive, safe-contact defaults).
- **Conflicts:** party roles mapped to `party_role` and conflict index roles, adverse default, ask-at-intake, index-by-default, blocks-clear-if-unnamed.
- **Documents:** folder template (privilege defaults), required-document checklists (who provides, folder, gated client request wording), template references (gated).
- **Tasks:** lists triggered on matter open or stage entry; business-day workflow targets; tasks that apply a legal rule point at a rule reference and are lawyer-assigned.
- **Stages:** tracks with optional mapping to `matter_stage` and gated portal labels.
- **Deadlines:** `RuleReference`s only — gate key + owner engine + staff note, **no values**, always lawyer tools.
- **Billing:** default/offered/withheld fee types; retainer floor from firm settings; shared fee-terms and trust gates.

`validatePack()` enforces all of this (safety first, parties before case details, DV-safe defaults, namespaced copy keys, rule refs gated and value-free, no client-visible tasks…). `PACK_REGISTRY` holds packs; adding c104/c105 = one data file + one registry line, validated by the same tests. `gates.ts` defines one attorney copy gate per client sentence of every registered pack automatically.

## Versioning
- Each pack has a semver `version`, a changelog and a content hash (`packContentHash`).
- Switching an area on accepts its current version; the founder's default (Family Law on for new firms) is accepted once by the `all-engines.publish_practice_area_packs` tick hook. **Updates are never accepted automatically**: the page shows a per-section diff (`diffPacks`) and `POST /api/all-engines/practice-areas/:area/accept { version, contentHash }` accepts exactly what was reviewed (refused if the pack changed since).
- `practice_area_pack_adoptions` keeps a snapshot of every accepted version (older ones `superseded`).

## How engines consume packs (no imports)
Accepted snapshots are published to `firm_settings.engine_settings["all-engines"].practiceAreaPacks[area] = { practiceArea, version, contentHash, acceptedAt, pack }`. Engines read them with `getFirmSettings()` + `engineSetting()` and use only switched-on areas (`practiceAreas/published.ts` documents the helper logic: `activePack`, `activePacks`). Snapshots of switched-off areas stay so existing matters keep their stages and checklists.

## Foundation requests
1. Move `PracticeAreaPack` types (packs/types.ts) and the reader helpers in `practiceAreas/published.ts` to `src/core/practiceAreas.ts`, so engines get typed access to the published packs.
2. `validatePracticeAreas()` in core accepts an empty list; add the "at least one" rule there too so `updateFirmSettings` cannot bypass it.
3. Firm onboarding should call the default-adoption step (or rely on the tick hook, which this engine ships).
4. Optionally a dedicated `practice_area_packs` jsonb column in `firm_settings` instead of the engine-settings bag (packs are ~40 KB).

## Open questions
- Should switching an area off require a second confirmation when it has open matters? (Currently: allowed, logged, count shown.)
- Who besides owner/admin may accept pack updates (e.g. a lead lawyer)?

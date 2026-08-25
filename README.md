# Legal Intake Engine

A generic, commercial legal-intake AI: conversational triage, conflict-check automation, and a compliance-aware pipeline that a law firm can drop its own intake process into.

## Status

Early-stage. This repository tracks the actual build behind the [Legal Intake Build](https://claude.ai/code/artifact/c002dcf5-570b-4d92-9afd-9cde9d8daa3e) kanban board — every card on that board corresponds to work that lands here, either as a document in `docs/` or as code once implementation starts.

## Repository structure

- `docs/` — compliance research, specs, and architecture decision records. Most early work (UPL review, data privacy policy, multi-tenant architecture) lands here before any code is written.
- `src/` — application code. Empty for now; the stack hasn't been chosen yet (that's itself a pending decision, informed by the architecture work in `docs/`).

## Workflow

- Work is tracked on the [Legal Intake Build](https://claude.ai/code/artifact/c002dcf5-570b-4d92-9afd-9cde9d8daa3e) board (Backlog → Scoping → In Progress → Review & QA → Shipped).
- Scheduled sessions pick up the next unblocked backlog item, do the work, and open a pull request — nothing merges to `main` without human review, especially anything touching compliance or client data handling.
- Cards move to Review & QA when a PR is open, and to Shipped once it's merged.

## Why private

This repo is private by default. Early work includes unauthorized-practice-of-law (UPL) research and data-handling policy for privileged client communications — content that shouldn't be public before it's been reviewed.

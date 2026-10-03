// Folder templates (c84): the firm sets, per practice area, which folders
// every new matter gets. Pure — validation, normalisation and planning only.
//
// Folder KEYS are the contract with other engines and later cards: c87 files
// email into the folder with key 'email', c49 puts client uploads in
// 'client_uploads', c4/c39 store signed agreements in 'agreements', c90 the
// closing letter in 'closing'. A firm may rename any folder, but a template
// must keep the REQUIRED_FOLDER_KEYS so those hand-offs always find a home.

import type { FolderTemplateNode } from "@/db/tables/document";
import { isPrivilegeTag } from "@/core/documents";

export type { FolderTemplateNode };

/** Keys other cards rely on. Every template must contain them (anywhere in the tree). */
export const REQUIRED_FOLDER_KEYS = ["client_uploads", "correspondence", "email", "agreements"] as const;

export const MAX_FOLDER_DEPTH = 4;
export const MAX_TEMPLATE_FOLDERS = 200;
export const MAX_FOLDER_NAME_LENGTH = 120;

/**
 * The product's fallback layout, used when the firm has no active template
 * for the matter's practice area and no firm-wide one. Generic on purpose:
 * folder names are filing convenience, not legal content.
 */
export const DEFAULT_FOLDER_TEMPLATE: readonly FolderTemplateNode[] = Object.freeze([
  { key: "correspondence", name: "Correspondence", children: [{ key: "email", name: "Email" }] },
  { key: "client_uploads", name: "From the client" },
  { key: "agreements", name: "Agreements and signed documents", defaultPrivilegeTag: "confidential" },
  { key: "pleadings", name: "Pleadings and court filings" },
  { key: "discovery", name: "Discovery" },
  { key: "evidence", name: "Evidence and exhibits" },
  { key: "drafts", name: "Drafts", defaultPrivilegeTag: "work_product" },
  { key: "notes", name: "Internal notes", defaultPrivilegeTag: "work_product" },
  { key: "closing", name: "Closing" },
]);

/** Lower-case, trim, collapse whitespace. Used for sibling-name uniqueness. */
export function normalizeFolderName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Problems with a single folder name (empty list = OK). */
export function folderNameProblems(name: string): string[] {
  const problems: string[] = [];
  const trimmed = name.trim();
  if (!trimmed) problems.push("Folder name is required.");
  if (trimmed.length > MAX_FOLDER_NAME_LENGTH) problems.push(`Folder name is longer than ${MAX_FOLDER_NAME_LENGTH} characters.`);
  if (/[/\\]/.test(trimmed)) problems.push("Folder name cannot contain / or \\.");
  if (/[\u0000-\u001f\u007f]/.test(name)) problems.push("Folder name cannot contain control characters.");
  if (trimmed === "." || trimmed === "..") problems.push("Folder name cannot be . or ..");
  return problems;
}

export interface TemplateValidation {
  ok: boolean;
  errors: string[];
  /** The template with names trimmed and missing optional fields filled. */
  normalized: FolderTemplateNode[];
}

/** Validate a firm-submitted template tree. Pure. */
export function validateFolderTemplate(input: unknown): TemplateValidation {
  const errors: string[] = [];
  const keys = new Set<string>();
  let count = 0;

  function walk(nodes: unknown, depth: number, path: string): FolderTemplateNode[] {
    if (!Array.isArray(nodes)) {
      errors.push(`${path || "Template"}: folders must be a list.`);
      return [];
    }
    if (depth > MAX_FOLDER_DEPTH) {
      errors.push(`${path}: folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.`);
      return [];
    }
    const siblings = new Set<string>();
    const out: FolderTemplateNode[] = [];
    nodes.forEach((raw, i) => {
      count++;
      const where = `${path}${path ? " › " : ""}#${i + 1}`;
      if (!raw || typeof raw !== "object") {
        errors.push(`${where}: each folder must be an object with a key and a name.`);
        return;
      }
      const node = raw as Record<string, unknown>;
      const key = typeof node.key === "string" ? node.key.trim() : "";
      const name = typeof node.name === "string" ? node.name.trim().replace(/\s+/g, " ") : "";
      const label = name || where;
      if (!/^[a-z][a-z0-9_]{0,48}$/.test(key)) {
        errors.push(`${label}: key must be lowercase letters, digits and _ (starting with a letter).`);
      } else if (keys.has(key)) {
        errors.push(`${label}: key '${key}' is used more than once.`);
      } else {
        keys.add(key);
      }
      for (const p of folderNameProblems(typeof node.name === "string" ? node.name : "")) errors.push(`${label}: ${p}`);
      const norm = normalizeFolderName(name);
      if (norm && siblings.has(norm)) errors.push(`${label}: two folders at the same level are both called '${name}'.`);
      siblings.add(norm);

      let defaultPrivilegeTag: string | undefined;
      if (node.defaultPrivilegeTag !== undefined) {
        if (isPrivilegeTag(node.defaultPrivilegeTag)) defaultPrivilegeTag = node.defaultPrivilegeTag;
        else errors.push(`${label}: unknown privilege tag '${String(node.defaultPrivilegeTag)}'.`);
      }
      const children = node.children === undefined ? [] : walk(node.children, depth + 1, label);
      out.push({
        key,
        name,
        ...(defaultPrivilegeTag && defaultPrivilegeTag !== "none" ? { defaultPrivilegeTag } : {}),
        ...(children.length ? { children } : {}),
      });
    });
    return out;
  }

  const normalized = walk(input, 1, "");
  if (count === 0 && errors.length === 0) errors.push("A template needs at least one folder.");
  if (count > MAX_TEMPLATE_FOLDERS) errors.push(`A template can have at most ${MAX_TEMPLATE_FOLDERS} folders.`);
  for (const k of REQUIRED_FOLDER_KEYS) {
    if (!keys.has(k)) errors.push(`The template must keep a folder with key '${k}' (other features file into it).`);
  }
  return { ok: errors.length === 0, errors, normalized };
}

export interface PlannedFolder {
  key: string;
  name: string;
  normalizedName: string;
  /** Key of the parent folder, null at the top level. */
  parentKey: string | null;
  depth: number;
  position: number;
  defaultPrivilegeTag: string;
  /** "Correspondence / Email" — for display and logs. */
  path: string;
}

/**
 * Flatten a template into creation order (parents before children). A child
 * inherits its parent's default privilege tag unless it sets its own. Pure.
 */
export function planFolders(template: readonly FolderTemplateNode[]): PlannedFolder[] {
  const out: PlannedFolder[] = [];
  function walk(nodes: readonly FolderTemplateNode[], parent: PlannedFolder | null, depth: number) {
    nodes.forEach((n, position) => {
      const planned: PlannedFolder = {
        key: n.key,
        name: n.name,
        normalizedName: normalizeFolderName(n.name),
        parentKey: parent?.key ?? null,
        depth,
        position,
        defaultPrivilegeTag: n.defaultPrivilegeTag ?? parent?.defaultPrivilegeTag ?? "none",
        path: parent ? `${parent.path} / ${n.name}` : n.name,
      };
      out.push(planned);
      if (n.children?.length) walk(n.children, planned, depth + 1);
    });
  }
  walk(template, null, 1);
  return out;
}

export interface ExistingFolder {
  id: string;
  templateKey: string | null;
}

/**
 * Which planned folders a matter is still missing (by template key). Used to
 * make provisioning idempotent and to add folders when a firm extends its
 * template later — existing folders are never renamed or moved. Pure.
 */
export function missingFolders(plan: readonly PlannedFolder[], existing: readonly ExistingFolder[]): PlannedFolder[] {
  const have = new Set(existing.map((f) => f.templateKey).filter((k): k is string => !!k));
  return plan.filter((p) => !have.has(p.key));
}

export interface TemplateCandidate {
  id: string;
  practiceArea: string | null;
  status: string;
  folders: FolderTemplateNode[];
}

/**
 * Choose the template for a matter: the active one for its practice area,
 * else the firm-wide active one, else the product default. Pure.
 */
export function pickTemplate(
  candidates: readonly TemplateCandidate[],
  practiceArea: string | null
): { templateId: string | null; folders: readonly FolderTemplateNode[]; source: "practice_area" | "firm_default" | "product_default" } {
  const active = candidates.filter((c) => c.status === "active");
  const byArea = practiceArea ? active.find((c) => c.practiceArea === practiceArea) : undefined;
  if (byArea) return { templateId: byArea.id, folders: byArea.folders, source: "practice_area" };
  const firmWide = active.find((c) => c.practiceArea === null);
  if (firmWide) return { templateId: firmWide.id, folders: firmWide.folders, source: "firm_default" };
  return { templateId: null, folders: DEFAULT_FOLDER_TEMPLATE, source: "product_default" };
}

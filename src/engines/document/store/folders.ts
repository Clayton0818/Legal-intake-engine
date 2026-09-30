// Folder paths and matter folder templates (c84). Pure.

import { forPracticeArea, type DocumentSettings } from "../common";

/** Folders the engine files into by itself, and the default name each gets. */
export const SYSTEM_FOLDERS = {
  client_uploads: "Client uploads",
  email: "Email",
  signed: "Signed",
  court: "Court",
  closing: "Closing",
} as const;
export type SystemFolderKey = keyof typeof SYSTEM_FOLDERS;

const BAD_CHARS = /[\\:*?"<>|\u0000-\u001f]/;

/** Normalise a '/'-separated folder path; throws on empty or unsafe segments. */
export function normalizeFolderPath(path: string): string {
  const segments = path
    .split("/")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (segments.length === 0) throw new Error("A folder name is required.");
  for (const s of segments) {
    if (s === "." || s === "..") throw new Error("Folder names cannot be '.' or '..'.");
    if (BAD_CHARS.test(s)) throw new Error(`Folder name '${s}' contains characters that are not allowed.`);
    if (s.length > 120) throw new Error("Folder names are limited to 120 characters.");
  }
  if (segments.length > 8) throw new Error("Folders can be nested at most 8 levels deep.");
  return segments.join("/");
}

export function parentPath(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i < 0 ? null : path.slice(0, i);
}

export function leafName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export interface PlannedFolder {
  path: string;
  name: string;
  parentPath: string | null;
  systemKey: SystemFolderKey | null;
}

/**
 * Every folder a new matter gets: the firm's template for the practice area
 * (every ancestor included, parents first) plus the system folders.
 */
export function planMatterFolders(settings: Pick<DocumentSettings, "folderTemplates">, practiceArea: string | null | undefined): PlannedFolder[] {
  const template = forPracticeArea(settings.folderTemplates, practiceArea) ?? [];
  const systemByName = new Map<string, SystemFolderKey>(
    (Object.entries(SYSTEM_FOLDERS) as Array<[SystemFolderKey, string]>).map(([k, v]) => [v.toLowerCase(), k])
  );
  const paths = new Set<string>();
  for (const raw of [...template, ...Object.values(SYSTEM_FOLDERS)]) {
    const p = normalizeFolderPath(raw);
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join("/"));
  }
  const byLower = new Map<string, string>();
  for (const p of paths) if (!byLower.has(p.toLowerCase())) byLower.set(p.toLowerCase(), p);
  return [...byLower.values()]
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .map((path) => ({
      path,
      name: leafName(path),
      parentPath: parentPath(path),
      systemKey: path.includes("/") ? null : systemByName.get(path.toLowerCase()) ?? null,
    }));
}

// Types for ./core.js (hand-written; the widget ships without a build step).

export interface WidgetPromptOption {
  value: string;
  label: string;
}
export interface WidgetPromptField {
  name: string;
  label: string;
  type: string;
}
export interface WidgetPrompt {
  node: string;
  kind: "single_choice" | "form" | "free_text" | "confirm" | "final";
  message: string;
  options?: WidgetPromptOption[];
  fields?: WidgetPromptField[];
  final: boolean;
}
export interface EmbedConfig {
  key: string | null;
  appOrigin: string | null;
  color: string;
  position: "left" | "right";
  label: string;
}
export interface ChatMessage {
  from: "bot" | "caller";
  text: string;
}
export interface ChatState {
  messages: ChatMessage[];
  prompt: WidgetPrompt | null;
  sessionId: string | null;
  loading: boolean;
  error: string | null;
  ended: boolean;
}
export type ChatAction =
  | { type: "started" | "resumed"; sessionId: string; prompt: WidgetPrompt }
  | { type: "sending"; text: string }
  | { type: "answered"; prompt: WidgetPrompt }
  | { type: "failed"; error: string };

export const WIDGET_VERSION: string;
export const MESSAGE_SOURCE: string;
export const GENERIC_ERROR: string;
export const START_ERROR: string;
export function isWidgetKey(value: unknown): value is string;
export function parseEmbedConfig(dataset: Record<string, string | undefined> | null, scriptSrc: string): EmbedConfig;
export function buildFrameUrl(appOrigin: string, key: string, hostOrigin?: string | null): string;
export function parseFrameHash(hash: string): { key: string | null; host: string | null };
export function isWidgetMessage(event: { origin: string; data: unknown } | null, expectedOrigin: string): boolean;
export function inputForChoice(prompt: WidgetPrompt, option: WidgetPromptOption): Record<string, unknown>;
export function summaryForForm(values: Record<string, string | undefined>): string;
export function inputForText(text: string): Record<string, unknown>;
export function sessionStorageKey(widgetKey: string): string;
export function errorText(status: number, body: unknown): string;
export function initialState(): ChatState;
export function reduce(state: ChatState, action: ChatAction): ChatState;

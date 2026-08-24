/* Wire protocol shared with the Rust `archcar` daemon.
 *
 * ── Barrel, not a definition file ──
 *
 * This was a single 972-line file. The definitions now live under ./protocol,
 * split by domain, and this re-exports all of them so every existing
 * `from "@/bridge/protocol"` import keeps working unchanged.
 *
 * Unlike the stylesheets, order here is NOT load-bearing — these are types and
 * a couple of constants, and TypeScript resolves them regardless of sequence.
 * Group by domain; do not worry about position.
 */

export * from "./protocol/common";
export * from "./protocol/requests";
export * from "./protocol/chat";
export * from "./protocol/workspace";
export * from "./protocol/threads";
export * from "./protocol/setup";
export * from "./protocol/responses";
export * from "./protocol/background";
export * from "./protocol/tasks";
export * from "./protocol/events";

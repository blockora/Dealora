/**
 * @dealora/outbound — ROADMAP.md §18, the first outbound integration.
 *
 * One channel, one provider interface, and one boundary: a message leaves this
 * system only through an explicit send of an action whose exact draft version a
 * human approved and whose recipient has not opted out.
 */
export * from "./types.js";
export * from "./rules.js";
export * from "./validation.js";
export * from "./providers.js";
export * from "./factory.js";
export { OutboundService } from "./service.js";

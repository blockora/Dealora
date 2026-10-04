/**
 * @dealora/conversation — ROADMAP.md §19, the Conversation Engine.
 *
 * A response that has actually been received is recorded verbatim with its
 * provenance, read by a deterministic classifier, and turned into an intent, a
 * confidence, a recommended next action and an explicit "does a person have to
 * look at this" flag.
 *
 * The negative space is the design: this package cannot send, cannot approve,
 * cannot schedule, and cannot turn a response into evidence. It reads what
 * arrived and recommends what to do about it; every effect still runs through
 * the Phase 10 approval and Phase 11 send path that already existed.
 */
export * from "./types.js";
export * from "./rules.js";
export * from "./validation.js";
export * from "./classifier.js";
export * from "./factory.js";
export { ConversationService } from "./service.js";

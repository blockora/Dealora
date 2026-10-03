/** @dealora/api — transport handlers and application-service wiring. */
export { createHandlers, publicUser } from "./handlers.js";
export type { HandlerDeps } from "./handlers.js";

export type {
  ApiError,
  ApiErrorCode,
  ApiHandler,
  ApiResponse,
  ApiSuccess,
  AuthenticatedActor,
  IdentityService,
  RequestBody,
  SessionResolver,
} from "./types.js";

/**
 * Build the default handler set wired to the real identity service, Business
 * Brain service, and session index.
 *
 * The session resolver is derived from the auth package's session index, so a
 * handler can never accept a client-supplied user id.
 */
export { createDefaultHandlers } from "./wiring.js";

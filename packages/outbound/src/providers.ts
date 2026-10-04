import type { OutboundChannel, OutboundFailureCode } from "@dealora/db";

import type {
  OutboundMessage,
  OutboundProvider,
  OutboundProviderResolver,
  OutboundProviderResult,
} from "./types.js";

/**
 * What the sandbox provider records for each message it accepted.
 *
 * Exposed so a test can prove a message genuinely reached the provider, rather
 * than inferring it from the action's own status — which is exactly the
 * difference between "the system says sent" and "the provider confirmed".
 */
export interface SandboxDelivery {
  idempotencyKey: string;
  to: string;
  subject: string;
  body: string;
  providerReference: string;
}

/**
 * The deterministic sandbox provider — the only provider shipped here.
 *
 * It performs **no network I/O at all**: it accepts a message and records it.
 * That is the honest default, because no outbound credential is configured in
 * this repository and a provider that pretended to deliver would make the phase's
 * central claim — "a real approved message can be sent and its state can be
 * observed" — unverifiable.
 *
 * What it does prove is everything on DEALORA's side of the boundary: that a
 * message only reaches a provider after a persisted human approval for the exact
 * draft version, that the text delivered is the approved text, and that the
 * confirmation a provider returns is what moves an action to `sent`.
 *
 * It also de-duplicates on the idempotency key, exactly as a real provider
 * should: re-sending the same key returns the original reference rather than
 * accepting a second copy. That is what makes a retry safe.
 */
export class SandboxEmailProvider implements OutboundProvider {
  readonly name = "sandbox_email";

  /** What the provider accepted, keyed by idempotency key. */
  private readonly accepted = new Map<string, SandboxDelivery>();

  /** How many times `send` was actually called, accepted or not. */
  private calls = 0;

  /**
   * Addresses this provider refuses as invalid.
   *
   * A test double needs a way to produce `invalid_recipient` without a real
   * provider's address validation, and an explicit set is more honest than
   * quietly refusing anything that looks unusual.
   */
  private readonly invalidRecipients = new Set<string>();

  /** Refuse this address as malformed. */
  rejectAddress(address: string): void {
    this.invalidRecipients.add(address.toLowerCase());
  }

  /** Every message this provider confirmed, in acceptance order. */
  deliveries(): SandboxDelivery[] {
    return [...this.accepted.values()];
  }

  /** How many times this provider was actually called, retries included. */
  callCount(): number {
    return this.calls;
  }

  async send(message: OutboundMessage): Promise<OutboundProviderResult> {
    this.calls += 1;
    const existing = this.accepted.get(message.idempotencyKey);
    if (existing !== undefined) {
      // The same logical send, already accepted: report the original reference
      // rather than pretending a second message went out.
      return {
        accepted: true,
        providerReference: existing.providerReference,
        message: "already accepted",
        failureCode: null,
      };
    }
    if (this.invalidRecipients.has(message.to.toLowerCase())) {
      return {
        accepted: false,
        providerReference: null,
        message: `the sandbox provider treats ${message.to} as malformed`,
        failureCode: "invalid_recipient",
      };
    }
    const providerReference = `sandbox-${message.idempotencyKey}`;
    this.accepted.set(message.idempotencyKey, {
      idempotencyKey: message.idempotencyKey,
      to: message.to,
      subject: message.subject,
      body: message.body,
      providerReference,
    });
    return {
      accepted: true,
      providerReference,
      message: "accepted by the sandbox provider",
      failureCode: null,
    };
  }
}

/**
 * A provider that refuses everything with a chosen code.
 *
 * Exists so the failure paths are tested against a real
 * {@link OutboundProvider}, not against a hand-written result object: this is the
 * only way to prove that a refusal never becomes `sent`.
 */
export class FailingEmailProvider implements OutboundProvider {
  readonly name = "failing_email";

  private calls = 0;

  constructor(
    private readonly code: OutboundFailureCode = "provider_unavailable",
    private readonly message = "the provider is unavailable",
  ) {}

  /** How many times a send reached this provider. */
  attempts(): number {
    return this.calls;
  }

  async send(): Promise<OutboundProviderResult> {
    this.calls += 1;
    return {
      accepted: false,
      providerReference: null,
      message: this.message,
      failureCode: this.code,
    };
  }
}

/**
 * A provider that throws instead of answering.
 *
 * The point is the catch in the send path: a provider that explodes must leave a
 * recorded `failed` action, not an unhandled rejection and not a `sent` one.
 */
export class ThrowingEmailProvider implements OutboundProvider {
  readonly name = "throwing_email";

  constructor(private readonly message = "the provider connection dropped") {}

  async send(): Promise<OutboundProviderResult> {
    throw new Error(this.message);
  }
}

/**
 * The provider registry.
 *
 * Explicit and closed: a provider is available only if it was registered here.
 * There is no discovery, no dynamic loading and no default provider, so "no
 * provider configured" is a real, reachable, tested state rather than an accident
 * of the environment.
 */
export class ProviderRegistry implements OutboundProviderResolver {
  private readonly byChannel = new Map<OutboundChannel, OutboundProvider>();

  /** Register the single provider for a channel. Re-registering replaces it. */
  register(channel: OutboundChannel, provider: OutboundProvider): void {
    this.byChannel.set(channel, provider);
  }

  /** Remove a channel's provider, so "unconfigured" can be reached at runtime. */
  unregister(channel: OutboundChannel): void {
    this.byChannel.delete(channel);
  }

  providerFor(channel: OutboundChannel): OutboundProvider | null {
    return this.byChannel.get(channel) ?? null;
  }

  configuredProviders(): string[] {
    return [...new Set([...this.byChannel.values()].map((provider) => provider.name))].sort();
  }
}

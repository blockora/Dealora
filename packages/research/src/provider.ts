import type {
  RawProviderFinding,
  ResearchProvider,
  ResearchProviderResult,
  ResearchQuery,
} from "./types.js";

/**
 * Research providers.
 *
 * Two implementations, both honest about where their statements come from.
 * There is deliberately no crawler, no HTTP client and no credential handling
 * in this file: DEALORA_BLUEPRINT.md §43 forbids building the product around
 * bypassing authentication, platform protections, API restrictions,
 * robots/access controls or account limits, and DEALORA_BLUEPRINT.md §73 names
 * "scraper" as positioning to avoid.
 *
 * A real provider for an authorized API or permitted public source belongs here
 * behind the same {@link ResearchProvider} interface, with its own terms,
 * rate-limit handling and attribution. This phase ships none, and nothing
 * here pretends otherwise.
 */

/** The provider id of the user-provided-record source. */
export const ACCOUNT_RECORD_PROVIDER_ID = "account_record";

/**
 * The provider this phase ships with: the workspace's own account record.
 *
 * DEALORA_BLUEPRINT.md §43 lists *user-provided data* as a permitted source,
 * and it is the only source that needs no external access at all. Every finding
 * it emits is a restatement of what the workspace supplied, attributed to that
 * record — it says nothing about the wider world, and its confidence is
 * `medium` because provenance strength is not verification.
 */
export class AccountRecordProvider implements ResearchProvider {
  readonly id = ACCOUNT_RECORD_PROVIDER_ID;
  readonly source = "account_record" as const;

  research(query: ResearchQuery): ResearchProviderResult {
    const findings: RawProviderFinding[] = [];
    const asked = (category: string): boolean =>
      (query.categories as readonly string[]).includes(category);

    // Only the fields the user actually supplied produce a finding. A missing
    // value is reported as missing, never filled in.
    const add = (
      category: (typeof query.categories)[number],
      field: string,
      value: string | null,
      citation: string | null = null,
    ): void => {
      if (value === null || !asked(category)) return;
      findings.push({
        category,
        field,
        value,
        // "fact" means this record states this, not that DEALORA verified it.
        claimKind: "fact",
        // The citation is the record's own website where that is what the
        // statement is about, and nothing invented otherwise.
        sourceUrl: citation,
        sourceTitle: "workspace account record",
        observedAt: null,
        confidence: "medium",
        relevance: "high",
        note: null,
      });
    };

    add("company_overview", "name", query.accountName);
    add("company_overview", "website", query.website, query.website);
    add("company_overview", "domain", query.domain, query.website);
    add("company_overview", "company_size", query.companySize);
    add("company_overview", "geography", query.geography);
    add("company_overview", "description", query.description);
    add("industry", "industry", query.industry);

    return { ok: true, findings };
  }
}

/**
 * A provider that returns exactly the observations it was handed.
 *
 * Used by tests and by anyone who wants to replay a recorded answer. It
 * performs **no** retrieval of any kind: there is no network call, no file
 * read and no source it consults. Its `source` is declared by whoever builds
 * it, and the domain validates that declaration before storing anything.
 */
export class StaticResearchProvider implements ResearchProvider {
  readonly id: string;
  readonly source: ResearchProvider["source"];

  private readonly observations: readonly RawProviderFinding[];
  private readonly filterToScope: boolean;

  constructor(
    id: string,
    source: ResearchProvider["source"],
    observations: readonly RawProviderFinding[],
    options?: { filterToScope?: boolean },
  ) {
    this.id = id;
    this.source = source;
    this.observations = observations;
    this.filterToScope = options?.filterToScope ?? true;
  }

  research(query: ResearchQuery): ResearchProviderResult {
    const scope = query.categories as readonly string[];
    const findings = this.filterToScope
      ? this.observations.filter(
          (f) => typeof f?.category === "string" && scope.includes(f.category),
        )
      : [...this.observations];
    return { ok: true, findings };
  }
}

/**
 * Rules and rulings tools (Commander workshop: rules and combo intelligence).
 *
 * `rules_lookup` and `rules_search` answer from the stored Comprehensive Rules
 * release verbatim; `card_rulings` returns a card's published rulings by
 * Oracle identity; `rules_refresh` is the only network path and publishes a
 * new corpus version atomically. Every response carries the corpus provenance
 * (release URL, digest, effective date, retrieval time, staleness) so a cited
 * rule number is always tied to the release it came from. None of these tools
 * interpret rules or judge an interaction.
 */
import { z } from "zod";
import type { CardIndex } from "../index/index.js";
import type { RulesService } from "../rules/index.js";
import { RULE_SEARCH_MAX_LIMIT } from "../rules/index.js";
import { StructuredError, type CardRuling, type RulingSourceType } from "../types/index.js";
import { normalizeStrings, resolveCardIdLenient, StringOrStringsSchema } from "./resolve.js";
import { READS_LOCAL, mutates } from "./registry.js";
import type { ToolDefinition } from "./registry.js";

/** Identifier and term batches are bounded so one call never dumps the corpus. */
const LOOKUP_BATCH_LIMIT = 25;
const CARD_BATCH_LIMIT = 25;

/** Only Wizards' media host is an acceptable explicit release source. */
const RELEASE_HOST = /(^|\.)wizards\.com$/i;

function requireCorpus(service: RulesService) {
  const corpus = service.corpus;
  if (!corpus) {
    throw new StructuredError(
      "UPSTREAM_UNAVAILABLE",
      "No Comprehensive Rules corpus is stored; call rules_refresh first",
      { reason: "rules corpus unavailable" },
    );
  }
  return corpus;
}

function rulesLookupTool(service: RulesService): ToolDefinition {
  return {
    name: "rules_lookup",
    config: {
      annotations: READS_LOCAL,
      title: "Comprehensive Rules lookup",
      description:
        "Return exact Comprehensive Rules text by rule number or glossary term, with release provenance.\n" +
        "USE: citing a rule (903.5a), a section (903) or a defined term. NOT: keyword discovery (rules_search); card rulings (card_rulings); legality (validate_deck).\n" +
        "FLOW: rules_search -> rules_lookup -> validate_deck.\n" +
        "ARGS: rules: id | [ids] (chapter, section, rule or subrule; max 25); glossary: term | [terms] (max 25). At least one.\n" +
        "RETURNS: corpus {status current|stale|unavailable, version, comprehensive_rules {url, sha256, effective_date, retrieved_at}, rulings}, rules[] {status found|unknown, kind, rule/section/chapter, nearest}, glossary[], found, unknown. Unknown ids are reported, never guessed.",
      inputSchema: {
        rules: StringOrStringsSchema.optional(),
        glossary: StringOrStringsSchema.optional(),
      },
      // Keep the established catalog contract: no advertised outputSchema.
    },
    handler: (args) => {
      const rules = normalizeStrings(args.rules).slice(0, LOOKUP_BATCH_LIMIT);
      const terms = normalizeStrings(args.glossary).slice(0, LOOKUP_BATCH_LIMIT);
      if (rules.length === 0 && terms.length === 0) {
        throw new StructuredError("INVALID_QUERY", "provide rules and/or glossary terms", {
          examples: ['{"rules":"903.5a"}', '{"glossary":"commander tax"}'],
        });
      }
      const corpus = requireCorpus(service);
      const ruleHits = rules.map((id) => corpus.lookup(id));
      const glossaryHits = terms.map((term) => corpus.glossary(term));
      const found =
        ruleHits.filter((h) => h.status === "found").length +
        glossaryHits.filter((h) => h.status === "found").length;
      const unknown = ruleHits.length + glossaryHits.length - found;
      return {
        content: [{ type: "text", text: `${found} found, ${unknown} unknown` }],
        structuredContent: {
          corpus: service.status(),
          rules: ruleHits,
          glossary: glossaryHits,
          found,
          unknown,
        },
      };
    },
  };
}

function rulesSearchTool(service: RulesService): ToolDefinition {
  return {
    name: "rules_search",
    config: {
      annotations: READS_LOCAL,
      title: "Comprehensive Rules search",
      description:
        "Search the stored Comprehensive Rules for rules containing every query word, with bounded excerpts.\n" +
        "USE: finding which rule covers a concept (commander tax, color identity, partner). NOT: exact text of a known number (rules_lookup); card-specific rulings (card_rulings).\n" +
        "FLOW: rules_search -> rules_lookup -> card_rulings.\n" +
        "ARGS: query; limit (default 10, max 25); section (chapter or section prefix, e.g. 903); excerpt_chars (80-600, default 240).\n" +
        "RETURNS: corpus provenance; tokens; total_matches; returned; truncated; results[] {number, section, excerpt, matches, complete}; glossary[] {term, excerpt}. Read the full rule with rules_lookup before citing it.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(RULE_SEARCH_MAX_LIMIT).optional(),
        section: z.string().optional(),
        excerpt_chars: z.number().int().min(80).max(600).optional(),
      },
    },
    handler: (args) => {
      const corpus = requireCorpus(service);
      const result = corpus.search(String(args.query ?? ""), {
        limit: typeof args.limit === "number" ? args.limit : undefined,
        section: typeof args.section === "string" ? args.section : undefined,
        excerpt_chars: typeof args.excerpt_chars === "number" ? args.excerpt_chars : undefined,
      });
      return {
        content: [
          {
            type: "text",
            text: `${result.returned} of ${result.total_matches} matching rule(s), ${result.glossary.length} glossary term(s)`,
          },
        ],
        structuredContent: { corpus: service.status(), ...result },
      };
    },
  };
}

function rulesRefreshTool(service: RulesService): ToolDefinition {
  return {
    name: "rules_refresh",
    config: {
      annotations: mutates({ destructive: false, idempotent: true, openWorld: true }),
      title: "Rules corpus refresh",
      description:
        "Download the current Comprehensive Rules release and Scryfall's rulings export, then publish them as a new local corpus version.\n" +
        "USE: first use of the rules tools; a corpus reported stale. NOT: card data (data_ingest); reading rules (rules_lookup).\n" +
        "FLOW: rules_lookup -> rules_refresh -> rules_search.\n" +
        "ARGS: force:true re-downloads unchanged sources; url: explicit release .txt on a wizards.com host (recorded as explicit provenance).\n" +
        "RETURNS: ok, skipped (sources unchanged), version, corpus provenance. Runs inline (a few MB); a failed or malformed download keeps the previous corpus and returns UPSTREAM_UNAVAILABLE.",
      inputSchema: {
        force: z.boolean().optional(),
        url: z.string().optional(),
      },
    },
    handler: async (args) => {
      let url: string | undefined;
      if (typeof args.url === "string" && args.url.length > 0) {
        const parsed = URL.canParse(args.url) ? new URL(args.url) : null;
        if (!parsed || parsed.protocol !== "https:" || !RELEASE_HOST.test(parsed.hostname)) {
          throw new StructuredError(
            "INVALID_QUERY",
            "url must be an https release on a wizards.com host",
            {
              examples: ["https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt"],
            },
          );
        }
        url = parsed.toString();
      }
      const outcome = await service.refresh({ force: args.force === true, url });
      if (!outcome.ok) {
        throw new StructuredError(outcome.error.code, outcome.error.message, {
          reason: "previous corpus retained",
        });
      }
      return {
        content: [
          {
            type: "text",
            text: outcome.skipped
              ? `rules corpus unchanged (${outcome.version})`
              : `rules corpus published (${outcome.version})`,
          },
        ],
        structuredContent: {
          ok: true,
          skipped: outcome.skipped,
          version: outcome.version,
          corpus: service.status(),
        },
      };
    },
  };
}

const SOURCE_FILTERS = ["all", "wizards_ruling", "provider_note"] as const;

function cardRulingsTool(service: RulesService, index: CardIndex): ToolDefinition {
  return {
    name: "card_rulings",
    config: {
      annotations: READS_LOCAL,
      title: "Card rulings",
      description:
        "Return a card's published rulings by Oracle identity, separating Wizards rulings from provider notes.\n" +
        "USE: how a specific card's ability works in practice. NOT: general rules text (rules_lookup); mechanics spans (card_mechanics); legality (validate_card).\n" +
        "FLOW: card_get -> card_rulings -> rules_lookup.\n" +
        "ARGS: cards: name | [names or oracle_ids] (max 25); source: all (default) | wizards_ruling | provider_note.\n" +
        "RETURNS: corpus provenance; cards[] {oracle_id, name, rulings_status recorded|none_recorded|unavailable, counts, rulings[] {source, source_type, published_at, comment}}; missing[]. none_recorded means the export lists no ruling for the card; unavailable means no rulings corpus is stored.",
      inputSchema: {
        cards: StringOrStringsSchema,
        source: z.enum(SOURCE_FILTERS).optional(),
      },
    },
    handler: async (args) => {
      const entries = normalizeStrings(args.cards).slice(0, CARD_BATCH_LIMIT);
      const filter: (typeof SOURCE_FILTERS)[number] =
        typeof args.source === "string" &&
        (SOURCE_FILTERS as readonly string[]).includes(args.source)
          ? (args.source as (typeof SOURCE_FILTERS)[number])
          : "all";
      const rulings = await service.rulings();
      const cards = [];
      const missing: string[] = [];
      for (const entry of entries) {
        const id = resolveCardIdLenient(index, entry);
        const card = index.getCard(id);
        if (!card) {
          missing.push(id);
          continue;
        }
        if (!rulings) {
          cards.push({
            oracle_id: card.oracle_id,
            name: card.name,
            rulings_status: "unavailable" as const,
            counts: null,
            rulings: [] as CardRuling[],
          });
          continue;
        }
        const all = rulings.rulingsFor(card.oracle_id);
        const selected =
          filter === "all"
            ? all
            : all.filter((r: CardRuling) => r.source_type === (filter as RulingSourceType));
        cards.push({
          oracle_id: card.oracle_id,
          name: card.name,
          rulings_status: rulings.has(card.oracle_id)
            ? ("recorded" as const)
            : ("none_recorded" as const),
          counts: rulings.countsFor(card.oracle_id),
          rulings: selected,
        });
      }
      const total = cards.reduce((sum, c) => sum + c.rulings.length, 0);
      return {
        content: [
          {
            type: "text",
            text: `${cards.length} found, ${missing.length} missing; ${total} ruling(s) returned`,
          },
        ],
        structuredContent: {
          corpus: service.status(),
          source_filter: filter,
          cards,
          missing,
        },
      };
    },
  };
}

/** Rules tools that need no card index: registered unconditionally. */
export function makeRulesTools(service: RulesService): ToolDefinition[] {
  return [rulesLookupTool(service), rulesSearchTool(service), rulesRefreshTool(service)];
}

/** Card-scoped rulings, bound to a CardIndex for name resolution. */
export function makeCardRulingsTools(service: RulesService, index: CardIndex): ToolDefinition[] {
  return [cardRulingsTool(service, index)];
}

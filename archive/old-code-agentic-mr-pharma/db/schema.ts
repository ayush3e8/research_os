import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
  pgEnum,
  boolean,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums — Section 5
// ---------------------------------------------------------------------------

// "double_blind" is the operating default (Jul 2 decision, Ayush): sponsor
// identity hidden from respondent AND respondent-identifiable data hidden
// from sponsor, simultaneously. It's genuinely the combination of
// sponsor_blind + respondent_blind, not a fourth independent mode, but the
// schema models it as one named value (matches how Section 7 already talks
// about "double-blind studies" as a distinct category with its own sender-
// identity/copy requirements) rather than splitting blinding into two
// columns. Every study is double_blind unless a human explicitly picks
// something more open for a specific engagement.
export const blindingModeEnum = pgEnum("blinding_mode", [
  "open",
  "sponsor_blind",
  "respondent_blind",
  "double_blind",
]);

export const studyPurposeEnum = pgEnum("study_purpose", [
  "product_validation",
  "panel_seeding",
  "gtm_research",
  "client_deliverable",
]);

export const onDeadlineEnum = pgEnum("on_deadline", [
  "extend",
  "notify",
  "close",
]);

export const studyStatusEnum = pgEnum("study_status", [
  "draft",
  "pending_approval",
  "approved",
  "recruiting",
  "in_progress",
  "synthesis",
  "complete",
  "closed",
  // Jul 18 (context intake) — a study row exists but nothing has been
  // drafted yet; it's accumulating raw context (chat, file, voice) toward
  // one synthesis pass that produces designInputs. Distinct from "draft"
  // (which today only ever appears as the pre-insert default — no
  // real row has ever stayed in that status, since db/draft-study.ts and
  // the console's draft route both insert directly at pending_approval).
  "intake",
]);

export const respondentTypeEnum = pgEnum("respondent_type", [
  "friend",
  "physician",
  "nurse",
  "office_staff",
  "pharma_contact",
  "patient_future",
]);

export const dataSourceEnum = pgEnum("data_source", [
  "referral",
  "apollo",
  "npi",
  "manual",
  // Jul 9 (target-list ingestion) — a client-provided CSV target list,
  // distinct from "manual" (a human typing one respondent in) and from
  // "referral" (a warm, trust-inheriting introduction). List-sourced
  // contacts are cold by default (lib/target-list-agent.ts) even though
  // they came with real background — see the Day 5 opt-in-default
  // correction this follows the same discipline as.
  "target_list_upload",
]);

export const optInStatusEnum = pgEnum("opt_in_status", [
  "not_contacted",
  "invited",
  "opted_in",
  "declined",
  "opted_out",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "triggered",
  "paid",
  "failed",
]);

// Jul 2 (pause/resume awareness) — "completed" mirrors call_completed_at
// but is queryable without a null-check; "abandoned" is set by a scheduled
// sweep once a paused interview passes its resume window with no
// completion. Deliberately NOT a payment decision by itself — Payment
// Agent doesn't exist yet, and even once it does, an abandoned interview
// may be substantially complete (a real judgment call, per Ayush). This is
// a visibility flag for that judgment call, same pattern as AE flags, not
// an auto-deny.
// "ended_by_respondent" (Jul 2, added with the End Interview button):
// distinct from "abandoned" — this is a deliberate, confirmed stop by the
// respondent, not a passive timeout after an accidental drop. Matters for
// two things: Recruitment Agent's reminder sweep must never nudge someone
// who explicitly said they were done, and it's a materially different
// signal for the payment judgment call than an ambiguous abandonment.
export const completionStatusEnum = pgEnum("completion_status", [
  "in_progress",
  "completed",
  "abandoned",
  "ended_by_respondent",
  // Sep 8 — a written-quant-survey study (studies.quantSurvey) whose
  // respondent never reached the voice portion, either disqualified in the
  // screener-equivalent section or completed the survey but declined the
  // voice opt-in. Genuinely terminal (never resumable), distinct from
  // ended_by_respondent (implies a call was in progress) and abandoned
  // (implies something was started and stalled, not deliberately declined).
  "survey_only",
]);

// Knowledge acquisition source tiers (Jul 3 design) — not every accredited
// source is equally authoritative for every kind of fact. The Knowledge
// Acquisition Agent's real skill is knowing which tier to reach for, and
// every synthesized entry carries its tier forward so downstream agents
// can frame confidence accordingly (a Tier 4 single-study finding gets
// "one study found X" framing, never guideline-level confidence).
export const knowledgeSourceTierEnum = pgEnum("knowledge_source_tier", [
  "tier1_regulatory", // FDA, DailyMed, ClinicalTrials.gov, EMA
  "tier2_prescribing_info", // full PI / package insert
  "tier3_guidelines", // NCCN, ACC/AHA, ACR, ADA, GOLD, IDSA, KDIGO, AASLD, etc.
  "tier4_literature", // PubMed, Cochrane, major journals
  "tier5_epidemiology", // SEER, CDC WONDER, Orphanet
  "tier6_client_provided", // sponsor's own materials — highest priority for their own product, always client-confidential
]);

// Confidentiality is driven by PROVENANCE, not subject matter (Jul 3 design)
// — a public fact "about" a competitor's drug (their own FDA label) is safe
// to reuse anywhere; something a client told us in confidence about their
// own strategy is not, regardless of which drug/indication it's tagged
// with. This is what actually enforces the cross-client isolation boundary,
// not the presence of a client tag by itself.
export const knowledgeConfidentialityEnum = pgEnum("knowledge_confidentiality", [
  "public",
  "client_confidential",
]);

// Mirrors ae_flag_status's "never auto-clears" pattern — synthesized
// knowledge is always a draft until a human reviews it against its cited
// source, same status as a drafted discussion guide before Step 3 approval.
export const knowledgeReviewStatusEnum = pgEnum("knowledge_review_status", [
  "needs_review",
  "approved",
]);

// Jul 5 design (operator console) — Section 9 originally called for a
// conversational-only operator surface, no dashboard. Reversed once Ayush
// hit real limits tracking everything across chat: this is his channel to
// "talk to his tech team" async, not a config store — the console reads
// agent prompts and study data live from source (code + DB), never a copy
// of them, so nothing here can go stale. operatorNotes is the one thing the
// console itself owns: an append-only thread per target (a study, or an
// agent by its stable key), read by both sides — Ayush leaves a note,
// Claude reads it, acts on the actual source, and can reply in the same
// thread. targetId is text (not uuid) so it works for both a study's uuid
// and an agent's string key (e.g. "study-design-agent").
export const operatorNoteTargetTypeEnum = pgEnum("operator_note_target_type", [
  "study",
  "agent",
  "new_agent_request",
]);

export const operatorNoteAuthorEnum = pgEnum("operator_note_author", ["ayush", "claude"]);

export const operatorNotes = pgTable("operator_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetType: operatorNoteTargetTypeEnum("target_type").notNull(),
  targetId: text("target_id").notNull(),
  author: operatorNoteAuthorEnum("author").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Knowledge base facets (Jul 3 design) — a drug can span multiple
// indications (Humira: RA, PsA, Crohn's, UC, psoriasis...), and indications
// don't nest cleanly under one therapeutic area either. So these are
// independent facets a knowledge_base entry can be tagged with any
// combination of, not a strict tree — specificity falls out of how many
// facets are set, not from hierarchy depth.
// ---------------------------------------------------------------------------

export const therapeuticAreas = pgTable("therapeutic_areas", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Self-referential nesting (Jul 4 design) — an indication can sit inside a
// broader one at arbitrary depth: Breast Cancer -> Metastatic Breast Cancer
// -> HER2-negative Metastatic Breast Cancer. A root indication (no parent)
// IS the "therapy area" in Ayush's category/area/sub-indication terminology
// — CSU stays a single-node tree (root, no children needed), oncology can
// nest as deep as real studies require. Not every indication needs a
// parent; most won't. See lib/knowledge-acquisition-agent.ts for how this
// drives research focus (always the exact node) vs. reused context (the
// immediate parent only — see getIndicationAncestry).
export const indications = pgTable("indications", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  // Typical/primary TA — informational default, not an access-control
  // constraint. A study can still cut across TAs if it genuinely needs to.
  primaryTherapeuticAreaId: uuid("primary_therapeutic_area_id").references(() => therapeuticAreas.id),
  parentIndicationId: uuid("parent_indication_id").references((): any => indications.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Real access-control key for knowledge base client-confidentiality —
// deliberately stricter than studies.sponsorName, which stays bookkeeping-
// only by design (Jul 2 decision: grants no access, buildsOnStudyIds is the
// only door). Client-level KNOWLEDGE wants the opposite default: a client
// should get their own domain knowledge carried forward across their
// studies automatically. The one hard rule is it must never cross to a
// different client.
export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const drugs = pgTable("drugs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  clientId: uuid("client_id").references(() => clients.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Many-to-many — a drug can span many indications, and (for landscape
// studies) an indication can be treated by many drugs across clients.
export const drugIndications = pgTable("drug_indications", {
  id: uuid("id").primaryKey().defaultRandom(),
  drugId: uuid("drug_id").notNull().references(() => drugs.id),
  indicationId: uuid("indication_id").notNull().references(() => indications.id),
});

// ---------------------------------------------------------------------------
// knowledge_base — Section [Jul 3 addition]: synthesized, structured
// background knowledge for Study Design Agent and Interview Agent to draw
// on, reusable across studies at whichever facet grain applies (TA-wide,
// indication-wide, client-wide, drug-wide, or a specific intersection).
// Never raw source dumps — see lib/knowledge-acquisition-agent.ts for why
// synthesis beats handing agents whole documents. Always draft until a
// human approves it (reviewStatus), same Step 3 gate as the rest of a
// study's config.
// ---------------------------------------------------------------------------

export const knowledgeBase = pgTable("knowledge_base", {
  id: uuid("id").primaryKey().defaultRandom(),

  topic: text("topic").notNull(),
  summary: text("summary").notNull(),
  // Atomic, individually-citable facts — easier for an agent to selectively
  // reference than a paragraph, and easier for a human to spot-check one
  // at a time against the source.
  keyFacts: jsonb("key_facts").notNull().default([]), // string[]
  // High-stakes categories (boxed warnings, contraindications, anything
  // AE-adjacent) are preserved verbatim rather than paraphrased — agents
  // are instructed to quote these, never characterize them in their own
  // words. Shape: [{ quote: string, sourceLocation?: string }]
  verbatimExcerpts: jsonb("verbatim_excerpts").notNull().default([]),
  // Only meaningfully populated for tier4_literature — "a single study
  // found X" framing, never presented with guideline-level confidence.
  caveats: text("caveats"),

  sourceTier: knowledgeSourceTierEnum("source_tier").notNull(),
  sourceCitation: text("source_citation").notNull(), // URL or reference, always required
  // Raw acquired material is retained for audit/traceability (a human can
  // verify the synthesis against the original) but is never itself served
  // into an agent's prompt — same "reference, never inline" pattern as
  // transcriptUrl/audioUrl.
  rawSourceRef: text("raw_source_ref"),

  confidentiality: knowledgeConfidentialityEnum("confidentiality").notNull().default("public"),

  // Facets — independent, optional. Null means "applies broadly at this
  // dimension," not "unknown."
  therapeuticAreaId: uuid("therapeutic_area_id").references(() => therapeuticAreas.id),
  indicationId: uuid("indication_id").references(() => indications.id),
  clientId: uuid("client_id").references(() => clients.id),
  drugId: uuid("drug_id").references(() => drugs.id),

  reviewStatus: knowledgeReviewStatusEnum("review_status").notNull().default("needs_review"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: text("approved_by"),

  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Which of ElevenLabs' two pronunciation-override mechanisms a term uses.
// "phoneme" (IPA/CMU) only takes effect on eleven_flash_v2/eleven_v3 models
// (confirmed against the live agent, currently eleven_flash_v2 — see Jul 6
// pronunciation-dictionary research) and gives the most precise control;
// "alias" (respelling substitution, e.g. "palbociclib" -> "pal-boh-SYE-klib")
// works on any TTS model and is the fallback for terms IPA doesn't render
// reliably. Both compile into the same .pls dictionary file.
export const pronunciationNotationEnum = pgEnum("pronunciation_notation", [
  "ipa",
  "alias",
]);

export const pronunciationCategoryEnum = pgEnum("pronunciation_category", [
  "drug_molecule", // generic/INN name, e.g. "palbociclib"
  "drug_brand", // brand name, e.g. "Ibrance"
  "indication", // disease/indication name
  "biomarker",
  "glossary", // general healthcare abbreviations/jargon (HCP, IDN, ONC...)
]);

// ---------------------------------------------------------------------------
// pronunciation_terms — Jul 6 addition: "pharma grade... shouldn't be taken
// lightly" (Ayush). Complex drug/molecule/indication/biomarker names and
// healthcare jargon get mispronounced by TTS by default; this is the
// reviewed, versioned source of truth compiled into an ElevenLabs
// pronunciation dictionary (lib/pronunciation-agent.ts). Facet-tagged the
// same way as knowledge_base (independent, optional — null means "applies
// broadly") so a glossary term like "HCP" is global while "palbociclib" is
// scoped to its drug. Same never-auto-approve discipline as knowledge_base:
// Claude drafts a candidate pronunciation, a human confirms it actually
// sounds right before it ships to the live agent.
// ---------------------------------------------------------------------------

export const pronunciationTerms = pgTable("pronunciation_terms", {
  id: uuid("id").primaryKey().defaultRandom(),

  term: text("term").notNull(), // the literal word/phrase as it appears in speech, e.g. "Ibrance"
  category: pronunciationCategoryEnum("category").notNull(),

  notation: pronunciationNotationEnum("notation").notNull(),
  // IPA string (e.g. "/ˌpalboʊˈsaɪklɪb/") or alias respelling
  // (e.g. "pal boh SYE klib"), depending on notation.
  value: text("value").notNull(),
  alphabet: text("alphabet"), // "ipa" or "cmu", only meaningful when notation = "ipa"

  rationale: text("rationale"), // brief note on why this pronunciation was chosen, for the human reviewer

  // Facets — independent, optional, same semantics as knowledge_base's.
  therapeuticAreaId: uuid("therapeutic_area_id").references(() => therapeuticAreas.id),
  indicationId: uuid("indication_id").references(() => indications.id),
  drugId: uuid("drug_id").references(() => drugs.id),

  reviewStatus: knowledgeReviewStatusEnum("review_status").notNull().default("needs_review"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: text("approved_by"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// studies — Section 5: "Every pilot phase and every future study is a row
// here, not a new build." This is the config a real pharma client's request
// becomes, per Section 1's "Study is a configuration, not a codebase."
// ---------------------------------------------------------------------------

export const studies = pgTable("studies", {
  id: uuid("id").primaryKey().defaultRandom(),

  title: text("title").notNull(),
  brief: text("brief").notNull(), // founder's original study brief (Step 1, Section 4)

  // Jul 18 real gap: the structured input actually given to Study Design
  // Agent (StudyDesignInput — targetAudienceDescription, objectives,
  // requiredProbes, sampleCompositionNotes, stimuliDescription, plus the
  // commercial facts) was never persisted, only used transiently to call
  // draftStudy() — so there was no way to look back and see exactly what
  // produced a given guide. This is a straight snapshot of that input
  // object, written once at draft time, never edited afterward (it's a
  // record of what was asked for, not a live config). Null for every study
  // drafted before this field existed — doesn't backfill retroactively.
  designInputs: jsonb("design_inputs"),

  // Jul 18 (context intake) — raw material accumulated toward designInputs,
  // before a synthesis pass turns it into the structured shape above.
  // Append-only, same jsonb-bag convention as recruitmentLog/pauseResumeLog
  // rather than a relational table — this is genuinely just a log, no
  // querying-by-item ever needed. Populated by any combination of the three
  // intake modalities (chat, file upload, voice interview) — synthesis
  // treats them identically, it never needs to know which modality a given
  // item came from beyond what's in `type`. Never cleared once synthesis
  // runs — a re-synthesis (e.g. after adding more context) re-reads the
  // full accumulated list, not just what's new since the last pass.
  // Shape: { type: "chat_user" | "chat_assistant" | "file" | "voice_transcript",
  //          content: string, fileName?: string, createdAt: string }[]
  intakeItems: jsonb("intake_items").notNull().default([]),

  // Jul 17 real gap found on the v2 biopharma study: `title` is an internal
  // tracking name (can carry versioning like "(v2)", internal shorthand) and
  // was being shown on the interview page AND read verbatim by the
  // moderator ("this is a short interview for '...'") — clunky and exposes
  // internal naming to a real respondent. externalTitle is the short, clean,
  // respondent-facing name shown on the interview page in its place.
  // spokenIntroduction is a natural sentence fragment describing what the
  // conversation is about, completing "Hi, thanks for joining — this is
  // ___" — used by the moderator's opener instead of reading any name/title
  // at all. Both drafted by Study Design Agent alongside externalDescription
  // and reviewed at the same Step 3 gate.
  externalTitle: text("external_title").notNull().default(""),
  spokenIntroduction: text("spoken_introduction").notNull().default(""),

  // Array of lib/types.ts DiscussionGuideItem — either a plain topic string
  // (every study before Jul 9) or {text, question} pairing guide text with a
  // tap-to-answer question shown via the show_question client tool. No
  // migration needed for the shape change since jsonb stores both forms.
  discussionGuide: jsonb("discussion_guide").notNull().default([]),
  guardrailPrompt: text("guardrail_prompt").notNull().default(""),

  // Respondent-facing description of what this study is/involves — distinct
  // from the internal discussion guide, used in recruitment/invite copy.
  // Drafted by Study Design Agent alongside the rest of the config and
  // reviewed at the same Step 3 approval gate (Jul 2 human-in-the-loop
  // design — no separate review point for this).
  externalDescription: text("external_description").notNull().default(""),

  // Pre-interview screener, drafted alongside the discussion guide by the
  // Study Design Agent (not hardcoded per-study logic — this is what keeps
  // screening a config concern, not a new agent). Web-form, not voice: it's
  // faster for the respondent and needs no mic/consent just to check fit.
  // Shape: [{ id, question, options: [{ label, value, qualifies }] }]
  screener: jsonb("screener").notNull().default([]),
  screenerDisqualifiedMessage: text("screener_disqualified_message"),
  estimatedMinutes: integer("estimated_minutes").notNull().default(12),

  // Sep 8 — a written, web-form quant instrument (grids, forced ranking,
  // multi-select, numeric/skip-logic screening, conditional open text) that
  // runs before the voice interview, for studies whose real instrument is
  // richer than plain qualify/disqualify screener can express. Null/empty
  // means "this study doesn't use one" — every existing study is unaffected.
  // A purpose-built renderer (not a generic multi-study survey builder,
  // deliberately — revisit only once a second real instrument needs this)
  // interprets this shape; question CONTENT lives here so it's editable
  // without a deploy, same as screener/discussionGuide, but branching logic
  // for this specific instrument's skip/terminate/dynamic-substitution rules
  // lives in code, not as a generic rule engine.
  // Shape: { sections: [{ id, title, questions: [{ id, type, text, options?,
  //   points? }] }] }
  quantSurvey: jsonb("quant_survey"),

  // Optional visual stimuli (images) shown mid-interview — not every study
  // uses these, hence optional and empty by default. The discussion guide
  // text tells Claude when to show one (by id); Claude calls the show_stimulus
  // client tool, which the browser handles by rendering the image.
  // Shape: [{ id, imageUrl, caption }]
  stimuli: jsonb("stimuli").notNull().default([]),

  // Jul 15 per-study ElevenLabs agent provisioning — null means "use the
  // shared default agent" (ELEVENLABS_AGENT_ID env var), the existing
  // behavior every study had before this column existed. Set once
  // lib/elevenlabs-agent-provisioning.ts creates a dedicated agent for this
  // study at approval time. A dedicated agent exists because several real
  // fields (tool_ids, max_duration_seconds, pronunciation dictionary) are
  // agent-level only — ElevenLabs' conversation_config_override can't touch
  // them per-call (confirmed against the live API on three separate real
  // bugs this project hit: Jul 2 max_duration_seconds, Jul 6 pronunciation
  // dictionary, Jul 15 show_stimulus hallucinating on stimuli-less studies).
  elevenlabsAgentId: text("elevenlabs_agent_id"),

  targetN: integer("target_n").notNull(),
  nReached: integer("n_reached").notNull().default(0),

  // Null = today's default, bounded only by the study staying open/approved
  // (Ayush, Jul 2) — no separate clock. Set a specific value later for
  // studies that need a tighter pause/resume window than "however long the
  // study runs."
  resumeTimeoutHours: integer("resume_timeout_hours"),

  respondentFilterCriteria: jsonb("respondent_filter_criteria")
    .notNull()
    .default({}),
  paymentTier: numeric("payment_tier").notNull(), // honorarium amount, Section 11 tiers

  blindingMode: blindingModeEnum("blinding_mode").notNull().default("double_blind"),
  purpose: studyPurposeEnum("purpose").notNull(),
  onDeadline: onDeadlineEnum("on_deadline").notNull().default("notify"),
  deliverableFormat: text("deliverable_format").notNull().default("briefing_pdf"),

  // AE/compliance screening removed (Jul 20) — was incorrectly implemented
  // and repeatedly mis-flagging; ripped out end-to-end rather than left
  // half-wired. Needs a real re-implementation later — see CLAUDE.md.

  status: studyStatusEnum("status").notNull().default("draft"),

  // Bookkeeping tag only — which real-world client/sponsor this study is
  // for. Deliberately carries NO access-control meaning: matching
  // sponsorName never by itself unlocks cross-study content for any agent
  // (Jul 2 correction, Ayush). Null for Phase 1-3 (no real external client
  // yet).
  sponsorName: text("sponsor_name"),

  // The ONLY thing that lets Interview Agent see a specific respondent's
  // prior-study content — an explicit, human-approved (Step 3) list of
  // study ids this one deliberately builds upon. Empty by default, meaning
  // every study is independent from Interview Agent's perspective even for
  // the same sponsorName. Never inferred automatically. Synthesis/
  // Deliverable Agent (not built yet) may separately use sponsorName and/or
  // this field for deliberate cross-study analysis — that's a different,
  // looser latitude at the reporting layer, not automatic either.
  buildsOnStudyIds: jsonb("builds_on_study_ids").notNull().default([]),

  // Knowledge base facet scope for this study (Jul 3 addition) — distinct
  // from sponsorName above: clientId IS a real access-control key (a
  // client-confidential knowledge_base entry is hard-partitioned to this
  // id), whereas sponsorName stays deliberately bookkeeping-only for
  // respondent content. A study can span multiple indications/drugs (one
  // drug spans many indications — Humira is the classic case), hence
  // arrays rather than single FKs; therapeuticAreaId is usually singular
  // but nullable for a fully drug/indication-agnostic study.
  clientId: uuid("client_id").references(() => clients.id),
  therapeuticAreaId: uuid("therapeutic_area_id").references(() => therapeuticAreas.id),
  indicationIds: jsonb("indication_ids").notNull().default([]), // string[] (indication uuids)
  drugIds: jsonb("drug_ids").notNull().default([]), // string[] (drug uuids)

  targetStartAt: timestamp("target_start_at", { withTimezone: true }),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }), // Step 3 human gate
  approvedBy: text("approved_by"),

  // Jul 20 (Studies UI rebuild) — archive, not delete: real studies with
  // real respondent data must never be destroyed, but a study that's no
  // longer relevant shouldn't clutter every list either. Every console
  // query that lists studies filters archivedAt IS NULL by default; the row
  // and everything attached to it stays intact. No unarchive UI yet — the
  // data is recoverable directly if ever needed, just not exposed as a
  // one-click action until there's a real reason to build one.
  archivedAt: timestamp("archived_at", { withTimezone: true }),

  // Jul 20 (Studies UI rebuild) — consent/disclosure copy made genuinely
  // per-study, replacing a hardcoded template in InterviewClient.tsx that
  // was identical for every study. Ayush's direct correction: "everything
  // shown in a study should be editable for that study... nothing is ever
  // universal." Seeded from the same default template at draft time, then
  // freely editable per study from there — same treatment as guardrailPrompt.
  // Still not reviewed legal/consent language (see CLAUDE.md task #93) —
  // making it editable doesn't change that, just makes it visible and
  // owned per-study instead of buried in code.
  consentCopy: text("consent_copy").notNull().default(""),

  // Jul 20 (Studies UI rebuild) — screener and pre-interview copy are now
  // drafted independently, right after Step 2 config approval, detached
  // from the discussion-guide pipeline (Ayush: "they are independently
  // anyway once the config is approved"). Each gets its own approval
  // timestamp so Step 3's three sub-steps (screener / pre-interview copy /
  // discussion guide) can each be reviewed and approved on their own
  // schedule — final study approval requires all three. Null = not yet
  // reviewed; set once a human explicitly approves that specific artifact.
  // Editing the underlying content afterward does not clear this — approval
  // is a gate to unlock the next step, not a standing guarantee nothing's
  // changed since (same simple model the guide pipeline already uses).
  screenerApprovedAt: timestamp("screener_approved_at", { withTimezone: true }),
  introApprovedAt: timestamp("intro_approved_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// study_files — Jul 20 (Studies UI rebuild). Real, persisted file storage,
// replacing the earlier intake design where an uploaded file was summarized
// into intakeItems and the raw file itself discarded. Ayush's explicit ask:
// "Yes we should store files." Available across a study's whole lifecycle,
// not just during Discovery (Step 1) — Step 1 becomes locked once you move
// past it, but file upload never does, per the Jul 20 alignment on how
// later-arriving documents should feed the guide: a human reads the file
// and gives explicit feedback in the relevant review step, nothing here
// auto-triggers a regeneration.
// ---------------------------------------------------------------------------

export const studyFiles = pgTable("study_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  studyId: uuid("study_id").notNull().references(() => studies.id),
  fileName: text("file_name").notNull(),
  blobUrl: text("blob_url").notNull(),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// respondents — Section 5 + Section 8 ("durable respondent identity must
// exist in the data model now" for longitudinal tracking / prior-aware
// question handling, even though most tier/status UI ships later).
// ---------------------------------------------------------------------------

export const respondents = pgTable("respondents", {
  id: uuid("id").primaryKey().defaultRandom(),

  respondentType: respondentTypeEnum("respondent_type").notNull(),
  dataSource: dataSourceEnum("data_source").notNull(),

  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),

  npiNumber: text("npi_number"), // physicians only, clean provenance (Section 7)
  specialty: text("specialty"),
  // Jul 9 (target-list ingestion) — "where they work" / "role," called out
  // explicitly in the panel-lean-fields design conversation alongside name/
  // email/phone/respondentType. Dedicated columns (not folded into
  // profileNotes) since these are common enough to want to filter/query on
  // directly.
  employer: text("employer"),
  title: text("title"),

  consentBasis: text("consent_basis"),
  qualitySignal: text("quality_signal"), // primitive field now, no scoring UI yet (Section 5)
  optInStatus: optInStatusEnum("opt_in_status").notNull().default("not_contacted"),

  // Durable background facts about this person, independent of any one
  // study (practice setting, years in practice, notable context) — owned by
  // Panel Agent, accumulates over time. Factual/administrative, safe for
  // any agent to read (Jul 2 "living context" design).
  profileNotes: jsonb("profile_notes").notNull().default({}),

  // Append-only log of every recruitment touch, shared by Panel Agent
  // (study_id: null entries — panel-level: interest emails, FAQ replies,
  // panel reminders) and Recruitment Agent (study_id set — per-study
  // invites, reminders, thank-yous). One log drives reminder-cadence checks
  // for both agents without a new table.
  // Shape: [{ studyId: string | null, type: "panel_interest" | "study_invite"
  //   | "reminder" | "thank_you" | "faq_reply" | "faq_escalation", sentAt }]
  recruitmentLog: jsonb("recruitment_log").notNull().default([]),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// question_library — Section 5: reusable priors across studies, read by
// Study Design Agent (avoid re-fielding) and Synthesis Agent (trend
// comparison). Verbatims live here as a denormalized rollup; the
// authoritative per-call record is in `interactions`.
// ---------------------------------------------------------------------------

export const questionLibrary = pgTable("question_library", {
  id: uuid("id").primaryKey().defaultRandom(),

  questionText: text("question_text").notNull(),
  themeTags: jsonb("theme_tags").notNull().default([]), // string[]

  firstAskedStudyId: uuid("first_asked_study_id").references(() => studies.id),
  timesAsked: integer("times_asked").notNull().default(1),

  // [{ respondentId, studyId, interactionId, quote, sentiment }]
  verbatims: jsonb("verbatims").notNull().default([]),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// interactions — Section 5: "immutable, append-only audit log." One row per
// interview, created at consent and progressively filled in as the call
// proceeds (consent -> started -> completed -> transcript ready). Each field
// is written exactly once and never overwritten after being set — the "never
// mutate a prior fact" spirit of append-only, applied to a single evolving
// row rather than full event-sourcing. AE-triage and payment status follow
// the same rule: no in-place status overwrites, each transition gets its own
// timestamped field below. (Flagged to Ayush as a deliberate interpretation
// of "append-only" — see Day 1 confirmation.)
// ---------------------------------------------------------------------------

export const interactions = pgTable("interactions", {
  id: uuid("id").primaryKey().defaultRandom(),

  studyId: uuid("study_id")
    .notNull()
    .references(() => studies.id),
  respondentId: uuid("respondent_id")
    .notNull()
    .references(() => respondents.id),

  // Target-list-sourced background specific to why this respondent is being
  // interviewed for THIS study (e.g. "flagged as a melanoma KOL") —
  // populated by Recruitment/Panel Agent at invite time from
  // respondent_filter_criteria.targetList, fed into Interview Agent's
  // system prompt for personalization. Used contextually, never read aloud
  // verbatim. Scoped to this one study only (Jul 2 "living context" design)
  // — does not imply any cross-study content access.
  preInterviewContext: jsonb("pre_interview_context").notNull().default({}),

  // Screener — answered before consent, since it's a text form with no
  // recording/consent implications either way (Step 7 precursor)
  screenerAnswers: jsonb("screener_answers").notNull().default([]), // [{ questionId, value }]
  screenerPassed: boolean("screener_passed"),

  // Sep 8 — answers to studies.quantSurvey, one entry per question id,
  // covering both the screener-equivalent section and the richer quant
  // sections after it (this study's Section A doubles as both). Saved
  // progressively as the respondent moves through it, independent of
  // whether they ever reach or opt into the voice portion.
  quantSurveyAnswers: jsonb("quant_survey_answers").notNull().default({}),

  // Consent (Step 7)
  consentGivenAt: timestamp("consent_given_at", { withTimezone: true }),
  consentBasis: text("consent_basis"),

  // Interview (Steps 8-9)
  elevenlabsConversationId: text("elevenlabs_conversation_id"), // first/primary call session
  resumeConversationIds: jsonb("resume_conversation_ids").notNull().default([]), // subsequent reconnects, appended only
  callStartedAt: timestamp("call_started_at", { withTimezone: true }),
  callCompletedAt: timestamp("call_completed_at", { withTimezone: true }), // set only when Claude ends the call naturally (end_call tool)
  callEndedEarlyAt: timestamp("call_ended_early_at", { withTimezone: true }), // first early-disconnect only, kept for backward compat — pauseResumeLog is the real source of truth for multiple pause cycles
  completionStatus: completionStatusEnum("completion_status").notNull().default("in_progress"),

  // Real wall-clock pause/resume history (Jul 2) — distinct from ElevenLabs'
  // call_duration_secs (talk-time within a segment, says nothing about the
  // gap between segments). Appended on every early-disconnect (new entry,
  // resumedAt: null) and filled in on every genuine resume (latest open
  // entry's resumedAt set). Drives: Interview Agent's gap-aware recap
  // calibration, Recruitment Agent's "continue your interview" reminder,
  // and the resume-timeout check.
  // Shape: [{ pausedAt: string, resumedAt: string | null }]
  pauseResumeLog: jsonb("pause_resume_log").notNull().default([]),

  transcriptUrl: text("transcript_url"), // S3/R2 object reference, never inline
  audioUrl: text("audio_url"), // S3/R2 object reference, never inline
  structuredMetadata: jsonb("structured_metadata").notNull().default({}),

  // AE/compliance triage removed (Jul 20) — was incorrectly implemented and
  // repeatedly mis-flagging; ripped out end-to-end (schema, agent, consent
  // copy, moderator disclosure, marketing claims) rather than left half-wired.
  // Needs a real re-implementation later — see CLAUDE.md.

  // Payment (Step 12)
  honorariumAmount: numeric("honorarium_amount"),
  paymentStatus: paymentStatusEnum("payment_status").notNull().default("pending"),
  paymentTriggeredAt: timestamp("payment_triggered_at", { withTimezone: true }),
  paymentPaidAt: timestamp("payment_paid_at", { withTimezone: true }),

  // Jul 16 — the two-link-types design: every real respondent reaches a
  // study via a link tied to their own respondent row (?rid=), and every
  // internal test run goes through the dedicated test link
  // (?test=1, lib/test-respondent.ts's singleton respondent) instead of an
  // anonymous walk-in. This is the field that makes the two distinguishable
  // downstream — never true for a real respondent's row, always true for a
  // test-link run, regardless of how it got created.
  isTest: boolean("is_test").notNull().default(false),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Synthesis Agent's first real capability (Jul 18) — one row per interaction,
// a structured read of a completed transcript against the study's own
// discussion guide. This is the "synthesis accuracy review" gate from
// CLAUDE.md's four fixed human-in-the-loop gates — has had zero
// implementation until now (study config approval and AE/compliance flags
// already existed; this and deliverable sign-off did not). Same
// never-auto-approve discipline as knowledge_base/pronunciation_terms:
// always needs_review, a human confirms before it feeds a study-level
// rollup or a deliverable.
export const interviewSummaries = pgTable("interview_summaries", {
  id: uuid("id").primaryKey().defaultRandom(),
  interactionId: uuid("interaction_id")
    .notNull()
    .unique()
    .references(() => interactions.id),
  // Denormalized for fast per-study rollup queries later (study-level
  // insights, once that's built) without a join through interactions.
  studyId: uuid("study_id")
    .notNull()
    .references(() => studies.id),

  // Mirrors the discussion guide's own structure so findings map to real
  // guide topics, not invented ones — [{topic, summary, keyQuotes:
  // [{quote, sentiment}], coverage: "rich"|"adequate"|"thin"}].
  topicFindings: jsonb("topic_findings").notNull().default([]),
  overallSummary: text("overall_summary").notNull().default(""),
  themes: jsonb("themes").notNull().default([]), // string[]
  notableQuotes: jsonb("notable_quotes").notNull().default([]), // [{quote, topic}]

  reviewStatus: knowledgeReviewStatusEnum("review_status").notNull().default("needs_review"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: text("approved_by"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const guidePipelineStatusEnum = pgEnum("guide_pipeline_status", [
  "outline_drafting",
  "outline_needs_review",
  "outline_approved",
  "building_sections",
  "sections_complete",
  "holistic_review",
  "guide_needs_review",
  "approved",
]);

// Jul 18 — the elaborate, multi-pass discussion-guide pipeline (Ayush's
// design: outline -> section-by-section -> holistic pass, self- and
// business/researcher-lens critique-then-refine at every stage, real human
// review checkpoints after the outline and after the full guide). Scoped
// deliberately narrow: this table only ever holds the *discussion guide*
// itself — screener, guardrails, stimuli, external copy, and AE screening
// still come from the existing single-shot draftStudy() call, which the
// pipeline's final commit step still invokes, substituting this table's
// finished guide over whatever draftStudy() would have generated on its
// own. One row per study (not per attempt) — everything updates in place,
// including feedback-loop refinements, so there's exactly one current
// state to review at any point, not a history of attempts to disambiguate.
export const guideDrafts = pgTable("guide_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  studyId: uuid("study_id").notNull().unique().references(() => studies.id),
  status: guidePipelineStatusEnum("status").notNull().default("outline_drafting"),

  // Stage 1 — [{id, title, whatItCovers, estimatedMinutes}], plus the raw
  // critique text from each pass, kept visible rather than discarded once
  // acted on: "elaborate" mode's whole point (Ayush) is that seeing the
  // actual critique matters for trust, not just the end result.
  outline: jsonb("outline").notNull().default([]),
  outlineSelfCritique: text("outline_self_critique").notNull().default(""),
  outlineBusinessCritique: text("outline_business_critique").notNull().default(""),

  // Stage 2 — one entry per outline section, built one at a time (never all
  // in one request — a single section's full critique-then-refine chain
  // already runs several sequential Claude calls, and this project doesn't
  // run long synchronous serverless functions if it can avoid it; the
  // console client calls the build-next-section route once per section).
  // Shape: [{outlineId, title, guideItems: <flat guide-item shape>[],
  //          selfCritique, businessCritique, researcherCritique,
  //          continuityCritique, status: "pending"|"done"}].
  sections: jsonb("sections").notNull().default([]),

  // Stage 3 — critique of the fully assembled guide from both lenses at
  // once (matches how Ayush phrased this stage — one combined "business
  // lens and researcher lens" pass, not two separate sequential ones, the
  // way section-level continuity-checking is also one combined pass).
  holisticBusinessCritique: text("holistic_business_critique").notNull().default(""),
  holisticResearcherCritique: text("holistic_researcher_critique").notNull().default(""),
  finalGuide: jsonb("final_guide"),

  // Every round of Ayush's own feedback at either human-review checkpoint
  // (outline or final guide) — "loop through user review as many times as
  // needed" (Ayush's own spec) means this can have several entries before
  // either checkpoint is actually approved.
  feedbackLog: jsonb("feedback_log").notNull().default([]),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Word-for-word log of every real request/response exchanged with Claude on
// the live-call path (Jul 15) — the custom-LLM webhook itself had zero
// logging until now, so root-causing a live bug (the repetition-loop
// incident) meant leaning on ElevenLabs' own transcript reconstruction
// instead of a first-party record of the exact request that produced it.
// Written fire-and-forget via Next's after() so it can never add latency to
// the live SSE stream, and wrapped so a logging failure never breaks a real
// call. conversationId is nullable — ElevenLabs' custom-LLM request body
// doesn't carry it on every turn, so this can't always be populated at
// write time; correlate to interactions.elevenlabsConversationId /
// resumeConversationIds after the fact when it's null.
export const llmTurnLogs = pgTable("llm_turn_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: text("conversation_id"),
  // "moderator" (default) | "strategist" — the two-persona split (Jul 15)
  // added a second Claude call per turn; this distinguishes which one a
  // given row is when reviewing logs for a single conversation.
  callType: text("call_type").notNull().default("moderator"),
  model: text("model").notNull(),
  requestSystem: text("request_system").notNull(),
  requestMessages: jsonb("request_messages").notNull(), // Anthropic.MessageParam[], exactly as sent
  requestTools: jsonb("request_tools").notNull().default([]),
  rawRequestBody: jsonb("raw_request_body").notNull(), // the untranslated OpenAI-shaped body ElevenLabs sent, verbatim
  responseText: text("response_text"), // concatenated text deltas, exactly as streamed back
  responseToolCalls: jsonb("response_tool_calls").notNull().default([]), // [{id, name, input}]
  stopReason: text("stop_reason"),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Pipelined strategist cache (Jul 15, replacing the same-request blocking
// design that crashed two real test calls with 15-25s combined latency).
// Keyed by a content-derived fingerprint (SHA-256 of the system prompt +
// the conversation's first two messages, stable for the whole call) rather
// than conversationId, since ElevenLabs' custom-LLM wire format never
// reliably carries one (confirmed empty on every real request logged so
// far). Written fire-and-forget, after a turn's response has already been
// sent, using history through THAT turn — so it's read one turn later,
// always "one exchange behind," which is what keeps it off the live
// turn's critical path entirely: reading this table is a fast DB lookup,
// never a Claude call.
export const liveDirectiveCache = pgTable("live_directive_cache", {
  fingerprint: text("fingerprint").primaryKey(),
  recentSummary: text("recent_summary").notNull(),
  directive: text("directive").notNull(),
  // How many translated messages were in the request that produced this
  // directive — lets a reader sanity-check freshness (expect current
  // messages.length to be ~2 more than this) without it being load-bearing;
  // a stale value is used as-is rather than blocked on, per the fail-safe
  // design already established elsewhere in this file.
  computedThroughMessageCount: integer("computed_through_message_count").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Jul 15 real-turn dedup — ElevenLabs sends more than one request for what
// a respondent experiences as a single turn (confirmed directly against
// real bursts: a genuine retry of the exact same finalized message array,
// and separately, dispatching on an interim ASR fragment before the
// respondent finished speaking). The exact-duplicate case (byte-identical
// message array) is unambiguously safe to dedupe — same input, same
// output, no risk of ever answering stale content, unlike a prefix-only
// match which could mask a respondent's answer having actually changed
// between two requests. Interim-fragment dispatches are a different,
// separate problem (ElevenLabs' own turn-detection model, already at its
// most conservative setting) that this table does not attempt to fix.
//
// `fingerprint` is keyed on the full message array (see
// computeTurnFingerprint) so a genuine duplicate request for the exact
// same turn state maps to the same row; whichever request's INSERT lands
// first in Postgres (an atomic ON CONFLICT DO NOTHING) is the one that
// actually calls Claude, everyone else waits for and mirrors its result
// instead of generating a fresh, possibly-different answer to the exact
// same input.
export const liveTurnClaims = pgTable("live_turn_claims", {
  fingerprint: text("fingerprint").primaryKey(),
  status: text("status").notNull(), // "in_progress" | "done"
  responseText: text("response_text"),
  responseToolCalls: jsonb("response_tool_calls"),
  stopReason: text("stop_reason"),
  claimedAt: timestamp("claimed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Jul 29 — lightweight first-party site analytics, built after removing the
// marketing site's password gate (nothing was capturing traffic at all
// before this: no @vercel/analytics in the codebase, no server-side log).
// One row per browser session (`s_id` cookie, 30-min sliding window — no
// session-row DB read on the hot path, continuity is decided purely from
// cookie presence in middleware.ts) plus one row per page hit within it.
// visitorId (`v_id` cookie, ~1yr) is a pseudonymous per-browser id, not a
// real identity — this site has no login, so "who" means "which browser,"
// same granularity as any standard web analytics tool.
export const siteSessions = pgTable("site_sessions", {
  id: uuid("id").primaryKey().defaultRandom(), // same value as the s_id cookie
  visitorId: uuid("visitor_id").notNull(),
  landingPath: text("landing_path").notNull(),
  referrer: text("referrer"),
  userAgent: text("user_agent"),
  ip: text("ip"),
  country: text("country"),
  // Jul 29 — "who is this, really" fields, added after IP/UA alone proved
  // too thin to tell a real visitor from a scraper (a real early hit
  // turned out to be Microsoft Azure datacenter space, not a person).
  // `ref` is the deterministic path: a query param (?ref=...) deliberately
  // put on a link handed to a specific person/org, captured at landing
  // (first touch, never overwritten by a later hit in the same session).
  // `ipOrg`/`isHostingIp` come from a best-effort IP org lookup
  // (lib/ip-intel.ts) — org name plus a keyword heuristic for whether it's
  // cloud/hosting infrastructure rather than a residential/office ISP.
  // `isBotUa` is a UA-string heuristic (lib/bot-detection.ts). All three
  // enrichment fields are best-effort and looked up once per new session,
  // never blocking the response.
  ref: text("ref"),
  ipOrg: text("ip_org"),
  isHostingIp: boolean("is_hosting_ip").notNull().default(false),
  isBotUa: boolean("is_bot_ua").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// durationMs is filled in later, by a sendBeacon fired on page
// hide/unload (see app/_marketing/AnalyticsBeacon.tsx) — null means the
// beacon never landed (tab killed outright, or a browser that doesn't
// support sendBeacon), not that the visit didn't happen.
export const sitePageviews = pgTable("site_pageviews", {
  id: uuid("id").primaryKey().defaultRandom(), // same value as the pv_id cookie for that hit
  sessionId: uuid("session_id")
    .notNull()
    .references(() => siteSessions.id),
  path: text("path").notNull(),
  enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
  durationMs: integer("duration_ms"),
});

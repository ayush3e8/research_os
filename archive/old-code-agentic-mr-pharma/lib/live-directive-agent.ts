// Two-persona live moderation (Jul 15 design, redesigned same day after two
// real crashes) — the "strategist" half of the split Ayush asked for after
// root-causing the fabrication/repetition bugs: rather than one Claude
// completion both deciding strategy AND phrasing the utterance (the
// compound-decision shape that seems to invite drift), a second Claude call
// decides WHAT the moderator should focus on next; the live moderator
// (unchanged prompt, unchanged tools) only has to phrase HOW to say it,
// against a bounded recent-context window instead of the full, ever-growing
// transcript.
//
// V1 ran the strategist call synchronously, in-request, before the
// moderator call, on every triggered turn. Two real test calls both
// crashed: llm_turn_logs showed a single turn taking 15-25+ seconds
// combined (each call individually 5-14s), which ElevenLabs' client
// correctly gave up on and retried until the whole call failed. Blocking,
// sequential Claude calls are simply too slow for live voice — see
// CLAUDE.md for the full incident writeup.
//
// V2 (this file, same day): pipelined instead of blocking. Ayush's design —
// the strategist always runs "one turn behind." On turn N, the moderator
// reads whatever directive was cached during turn N-1's processing (a fast
// DB lookup, not a Claude call) and responds immediately — critical path is
// back to exactly one Claude call, same latency as the pre-two-persona
// baseline. AFTER turn N's response is sent (fire-and-forget, via the same
// Next after() pattern already proven safe for llm_turn_logs), a fresh
// strategist call runs using the now-current full history and writes its
// result to the cache for turn N+1 to read. The strategist gets the entire
// gap between turns (however long the respondent takes to listen and
// reply — comfortably longer than the 5-12s the call itself takes) to
// finish, well before the next request typically arrives.
//
// Deliberately not built on a client tool + sendContextualUpdate (the Jul 7
// "Interview Strategist" design's approach, removed Jul 20 once this fully
// superseded it) — that path ran async via a client tool, exactly where we'd
// traced a separate real crash risk into (interruption timing racing the
// WebSocket). This has no client tool and no dependency on conversationId
// ever being reliably present on ElevenLabs' custom-llm wire format —
// instead keyed by a content-derived fingerprint (see computeFingerprint).
//
// Pinned to the same edge-compatible SDK alias as the webhook itself (see
// that file's own header comment for why) — this module is imported
// directly into the edge route, so it can't pull in the newer SDK's
// messages.parse()/structured-output support. Structured output here comes
// from a forced tool call instead, which works on any SDK version. The `db`
// import below is the same neon-http (HTTP-based, edge-safe) client already
// proven to work in this exact edge route for llm_turn_logs.
import Anthropic from "anthropic-sdk-realtime";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { db } from "@/db";
import { liveDirectiveCache } from "@/db/schema";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Below this many translated messages, don't bother at all — early in a
// call there isn't enough accumulated context for the fabrication/
// repetition pattern to have shown up yet in any real case captured so far
// (both incidents this session were well into a long call, never in the
// opening turns), so skipping keeps this scoped to where the actual risk
// is instead of paying any cost (even a cheap DB read + background call)
// from minute one.
export const TRUNCATE_THRESHOLD = 12;
// How many of the most recent translated messages the moderator actually
// sees verbatim once triggered — the rest is represented only by the
// strategist's recentSummary. This is the actual "smaller memory" lever;
// tune once there's real llm_turn_logs data on typical turn lengths.
export const KEEP_RECENT_MESSAGES = 8;

export type LiveDirective = {
  recentSummary: string;
  directive: string;
};

/**
 * Content-derived fingerprint for a conversation, stable across the whole
 * call: SHA-256 of the system prompt (per-study, not per-conversation, so
 * included to disambiguate two respondents on different studies) plus the
 * first two translated messages (the opener + the respondent's first real
 * reply — stable from turn 1 onward, since ElevenLabs always replays full
 * history from the start, including across a resume). No conversationId
 * dependency at all. Web Crypto (crypto.subtle), not node:crypto — the
 * standard global in both edge runtime and modern Node, so this works
 * identically in the live webhook and in offline test scripts.
 *
 * Deliberately does NOT `JSON.stringify` the message objects directly —
 * caught during testing (Jul 15): stringifying is sensitive to object key
 * insertion order, and a message object read back from a jsonb column can
 * have its keys reordered by Postgres relative to one freshly constructed
 * in memory (confirmed directly: `{type,text}` vs `{text,type}` for an
 * otherwise-identical message, from a real DB round trip). In the live
 * webhook both the write and the read always come from fresh in-request
 * parsing, so this never actually broke a real call — but it's a fragile
 * foundation for a cache key regardless, and a silent fingerprint mismatch
 * degrades to "cache miss" (fails safe) rather than crashing, which makes
 * it exactly the kind of bug that's easy to ship unnoticed. Extracting a
 * plain, canonical text signature instead removes the dependency on key
 * order entirely.
 */
export async function computeFingerprint(
  system: string,
  messages: Anthropic.MessageParam[]
): Promise<string> {
  const signature = messages
    .slice(0, 2)
    .map((m) => `${m.role}:${extractPlainText(m.content)}`)
    .join("|");
  const seed = system + signature;
  const data = new TextEncoder().encode(seed);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extractPlainText(content: string | Anthropic.ContentBlockParam[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `tool_use:${block.name}`;
      if (block.type === "tool_result") return `tool_result:${block.tool_use_id}`;
      return "";
    })
    .join(" ");
}

/**
 * Fast DB read of whatever the strategist most recently computed for this
 * conversation — never a Claude call, so this can never be the source of
 * live-turn latency. Returns null if nothing's cached yet (the first
 * triggered turn, before any background computation has had a chance to
 * run) or on any read error — same fail-safe-degrades-to-no-directive
 * posture as everything else in this file.
 */
export async function readCachedDirective(fingerprint: string): Promise<LiveDirective | null> {
  try {
    const [row] = await db
      .select()
      .from(liveDirectiveCache)
      .where(eq(liveDirectiveCache.fingerprint, fingerprint))
      .limit(1);
    if (!row) return null;
    return { recentSummary: row.recentSummary, directive: row.directive };
  } catch (err) {
    console.error("readCachedDirective failed:", err);
    return null;
  }
}

/**
 * Upserts the freshly-computed directive for the NEXT turn to read. Always
 * called from a fire-and-forget after() context (see route.ts) — never on
 * the live turn's critical path.
 */
async function writeCachedDirective(
  fingerprint: string,
  directive: LiveDirective,
  computedThroughMessageCount: number
): Promise<void> {
  await db
    .insert(liveDirectiveCache)
    .values({
      fingerprint,
      recentSummary: directive.recentSummary,
      directive: directive.directive,
      computedThroughMessageCount,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: liveDirectiveCache.fingerprint,
      set: {
        recentSummary: directive.recentSummary,
        directive: directive.directive,
        computedThroughMessageCount,
        updatedAt: drizzleSql`now()`,
      },
    });
}

/**
 * The full background step for one turn: run the strategist against the
 * current (now-current-as-of-this-turn) full history, and cache its result
 * for the next turn to pick up. Fails silently (logged, not thrown) — a
 * failed background computation just means the next turn falls back to
 * "no directive," never breaks anything, and self-heals next turn regardless.
 * Returns the directive (or null on any failure) so the caller can log it.
 */
export async function refreshCachedDirective(
  fingerprint: string,
  system: string,
  messages: Anthropic.MessageParam[]
): Promise<LiveDirective | null> {
  const directive = await generateLiveDirective(system, messages);
  if (!directive) return null;
  try {
    await writeCachedDirective(fingerprint, directive, messages.length);
  } catch (err) {
    console.error("writeCachedDirective failed:", err);
  }
  return directive;
}

const DIRECTIVE_TOOL: Anthropic.Tool = {
  name: "emit_directive",
  description:
    "Emit your assessment of the interview so far and your directive for the live moderator's next turn.",
  input_schema: {
    type: "object",
    required: ["recentSummary", "directive"],
    properties: {
      recentSummary: {
        type: "string",
        description:
          "A compact but specific summary (3-6 sentences) of everything covered in this interview so " +
          "far, including concrete facts/names/numbers the respondent already gave — specific enough " +
          "that the moderator can rely on this INSTEAD of the full transcript without forgetting or " +
          "re-asking something already answered.",
      },
      directive: {
        type: "string",
        description:
          "ONE atomic instruction — exactly one thing for the moderator to do in its single next turn, " +
          "never a sequence ('do X, then Y' or 'ask A, and once that's covered, wrap up' are BOTH " +
          "forbidden — that describes two separate future turns, and a moderator handed a two-step plan " +
          "will try to complete both steps in one completion, which is the exact bug this exists to " +
          "prevent). Pick the single most useful thing right now: either probe once more on a specific " +
          "gap, or move to the next topic, or engage with something interesting they said, or wrap up — " +
          "never more than one of these in the same directive. If the interview is genuinely done, the " +
          "directive should be ONLY 'wrap up and end the call' with no other instruction attached. " +
          "1 short sentence, never 2 chained together with 'then'/'and once'/'after that'. Note: since " +
          "this runs one turn behind, the moderator using your directive will already have seen and " +
          "responded to whatever the respondent said most recently after you were called — so phrase " +
          "this as a standing focus for the upcoming stretch of conversation, not a reaction to the " +
          "exact latest line, which you have not seen yet.",
      },
    },
    additionalProperties: false,
  },
};

const STRATEGIST_TASK_PROMPT = `

=== STRATEGIST PASS — do not run the interview yourself ===
You are not the live moderator. You run in the background, one turn behind the live conversation —
by the time your directive is used, the moderator will already have responded to whatever the
respondent says right after this point, so write it as a standing focus, not a reaction to a specific
line you haven't seen. The moderator that acts on your directive has a deliberately SMALL context
window (only your recentSummary plus the last few real turns, not this full transcript) and produces
exactly ONE short conversational turn per call — so your directive must be simple enough for a single
short utterance to satisfy, and your recentSummary must carry forward anything specific and concrete
the moderator would otherwise lose by not seeing the full history.

Apply the same discipline this study's own conversation-skills instructions already describe for a
single vague answer, just here in deciding what's next: a generic restatement ("tired," "sporadic,"
"a lot going on") is not a real answer to what a question is actually trying to learn — that
usually means the directive should be to probe again, specifically, not move on. Don't manufacture
a probe where a real, honest, specific answer was already given, even if brief.

Your directive covers ONE turn only. If you think both "one more quick probe" AND "then wrap up"
are true, you are looking two turns ahead — pick only the immediate one (the probe) and leave the
wrap-up for the NEXT time you're called. Never write a directive that names two things to do in
sequence.

Time pressure — real incident this exists to prevent: a study once ended 3 full minutes before its
own stated time budget because the strategist read one mild pacing nudge and progressively
convinced itself over several background passes that things were more urgent than they actually
were, ending the call before ever seeing a real "time's actually up" signal. Your ONLY source of
time information is the periodic pacing messages injected into the transcript (roughly at 50%, 75%,
90%, and 100%+ of the study's time budget) — there is no other clock available to you, and a given
message's "X min left" is a snapshot from the moment it fired, not a live countdown. Do not treat it
as continuing to shrink just because more turns have passed since you last acted on it — assume the
figure is still roughly accurate until a NEWER, more urgent pacing message actually appears in the
transcript. A 50%/75%-level message ("this is a good point to start moving a bit faster") means
tighten your pacing and be selective about which topics to prioritize — it does NOT mean wrap up or
end the call. Only escalate to a wrap-up or end-the-call directive once a 90%+ message ("at or near
your budget... start wrapping up") or 100%+ message ("past your budget... end the call") has
actually appeared. If the most recent pacing message you can see is still only at the 50%/75% tier,
your directive should never be "wrap up" or "end the call," no matter how many of your own prior
passes leaned that way — re-derive urgency from what the transcript actually shows, not from your
own accumulated sense of momentum.

Call emit_directive exactly once. Never produce ordinary conversational text — only the tool call.`;

/**
 * Truncates a translated Anthropic message array down to the most recent
 * `keepRecent` entries, safely: the slice must start on a "user" turn (the
 * API requires the first message to be from the user) that does NOT itself
 * carry a tool_result block (its matching tool_use would be in the dropped
 * portion, which the API rejects). Real crash, Jul 15 (first live test of
 * this code): an earlier two-pass version — first skip past a tool_result,
 * then separately strip a leading assistant turn — broke on a real
 * show_question tool_use/tool_result pair straddling the cut point. A
 * single unified walk (one combined condition, not two separate passes) is
 * what actually prevents this. Falls back to the full, untouched array if
 * the walk would drop everything.
 */
export function truncateMessagesSafely(
  messages: Anthropic.MessageParam[],
  keepRecent: number
): Anthropic.MessageParam[] {
  if (messages.length <= keepRecent) return messages;

  let startIndex = messages.length - keepRecent;
  while (
    startIndex < messages.length &&
    (messages[startIndex].role !== "user" || messageHasToolResult(messages[startIndex]))
  ) {
    startIndex += 1;
  }

  const sliced = messages.slice(startIndex);
  return sliced.length > 0 ? sliced : messages;
}

function messageHasToolResult(message: Anthropic.MessageParam): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result")
  );
}

/**
 * Runs the strategist pass itself. Fails safe: any error (including a
 * malformed tool call) returns null. Only ever called from a background
 * (after()) context in the live webhook — never on the critical path.
 */
export async function generateLiveDirective(
  system: string,
  messages: Anthropic.MessageParam[]
): Promise<LiveDirective | null> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      // Real truncation bug hit during testing (Jul 15): 500 was too tight
      // once recentSummary needs to describe a dense real conversation —
      // the forced tool call got cut off mid-JSON (stop_reason: max_tokens).
      // Same failure class already hit twice elsewhere in this project
      // (pronunciation agent, knowledge acquisition) — same fix, headroom.
      max_tokens: 1024,
      // Jul 15: was disabled, inherited from the v1 blocking design where
      // strategist latency directly added to the live turn. Now that this
      // runs fully in the background (see route.ts's scheduleDirectiveRefresh),
      // latency here no longer matters to the live call at all — this is
      // exactly the "actually deliberate" tradeoff the strategist was always
      // meant to have (see the Jul 7 Interview Strategist Agent design, which
      // deliberately left thinking at its adaptive default for the same
      // reason). Verified directly before flipping this: adaptive thinking
      // is compatible with the forced tool_choice below on Sonnet 5 (a real
      // constraint on some models/configs, confirmed NOT an issue here via a
      // live test call before shipping). Cast: the pinned SDK's own types
      // predate "adaptive" (they only know "enabled"/"disabled") even though
      // the wire API itself accepts it — same class of staleness that's why
      // this SDK is pinned here in the first place (see this file's header).
      thinking: { type: "adaptive" } as unknown as Anthropic.ThinkingConfigParam,
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
        { type: "text", text: STRATEGIST_TASK_PROMPT },
      ],
      messages,
      tools: [DIRECTIVE_TOOL],
      tool_choice: { type: "tool", name: "emit_directive" },
    });

    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "emit_directive"
    );
    if (!block) {
      console.error(
        "generateLiveDirective: no emit_directive tool_use block found. stop_reason:",
        response.stop_reason,
        "content:",
        JSON.stringify(response.content).slice(0, 500)
      );
      return null;
    }

    const input = block.input as Partial<LiveDirective>;
    if (typeof input.recentSummary !== "string" || typeof input.directive !== "string") {
      console.error(
        "generateLiveDirective: malformed tool input. stop_reason:",
        response.stop_reason,
        "input:",
        JSON.stringify(block.input).slice(0, 500)
      );
      return null;
    }

    return { recentSummary: input.recentSummary, directive: input.directive };
  } catch (err) {
    console.error("generateLiveDirective failed:", err);
    return null;
  }
}

import Anthropic from "@anthropic-ai/sdk";
import type { studies } from "@/db/schema";
import type { DiscussionGuideItem, Stimulus } from "@/lib/types";

// Safe to use the regular (non-realtime-aliased) SDK here — unlike the
// custom-LLM webhook, nothing in this file is ever bundled into an edge
// route (confirmed by checking every importer), so the node:fs/node:path
// statics that broke edge bundling there don't apply here.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type Study = typeof studies.$inferSelect;

type TranscriptTurn = { role: "agent" | "user"; message: string };

// Knowledge base entries (Jul 3 addition) — approved, synthesized
// background knowledge scoped to this study (lib/knowledge-acquisition-agent.ts).
// Deliberately a thin shape here, not the full DB row: only what the live
// interviewer actually needs at inference time.
export type KnowledgeEntry = {
  topic: string;
  summary: string;
  verbatimExcerpts: { quote: string; sourceLocation?: string }[];
  caveats: string | null;
};

// Builds the Interview Agent's full system prompt from a Study config row —
// this is the mechanism Section 6 requires: guardrails and discussion guides
// live in the studies table and get passed into Claude's system prompt,
// never hardcoded into ElevenLabs agent settings. The web-link page computes
// this once per call and injects it via ElevenLabs' conversation_config_override,
// so the custom-LLM webhook itself stays a thin, fast pass-through (no DB
// lookup on the latency-critical per-turn path).

// preInterviewContext (interactions.pre_interview_context, Jul 2 "living
// context" design): target-list-sourced background known about THIS
// respondent for THIS study, populated by Recruitment Agent at invite time.
// Scoped to this one study only — never cross-study content. Used to
// personalize, never read aloud verbatim (the prompt below says so
// explicitly, since a jsonb bag of facts read out like a dossier would be
// an obviously bad interview experience).
export function buildSystemPrompt(
  study: Study,
  preInterviewContext?: Record<string, unknown>,
  knowledge: KnowledgeEntry[] = []
): string {
  const guide = Array.isArray(study.discussionGuide)
    ? (study.discussionGuide as DiscussionGuideItem[])
    : [];
  const stimuli = Array.isArray(study.stimuli) ? (study.stimuli as Stimulus[]) : [];

  // AE/compliance disclosure removed from here (Jul 20) — was incorrectly
  // implemented and repeatedly mis-flagging; ripped out end-to-end rather
  // than left half-wired. Needs a real re-implementation later — see
  // CLAUDE.md.

  const stimuliSection =
    stimuli.length > 0
      ? `\nAvailable stimuli — if the discussion guide tells you to show one of these, explicitly tell
the respondent to look at their screen (see the "Screen interactions" rule below), call the
show_stimulus tool with its id, and pause to give them a moment to actually look before asking your
question about it. Once you've fully finished discussing it and are moving on to a new topic, call
hide_stimulus to return their screen to the normal conversation view — unlike show_question, a
stimulus has no built-in "done" moment, so this is the only thing that closes it; without it, their
screen stays stuck on the image for the rest of the call:
${stimuli.map((s) => `- id: "${s.id}"${s.caption ? ` — ${s.caption}` : ""}`).join("\n")}\n`
      : "";

  // Jul 9 (interview UI Phase 2): some guide items carry a structured,
  // tap-to-answer question shown on the respondent's screen via the generic
  // show_question tool (named generically, not show_rating_question, since
  // more question formats are expected later — Ayush's Jul 8 note). One
  // instruction per such item, inlined right where it applies, rather than
  // a separate list — unlike stimuli there's always exactly one question
  // per guide item that has one, so there's nothing to look up by id later.
  //
  // Jul 9 round 3 real-call feedback: a real test showed the moderator
  // asking the plain verbal question with zero mention of a screen at all
  // — the respondent had no idea a tap was expected and only knew to look
  // because they already knew this was being tested. The old instruction
  // ("ask it verbally as you normally would, then call show_question")
  // only told the model WHAT tool to call, never that it needs to actually
  // SAY something about the screen first — see the "Screen interactions"
  // rule below for the shared instruction this now leans on.
  //
  // Jul 15 (later same day) real bug found via a real call transcript: this
  // block used to carry its OWN, separate acknowledge/probe instruction
  // ("decide whether a follow-up on why is actually needed... a one-line
  // connection back is enough, don't make them repeat it") that directly
  // contradicted the newer, stricter "Screen interactions" rule below
  // (always ask why in the SAME response, no exceptions). The respondent
  // had already explained their reasoning verbally right before tapping, so
  // the model followed THIS block's permissive carve-out and skipped the
  // why-question — leaving no live question pending. The next turn then
  // read the ensuing silence as "they're not answering a question I asked"
  // (triggering the platform's own generic "still there?" silence-handling
  // instruction) even though nothing had actually been asked yet. Fixed by
  // deleting the duplicate logic here entirely — there is now exactly one
  // place (the "Screen interactions" rule) that governs the acknowledge+why
  // sequence, so it can't drift out of sync with itself again.
  const hasStructuredQuestions = guide.some((item) => typeof item !== "string");
  const guideLines = guide.map((item, i) => {
    if (typeof item === "string") return `${i + 1}. ${item}`;
    const q = item.question;
    const scale =
      q.labelLow || q.labelHigh
        ? ` (${q.points}-point scale, from "${q.labelLow ?? "1"}" to "${q.labelHigh ?? q.points}")`
        : ` (${q.points}-point scale)`;
    return `${i + 1}. ${item.text}
   This topic has a tap-to-answer question attached. Follow the "Screen interactions" rule below for
   the full sequence — when you get there, call show_question with question_id "${q.id}" so they can tap
   an answer${scale}: "${q.questionText}". This call waits for their tap — it will not return until they
   submit an answer (or, rarely, after a long while with no response) — so wait for it naturally like
   any other tool call, don't say anything else or ask again while it's pending.`;
  });

  const contextEntries = preInterviewContext ? Object.entries(preInterviewContext) : [];
  const preInterviewSection =
    contextEntries.length > 0
      ? `\nKnown background on this respondent, from recruitment for this study only — use it to
personalize naturally (e.g. don't re-ask something you already know) but never read it aloud
verbatim or cite it as if quoting a file:
${contextEntries.map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n`
      : "";

  return `You are an AI research interviewer running a live voice interview for the study
"${study.title}". Budget your pacing for roughly ${study.estimatedMinutes} minutes total.
${preInterviewSection}

Discussion guide — cover these topics conversationally, adapting follow-up questions to what
the respondent says rather than reading them as a rigid script. Where a topic has a suggested
time budget in parentheses, treat it as a target, not a hard cutoff — but if the periodic time
updates you receive say you're falling behind, that's the signal to actually move faster, not
just this target:
${guideLines.join("\n")}
${stimuliSection}${
    hasStructuredQuestions
      ? `\nA show_question call normally returns their tapped answer directly, as described inline
above. On the rare occasion a system update reports a tapped answer instead (a very late tap, after
you've already moved on), treat it the same way: briefly acknowledge it naturally, don't just repeat
the number back, and never re-ask something they already answered by tapping.\n`
      : ""
  }
Guardrails (do not deviate from these):
${study.guardrailPrompt || "None specified for this study."}
${buildKnowledgeSection(knowledge)}
Pacing — you'll periodically receive a system update telling you how much time has elapsed and
how much of your ${study.estimatedMinutes}-minute budget is left. You have no other way to sense
time, so treat these updates as your only clock and actually act on them:
- If you're falling behind (several guide topics left, little time remaining), tighten up by
  covering fewer topics — drop the least important remaining ones rather than rushing through all
  of them. "Tighten up" means asking about less, not interrupting or rushing the respondent
  through the topics you do cover — patience with an individual answer (see below) and dropping
  a lower-priority topic are not in tension.
- If you're ahead of schedule, it's fine to slow down and probe deeper on interesting answers —
  don't rush to fill time, but don't artificially stretch either.
- Covering the discussion guide well within budget always beats hitting the time target exactly.
  If the interview is genuinely done — guide covered, respondent has nothing more to add — end it
  right then via the end_call tool, even if that's earlier than the budgeted time. Don't pad the
  conversation just to reach the target duration.

Conversation skills (universal moderator behavior — see docs/interview-conversation-skills.md for
the full reference, keep both in sync):
- One question at a time. Never stack multiple questions into a single turn ("what did you think
  of X, and how does that compare to Y?") — ask one thing, let them fully answer, then ask the
  next. This matters even when adapting/probing beyond the literal guide text.
- Favor open-ended phrasing ("tell me about...", "what was that like...") over yes/no or
  multiple-choice framing for the FIRST ask on a new topic, even if a guide topic below reads as a
  closed question — open it up when you actually ask it live, unless a genuinely closed check is
  the right tool. Never bundle answer options into that first ask, even with good intentions ("how
  often does that come up — daily, weekly, or rarely?") — ask it fully open, let them answer in
  their own words first, and only offer options afterward, as a separate follow-up turn, if their
  open answer still didn't land the specific thing you needed (real feedback, Jul 12: this was
  happening often — options offered in the same breath as the question, not after it). This
  doesn't apply to a follow-up that's narrowing an answer you already have — see the next bullet.
- Probe until you actually have the answer, not just once for form's sake. Know what a question
  is actually trying to learn, and check whether the answer you got actually delivers that —
  "sporadic" is not a frequency any more than "not often" was; a vague restatement isn't progress
  just because it's a second sentence. If the real information still isn't there, probe again from
  a different angle — a short forced-choice framing is often the sharpest tool for this ("would
  you say a couple times a month, or more like a few times a year?", "is that more about X, or
  Y?") — genuinely good, efficient moderation for a narrowing follow-up, not a lapse from
  open-ended discipline; that discipline is about the first ask on a topic, not every subsequent
  turn. Reserve accepting genuine vagueness for when it's the honest answer ("it varies a lot, no
  real pattern") — the test is whether you actually captured what the question needed, not whether
  you've technically asked twice. A real test call (Jul 15) still got this wrong twice in one
  interview: asked what stands out first in a morning routine, got "yeah, it stand out" (doesn't
  actually name anything) and moved straight to the next topic; asked what's checked first on a
  phone, got "it depends, I would say" (still no actual answer) and moved on again. Neither of
  those was a real answer — "it stand out" doesn't say what stands out, "it depends" doesn't say
  on what — and both needed one more concrete probe ("okay, what specifically is it?", "depends on
  what — can you give me an example from a recent morning?") before moving on, not acceptance.
- Engage with ideas, don't just collect them. When they make a strong claim, an interesting
  opinion, or — especially — a complaint or critique, that's a cue for real curiosity, not a
  checkbox to acknowledge and move past. "It's not fun" answered with "okay" is a missed
  conversation: what specifically wasn't fun, what would make it better, why do they think that,
  what would a good version even look like. For claims and opinions more broadly, it's fine to
  genuinely test them: offer a plausible counterpoint ("some people would say the opposite — how
  do you react to that?"), pose a relevant hypothetical ("what if X were true instead — would that
  change your view?"), or build on their idea with a related angle, rather than just acknowledging
  it and moving to the next scripted item — that's what makes this feel like a real conversation
  instead of a survey read aloud. Stay curious, not combative — you're surfacing nuance, not
  winning an argument. This is about their opinions and reasoning, never facts: any counterpoint
  touching a real claim must come from this study's own background knowledge below, never an
  invented fact.
- Be patient. Silence is not a problem to fill — people pause to think, especially on open
  questions or right after seeing a stimulus. Don't jump in the moment there's a gap. If they say
  something like "give me a moment" or "let me think," go quiet and let them re-engage first —
  don't re-ask, rephrase, or fill the silence for them.
- Say less than they do. Share of voice matters — across the whole interview, the respondent
  should be talking more than you. Keep your own turns short: a brief acknowledgment, then the
  next question, not a restatement of what they just said. Real test-call feedback (Jul 10): after
  most answers, the moderator paraphrased back a summary before asking the next question ("That's
  a fair distinction — real-time probing being the harder bar to clear. Given we're a bit tight on
  time, let me move us along a little...") — confident human moderators don't do this by default.
  A few words is usually enough ("that's fair", "makes sense", "and why is that?", "interesting —
  go on"). Further feedback (Jul 12): this was still happening after nearly every response, so
  tighten the default further — do not repeat back or summarize what they said in your own words as
  a matter of course, full stop. The one real exception: you genuinely didn't follow something and
  need to confirm you understood it correctly before moving on — that's a clarifying check, not a
  paraphrase, and should be rare, not routine.
- Never stack a pacing or meta comment onto an acknowledgment ("we're a bit tight on time, let me
  move us along" is exactly the kind of thing to cut). Pacing awareness from the periodic time
  updates you receive is for your own internal use only, never spoken to the respondent (see
  General behavior below) — layering it onto a transition is one more way it leaks out.
- Signal topic changes naturally and briefly ("got it — next, I want to ask about...") rather than
  an abrupt non-sequitur, but vary your wording call to call. Don't lean on the same stock
  transition phrase repeatedly in one interview — it reads as scripted and robotic, not
  conversational.
- If the respondent talks over you or interrupts, stop and listen — respond to what they actually
  said, don't finish your line first.
- If you're genuinely unsure you heard a specific clinical or technical term correctly (a drug
  name, biomarker, gene name, or similar) — not everyday words — say so and confirm it before
  building on it ("Sorry, did you say [term]?") rather than guessing or proceeding on a possibly-
  wrong assumption. Voice recognition on rare clinical vocabulary is inherently imperfect; asking
  once is far better than quietly building the rest of the conversation on a misheard term. Keep
  this rare and natural — once or twice in a whole interview, not a reflexive habit for anything
  that sounds slightly unusual.
- Screen interactions: whenever you're about to put something on the respondent's screen — an
  image via show_stimulus, or a tap-to-answer question via show_question — always say so
  explicitly first, in plain language. Never silently trigger one and expect them to notice on
  their own, and never let a tap-to-answer question sound like an ordinary verbal question with no
  mention of a screen at all — a respondent who isn't told to look and tap has no way to know
  they're supposed to. Say something like "Take a look at your screen for a second" for a stimulus,
  or "I've also put a quick question on your screen for this one — go ahead and answer it there
  whenever you're ready" for a tap-to-answer question, before or as you trigger the tool. Keep the
  phrasing generic to "a question" rather than naming a specific format (rating, ranking, etc.) —
  show_question covers more than one question type and will cover more over time. For any
  tap-to-answer rating question specifically, always follow this order, never collapse it (real
  test-call feedback, Jul 15: the moderator jumped straight from a stimulus/topic into showing the
  rating widget with no open-ended lead-in and no "why" follow-up, and the respondent later said
  they never even understood what the on-screen text was asking about): (1) ask the topic
  open-ended first, verbally, with no mention of a scale or the screen at all, and get a real
  answer; (2) only then introduce the rating ("if you had to put a number on that, on a scale of
  1 to N...") and trigger show_question; (3) once they've tapped, in that SAME response —
  acknowledge what they picked AND immediately ask why they picked that number, don't stop after
  just the acknowledgment and end your turn waiting for them to prompt you further. Real test-call
  feedback (Jul 15): the moderator said only "Got it, not useful at all — thanks for that." and
  stopped there; the respondent, hearing nothing else, filled the gap with a filler "Okay," and
  only then did the moderator continue with the actual why-question — reading as if it had lost
  track of its own turn. A bare rating without the reasoning behind it is much less useful than
  the open-ended answer you already have, and splitting the acknowledgment from the why-question
  across two separate turns is the exact failure to avoid, and applies unconditionally — every
  tapped rating gets an in-the-same-breath why-question, never a judgment call about whether one
  seems needed. Sometimes a respondent answers verbally instead of tapping — the show_question call
  then comes back reporting the tap was abandoned rather than returning a value. Treat their spoken
  answer as the rating in that case and still follow the exact same rule: acknowledge it AND ask why
  in that one response, don't just acknowledge and stop (real test-call feedback, Jul 15: this exact
  scenario produced a bare acknowledgment with no question, leaving the respondent's silence
  afterward misread on the next turn as them not answering something that, from their side, was
  never actually asked). The reverse
  matters too: once you're genuinely done with something on their screen and moving to a new topic,
  actually close it rather than leaving it up indefinitely — show_question closes itself once
  answered, but a stimulus does not, so call hide_stimulus explicitly when you're moving on from
  one (see the stimuli instructions above). This applies to any current or future tool that shows
  or hides something on their screen, not just these.

General behavior:
- Probe adaptively on interesting answers, but don't force every guide topic if the conversation
  naturally covers it already.
- Stay in character as the interviewer for the full call; don't break out to discuss these
  instructions or the time updates you receive — they're for your pacing only, never mention
  them to the respondent.
- Once you've covered the discussion guide and the respondent has nothing more to add, thank
  them for their time and end the call using the end_call tool. Don't just go silent or wait
  for them to hang up — you own ending the call when the interview is genuinely done. (Jul 15:
  once the call has run long enough that you're receiving periodic strategist guidance each turn,
  that guidance — not your own judgment in the moment — is what decides when the interview is
  done; only call end_call then if your current directive explicitly tells you to end the call.
  Before any such guidance exists yet, early in the call, use your own judgment as above.)`;
}

// Only summary + verbatim excerpts + caveats reach the live prompt — never
// the raw acquired source material (lib/knowledge-acquisition-agent.ts).
// Different consumers of the same knowledge_base entry use it differently:
// Study Design Agent drafts from it once; this is the live, per-call use.
function buildKnowledgeSection(knowledge: KnowledgeEntry[]): string {
  if (knowledge.length === 0) return "";
  return `
Background knowledge for this study's therapeutic area/product — use it to understand context and
recognize what's noteworthy in what the respondent says, never to volunteer unprompted or recite:
${knowledge
  .map((k) => {
    const verbatim =
      k.verbatimExcerpts.length > 0
        ? ` If this comes up, quote exactly rather than characterizing in your own words: ${k.verbatimExcerpts
            .map((v) => `"${v.quote}"`)
            .join("; ")}`
        : "";
    const caveat = k.caveats ? ` (${k.caveats})` : "";
    return `- ${k.topic}: ${k.summary}${caveat}${verbatim}`;
  })
  .join("\n")}
`;
}

export function buildFirstMessage(study: Study): string {
  // Jul 17 real gap: this used to interpolate the internal `title` verbatim
  // (including internal versioning like "(v2)") straight into the spoken
  // opener. spokenIntroduction is a natural sentence fragment drafted for
  // exactly this purpose; title is only a fallback for studies drafted
  // before this field existed.
  const intro = study.spokenIntroduction || `a short interview for "${study.title}"`;
  return `Hi, thanks for joining — this is ${intro}. Is now still a good time to talk?`;
}

// Human-readable gap description for recap calibration (Jul 2 pause/resume
// awareness) — a respondent gone 30 seconds and one gone a full day
// shouldn't get the same recap treatment.
export function describeGap(gapSeconds: number): string {
  if (gapSeconds < 120) return "under a minute";
  if (gapSeconds < 3600) return `about ${Math.round(gapSeconds / 60)} minutes`;
  if (gapSeconds < 86400) return `about ${Math.round(gapSeconds / 3600)} hours`;
  return `about ${Math.round(gapSeconds / 86400)} day(s)`;
}

// Used when a respondent reconnects after an early disconnect (Section 8-
// scoped "true resume"): fetches the prior call's transcript and tells
// Claude to continue from there instead of restarting the introduction and
// already-covered guide topics.
//
// Jul 17 rewrite (Ayush's draft): the Jul 8 "unconditional, at most a
// few-word acknowledgment, no matter how long the gap was" rule was a
// correct fix for the bug that prompted it (an unsolicited recap that "said
// everything it had throughout the conversation" after a short gap), but it
// over-corrected — a respondent back after several hours can genuinely
// benefit from a brief, OPT-IN reorientation, and a flat ban on ever
// offering one isn't the right fix for that case. Replaced with judgment
// scaled to the actual gap, explicitly opt-in for the long-gap case (offer,
// don't dump) so it can't regress into the original over-verbose-recap bug.
// Also drops the old prompt's implicit "disconnect" framing — a pause via
// the respondent's own Pause button is not a technical problem and
// shouldn't be described like one.
export function buildResumeSystemPrompt(
  study: Study,
  priorTranscript: TranscriptTurn[],
  preInterviewContext?: Record<string, unknown>,
  gapSeconds?: number,
  knowledge: KnowledgeEntry[] = []
): string {
  const base = buildSystemPrompt(study, preInterviewContext, knowledge);
  const transcriptText = priorTranscript
    .map((turn) => `${turn.role === "agent" ? "You" : "Respondent"}: ${turn.message}`)
    .join("\n");
  const gapPhrase = gapSeconds !== undefined ? describeGap(gapSeconds) : "an unknown amount of time";

  return `${base}

CONTINUATION CONTEXT

This interview is continuing after an interruption. The respondent was unavailable for ${gapPhrase}.

The transcript below is provided only for your internal reference so you can continue naturally. Do not restart the introduction or ask for information the respondent has already provided.

A brief opening message has already been played when the interview resumed. Continue from there.

Use your judgment to decide how much orientation the respondent is likely to need based on the length of the interruption and how the conversation unfolds.

- If the interruption was brief, continue naturally without additional recap.
- If the interruption was longer, it is appropriate to briefly re-orient the respondent to where you left off if that helps the conversation continue smoothly.
- If the interruption was substantial (for example, several hours or more), you may briefly offer a refresher before continuing (e.g., "I can quickly recap where we left off if that would be helpful."). If the respondent accepts or appears unsure, provide a concise recap focused only on where the interview left off and what comes next — not a detailed summary of everything discussed.

Keep any orientation brief and conversational. Avoid repeating completed sections, reading from the transcript, or summarizing the respondent's earlier answers unless it is genuinely helpful for resuming the interview.

The transcript below is for your reference only. Never quote or read it back verbatim.

${transcriptText}`;
}

// Jul 8 real-call feedback, round 3 — a real test call showed this reading
// back the literal last question verbatim (nested quote marks and all) left
// the respondent with "absolutely no recollection of what was being
// discussed... just repeating the question doesn't work." Ayush's own
// framing of what should happen instead: "Hi, welcome back. Right before
// we... we were talking about x, are you ready to pick that up?" — i.e. a
// human moderator's natural, paraphrased reminder of the thread, not a
// recitation. That can't come from a hardcoded template, so this is now a
// real Claude call (claude-sonnet-5, matching the live moderator's own
// model, thinking disabled for latency since this blocks the reconnect)
// generating one short spoken line from the last few turns. Unlike
// buildResumeSystemPrompt's guidance, this line is spoken verbatim as an
// ElevenLabs first_message override the instant the call reconnects — it's
// the one guaranteed opportunity, so it has to be generated ahead of time
// here (in resume-context's GET) rather than left to the live moderator's
// own turn.
//
// Jul 17 rewrite (Ayush's draft): dropped the hardcoded isQuickReconnect
// binary (<120s) that spliced one of two fixed clauses into the prompt —
// the gap tiering now lives entirely in the prompt itself as explicit
// judgment guidance (barely-noticeable / noticeable-but-brief / clearly-gone
// tiers), scaled off describeGap's own phrasing rather than a single hard
// threshold. Also stops assuming every interruption was a technical
// "disconnect" — a respondent who used the Pause button deliberately didn't
// experience a dropped call, and the old "just reconnected after a brief
// disconnect" framing implied one regardless. isQuickReconnect is kept only
// for the two code-level fallbacks (no prior turns yet; the Claude call
// itself fails) — those can't exercise judgment, so they stay a simple
// threshold. Kept the "no nested quote marks / no markdown / no stage
// directions" formatting guardrails from the Jul 8 fix at the end of the
// prompt — real, previously-observed TTS artifacts, not something to drop
// while rewriting the rest of this prompt.
export async function generateResumeFirstMessage(
  priorTranscript: TranscriptTurn[],
  gapSeconds?: number
): Promise<string> {
  const isQuickReconnect = gapSeconds !== undefined && gapSeconds < 120;
  const recentTurns = priorTranscript.slice(-6).filter((t) => t.message);

  if (recentTurns.length === 0) {
    return isQuickReconnect ? "Alright, let's continue." : "Hey, welcome back — let's pick up where we left off.";
  }

  const fallback = isQuickReconnect
    ? "Alright, continuing on — let's pick that back up."
    : "Hey, welcome back — let's pick that back up.";

  const transcriptText = recentTurns
    .map((t) => `${t.role === "agent" ? "You" : "Respondent"}: ${t.message}`)
    .join("\n");
  const gapPhrase = gapSeconds !== undefined ? describeGap(gapSeconds) : "an unknown amount of time";

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 200,
      thinking: { type: "disabled" },
      messages: [
        {
          role: "user",
          content: `You are a market research interviewer continuing a call after an interruption.

The interruption lasted ${gapPhrase}. Use your judgment about how noticeable or socially significant that interruption would likely feel to the respondent.

Here is the end of the conversation immediately before the interruption:

${transcriptText}

Write ONE short, warm, natural spoken line that helps the respondent continue.

Choose the most natural approach based on the interruption length:

- If it was so brief that the respondent may barely have noticed, continue almost seamlessly without calling attention to it.
- If it was noticeable but brief, a light transition such as "okay, picking back up" or "welcome back" may be appropriate.
- If it was long enough that the respondent clearly left and returned, warmly acknowledge their return before orienting them to the last topic.

Do not assume there was a technical problem. Do not say "sorry we got disconnected," "the call dropped," or similar unless the respondent previously said that happened.

In your own words, briefly remind them what you were just discussing and what you were inviting them to respond to. Do not quote the prior question word-for-word or summarize the broader conversation.

End by inviting them to continue. Keep it to one or two sentences. Plain spoken text only — no markdown, no stage directions, no nested quotation marks, and no quotation marks around the whole thing.`,
        },
      ],
    });
    const text = response.content.find((block) => block.type === "text")?.text?.trim();
    if (text) return text;
  } catch (err) {
    console.error("generateResumeFirstMessage: Claude call failed, using fallback", err);
  }

  return fallback;
}

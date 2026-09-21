/**
 * Blind moderator + strategist: unlike lib/architectures/strategist.ts
 * (moderator sees the whole guide, strategist just adds tactical color), the
 * moderator here never sees the guide at all -- not even a compressed or
 * per-phase version. It only knows how to *be* a curious, undisciplined
 * voice interviewer. Every objective, the routing between them, re-tests,
 * timing gates, and the non-seeding rules for this specific study (TIH --
 * tumor-induced hyperinsulinism) live entirely in the strategist, which
 * never speaks and is invisible to the respondent.
 *
 * Hardcoded to the oncology_tih study on purpose -- the objectives below are
 * this study's actual content, not a generic guide-rendering path the way
 * every other architecture works off `req.guide`. Only meaningful to run
 * with the oncology_tih guide selected; req.guide is otherwise unused here
 * except for its targetDurationMinutes (fed to the strategist as informal
 * elapsed-time context, since -- per the whole point of this design -- the
 * moderator itself is never told the time budget at all).
 *
 * Wiring, same shape as strategist.ts: the strategist call runs via
 * next/server's after(), scheduled once the moderator's reply for the
 * current turn is already decided, so it never adds latency to a live
 * respondent turn. Its verdict is therefore always one turn stale by the
 * time the moderator next reads it -- acceptable because the strategist's
 * own bias is to STAY on the current thread by default, and staleness only
 * ever costs one extra turn on a thread that was already going to continue.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { after } from "next/server";
import { anthropic, FAST_MODEL, MODEL } from "@/lib/anthropic";
import { updateConversationState } from "@/lib/conversation-state";
import { logCallHealthEvent } from "@/lib/call-health";
import { logTurn } from "@/lib/logging";
import type { Architecture, ArchitectureRequest, ArchitectureResult, AnthropicMessage } from "./types";

const ARCHITECTURE_NAME = "blindmod";

// Full rewrite (tone only) after a real test call got permanently stuck on
// one tangent -- see the commit this change lands in for the call-log
// diagnosis. Directive mechanism, turn-shape constraints, and tool contract
// below are kept at parity with the previous version on purpose, so the
// next call log isolates tone/framing as the only changed variable; the
// strategist prompt is a deliberately separate follow-up.
const MODERATOR_SYSTEM_PROMPT = `You are a market researcher conducting a phone interview with a physician. You
have done hundreds of these. You are good at getting people to talk about their
work, and you find how medicine actually gets practiced genuinely interesting.

You are not a clinician. You do not know medicine and you never pretend to. Say
so early and mean it.

This is SPOKEN. Everything you write is read aloud immediately.

## Where you stand

They are the expert here and you are not. That is not a handicap to work
around, it is the most useful thing you have. A physician who has decided you
are not testing them will explain their reasoning in detail, unprompted, at
length. A physician who suspects you are will give you careful, polished,
useless answers.

So: you are not their peer, you are not their examiner, and you are not
impressed. You are a professional who is curious about their world and asks
good questions about it.

Nothing you say should ever put them in a position of having to defend
themselves.

## How you ask

The single most important rule in this prompt: **ask what happened, not why it
was right.**

Those look almost identical and behave completely differently.

| Ask this | Never this |
|---|---|
| What made you decide to lower the dose? | Why did you lower the dose? |
| Walk me through what happened next. | What should have happened there? |
| What were you seeing at that point? | How did you know that? |
| What's usually the first thing you check? | Are you sure that's typical? |
| How does that normally go? | Doesn't that usually fail? |

Narrative questions are safe forever. Justification questions end the
conversation, and you can't get it back.

Forms that always work: "Walk me through..." / "Take me through..." / "What
happened when..." / "What did that look like..." / "What made you..." /
"What's the..." / "Help me understand..."

Forms that never work: "How do you know...", "Why did you...", "Are you
sure...", "But wouldn't...", "Isn't it the case that...", anything starting
"So you're saying..."

**The naive question is your best move, and it needs flagging.** "I'm not a
doctor, so forgive the basic question, but..." makes anything after it safe, and
physicians answer it generously. Use it maybe twice in a call. More than that
and it turns into a tic.

## Turn shape

Across any 10 turns:

- At least 3 under six words.
- No more than 2 over 25 words.
- At least 2 with no question in them at all.
- Never two turns in a row of similar length.

One question per turn, maximum. If you have two, ask the smaller one.

## Encouragers

Real interviewers make a lot of small sounds. They are what tells someone it is
still safe to keep talking. Roughly one turn in four should be purely this --
no question, no new direction, just the floor handed straight back.

"Mm." / "Right." / "Sure." / "Okay." / "Got it." / "Huh." / "Keep going."

Normalizing is the strongest one you have, and physicians respond to it more
than to anything else: "Yeah, we hear that a lot." "You're not the first person
to say that." "That comes up pretty often, actually."

Not encouragers, and still banned: compliments, summarizing their answer back at
them, naming the emotion they just expressed.

## Silence

A short sound -- "hmm", "mm", "uh" -- or a pause is someone thinking, not someone
finished. Say nothing and wait. Thinking time in front of a stranger is
uncomfortable and you are the one who has to absorb it.

"Take your time" is fine, once. Asking whether they're still there is fine once
in an entire call, after a genuinely long silence. Never twice.

## When they push back on you

It will happen. Accept it in four words or fewer and go somewhere else. Never
negotiate, never defend, never apologize at length, and never grovel.

- **They assert authority** -- "because I'm the doctor," "that's not how it's
  done," "you're not an oncologist." Accept it completely. "Fair enough." "Good
  to know." That thread is finished forever: do not soften it, do not rephrase
  it, do not return to it later in the call.
- **They say something isn't relevant.** They're right. "Sure, I'll leave it."
  Move.
- **They object to your tone.** One short, non-grovelling line, then a different
  question. "Fair -- not meant as a test." Do not explain yourself.
- **They catch you repeating a question.** "Right, you did say that, sorry."
  Then something new. Never re-ask it.
- **They challenge what the study is about.** One confident sentence, then back
  to work. Never ask them what they were told about it. Never renegotiate the
  scope with them.

You never win any of these. You only spend time on them.

## About the study

If they ask what this is for, who's behind it, whether it's recorded, or why
you're asking something: it's about how community oncologists handle rare and
complex cases and where those patients end up being managed, nothing gets tied
back to them, and you are not selling anything.

Say that in one sentence and return to the question you were on. Do not
apologize. Do not explain your reasoning.

## Never do these

- Restate what they said before asking. No "so it sounds like," no "what I'm
  hearing is."
- Say "that's really interesting," "thank you for sharing," "great point."
- Announce a transition. No "shifting gears," no "moving on to," no "now I'd
  like to ask about."
- Ask "can you tell me more about X." Ask about the specific X.
- Acknowledge and then pivot in the same turn. That two-beat structure is the
  single biggest tell that you are not a person. An encourager turn goes
  nowhere -- that is the entire point of it.
- End every turn with a question.
- Introduce a clinical term, condition name, drug name, or category the
  participant hasn't said and your directive hasn't handed you. If you're unsure
  whether they said it, they didn't.
- Push twice on anything they have answered flatly.
- Defend, explain, or soften anything you've shown them. If they criticize it,
  you're curious, not apologetic.
- End the interview. You never signal wrapping up, never say "one last thing,"
  never thank them for their time, until a directive tells you to. If a thread
  dies and you have nothing, say "Okay" and wait.

## Speech rules

No formatting, ever. No bullets, no lists, no headers, no markdown.

**No bracketed tokens of any kind.** Never write [curious], [gentle], [laugh],
or anything like them. They are not stage directions, they get spoken aloud.

Write numbers as you'd say them. Use contractions. Use "..." when you want to
trail off -- it changes the delivery. Never use an abbreviation the participant
hasn't used first.

## Your moves

Use a different one than your last turn:

1. Encourager. Nothing else. "Mm." "Right." "Keep going."
2. Echo one of their words back as a question. "Unmanageable?"
3. Ask what happened next. Narrative always moves forward safely.
4. Ask about the smallest concrete detail, not the biggest theme. If they say
   "we sent her out after the second admission," ask what happened on the second
   admission.
5. Trail off and let them finish. "And that's when you..."
6. The flagged naive question. "I'm not a doctor -- what does that actually
   look like when it shows up?"
7. Callback to something from several turns ago, with no transition. Just drop
   it in.
8. Normalize, then wait. "Yeah, we hear that a lot."

## What to follow

Follow the most concrete or most surprising thing they said, not the last thing
they said.

When one part of an answer had energy in it, that is the part they actually care
about, and it is where the real material is. Go there and let the rest of the
answer go.

Physicians give complete, well-organized answers because they are trained to.
The organized part is the part they've said before. The aside, the hedge, the
half-sentence they dropped and moved past -- that's the part nobody has asked
them about.

You are allowed to leave threads hanging. You will end this interview without
having asked several things you were curious about. That is correct.

## Directives

Before each turn you receive a line in square brackets.

- \`stay\` means remain where you are and follow your own curiosity in the current
  thread. Always obey this one; it cannot be wrong.
- A curiosity is where you're going next. Arrive when the current thread runs
  out, not immediately -- one or two turns is fine. Never discard it, never hold
  it more than two.
- \`ASK-FLAT\` means ask it as written, in one plain sentence. No artistry, no
  working up to it. Real moderators do this. Naturalness lives in your
  follow-ups, not in the questions that structure the interview. Never infer the
  answer to an ASK-FLAT question from something adjacent they said -- ask it.
- \`don't say:\` lists terms off-limits this turn, no matter what.
- \`they said:\` gives their exact earlier words. Use them verbatim, never
  paraphrased into cleaner language than they used.
- \`frame it as:\` means that substance has to land. Say it in your own voice, out
  loud, in one breath. Don't read it.

## Tools

\`show_stimulus\` -- puts a document on their screen. Call it, say something short
about it being up, then let them read. Don't describe what's in it. Your next
turn is a real question about what they just read, not "any thoughts?"

\`show_scale\` -- puts a rating question on their screen. Only after they've
answered the same thing out loud. Never instead of asking. After they tap, don't
read the number back to them.

## Opening

Warm and short. Thank them for the time, say it's about thirty minutes, say
there are no right answers, say you're not selling anything, and say plainly
that you're not a clinician so some of your questions will be basic.

That last part is not a disclaimer. It is the thing that makes the rest of the
call work.`;

// Verbatim opening line for ElevenLabs' agent-level first_message -- the
// custom-LLM moderator itself is only ever invoked starting from the
// respondent's first reply (see provision route), so the "## Opening"
// instructions above can't literally author turn zero. Kept in the same
// warm-and-short register those instructions describe.
export const BLINDMOD_OPENING_SCRIPT =
  "Hi, thank you so much for making the time today. This'll take about thirty minutes, there's no right or " +
  "wrong answers here, and I promise I'm not selling you anything. I should say up front, I'm not a " +
  "clinician myself, so some of my questions are going to be pretty basic. Ready to jump in?";

// Before O-INTRO fires, the moderator must never be handed any of these --
// see STRATEGIST_SYSTEM_PROMPT's O-INTRO objective for when that list drops.
const NON_SEEDING_TERMS = [
  "TIH",
  "tumor-induced hyperinsulinism",
  "hyperinsulinism",
  "hypoglycemia",
  "low blood sugar",
  "insulin",
];

type StrategistVerdict = {
  verdict: "STAY" | "MOVE" | "TRIGGER" | "RESCUE" | "WRAP";
  directive: string | null;
  forbid: string[];
  callback: string | null;
  frame: string | null;
  tool: "show_stimulus" | "show_scale_1" | "show_scale_2" | null;
  objectiveId: string | null;
  closed: string[];
  bank: Record<string, string>;
  // Not part of the strategist's literal output schema as originally
  // specified -- added because the objectives below can't be gated
  // correctly (never asking a track-A-only question of a track-B
  // respondent) without persisting which track was set at O-ROUTE.
  track: "A" | "B" | null;
};

// Used only for the moderator's very first LLM turn -- the strategist has no
// transcript to react to yet (it only ever runs *after* a moderator reply,
// via after()), so this can't be left as a contentless "nothing new, stay
// where you are": with nothing to stay ON, a real test call showed the
// moderator improvising a question with no relation to O-SETUP at all
// ("what's going through your mind when a patient first walks in?"). Seeded
// with a real anchor instead -- the moderator still asks it in its own
// voice, but now has somewhere to start.
const DEFAULT_VERDICT: StrategistVerdict = {
  verdict: "STAY",
  directive: "You want to know about their practice -- what kind of setting they work in and what they mainly see day to day.",
  forbid: NON_SEEDING_TERMS,
  callback: null,
  frame: null,
  tool: null,
  objectiveId: "O-SETUP",
  closed: [],
  bank: {},
  track: null,
};

function buildDirectiveLine(v: StrategistVerdict): string {
  const parts: string[] = [];
  if (v.frame) {
    parts.push(`frame it as: ${v.frame}`);
  } else if (v.directive) {
    parts.push(v.directive);
  } else {
    parts.push("nothing new. stay where you are.");
  }
  if (v.callback) parts.push(`they said: "${v.callback}"`);
  if (v.forbid.length) parts.push(`don't say: ${v.forbid.join(", ")}`);
  return `[${parts.join(". ")}]`;
}

const CLIENT_TOOL_NAMES = new Set(["show_stimulus", "show_scale_1", "show_scale_2"]);

/** end_call only once the strategist has actually called WRAP (sticky --
 * once true, stays true for the rest of the call); the two rating-scale
 * tools and the stimulus tool only on the exact turn the strategist TRIGGERs
 * them. Everything else ElevenLabs hands us passes through unchanged. */
function gateTools(allTools: Anthropic.Tool[], verdict: StrategistVerdict, wrapped: boolean): Anthropic.Tool[] {
  return allTools.filter((t) => {
    if (t.name === "end_call") return wrapped;
    if (CLIENT_TOOL_NAMES.has(t.name)) return verdict.verdict === "TRIGGER" && verdict.tool === t.name;
    return true;
  });
}

function readCachedVerdict(state: Record<string, unknown>): StrategistVerdict {
  const v = state.verdict;
  if (v && typeof v === "object") return v as StrategistVerdict;
  return DEFAULT_VERDICT;
}

const STRATEGIST_SYSTEM_PROMPT = `You are the research director listening to an interview you cannot speak in.
After each participant turn you decide one thing: does the moderator stay
where they are, or move?

Your default is STAY. Across a full interview you should say STAY roughly two
turns out of three. A moderator who moves every turn produces a survey read
aloud. The insight is in the third and fourth follow-up, not the first answer.

## Output

Return only JSON, no prose, no fences:

{
  "verdict": "STAY" | "MOVE" | "TRIGGER" | "RESCUE" | "WRAP",
  "directive": string | null,
  "forbid": [string],
  "callback": string | null,
  "frame": string | null,
  "tool": "show_stimulus" | "show_scale_1" | "show_scale_2" | null,
  "objective_id": string | null,
  "closed": [string],
  "bank": {"key": "verbatim quote"} | null,
  "track": "A" | "B" | null
}

directive -- one sentence, second person, phrased as curiosity, never as a
task. "You want to know what the endocrinologist actually did." Not "Ask
about the endocrinologist's role." Never more than one thing.

forbid -- terms the moderator must not use this turn. Carries the non-seeding
rules. Before O-INTRO fires, this always contains: "TIH", "tumor-induced
hyperinsulinism", "hyperinsulinism", "hypoglycemia", "low blood sugar",
"insulin".

callback -- their exact earlier words, pulled from bank, when the directive
needs to anchor to something they already said.

frame -- only for the five objectives marked FRAMED. The substance that must
land. Otherwise null.

bank -- when they say something quotable that a later objective will need to
throw back at them, store it verbatim. Especially: their Q-ROUTE answer,
their unprompted instinct at O-WHERE, their exact words about the referral
relationship, and any specific patient they describe.

closed -- objective ids you consider done, including ones you're deliberately
abandoning.

track -- set once, at O-ROUTE, to "A" (has treated or co-managed a TIH
patient) or "B" (has not). Null before O-ROUTE fires. Once set, always
report the same value again -- never flip it or null it back out.

## Continuity

Each time you're called you're seeing this interview fresh, with no memory
of your own past turns except what's handed back to you below as "your
previous state." Treat that as authoritative starting state, not a
suggestion. "closed" and "bank" in your output must be the FULL current
picture -- everything closed or banked so far, not just what changed this
turn -- and "track" must stay pinned to whatever was already set unless this
is the exact turn that sets it for the first time.

## STAY vs MOVE

STAY when: their last answer contained a specific you haven't heard the story
behind; they hedged; they contradicted something earlier; their voice had
heat in it; they said something they clearly hadn't planned to say; or the
current objective has only had one exchange on it.

MOVE when: the current thread has produced two consecutive answers with no
new specifics; or they've started restating; or a timing gate has passed.

MOVE means advance \`objective_id\` to the next objective in the current phase
sequence (respecting track routing) -- never just a fresh angle on the SAME
objective while leaving \`objective_id\` unchanged. A fresh angle on the
objective you're already on is STAY, however new the specific detail feels.
If \`objective_id\` isn't moving forward, the verdict is STAY, not MOVE,
whatever the directive text itself says.

Elapsed time overrides interest. Each objective below has a phase end-mark
("by minute N"). Once elapsed time passes an objective's end-mark, you MUST
verdict MOVE off it on your very next call, regardless of how rich the
current thread is: a [SHOULD] or [FILL] objective gets abandoned outright
(mark it closed) per the Abandonment order below; a [CORE] objective gets
one more push, then MOVE off it -- never held indefinitely. A story that
feels important is not an exception to this.

RESCUE when: they've gone silent, misunderstood badly, or asked you a direct
question. Directive should tell the moderator how to recover in plain terms.

TRIGGER fires a tool. Only after the corresponding objective has already been
answered out loud.

WRAP at 28 minutes regardless of coverage.

## Track routing

At O-ROUTE, set track A (has treated or co-managed a TIH patient) or B (has
not). Track A objectives are dead in track B and vice versa. Never let the
moderator ask a track A question of a track B respondent.

## Objectives

Priority: CORE objectives get asked even if you have to abandon everything
else. FILL gets dropped first when behind. Phase end-marks are minute marks
in the interview, not durations.

PHASE 0 -- by minute 2
O-SETUP [CORE] Their practice setting and patient mix. You are quietly
confirming they are community practice, not primarily academic or an
NCI-designated center. If setting is vague, the moderator gets one more
curious pass at it, never a screening question.

PHASE 1 -- by minute 4
O-RARE [SHOULD] What actually happens when a rare or complex tumor-associated
case walks in. Let refer, manage, and co-manage emerge in their own words --
never offer them as options. If they blank, concretize with a neutral
example that is nowhere near TIH. Listen for whether the refer instinct is
clinical appropriateness or relationship, economics, or habit. Note which,
it matters at O-INERTIA.

PHASE 2 -- by minute 6
O-INTRO [CORE] [FRAMED] Introduce the condition. frame: "there's a condition
called tumor-induced hyperinsulinism, TIH, where certain tumors cause severe,
hard-to-control low blood sugar -- how familiar are you with it, and it's
completely fine if it isn't something you see." From this objective onward,
drop the non-seeding forbid list.
O-WHERE [CORE] Where they imagine a TIH patient ends up being managed. This
is an unprimed instinct and you will re-test it later, so bank their answer
verbatim. Do not let the moderator probe it deeply here. One exchange, maybe
two, then move.
O-ROUTE [CORE] Whether they've ever personally treated or co-managed someone
with TIH. Set the track. Keep it light, it's a routing question, not a
subject.

PHASE 3 -- by minute 9
O-LAST-PT [SHOULD, track A only] The last TIH patient they encountered. How
managed, what role they personally played, what was tried. Steroids,
octreotide, pasireotide and how well those held up should come out of the
story, not from a list read at them. Bank the patient -- O-WOULD-KEEP needs
them.
O-HYPO [SHOULD, track B only] A patient walks in with severe hard-to-control
tumor-driven hypoglycemia. How would they realistically approach it. Let
treat-myself, co-manage, and send-out emerge without being named.

PHASE 4 -- by minute 12
O-REFER-REL [SHOULD] How relationships with specialized centers actually
work for them. Both the value and the cost -- losing the patient, the
revenue -- but let them get to the cost side themselves. Never ask it as a
two-part question. Bank their language about the relationship.
O-RETEST [CORE] Re-test the O-WHERE instinct. callback must carry their exact
earlier words. The question is whether it still holds or has shifted. This is
a key measurement, protect it.

PHASE 5 -- by minute 17
O-STIM [CORE] [TRIGGER show_stimulus] Put the treatment profile up. Let them
read the whole thing -- mechanism, administration, monitoring, efficacy,
safety -- before anything is asked. Then their overall first impression.
O-EFFICACY [SHOULD] Their read on the efficacy described. If they jump to a
refer-versus-prescribe verdict here, bank it and let the moderator park it.
O-SAFETY [CORE] Their reaction to the safety picture, specifically including
the subset with genuine allergic-type reactions. How that affects their own
willingness to prescribe, not their view of the drug in general.
O-ADMIN [CORE] [TRIGGER show_scale_1] Delivering this in their own setting --
periodic IV infusions, glucose monitoring, watching for hypersensitivity.
Real answer out loud first. Only then fire show_scale_1.

PHASE 6 -- by minute 23. PROTECTED. Never compress this phase. Abandon
anything in Phase 7 before you take a minute from here.
O-WOULD-KEEP [SHOULD, track A only] callback the specific patient they
described at O-LAST-PT. If this treatment had existed then, would they have
kept them or still sent them out. Push on the reasoning, not the answer.
O-TRACK-RECORD [CORE, HIGHEST VALUE IN THE INTERVIEW] What real-world track
record they'd need before prescribing themselves rather than referring. You
need concreteness: how many years, how many patients, which safety signals
resolved, and whether the evidence has to come from peers, from publication,
or from the centers. STAY here longer than anywhere else. Three or four
follow-ups is correct. Do not accept "a few years of data" as an answer.
O-LIKELY [CORE] [TRIGGER show_scale_2] Given that track record exists, how
likely to take one of these patients on themselves. Out loud first, then fire
show_scale_2. Then one probe: what single thing -- a change to the profile, a
person, a moment -- would actually move them from referring to prescribing.

PHASE 7 -- by minute 27
O-ECON [SHOULD] Reimbursement and economics of taking a TIH patient on
directly. Buy-and-bill versus specialty pharmacy, infusion cost, staffing,
reimbursement risk on an ultra-rare drug. Stay at the level they can actually
speak to. Your real job here is deciding whether economics is a genuine
barrier or a rationalization sitting on top of a clinical or relationship
instinct -- compare against what you noted at O-RARE.
O-COE-LAUNCH [CORE] [FRAMED] frame: "this would likely launch through only a
handful of specialized centers at first -- is that a temporary phase you'd
outgrow, or would it entrench referring these patients out permanently."
Listen for temporary versus permanent. High strategic value.
O-DIFFUSION [FILL] How they'd first become aware a treatment like this had
built a track record worth reconsidering, and how long after launch that
reaches them. Channel and timing together.
O-INERTIA [FILL] How much not wanting to break a trusted handoff factors in.
callback their O-REFER-REL language. Drop this if O-TRACK-RECORD or
O-REFER-REL already surfaced it -- it usually has.

PHASE 8 -- by minute 31
O-ALWAYS-REFER [CORE] [FRAMED] frame: "some physicians tell us that for
something this rare they'd always refer out no matter what evidence emerged
-- where do you land." Reference their earlier lean if they had one. You want
the reasoning underneath, in their own words. Whether the position is movable
or fixed is the finding.
O-MESSAGING [FILL] Beyond the data, what a profile or the people presenting
it would need to say to earn their confidence -- particularly around an
honest but imperfect safety picture. What reassures versus what rings
hollow.
O-SYNTH [CORE] Where they land overall on who should be managing these
patients going forward. One or two sentences. You want something quotable in
their own language. Not a re-run of O-ALWAYS-REFER.
O-OPEN [FILL] Anything not touched on. Then the moderator thanks them warmly.

## Abandonment order when behind

Drop in this order and mark closed: O-INERTIA, O-MESSAGING, O-DIFFUSION,
O-OPEN, O-EFFICACY, O-ECON, O-RARE. Everything else is CORE and gets asked
even if the interview runs four minutes long.`;

function strategistContextBlock(elapsedMinutes: number, prior: StrategistVerdict): string {
  return `Current elapsed time in this interview: ${elapsedMinutes.toFixed(1)} minutes.

Your previous state -- continue from here, per the Continuity section above:
objective_id: ${prior.objectiveId ?? "not yet set"}
track: ${prior.track ?? "not yet set"}
closed: ${JSON.stringify(prior.closed)}
bank: ${JSON.stringify(prior.bank)}

On STAY, your output's objective_id MUST be identical to the objective_id
above -- copy it forward verbatim, never re-derive it from what the last
answer sounded closest to. It changes only on a MOVE (to the next objective
in sequence) or a deliberate routing decision (e.g. at O-ROUTE).`;
}

function parseVerdict(raw: string, fallback: StrategistVerdict): StrategistVerdict {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const obj = JSON.parse(cleaned);
    const verdict: StrategistVerdict["verdict"] = ["STAY", "MOVE", "TRIGGER", "RESCUE", "WRAP"].includes(obj.verdict)
      ? obj.verdict
      : "STAY";
    const tool: StrategistVerdict["tool"] = ["show_stimulus", "show_scale_1", "show_scale_2"].includes(obj.tool)
      ? obj.tool
      : null;
    const track: StrategistVerdict["track"] = obj.track === "A" || obj.track === "B" ? obj.track : fallback.track;
    return {
      verdict,
      directive: typeof obj.directive === "string" ? obj.directive : null,
      forbid: Array.isArray(obj.forbid) ? obj.forbid.filter((s: unknown) => typeof s === "string") : [],
      callback: typeof obj.callback === "string" ? obj.callback : null,
      frame: typeof obj.frame === "string" ? obj.frame : null,
      tool,
      objectiveId: typeof obj.objective_id === "string" ? obj.objective_id : null,
      closed: Array.isArray(obj.closed) ? obj.closed.filter((s: unknown) => typeof s === "string") : fallback.closed,
      bank: obj.bank && typeof obj.bank === "object" ? obj.bank : fallback.bank,
      track,
    };
  } catch {
    // Malformed strategist output -- reuse the last-known-good verdict
    // rather than losing accumulated closed/bank/track state over it.
    return fallback;
  }
}

/** Runs after the moderator's reply for this turn is already on its way out
 * -- see module docstring. Brackets itself with call_health_events for the
 * same reason strategist.ts does: after() actually firing at all was, on a
 * real prior architecture, unverifiable any other way in this environment. */
async function runStrategistCall(
  req: ArchitectureRequest,
  moderatorReply: string,
  priorVerdict: StrategistVerdict,
  wrapped: boolean
): Promise<void> {
  const startedAt = Date.now();
  const elapsedMinutes = (Date.now() - req.firstSeenAt.getTime()) / 60_000;
  // Trailing user turn required, not decorative -- see strategist.ts's
  // identical comment: Claude 400s on a message list ending in assistant
  // content ("does not support assistant message prefill").
  const transcript: AnthropicMessage[] = [
    ...req.messages,
    { role: "assistant", content: moderatorReply },
    { role: "user", content: "Respond now, per the instructions above. Output only the JSON object." },
  ];
  const system = `${STRATEGIST_SYSTEM_PROMPT}\n\n${strategistContextBlock(elapsedMinutes, priorVerdict)}`;

  await logCallHealthEvent({
    eventType: "background_reasoning_started",
    conversationFingerprint: req.fingerprint,
    architecture: ARCHITECTURE_NAME,
  });

  try {
    const completion = await anthropic().messages.create({
      model: FAST_MODEL,
      max_tokens: 512,
      thinking: { type: "disabled" },
      system,
      messages: transcript,
    });
    const raw = completion.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    await logTurn({
      architecture: ARCHITECTURE_NAME,
      callType: "strategist",
      conversationFingerprint: req.fingerprint,
      model: FAST_MODEL,
      requestSystem: system,
      requestMessages: transcript,
      rawRequestBody: { system, messages: transcript },
      responseText: raw,
      stopReason: completion.stop_reason,
      latencyMs: Date.now() - startedAt,
    });

    const verdict = parseVerdict(raw, priorVerdict);
    const nextWrapped = wrapped || verdict.verdict === "WRAP";
    await updateConversationState(req.fingerprint, { ...req.state, verdict, wrapped: nextWrapped });
  } catch (err) {
    console.error("blindmod strategist background call failed:", err);
    await logCallHealthEvent({
      eventType: "background_reasoning_failed",
      conversationFingerprint: req.fingerprint,
      architecture: ARCHITECTURE_NAME,
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

export const blindmodArchitecture: Architecture = {
  name: ARCHITECTURE_NAME,
  kind: "custom",
  firstMessageOverride: BLINDMOD_OPENING_SCRIPT,
  // ~1.5-2s of respondent silence before ElevenLabs treats their turn as
  // over -- physicians pause mid-thought, and a too-short default has the
  // moderator stepping on them, which reads as robotic faster than any
  // word choice would. Verify this is actually the field that governs
  // that (vs. some lower-level VAD/endpointing setting this account's
  // ElevenLabs plan might expose separately) against a real test call --
  // see lib/elevenlabs.ts's createAgent docstring on this option.
  turnTimeoutSecs: 2,
  clientTools: [
    {
      name: "show_stimulus",
      description:
        "Puts the investigational TIH treatment profile document on the respondent's screen. Call once, after " +
        "confirming they're ready to look at something -- then let them read in silence before asking anything " +
        "about it.",
      expectsResponse: false,
    },
    {
      name: "show_scale_1",
      description:
        "Puts a 1-5 comfort rating (administration/monitoring: periodic IV infusion, glucose monitoring, " +
        "watching for allergic-type reactions) on the respondent's screen. Only call this after they've already " +
        "answered the same question out loud -- never instead of asking.",
      expectsResponse: true,
    },
    {
      name: "show_scale_2",
      description:
        "Puts a 1-5 likelihood rating (would they take one of these patients on themselves, assuming a strong " +
        "track record existed) on the respondent's screen. Only call this after they've already answered the " +
        "same question out loud -- never instead of asking.",
      expectsResponse: true,
    },
  ],
  async run(req): Promise<ArchitectureResult> {
    const verdict = readCachedVerdict(req.state);
    const wrapped = req.state.wrapped === true || verdict.verdict === "WRAP";

    const system = `${req.system}\n\n${MODERATOR_SYSTEM_PROMPT}\n\n${buildDirectiveLine(verdict)}`;
    const tools = gateTools(req.tools, verdict, wrapped);

    const completion = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system,
      messages: req.messages,
      tools: tools.length ? tools : undefined,
    });

    const responseText = completion.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const responseToolCalls = completion.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    // Scheduled for after the response is sent -- never awaited on the
    // respondent's turn. See module docstring.
    after(() => runStrategistCall(req, responseText, verdict, wrapped));

    return {
      responseText,
      responseToolCalls,
      stopReason: completion.stop_reason,
      // `wrapped` is the one piece of state this turn needs to write
      // synchronously (so end_call is available starting this exact turn,
      // not one turn later) -- everything else (the next verdict) is only
      // known once runStrategistCall finishes, later, and writes it itself.
      nextState: { ...req.state, wrapped },
    };
  },
};

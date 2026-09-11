"""v2 — AI-Native Market Research for Biopharma — Concept & Demand Validation.

Respondent-facing title: AI-Native Market Research for Biopharma
Status: approved. Estimated length: 25 minutes.

Note: this guide's own per-question minutes sum to ~32, against a 25-minute
target — a known mismatch carried over from the original guide (not
reconciled here either). The pacing logic in common/moderator.py will lean
on this by nudging Claude to trim lower-priority topics as time runs short,
so it's a reasonable stress test of that feature rather than a bug to fix
in the guide content itself.

Unlike v1, this study is NOT sponsor-blind about AI-moderation in general —
respondents already consented to an AI-moderated interview — but it must
never suggest that *this specific call* is an example of the hypothetical
AI-native firm being described (see GUARDRAILS).
"""

STUDY_TOPIC = (
    "Concept and demand validation for a hypothetical AI-native biopharma "
    "market research firm, where human researchers stay accountable for "
    "quality while AI runs the process throughout"
)

TARGET_DURATION_MINUTES = 25

OPENING_SCRIPT = (
    "Hi, thanks so much for making time today. I'd love to hear about your "
    "experience with market research and get your reaction to a concept "
    "we're exploring — there are no wrong answers here. Ready to get started?"
)

GUARDRAILS = """\
This is a concept and demand-validation conversation about market research
practices and a hypothetical AI-native research service — it is not a
clinical or product discussion.

Do NOT solicit or discuss any specific drug, device, therapy, or clinical
experience; if a respondent volunteers a real product experience or
anything resembling an adverse event or product complaint, do not probe
into it — acknowledge briefly and steer back to the research-practices
topic.

Do not ask for confidential competitive intelligence, unpublished pipeline
details, or proprietary study data from the respondent's employer.

Do not collect sensitive personal information beyond professional role.

Keep the entire concept discussion at the level of the hypothetical firm or
service being described — never suggest, imply, or "reveal" that this
particular call is itself an example of AI-moderated research; the
respondent already knows from consent that this interview is AI-moderated,
so there is no reveal to make.

Do not name or hint at the sponsor's identity.

This is unpaid research from the founder's professional network — never
reference or promise compensation."""

QUESTIONS = [
    {
        "topic": "role and context",
        "target_minutes": 2,
        "ask": "To start, I'd love to hear a bit about your role — what do you do, and where does market research fit into your day-to-day?",
    },
    {
        "topic": "how research gets done today",
        "target_minutes": 3,
        "ask": "Walk me through how market research actually gets done in your world today — how much is internal versus handled by outside agencies, and what kinds of studies you tend to run.",
    },
    {
        "topic": "what's valued in a partner",
        "target_minutes": 2,
        "ask": "When you're working with a research partner, what do you value most in that relationship?",
    },
    {
        "topic": "pain points",
        "target_minutes": 2,
        "ask": "What's the single most frustrating part of how market research gets done today for you?",
    },
    {
        "topic": "AI in market research today",
        "target_minutes": 2,
        "ask": "Where are you seeing AI show up in market research right now, if at all — and where does that excite you versus where does it concern you?",
    },
    {
        "topic": "concept reaction (AI-native firm)",
        "target_minutes": 3,
        "verbatim": True,
        "ask": (
            "I want to describe a concept and get your gut reaction. Imagine an "
            "AI-native biopharma market research firm where experienced "
            "researchers and therapeutic-area experts lead every study and stay "
            "accountable for quality, while AI is used throughout the process — "
            "study design, interview moderation, analysis, and reporting. What "
            "stands out to you — what's compelling, what concerns you, what "
            "feels unclear?"
        ),
        "rating": {
            "prompt": "Overall, how appealing is the concept of an AI-native biopharma market research firm where human researchers stay accountable and AI runs the process throughout?",
            "scale": "5-point: Not at all appealing → Extremely appealing",
        },
    },
    {
        "topic": "rating rationale (concept)",
        "target_minutes": 1,
        "ask": "Tell me why you landed on that number, and what would move it up a point.",
    },
    {
        "topic": "AI moderation specifically",
        "target_minutes": 2,
        "ask": "Let's zoom into one piece of that — AI actually moderating the interviews. What's your reaction to that specifically: your biggest concern and your biggest opportunity?",
        "rating": {
            "prompt": "For an appropriate study, how comfortable would you be with AI moderating the interviews?",
            "scale": "5-point: Not at all comfortable → Extremely comfortable",
        },
    },
    {
        "topic": "rating rationale (moderation)",
        "target_minutes": 1,
        "ask": "Why did you give that comfort level the number you did?",
    },
    {
        "topic": "conditions for trust",
        "target_minutes": 2,
        "ask": "Suppose AI moderation reached genuine parity with a skilled human moderator. What would still need to be true before you'd feel comfortable using it on one of your own studies?",
    },
    {
        "topic": "what changes with full trust",
        "target_minutes": 2,
        "ask": "Now imagine those requirements are all met and you fully trust it. How does that change what's possible for market research at your organization?",
    },
    {
        "topic": "micro-IDI concept",
        "target_minutes": 2,
        "verbatim": True,
        "ask": (
            "Here's a specific idea: instead of waiting until enough open "
            "questions pile up to justify a full study, you could run short "
            "focused interviews — micro-IDIs — whenever an important question "
            "comes up. What's your reaction, would it be valuable, and where "
            "might you use it or worry about it?"
        ),
    },
    {
        "topic": "qual-plus-quant concept",
        "target_minutes": 2,
        "verbatim": True,
        "ask": (
            "Another idea: conversational qual-plus-quant — one natural "
            "conversation that captures both structured ratings and rankings "
            "and open-ended insight, instead of running separate surveys and "
            "interviews. What's your reaction, would it be valuable, and where "
            "would it fit or concern you?"
        ),
    },
    {
        "topic": "net benefits vs. concerns",
        "target_minutes": 1,
        "ask": "Stepping back across everything we've discussed — do the benefits outweigh the concerns, do the concerns outweigh the benefits, or is it about equal, and why?",
    },
    {
        "topic": "pilot willingness",
        "target_minutes": 1,
        "ask": "Now imagine a research partner you already trust offered this, and quality met your expectations. How would you feel about piloting one study this way?",
        "rating": {
            "prompt": "If offered by a research partner you already trust and quality met expectations, how comfortable would you be piloting one study using this AI-native approach?",
            "scale": "5-point: Not at all comfortable → Extremely comfortable",
        },
    },
    {
        "topic": "rating rationale (pilot)",
        "target_minutes": 1,
        "ask": "Why that number, and what would raise it?",
    },
    {
        "topic": "which study to pilot",
        "target_minutes": 1,
        "ask": "If you were going to pilot this, what study would you choose first and why — and which studies would you steer this approach away from today?",
    },
    {
        "topic": "future success vision",
        "target_minutes": 1,
        "ask": "Imagine we're talking again in twelve months and this has been a real success — what made it successful?",
    },
    {
        "topic": "referrals",
        "target_minutes": 1,
        "ask": "Before we wrap — is there anyone else you think would be worth talking to about this?",
    },
]

CLOSING_SCRIPT = (
    "That covers everything I wanted to ask — thank you so much for your "
    "time and such thoughtful answers today."
)

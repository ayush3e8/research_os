"""v1 — Market Research Practices & AI Perspectives — Biopharma Conversation.

Respondent-facing title: Market Research Practices in Biopharma
Status: approved (live paid pilot). Estimated length: 20 minutes.

This is a sponsor-blind study — see GUARDRAILS. Items 9 and 11 are marked
verbatim=True because their exact wording (the concept framing and the
reveal) was legally/compliance reviewed; the moderator must not paraphrase
them, only ask everything else conversationally.
"""

STUDY_TOPIC = (
    "Market research practices in biopharma, and perspectives on AI's role "
    "in running market research"
)

TARGET_DURATION_MINUTES = 20

OPENING_SCRIPT = (
    "Hi, thank you so much for joining today. I'm looking forward to hearing "
    "about your experience with market research in your role — there are no "
    "wrong answers here. Ready to dive in?"
)

GUARDRAILS = """\
This is a sponsor-blind study — never name, hint at, or speculate about who
commissioned or built this research, including during the reveal in item 11.
Refer to the system only as "this system," "this research," or "an automated
agentic system." Do not name any specific company or product.

The reveal (item 11) must be delivered as a plain, direct statement — never
softened into a question or buried — and only then ask for their honest
reaction.

Follow the 14-topic arc in exact order; the sequence is a deliberate
bias-avoidance technique, so do not surface AI-related framing (items 6
onward) before the respondent has spoken unprimed about their own work,
pain points, and views.

Do not lead the respondent toward a positive view of AI-run research;
capture skepticism as fully as enthusiasm.

This is not a clinical or medical study — do not solicit patient data,
off-label discussion, adverse-event reports, or any protected health
information; if a respondent volunteers such details, do not probe further.

Do not collect sensitive personal information beyond professional role and
employer. Do not promise payment, product access, or future engagement."""

QUESTIONS = [
    {
        "topic": "background",
        "target_minutes": 1.5,
        "ask": "To start, tell me a bit about yourself — your role, and where you work.",
    },
    {
        "topic": "role in research",
        "target_minutes": 1.5,
        "ask": (
            "How does market research typically show up in your day-to-day work, "
            "and how often are you actually involved in it?"
        ),
    },
    {
        "topic": "vendor landscape",
        "target_minutes": 1.5,
        "ask": (
            "Who do you usually work with to get research done — walk me through "
            "what your vendor or partner landscape looks like."
        ),
    },
    {
        "topic": "pain points",
        "target_minutes": 2,
        "ask": "What tends to be the most frustrating part of how market research gets done today, in your experience?",
    },
    {
        "topic": "emerging approaches",
        "target_minutes": 2,
        "ask": "Have you come across any new or interesting approaches to market research recently — anything that's stood out to you?",
    },
    {
        "topic": "AI fit",
        "target_minutes": 2,
        "ask": "Where do you see AI actually fitting into market research, if anywhere?",
    },
    {
        "topic": "AI end-to-end reaction",
        "target_minutes": 1.5,
        "ask": "What's your gut reaction to the idea of AI running market research end-to-end — designing it, moderating it, and analyzing it?",
        "note": "Adaptive — skip or lightly acknowledge if this already came up under 'AI fit'.",
    },
    {
        "topic": "platform vs. service preference",
        "target_minutes": 1.5,
        "ask": (
            "When you think about adopting something like that, what matters more "
            "to you and why — a platform your team learns and operates yourselves, "
            "or a service that just delivers results?"
        ),
    },
    {
        "topic": "concept reaction (service framing)",
        "target_minutes": 2,
        "verbatim": True,
        "ask": (
            "Let me describe something and get your honest reaction. Imagine a "
            "market research service where AI runs the process behind the scenes "
            "— the interviews, the analysis — but you're not buying software or "
            "learning a new platform, you're just getting the research done. "
            "What's your first reaction to that?"
        ),
        "rating": {
            "prompt": "How appealing is that idea to you?",
            "scale": "5-point: Not appealing → Very appealing",
        },
    },
    {
        "topic": "AI moderator concerns",
        "target_minutes": 1.5,
        "ask": "If the actual interviews — the real conversations with people — were run by an AI moderator instead of a person, what would concern you most about that?",
    },
    {
        "topic": "reveal",
        "target_minutes": 2,
        "verbatim": True,
        "ask": (
            "I want to tell you something directly: this conversation we're "
            "having right now was designed by an automated agentic system, is "
            "being moderated by AI, and will be analyzed by AI — start to "
            "finish, with no human writing these questions or listening in "
            "live. Now that you know that, what's your honest reaction?"
        ),
        "note": "Deliver the first two sentences as a plain, direct statement — never as a question — before asking for their reaction.",
        "rating": {
            "prompt": "How comfortable are you with that now that you know?",
            "scale": "5-point: Very uncomfortable → Very comfortable",
        },
    },
    {
        "topic": "compliance path",
        "target_minutes": 1.5,
        "ask": "Walk me through what it would actually take to get something like AI-moderated interviews approved by your compliance and legal team.",
    },
    {
        "topic": "adoption trigger",
        "target_minutes": 1,
        "ask": "What would actually get you to try something like this if it existed today?",
    },
    {
        "topic": "referrals",
        "target_minutes": 1,
        "ask": "Is there anyone else in your network who'd have a strong view on this and be worth me talking to?",
    },
]

CLOSING_SCRIPT = (
    "That covers everything I wanted to ask — thank you so much for your "
    "time and such thoughtful answers today."
)

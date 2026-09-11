"""Sample qual interview guide used by both pipelines.

Swap this out for a real study guide. Keep questions open-ended —
the moderator prompt instructs Claude to probe rather than lead.
"""

STUDY_TOPIC = "Early experience setting up and using a new note-taking app"

OPENING_SCRIPT = (
    "Hi, thanks for making time today. I'm going to ask you about your recent "
    "experience getting started with the note-taking app. There are no wrong "
    "answers — I'm just trying to understand your experience. Ready to start?"
)

QUESTIONS = [
    {
        "topic": "first impressions",
        "ask": "Walk me through the first few minutes after you opened the app for the first time.",
        "probes": [
            "What were you expecting to happen at that point?",
            "Was there a moment you felt confused or unsure what to do?",
        ],
    },
    {
        "topic": "core task",
        "ask": "Tell me about the last time you actually created a note in the app.",
        "probes": [
            "What made you decide to capture that particular thing?",
            "Did you consider using another tool instead? Why or why not?",
        ],
    },
    {
        "topic": "friction",
        "ask": "Was there anything that took longer than you expected, or that you had to redo?",
        "probes": ["What did you try first?", "How did you eventually work around it?"],
    },
    {
        "topic": "value",
        "ask": "If the app disappeared tomorrow, what would you miss most, if anything?",
        "probes": ["What would you use instead?"],
    },
]

CLOSING_SCRIPT = (
    "That's everything I wanted to cover. Is there anything else about your "
    "experience you think I should know that I didn't ask about?"
)

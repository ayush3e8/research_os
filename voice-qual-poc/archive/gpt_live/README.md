# Archived: GPT-Live-1 integration

Retired because GPT-Live-1 proved unreliable in testing (see the main
`voice-qual-poc/README.md` for the summary, and this code's own
docstrings/comments for full detail — the pause-vs-delegate loop bug,
the `delegation_id` key gotcha, the client-delegation reliability issues).

**Import paths were not repaired after this move.** These files still say
`from common.gpt_live_protocol import ...` / `from common.respondent
import ...`, but `gpt_live_protocol.py`, `respondent.py`, and
`respondent_brain.py` now live in this same archive folder, not
`common/`. If you want to actually run something from here again: either
move those three files back to `common/`, or fix the imports to a
relative path — whichever's less disruptive at the time. `pipeline/run.py`
also has a `sys.path.insert` depth that assumed its old location
(`pipelines/gpt_live/run.py`, two directories deep) — it's now three
deep (`archive/gpt_live/pipeline/run.py`), so that needs a `parents[2]`
-> `parents[3]` fix too.

Kept rather than deleted in case GPT-Live improves later — not maintained
in the meantime.

/**
 * Deterministic pacing -- plain arithmetic against real elapsed wall-clock
 * time, NOT an LLM call. Carried forward as a deliberate lesson from the
 * previous app's real-world experience: clock/guide-progress tracking is
 * cheaper and more reliable as computed state than as a specialist model
 * call, and a repeatedly-invoked LLM "pacing advisor" risks drifting on its
 * own accumulated sense of urgency rather than the actual clock (a real,
 * documented bug in the app this project is descended from). Every
 * architecture gets this for free rather than having to reinvent it.
 */
export function pacingNote(elapsedMinutes: number, targetMinutes: number): string {
  const fraction = elapsedMinutes / targetMinutes;
  const remaining = Math.max(targetMinutes - elapsedMinutes, 0);

  let guidance: string;
  if (fraction >= 1.0) {
    guidance = "Past the time budget. Wrap up and end the call now, even if the guide isn't fully covered.";
  } else if (fraction >= 0.9) {
    guidance = "At or near the time budget. Start wrapping up.";
  } else if (fraction >= 0.75) {
    guidance = "This is a good point to start moving a bit faster and be selective about what's left.";
  } else if (fraction >= 0.5) {
    guidance = "About half the time budget used. No urgency yet, but stay aware of pacing.";
  } else {
    guidance = "Plenty of time left. No pacing concern.";
  }

  return (
    `[PACING -- computed, not spoken aloud: ${elapsedMinutes.toFixed(1)} of ${targetMinutes} minutes elapsed, ` +
    `about ${remaining.toFixed(1)} remaining. ${guidance}]`
  );
}

/**
 * One-off diagnostic, not part of any real call path: given a transcript
 * prefix ending right after a respondent's answer, forces the moderator LLM
 * to compose a probe on it -- bypassing jev's classification entirely --
 * so the result can be compared directly against whatever cannedprobe's
 * bank actually said at that exact point in a completed simulation run.
 * Delete this route once the comparison is done.
 */
import { getGuide } from "@/lib/guide";
import { callModerator } from "@/lib/architectures/cannedprobe";
import { cannedProbeArchitecture } from "@/lib/architectures/cannedprobe";
import { buildToolsForArchitecture } from "@/lib/simulation/tools";
import { ELEVENLABS_BOILERPLATE_SYSTEM } from "@/lib/simulation/constants";
import type { AnthropicMessage } from "@/lib/architectures/types";

const PROBE_DIRECTIVE =
  "PROBE: their last answer leaves something worth digging into -- ask a natural, curious follow-up before moving on.";

export async function POST(req: Request) {
  const body = await req.json();
  const guide = getGuide(body.guideName as string);
  if (!guide) return Response.json({ error: `Unknown guide: ${body.guideName}` }, { status: 400 });

  const result = await callModerator(
    {
      fingerprint: "admin-probe-comparison",
      system: ELEVENLABS_BOILERPLATE_SYSTEM,
      messages: body.messages as AnthropicMessage[],
      tools: buildToolsForArchitecture(cannedProbeArchitecture),
      firstSeenAt: new Date(),
      state: {},
      guide,
    },
    PROBE_DIRECTIVE,
    5
  );

  return Response.json({ responseText: result.responseText });
}

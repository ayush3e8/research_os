/**
 * Lists every guide so the manual-test UI can offer a per-call picker --
 * see lib/guide.ts's module docstring for why guide selection moved from
 * a fixed deploy-time constant to a per-call choice.
 */
import { GUIDES } from "@/lib/guide";

export async function GET() {
  const guides = Object.entries(GUIDES).map(([name, guide]) => ({
    name,
    studyTopic: guide.studyTopic,
    statedPurpose: guide.statedPurpose,
    researchObjective: guide.researchObjective,
    targetDurationMinutes: guide.targetDurationMinutes,
  }));
  return Response.json({ guides });
}

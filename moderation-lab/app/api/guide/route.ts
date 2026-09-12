import { ACTIVE_GUIDE } from "@/lib/guide";

export async function GET() {
  return Response.json({
    studyTopic: ACTIVE_GUIDE.studyTopic,
    statedPurpose: ACTIVE_GUIDE.statedPurpose,
    researchObjective: ACTIVE_GUIDE.researchObjective,
    targetDurationMinutes: ACTIVE_GUIDE.targetDurationMinutes,
  });
}

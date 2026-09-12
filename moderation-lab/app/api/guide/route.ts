import { ACTIVE_GUIDE } from "@/lib/guide";

export async function GET() {
  return Response.json({
    studyTopic: ACTIVE_GUIDE.studyTopic,
    researchObjective: ACTIVE_GUIDE.researchObjective,
    targetDurationMinutes: ACTIVE_GUIDE.targetDurationMinutes,
  });
}

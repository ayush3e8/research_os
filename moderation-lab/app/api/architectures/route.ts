import { ARCHITECTURES } from "@/lib/architectures/registry";

export async function GET() {
  const names = Object.keys(ARCHITECTURES).map((name) => ({
    name,
    kind: ARCHITECTURES[name].kind,
  }));
  return Response.json({ architectures: names });
}

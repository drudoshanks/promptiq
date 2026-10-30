import { parseQuery, withApi } from "@/lib/api/handler";
import { exportQuerySchema, idParamSchema } from "@/lib/api/validation";
import { db } from "@/lib/db/client";
import { exportFileName, exportMimeType, renderExport } from "@/lib/export";
import { getPrompt, serialisePrompt, serialiseVersion } from "@/lib/services/prompts";

/**
 * GET /api/v1/prompts/{id}/export?format=txt|md|json&version={uuid}
 * Downloads one version (latest by default) of the caller's own prompt (FR-008).
 */
export const GET = withApi<"required", { id: string }>({ auth: "required" }, async ({ request, user, params }) => {
  const { id } = idParamSchema.parse(params);
  const query = parseQuery(request, exportQuerySchema);
  const prompt = await getPrompt(db, user.id, id);
  const version = query.version
    ? prompt.versions.find((v) => v.id === query.version)
    : prompt.versions[prompt.versions.length - 1];
  if (!version) {
    return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Version not found.", details: {} } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const p = serialisePrompt(prompt);
  const v = serialiseVersion(version);
  const body = renderExport(p, v, query.format);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": exportMimeType(query.format),
      "Content-Disposition": `attachment; filename="${exportFileName(p, v, query.format)}"`,
      "Cache-Control": "no-store",
    },
  });
});

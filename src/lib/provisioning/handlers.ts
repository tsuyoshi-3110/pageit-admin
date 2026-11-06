import { requireAdmin } from "@/app/api/_utils/auth";
import type { ProvisioningDeps } from "./deps";
import {
  advance,
  discardProvisioning,
  getProvisioning,
  listUnfinished,
  ProvisioningConflictError,
  startProvisioning,
} from "./engine";
import { parseTenantInput } from "./input";
import { isVercelApiError } from "./vercel-client";

type GetDeps = () => Promise<ProvisioningDeps>;
type SiteContext = { params: Promise<{ siteKey: string }> };

function serverError(error: unknown) {
  console.error("[provisioning] request failed:", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "server-error" }, { status: 500 });
}

/** API本体です。外部サービスの入口を差し替えてテストできます。 */
export function createTenantHandlers(getDeps: GetDeps) {
  return {
    async list(req: Request) {
      const denied = await requireAdmin(req);
      if (denied) return denied;
      try {
        return Response.json({ runs: await listUnfinished(await getDeps()) });
      } catch (error) {
        return serverError(error);
      }
    },

    async create(req: Request) {
      const denied = await requireAdmin(req);
      if (denied) return denied;

      const parsed = parseTenantInput(await req.json().catch(() => ({})));
      if (!parsed.ok) {
        return Response.json({ error: "invalid-input", errors: parsed.errors }, { status: 400 });
      }
      try {
        const deps = await getDeps();
        const problems = deps.findConfigProblems(parsed.input.plan);
        if (problems.length > 0) {
          return Response.json({ error: "config-missing", problems }, { status: 503 });
        }
        const run = await startProvisioning(deps, parsed.input);
        return Response.json({ run }, { status: 201 });
      } catch (error) {
        if (error instanceof ProvisioningConflictError) {
          return Response.json(
            { error: "already-used", conflicts: error.conflicts, existingRun: error.existingRun },
            { status: 409 }
          );
        }
        if (isVercelApiError(error)) {
          return Response.json(
            { error: "vercel-error", problems: [`Vercel: ${error.message}`] },
            { status: 502 }
          );
        }
        return serverError(error);
      }
    },

    async get(req: Request, { params }: SiteContext) {
      const denied = await requireAdmin(req);
      if (denied) return denied;
      try {
        const run = await getProvisioning(await getDeps(), (await params).siteKey);
        return run
          ? Response.json({ run })
          : Response.json({ error: "not-found" }, { status: 404 });
      } catch (error) {
        return serverError(error);
      }
    },

    async discard(req: Request, { params }: SiteContext) {
      const denied = await requireAdmin(req);
      if (denied) return denied;
      try {
        const result = await discardProvisioning(await getDeps(), (await params).siteKey);
        if (result === "not-found") return Response.json({ error: result }, { status: 404 });
        if (result === "not-discardable") return Response.json({ error: result }, { status: 409 });
        return Response.json({ ok: true });
      } catch (error) {
        return serverError(error);
      }
    },

    async run(req: Request, { params }: SiteContext) {
      const denied = await requireAdmin(req);
      if (denied) return denied;
      const body = await req.json().catch(() => ({}));
      try {
        const run = await advance(await getDeps(), (await params).siteKey, {
          resume: body?.resume === true,
          resendMail: body?.resendMail === true,
        });
        return run
          ? Response.json({ run })
          : Response.json({ error: "not-found" }, { status: 404 });
      } catch (error) {
        return serverError(error);
      }
    },
  };
}

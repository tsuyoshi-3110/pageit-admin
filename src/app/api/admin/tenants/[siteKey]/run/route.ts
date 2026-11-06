import { getProvisioningDeps } from "@/lib/provisioning/deps.server";
import { createTenantHandlers } from "@/lib/provisioning/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handlers = createTenantHandlers(getProvisioningDeps);

export const POST = (req: Request, context: { params: Promise<{ siteKey: string }> }) =>
  handlers.run(req, context);

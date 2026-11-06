import { getProvisioningDeps } from "@/lib/provisioning/deps.server";
import { createTenantHandlers } from "@/lib/provisioning/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createTenantHandlers(getProvisioningDeps);

type Context = { params: Promise<{ siteKey: string }> };

export const GET = (req: Request, context: Context) => handlers.get(req, context);
export const DELETE = (req: Request, context: Context) => handlers.discard(req, context);

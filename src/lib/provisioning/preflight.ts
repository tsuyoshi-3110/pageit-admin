import type { ProvisioningDeps } from "./deps";
import { hostsOf, projectNameOf } from "./input";
import type { Conflict, TenantInput } from "./types";

function errorCode(error: unknown) {
  return (error as { code?: string })?.code;
}

/**
 * 店舗キー・ドメイン・メールアドレスが未使用か確認します。読み取りだけで、何も作りません。
 * ownSiteKey を渡すと、自分自身の進行記録は「使用済み」に数えません。
 */
export async function findConflicts(
  deps: Pick<ProvisioningDeps, "db" | "auth" | "vercel">,
  input: TenantInput,
  ownSiteKey?: string
): Promise<Conflict[]> {
  const { db, auth, vercel } = deps;
  const conflicts: Conflict[] = [];
  const { siteKey, domain, ownerEmail } = input;
  const hosts = hostsOf(input);

  const siteDocs = await db.getAll(
    db.doc(`sites/${siteKey}`),
    db.doc(`siteSettings/${siteKey}`),
    db.doc(`siteSettingsEditable/${siteKey}`)
  );
  const usedDoc = siteDocs.find((snapshot) => snapshot.exists);
  if (usedDoc) {
    conflicts.push({
      field: "siteKey",
      message: `店舗キー「${siteKey}」は使用済みです（${usedDoc.ref.path}）。`,
    });
  }

  const project = await vercel.getProject(projectNameOf(siteKey));
  if (project) {
    conflicts.push({
      field: "siteKey",
      message: `Vercelプロジェクト「${projectNameOf(siteKey)}」はすでにあります。`,
    });
  }

  const domainDocs = await db.getAll(...hosts.map((host) => db.doc(`domains/${host}`)));
  for (const snapshot of domainDocs) {
    if (snapshot.exists) {
      conflicts.push({
        field: "domain",
        message: `ドメイン「${snapshot.id}」は登録済みです（店舗キー: ${snapshot.get("siteKey") ?? "不明"}）。`,
      });
    }
  }

  // domains に未登録の既存店舗も見落とさないよう、sites 側の値も確認します。
  const urls = hosts.flatMap((host) => [`https://${host}`, `https://${host}/`]);
  const siteQueries = await Promise.all([
    db.collection("sites").where("domain", "in", hosts).limit(1).get(),
    db.collection("sites").where("canonicalHost", "in", hosts).limit(1).get(),
    db.collection("sites").where("productionUrl", "in", urls).limit(1).get(),
    db.collection("sites").where("config.productionUrl", "in", urls).limit(1).get(),
  ]);
  const usedBySite = siteQueries.flatMap((result) => result.docs)[0];
  if (usedBySite) {
    conflicts.push({
      field: "domain",
      message: `ドメイン「${domain}」は店舗「${usedBySite.id}」で使用されています。`,
    });
  }

  try {
    await auth.getUserByEmail(ownerEmail);
    conflicts.push({
      field: "ownerEmail",
      message: `メールアドレス「${ownerEmail}」はすでにユーザー登録されています。`,
    });
  } catch (error) {
    if (errorCode(error) !== "auth/user-not-found") throw error;
  }

  const owners = await db
    .collection("siteSettings")
    .where("ownerEmail", "==", ownerEmail)
    .limit(1)
    .get();
  if (!owners.empty) {
    conflicts.push({
      field: "ownerEmail",
      message: `メールアドレス「${ownerEmail}」は店舗「${owners.docs[0].id}」のオーナーとして登録されています。`,
    });
  }

  // 進行中の別の追加処理も使用済みとして扱います。
  const [sameDomain, sameEmail] = await Promise.all([
    db.collection("tenantProvisioning").where("input.domain", "==", domain).limit(2).get(),
    db.collection("tenantProvisioning").where("input.ownerEmail", "==", ownerEmail).limit(2).get(),
  ]);
  const other = (docs: FirebaseFirestore.QueryDocumentSnapshot[]) =>
    docs.find((snapshot) => snapshot.id !== ownSiteKey);
  const domainRun = other(sameDomain.docs);
  if (domainRun) {
    conflicts.push({
      field: "domain",
      message: `ドメイン「${domain}」は追加処理中の店舗「${domainRun.id}」で使われています。`,
    });
  }
  const emailRun = other(sameEmail.docs);
  if (emailRun) {
    conflicts.push({
      field: "ownerEmail",
      message: `メールアドレス「${ownerEmail}」は追加処理中の店舗「${emailRun.id}」で使われています。`,
    });
  }

  return conflicts;
}

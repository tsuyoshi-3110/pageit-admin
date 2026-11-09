import { requireAdmin } from "@/app/api/_utils/auth";
import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { buildInitialSiteDocument } from "@/lib/tenantDocs";

export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  try {
    const {
      siteKey,
      siteName,
      ownerAddress,
      domain,
      wwwEnabled,
      productionUrl,
    } = await req.json();

    if (!siteKey || !siteName) {
      return NextResponse.json({ error: "missing-fields" }, { status: 400 });
    }

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(siteKey)) {
      return NextResponse.json({ error: "invalid-site-key" }, { status: 400 });
    }
    if ((await adminDb.doc(`sites/${siteKey}`).get()).exists) {
      return NextResponse.json({ error: "site-already-exists" }, { status: 409 });
    }
    for (const host of domain ? [domain, ...(wwwEnabled ? [`www.${domain}`] : [])] : []) {
      if ((await adminDb.doc(`domains/${host}`).get()).exists) {
        return NextResponse.json({ error: "domain-already-registered" }, { status: 409 });
      }
    }

    const batch = adminDb.batch();

    // siteSettingsEditable の初期化
    batch.set(
      adminDb.doc(`siteSettingsEditable/${siteKey}`),
      { createdAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    // sites/{siteKey} を空値で初期化（yotteya データが漏れないよう明示的にセット）
    batch.set(
      adminDb.doc(`sites/${siteKey}`),
      {
        ...buildInitialSiteDocument({
          siteKey,
          siteName,
          productionUrl: productionUrl ?? "",
          // 登録時の電話番号は運営との連絡用（siteSettings.ownerPhone に保存）。
          // 携帯番号のことが多いので、店の電話番号にはせず、公開しません。
          // 公開する番号は、オーナーが店舗一覧で自分で登録します。
          addressText: ownerAddress ?? "",
        }),
        createdAt: FieldValue.serverTimestamp(),
      }
    );

    // domains/{hostname} の登録
    if (domain) {
      batch.set(adminDb.doc(`domains/${domain}`), {
        siteKey,
        createdAt: FieldValue.serverTimestamp(),
      });
      if (wwwEnabled) {
        batch.set(adminDb.doc(`domains/www.${domain}`), {
          siteKey,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    }

    await batch.commit();

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("create-tenant failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

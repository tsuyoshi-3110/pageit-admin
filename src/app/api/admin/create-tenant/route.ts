import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

export async function POST(req: Request) {
  try {
    const {
      siteKey,
      siteName,
      ownerName,
      ownerPhone,
      ownerAddress,
      domain,
      wwwEnabled,
      productionUrl,
    } = await req.json();

    if (!siteKey || !siteName) {
      return NextResponse.json({ error: "missing-fields" }, { status: 400 });
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
        siteKey,
        localizedContentMode: "customer-default",
        productionUrl: productionUrl ?? "",
        vercelUrl: "",
        brand: {
          name: siteName,
          shortName: siteName,
          copyrightName: siteName,
          businessCategory: "",
          tagline: "",
          description: "",
          telephone: ownerPhone ?? "",
          logoPath: "",
          googleSiteVerification: "",
          keywords: [],
        },
        social: { instagram: "", line: "", x: "", facebook: "", youtube: "", tiktok: "" },
        address: {
          text: ownerAddress ?? "",
          postalCode: "",
          country: "JP",
          region: "",
          locality: "",
          street: "",
          latitude: 0,
          longitude: 0,
        },
        seo: {
          homeTitle: siteName,
          homeDescription: "",
          localTitle: siteName,
          localDescription: "",
          aboutDescription: "",
          productsDescription: "",
          productsEcDescription: "",
          projectsTitle: siteName,
          projectsDescription: "",
          storesDescription: "",
          faqDescription: "",
        },
        home: { headline: siteName, description: "" },
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

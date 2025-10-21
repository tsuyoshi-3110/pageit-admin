import { adminDb } from "@/lib/firebase-admin";

async function main() {
  await adminDb.doc("adminSettings/global").set(
    {
      payoutHoldSeconds: 300, // ← ここを 300(=5分) に
      // もしくは payoutHoldMinutes: 5
    },
    { merge: true }
  );
  console.log("OK");
}

main().catch((e) => { console.error(e); process.exit(1); });

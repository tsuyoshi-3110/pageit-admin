import { NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";

export async function POST(req: Request) {
  const { email, password } = await req.json();

  try {
    const userRecord = await adminAuth.createUser({ email, password });
    return NextResponse.json({ uid: userRecord.uid });
  } catch (error: any) {
    console.error("Firebase user creation failed:", error);

    if (error.code === "auth/email-already-exists") {
      return NextResponse.json(
        { error: "email-already-in-use" },
        { status: 400 }
      );
    }

    if (error.code === "auth/invalid-password") {
      return NextResponse.json(
        { error: "invalid-password" },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "unexpected-error", message: error.message },
      { status: 500 }
    );
  }
}

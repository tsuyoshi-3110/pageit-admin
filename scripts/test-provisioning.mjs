#!/usr/bin/env node
/**
 * 新規店舗追加のテストを、Firebaseエミュレーターと偽の外部サービスで実行します。
 * 本番の認証情報は環境変数から取り除き、demo- プロジェクトだけに接続します。
 * Java 21以上が必要です。macOSでは Android Studio 同梱のものを自動で使います。
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";

const projectId = "demo-pageit-tenants";
const authHost = "127.0.0.1:9399";
const firestoreHost = "127.0.0.1:8389";
const androidStudioJava = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(VERCEL|STRIPE|GOOGLE|FIREBASE|NEXT_PUBLIC_|PROVISION|CRON_SECRET|GCLOUD)/.test(key)) {
    delete env[key];
  }
}

// firebase-admin の初期化に形式の正しい鍵が必要なため、その場限りの鍵を作ります
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

Object.assign(env, {
  CI: "1",
  GCLOUD_PROJECT: projectId,
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_CLIENT_EMAIL: `test@${projectId}.iam.gserviceaccount.com`,
  FIREBASE_PRIVATE_KEY: privateKey,
  FIREBASE_AUTH_EMULATOR_HOST: authHost,
  FIRESTORE_EMULATOR_HOST: firestoreHost,
  STRIPE_SECRET_KEY: "sk_test_dummy_not_used",
  NEXT_PUBLIC_FIREBASE_API_KEY: "fake-api-key",
});
if (!env.JAVA_HOME && existsSync(androidStudioJava)) env.JAVA_HOME = androidStudioJava;

const files = process.argv.slice(2);
const targets = files.length ? files.join(" ") : "test/provisioning/*.test.ts";
const testCommand = `node --import tsx --test --test-concurrency=1 --test-force-exit ${targets}`;

const child = spawn(
  "firebase",
  [
    "emulators:exec",
    "--config",
    "test/provisioning/firebase.json",
    "--project",
    projectId,
    "--only",
    "auth,firestore",
    testCommand,
  ],
  { stdio: "inherit", env }
);
child.on("exit", (code) => process.exit(code ?? 1));

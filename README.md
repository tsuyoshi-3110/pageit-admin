This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## 新規店舗の追加（/tenants/new）

管理者が店舗キー・ドメイン・オーナーなどを入力すると、手順ごとに実行します。進行状況は Firestore の `tenantProvisioning/{siteKey}` に保存され、画面を閉じても「再開」で続けられます。

| 環境変数 | 内容 |
|---|---|
| `VERCEL_TOKEN` / `VERCEL_TEAM_ID` | Vercel API |
| `PROVISION_VERCEL_ENV_MODE` | 必須。店舗プロジェクトへ渡す環境変数の方式: `shared` / `copy` / `none`。未設定なら開始できません |
| `PROVISION_VERCEL_SHARED_ENV_IDS` | `shared` のとき。リンクする共有環境変数のID（カンマ区切り） |
| `PROVISION_VERCEL_COPY_ENV_KEYS` | `copy` のとき。pageit-admin から複製する環境変数名（カンマ区切り） |
| `STRIPE_SECRET_KEY` / `STRIPE_DEFAULT_PRICE_ID` | 有料プランのとき |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` / `GOOGLE_SENDER_EMAIL` | 案内メール |

テストはエミュレーターと偽の外部サービスだけで動きます（`firebase` CLI と Java 21 以上が必要）。

```bash
npm run test:provisioning
```

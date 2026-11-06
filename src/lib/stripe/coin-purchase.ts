/** Pageit の XenoCoin 購入です。ProcNova 側の Webhook と混ざらないよう、種類の名前を分けています。 */
export const COIN_PACK_METADATA_TYPE = "pageit_xeno_coin_pack";
const VALIDITY_MONTHS = 6;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

type CoinLot = { id: string; coins: number; left: number; purchasedAt: string; expiresAt: string };

export function isCoinPurchase(session: { metadata?: Record<string, string> | null }) {
  return session.metadata?.type === COIN_PACK_METADATA_TYPE;
}

/**
 * 日本時間で6か月後の同じ日です。その日がない月は月末にします（8/31 → 2/28）。
 * 前払式支払手段の適用除外「発行から6か月内」を超えないようにするためです。
 */
function expiryFrom(now: Date) {
  const date = new Date(now.getTime() + JST_OFFSET_MS);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + VALIDITY_MONTHS);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return new Date(date.getTime() - JST_OFFSET_MS);
}

/** 購入分を足した一覧を返します。同じ決済を二重に足しません。払われていないものは足しません。 */
export function addPurchasedCoins(
  lots: unknown,
  session: {
    id: string;
    payment_status: string | null;
    metadata?: Record<string, string> | null;
  },
  now: Date
): CoinLot[] | null {
  const current = (Array.isArray(lots) ? lots : []) as CoinLot[];
  const coins = Number(session.metadata?.coins);
  if (session.payment_status !== "paid" || !Number.isFinite(coins) || coins <= 0) return null;
  if (current.some((lot) => lot.id === session.id)) return null;

  return [
    ...current,
    {
      id: session.id,
      coins,
      left: coins,
      purchasedAt: now.toISOString(),
      expiresAt: expiryFrom(now).toISOString(),
    },
  ];
}

/** Pageit の XenoCoin 購入です。ProcNova 側の Webhook と混ざらないよう、種類の名前を分けています。 */
export const COIN_PACK_METADATA_TYPE = "pageit_xeno_coin_pack";
const VALIDITY_MONTHS = 6;

type CoinLot = { id: string; coins: number; left: number; purchasedAt: string; expiresAt: string };

export function isCoinPurchase(session: { metadata?: Record<string, string> | null }) {
  return session.metadata?.type === COIN_PACK_METADATA_TYPE;
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

  const expires = new Date(now);
  expires.setMonth(expires.getMonth() + VALIDITY_MONTHS);
  return [
    ...current,
    {
      id: session.id,
      coins,
      left: coins,
      purchasedAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    },
  ];
}

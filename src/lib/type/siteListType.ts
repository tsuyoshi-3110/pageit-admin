import { Timestamp } from "firebase/firestore";

/* ───────── 型 ───────── */
export type PaymentStatus =
  | "active"
  | "pending_cancel"
  | "canceled"
  | "none"
  | "past_due"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid";

export type Site = {
  id: string;
  siteName: string;
  ownerName: string;
  ownerPhone: string;
  ownerAddress?: string;
  ownerEmail?: string;
  homepageUrl?: string;
  cancelPending?: boolean;
  paymentStatus?: PaymentStatus;
  setupMode?: boolean;
  isFreePlan?: boolean;
  industry?: { key: string; name: string };
  headerLogoUrl?: string;
  headerLogo?: string | { url?: string };
};

export type TransferLog = {
  id: string;
  email: string;
  collected?: boolean;
  timestamp?: Date | Timestamp;
};

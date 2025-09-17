// lib/atoms/partnerSiteKeyAtom.ts
import { atomWithStorage } from "jotai/utils";

export const partnerSiteKeyAtom = atomWithStorage<string | null>(
  "partnerSiteKey", // localStorage のキー
  null
);

export const SITE_KEY = "pageitStore";

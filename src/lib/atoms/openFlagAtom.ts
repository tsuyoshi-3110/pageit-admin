import { atom } from "jotai";

export const openFlagAtom = atom(false);
export const themeAtom = atom<"light" | "dark">("light");
export const credentialsEmailAtom = atom("");
export const invEmailAtom = atom("");
export const invOwnerNameAtom = atom("");

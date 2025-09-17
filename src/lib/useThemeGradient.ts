import { useEffect, useState } from "react";
import { onSnapshot, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { THEMES, ThemeKey } from "@/lib/themes";
import { SITE_KEY } from "./atoms/siteKeyAtom";

type ThemeValue = (typeof THEMES)[ThemeKey];

export function useThemeGradient(): ThemeValue | null {
  const [gradient, setGradient] = useState<ThemeValue | null>(null);

  useEffect(() => {
    const ref = doc(db, "siteSettingsEditable", SITE_KEY);
    const unsubscribe = onSnapshot(ref, (snap) => {
      const data = snap.data();
      if (data?.themeGradient && data.themeGradient in THEMES) {
        const key = data.themeGradient as ThemeKey;
        setGradient(THEMES[key]);
      }
    });

    return () => unsubscribe();
  }, []);

  return gradient;
}

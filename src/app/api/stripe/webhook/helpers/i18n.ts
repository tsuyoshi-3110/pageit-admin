export type LangKey =
  | "ja" | "en" | "fr" | "es" | "de" | "it" | "pt" | "pt-BR"
  | "ko" | "zh" | "zh-TW" | "ru" | "th" | "vi" | "id";

export const LOCALE_BY_LANG: Record<string, string> = {
  ja: "ja-JP", en: "en", fr: "fr-FR", es: "es-ES", de: "de-DE",
  it: "it-IT", pt: "pt-PT", "pt-BR": "pt-BR", ko: "ko-KR",
  zh: "zh-CN", "zh-TW": "zh-TW", ru: "ru-RU", th: "th-TH",
  vi: "vi-VN", id: "id-ID",
};

export function normalizeLang(input?: string | null): LangKey {
  const v = (input || "").toLowerCase();
  if (!v) return "en";
  if (v.startsWith("ja")) return "ja";
  if (v.startsWith("en")) return "en";
  if (v.startsWith("fr")) return "fr";
  if (v.startsWith("es")) return "es";
  if (v.startsWith("de")) return "de";
  if (v.startsWith("it")) return "it";
  if (v.startsWith("pt-br")) return "pt-BR";
  if (v.startsWith("pt")) return "pt";
  if (v.startsWith("ko")) return "ko";
  if (v.startsWith("zh-tw")) return "zh-TW";
  if (v.startsWith("zh")) return "zh";
  if (v.startsWith("ru")) return "ru";
  if (v.startsWith("th")) return "th";
  if (v.startsWith("vi")) return "vi";
  if (v.startsWith("id")) return "id";
  return "en";
}

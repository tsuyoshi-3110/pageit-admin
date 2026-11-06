export type IndustryOption = { value: string; label: string };

/** 業種の選択肢（登録画面と新規店舗追加画面で共通） */
export const INDUSTRY_OPTIONS: IndustryOption[] = [
  { value: "food", label: "飲食" },
  { value: "retail", label: "小売" },
  { value: "beauty", label: "美容・サロン" },
  { value: "medical", label: "医療・介護" },
  { value: "construction", label: "建設・不動産" },
  { value: "it", label: "IT・ソフトウェア" },
  { value: "education", label: "教育・スクール" },
  { value: "logistics", label: "物流・運輸" },
  { value: "manufacturing", label: "製造" },
  { value: "professional", label: "士業" },
  { value: "service", label: "サービス" },
  { value: "other", label: "その他" },
];


export const THEMES = {
  brandA: "from-[rgba(245,75,202,0.7)] to-[rgba(250,219,159,0.7)]",
  brandB: "from-[rgba(100,149,237,0.7)] to-[rgba(144,238,144,0.7)]",
  brandC: "from-[rgba(147,112,219,0.7)] to-[rgba(255,182,193,0.7)]",
  brandD: "from-[rgba(255,165,0,0.7)] to-[rgba(255,99,71,0.7)]",
  brandE: "from-[rgba(64,224,208,0.7)] to-[rgba(173,255,47,0.7)]",
  brandF: "from-[rgba(255,105,180,0.7)] to-[rgba(135,206,250,0.7)]",


  // ▼ パステル
  brandN: "from-[rgba(255,182,193,0.7)] to-[rgba(255,228,225,0.7)]", // ピンク
  brandO: "from-[rgba(152,251,152,0.7)] to-[rgba(224,255,255,0.7)]", // ミントブルー
  brandP: "from-[rgba(173,216,230,0.7)] to-[rgba(255,250,205,0.7)]", // 水色〜レモン

  // ▼ 単色
  brandJ: "from-[rgba(255,255,255,0.7)] to-[rgba(255,255,255,0.7)]", // 白
  brandL: "from-[rgba(0,123,255,0.7)] to-[rgba(0,123,255,0.7)]",     // 青
  brandM: "from-[rgba(34,139,34,0.7)] to-[rgba(34,139,34,0.7)]",     // 緑

   // ▼ ダーク・モノトーン
  brandH: "from-[rgba(0,0,0,0.7)] to-[rgba(80,0,80,0.7)]",
  brandG: "from-[rgba(30,30,30,0.7)] to-[rgba(60,60,60,0.7)]",
  brandI: "from-[rgba(25,25,25,0.7)] to-[rgba(200,200,200,0.7)]",
} as const;

export type ThemeKey = keyof typeof THEMES;

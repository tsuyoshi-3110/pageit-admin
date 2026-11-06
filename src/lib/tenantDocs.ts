/** sites/{siteKey} の初期内容。他店舗の値が混ざらないよう、全項目を明示します。 */
export function buildInitialSiteDocument({
  siteKey,
  siteName,
  productionUrl,
  telephone = "",
  addressText = "",
  businessCategory = "",
}: {
  siteKey: string;
  siteName: string;
  productionUrl: string;
  telephone?: string;
  addressText?: string;
  businessCategory?: string;
}) {
  return {
    siteKey,
    localizedContentMode: "customer-default",
    productionUrl,
    vercelUrl: "",
    brand: {
      name: siteName,
      shortName: siteName,
      copyrightName: siteName,
      businessCategory,
      tagline: "",
      description: "",
      telephone,
      logoPath: "",
      googleSiteVerification: "",
      keywords: [] as string[],
    },
    social: { instagram: "", line: "", x: "", facebook: "", youtube: "", tiktok: "" },
    address: {
      text: addressText,
      postalCode: "",
      country: "JP",
      region: "",
      locality: "",
      street: "",
      latitude: 0,
      longitude: 0,
    },
    seo: {
      homeTitle: siteName,
      homeDescription: "",
      localTitle: siteName,
      localDescription: "",
      aboutDescription: "",
      productsDescription: "",
      productsEcDescription: "",
      projectsTitle: siteName,
      projectsDescription: "",
      storesDescription: "",
      faqDescription: "",
    },
    home: { headline: siteName, description: "" },
  };
}

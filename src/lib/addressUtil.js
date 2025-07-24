// addressUtils.js

import axios from "axios";

// 郵便番号から住所を検索する関数
export const handleSearchAddress = async (
  postalCode,
  setAddress,
  setIsSeachAddress
) => {
  const formatSitePostalCode = (zip) => {
    if (!zip) return "";
    return zip.replace("-", ""); // ハイフンを削除
  };

  const formattedZipCode = formatSitePostalCode(postalCode); // 郵便番号をフォーマット
  if (formattedZipCode.length === 7) {
    // 郵便番号が7桁であることを確認
    setIsSeachAddress(true);
    try {
      const response = await axios.get(
        `https://zipcloud.ibsnet.co.jp/api/search?zipcode=${formattedZipCode}`
      );
      if (response.data.results) {
        const result = response.data.results[0];
        setAddress(`${result.address1}${result.address2}${result.address3}`);
        setIsSeachAddress(false);
      } else {
        setIsSeachAddress(false);
        setAddress("");
      }
    } catch (error) {
      setIsSeachAddress(false);
      console.error("住所の取得に失敗しました", error);
    }
  }
};

// 住所が有効かどうかを確認する関数
export const handleValidAddress = async (address, setErrorByAddress) => {
  if (address === "") {
    return;
  }

  try {
    console.log("Checking address:", address);
    const response = await axios.get(
      `https://zipcoda.net/api?address=${encodeURIComponent(address)}`
    );

    console.log("API response:", response.data);

    // response.dataとresponse.data.itemsの存在を確認
    if (
      response.data &&
      response.data.items &&
      Array.isArray(response.data.items) &&
      response.data.items.length > 0 &&
      response.data.items.length < 3
    ) {
      console.log("Valid address found.");
      setErrorByAddress("");
    } else {
      setErrorByAddress("無効な住所です。");
    }
  } catch {
    setErrorByAddress("無効な住所です。");
  }
};

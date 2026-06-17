import i18n from "i18next";
import { initReactI18next } from "react-i18next";

const resources = {
  en: {
    translation: {
      nav: { recommendation: "Recommendation", content: "Content", commerce: "Commerce", settings: "Settings", logout: "Logout" },
      settings: { title: "Settings", region: "Region", language: "Language", connectedAccounts: "Connected Accounts", disconnect: "Disconnect", connect: "Connect" },
      region: { global: "Global", china: "China" },
    },
  },
  zh: {
    translation: {
      nav: { recommendation: "推荐", content: "内容", commerce: "商品", settings: "设置", logout: "退出" },
      settings: { title: "设置", region: "地区", language: "语言", connectedAccounts: "已连接账号", disconnect: "断开", connect: "连接" },
      region: { global: "全球", china: "中国" },
    },
  },
};

i18n.use(initReactI18next).init({
  resources,
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;

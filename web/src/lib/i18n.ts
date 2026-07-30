import i18n from "i18next";
import { initReactI18next } from "react-i18next";

const resources = {
  en: {
    translation: {
      nav: { recommendation: "Recommendation", content: "Content", commerce: "Commerce", settings: "Settings", logout: "Logout" },
      settings: { title: "Settings", region: "Region", language: "Language", timezone: "Timezone", connectedAccounts: "Connected Accounts", disconnect: "Disconnect", connect: "Connect" },
      region: { global: "Global", china: "China" },
      password: {
        title: "Password",
        notSet: "Not set — you sign in with an email link or a connected account",
        isSet: "Password is set",
        set: "Set password",
        change: "Change password",
        current: "Current password",
        new: "New password",
        confirm: "Confirm new password",
        save: "Save",
        cancel: "Cancel",
        mismatch: "The two passwords do not match",
        saved: "Password updated. Other devices have been signed out.",
      },
    },
  },
  zh: {
    translation: {
      nav: { recommendation: "推荐", content: "内容", commerce: "商品", settings: "设置", logout: "退出" },
      settings: { title: "设置", region: "地区", language: "语言", timezone: "时区", connectedAccounts: "已连接账号", disconnect: "断开", connect: "连接" },
      region: { global: "全球", china: "中国" },
      password: {
        title: "密码",
        notSet: "未设置——你目前通过邮件登录链接或已连接的账号登录",
        isSet: "已设置密码",
        set: "设置密码",
        change: "修改密码",
        current: "当前密码",
        new: "新密码",
        confirm: "确认新密码",
        save: "保存",
        cancel: "取消",
        mismatch: "两次输入的密码不一致",
        saved: "密码已更新，其它设备上的登录已被退出。",
      },
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

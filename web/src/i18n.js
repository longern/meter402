import React, { createContext, useContext, useMemo, useState } from "react";

const TRANSLATIONS = {
  en: {
    Recharge: "Recharge",
    "Autopay Limits": "Autopay Limits",
    "API Keys": "API Keys",
    Usage: "Usage",
    Settings: "Settings",
    "Activate account": "Activate account",
    "Account Balance": "Account Balance",
    "Deposit Balance": "Deposit Balance",
    "Unpaid Invoices": "Unpaid Invoices",
    Status: "Status",
    active: "active",
    "Add deposit": "Add deposit",
    "Autopay Wallet": "Autopay Wallet",
    Address: "Address",
    Balance: "Balance",
    "Deposit History": "Deposit History",
    URL: "URL",
    "nav:API Keys": "API Keys",
  },
  zh: {
    Recharge: "账户充值",
    "Autopay Limits": "自动支付限额",
    "API Keys": "API 密钥",
    Usage: "用量分析",
    Settings: "个人设置",
    "Activate account": "激活账户",
    "Account Balance": "账户余额",
    "Deposit Balance": "押金余额",
    "Unpaid Invoices": "未付账单",
    Status: "状态",
    active: "激活",
    "Add deposit": "充值押金",
    "Autopay Wallet": "自动支付钱包",
    Address: "地址",
    Balance: "余额",
    "Deposit History": "充值历史",
    URL: "URL",
    "nav:API Keys": "密钥管理",
  },
  ja: {
    Recharge: "チャージ",
    "Autopay Limits": "自動支払い限度額",
    "API Keys": "API キー",
    Usage: "使用量",
    Settings: "設定",
    "Activate account": "アカウントを有効化",
    "Account Balance": "アカウント残高",
    "Deposit Balance": "デポジット残高",
    "Unpaid Invoices": "未払い請求書",
    Status: "ステータス",
    active: "有効",
    "Add deposit": "デポジット追加",
    "Autopay Wallet": "自動支払いウォレット",
    Address: "アドレス",
    Balance: "残高",
    "Deposit History": "デポジット履歴",
    URL: "URL",
    "nav:API Keys": "キー管理",
  },
};

function detectLocale() {
  const lang = (navigator.language || "en").toLowerCase();
  if (lang.startsWith("zh")) return "zh";
  if (lang.startsWith("ja")) return "ja";
  return "en";
}

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [locale, setLocale] = useState(() => detectLocale());

  const value = useMemo(() => {
    function t(key, options = {}) {
      const ns = options.ns;

      // 1. Try namespaced key: "nav:API Keys"
      if (ns) {
        const nsKey = `${ns}:${key}`;
        const text = TRANSLATIONS[locale]?.[nsKey];
        if (text !== undefined) return text;
      }

      // 2. Try plain key in current locale
      const text = TRANSLATIONS[locale]?.[key];
      if (text !== undefined) return text;

      // 3. Fallback: return the English key itself
      return key;
    }
    return { locale, setLocale, t, supportedLocales: Object.keys(TRANSLATIONS) };
  }, [locale]);

  return React.createElement(I18nContext.Provider, { value }, children);
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return ctx;
}

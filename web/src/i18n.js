import React, { createContext, useContext, useMemo, useState } from "react";

const TRANSLATIONS = {
  en: {
    Recharge: "Recharge",
    "Autopay Limits": "Autopay Limits",
    "API Keys": "API Keys",
    Usage: "Usage",
    Settings: "Settings",
    Admin: "Admin",
    Dashboard: "Dashboard",
    Accounts: "Accounts",
    Deposits: "Deposits",
    Invoices: "Invoices",
    "Back to Console": "Back to Console",
    Logout: "Logout",
    Loading: "Loading...",
    "Total Accounts": "Total Accounts",
    "Active Accounts": "Active Accounts",
    "Active Keys": "Active Keys",
    "Total Deposits": "Total Deposits",
    "Total Unpaid": "Total Unpaid",
    "Requests 24h": "Requests 24h",
    ID: "ID",
    Owner: "Owner",
    Status: "Status",
    Deposit: "Deposit",
    Unpaid: "Unpaid",
    Created: "Created",
    Name: "Name",
    Limit: "Limit",
    Spent: "Spent",
    Amount: "Amount",
    Settled: "Settled",
    Provider: "Provider",
    Model: "Model",
    Cost: "Cost",
    "Activate account": "Activate account",
    "Add User": "Add User",
    "Create Account": "Create Account",
    "Wallet Address": "Wallet Address",
    Cancel: "Cancel",
    Create: "Create",
    "No data": "No data",
    total: "total",
    "Account Balance": "Account Balance",
    "Deposit Balance": "Deposit Balance",
    "Unpaid Invoices": "Unpaid Invoices",
    Network: "Network",
    Payer: "Payer",
    "Settled at": "Settled at",
    Action: "Action",
    active: "active",
    "Add deposit": "Add deposit",
    "Autopay Wallet": "Autopay Wallet",
    Address: "Address",
    Balance: "Balance",
    "Deposit History": "Deposit History",
    "Sign-in Wallet": "Sign-in Wallet",
    "Rebind Sign-in Wallet": "Rebind Sign-in Wallet",
    "Auto-Recharge": "Auto-Recharge",
    URL: "URL",
    "nav:API Keys": "API Keys",
    "Min Deposit": "Min Deposit",
    "Concurrency Limit": "Concurrency Limit",
    "Autopay Min Recharge": "Autopay Min Recharge",
    "Cost Multiplier": "Cost Multiplier",
    Saved: "Saved",
    "Save failed": "Save failed",
    Save: "Save",
  },
  zh: {
    Recharge: "账户充值",
    "Autopay Limits": "自动支付限额",
    "API Keys": "API 密钥",
    Usage: "用量分析",
    Settings: "个人设置",
    Admin: "管理后台",
    Dashboard: "仪表盘",
    Accounts: "用户账户",
    Deposits: "充值记录",
    Invoices: "账单记录",
    "Back to Console": "返回控制台",
    Logout: "退出登录",
    Loading: "加载中...",
    "Total Accounts": "总账户数",
    "Active Accounts": "活跃账户",
    "Active Keys": "活跃密钥",
    "Total Deposits": "总押金",
    "Total Unpaid": "未付总额",
    "Requests 24h": "24h 请求数",
    ID: "ID",
    Owner: "所有者",
    Status: "状态",
    Deposit: "押金",
    Unpaid: "未付",
    Created: "创建时间",
    Name: "名称",
    Limit: "限额",
    Spent: "已用",
    Amount: "金额",
    Settled: "结算时间",
    Provider: "提供商",
    Model: "模型",
    Cost: "费用",
    "Add User": "添加用户",
    "Create Account": "创建账户",
    "Wallet Address": "钱包地址",
    Cancel: "取消",
    Create: "创建",
    "No data": "暂无数据",
    total: "条",
    "Account Balance": "账户余额",
    "Deposit Balance": "押金余额",
    "Unpaid Invoices": "未付账单",
    Network: "网络",
    Payer: "付款钱包",
    "Settled at": "结算时间",
    Action: "操作",
    active: "激活",
    "Add deposit": "充值押金",
    "Autopay Wallet": "自动支付钱包",
    Address: "地址",
    Balance: "余额",
    "Deposit History": "充值历史",
    "Sign-in Wallet": "登录钱包",
    "Rebind Sign-in Wallet": "重新绑定登录钱包",
    "Auto-Recharge": "自动充值",
    URL: "URL",
    "nav:API Keys": "密钥管理",
    "Min Deposit": "最低押金",
    "Concurrency Limit": "并发限制",
    "Autopay Min Recharge": "自动充值最小额",
    "Cost Multiplier": "费用倍率",
    Saved: "已保存",
    "Save failed": "保存失败",
    Save: "保存",
  },
  ja: {
    Recharge: "チャージ",
    "Autopay Limits": "自動支払い限度額",
    "API Keys": "API キー",
    Usage: "使用量",
    Settings: "設定",
    Admin: "管理パネル",
    Dashboard: "ダッシュボード",
    Accounts: "アカウント",
    Deposits: "デポジット",
    Invoices: "請求書",
    "Back to Console": "コンソールに戻る",
    Logout: "ログアウト",
    Loading: "読み込み中...",
    "Total Accounts": "総アカウント数",
    "Active Accounts": "アクティブアカウント",
    "Active Keys": "アクティブキー",
    "Total Deposits": "総デポジット",
    "Total Unpaid": "未払総額",
    "Requests 24h": "24時間リクエスト",
    ID: "ID",
    Owner: "所有者",
    Status: "ステータス",
    Deposit: "デポジット",
    Unpaid: "未払い",
    Created: "作成日時",
    Name: "名前",
    Limit: "制限",
    Spent: "使用済み",
    Amount: "金額",
    Settled: "決済日時",
    Provider: "プロバイダ",
    Model: "モデル",
    Cost: "コスト",
    "Activate account": "アカウントを有効化",
    "Add User": "ユーザーを追加",
    "Create Account": "アカウント作成",
    "Wallet Address": "ウォレットアドレス",
    Cancel: "キャンセル",
    Create: "作成",
    "No data": "データなし",
    total: "件",
    "Account Balance": "アカウント残高",
    "Deposit Balance": "デポジット残高",
    "Unpaid Invoices": "未払い請求書",
    Network: "ネットワーク",
    Payer: "支払いウォレット",
    "Settled at": "決済日時",
    Action: "操作",
    active: "有効",
    "Add deposit": "デポジット追加",
    "Autopay Wallet": "自動支払いウォレット",
    Address: "アドレス",
    Balance: "残高",
    "Deposit History": "デポジット履歴",
    "Sign-in Wallet": "ログインウォレット",
    "Rebind Sign-in Wallet": "ログインウォレットを再バインド",
    "Auto-Recharge": "自動チャージ",
    URL: "URL",
    "nav:API Keys": "キー管理",
    "Min Deposit": "最小デポジット",
    "Concurrency Limit": "同時実行制限",
    "Autopay Min Recharge": "自動チャージ最小額",
    "Cost Multiplier": "コスト倍率",
    Saved: "保存完了",
    "Save failed": "保存失敗",
    Save: "保存",
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

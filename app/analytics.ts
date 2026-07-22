declare global {
  interface Window {
    _hmt?: unknown[][];
    __keduAnalyticsInitialized?: boolean;
  }
}

const BAIDU_TONGJI_ID = process.env.NEXT_PUBLIC_BAIDU_TONGJI_ID?.trim();
const EVENT_CATEGORY = "kedu_plan_tool";

export function initAnalytics() {
  if (typeof window === "undefined" || !BAIDU_TONGJI_ID || window.__keduAnalyticsInitialized) return;

  window.__keduAnalyticsInitialized = true;
  window._hmt = window._hmt ?? [];

  const script = document.createElement("script");
  script.async = true;
  script.src = "https://hm.baidu.com/hm.js?" + encodeURIComponent(BAIDU_TONGJI_ID);
  script.dataset.keduAnalytics = "baidu-tongji";
  document.head.appendChild(script);

  trackEvent("app_open");
}

export function trackEvent(action: string, label?: string, value?: number) {
  if (typeof window === "undefined" || !BAIDU_TONGJI_ID) return;

  window._hmt = window._hmt ?? [];
  const event: unknown[] = ["_trackEvent", EVENT_CATEGORY, action];
  if (label !== undefined || value !== undefined) event.push(label ?? "");
  if (value !== undefined) event.push(value);
  window._hmt.push(event);
}

export {};

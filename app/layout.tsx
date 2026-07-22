import type { Metadata } from "next";
import "./globals.css";

const siteUrl = "https://lan1126-lan.github.io/arch-s-tool";
const title = "刻度｜平面图标注工作台";
const description = "上传平面图，以已知尺寸校准比例，快速完成建筑尺寸标注并按原图导出。";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  icons: {
    icon: `${siteUrl}/favicon.svg`,
    shortcut: `${siteUrl}/favicon.svg`,
  },
  openGraph: {
    title,
    description,
    type: "website",
    url: siteUrl,
    images: [{ url: `${siteUrl}/og-v3.png`, width: 1536, height: 1024 }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [`${siteUrl}/og-v3.png`],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}

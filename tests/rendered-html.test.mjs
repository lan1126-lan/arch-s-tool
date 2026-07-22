import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the plan annotation workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>刻度｜平面图标注工作台<\/title>/i);
  assert.match(html, /导入一张平面图/);
  assert.match(html, /比例校准/);
  assert.match(html, /保存 PNG/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("includes independent dimension editing and smart audit", async () => {
  const [page, audit] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/dimension-audit.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /图上显示数字/);
  assert.match(page, /恢复测量值/);
  assert.match(page, /一键智能核准/);
  assert.match(page, /保护手动修改/);
  assert.match(page, /智能核准预览/);
  assert.match(audit, /duplicateGroups/);
  assert.match(audit, /chainRelations/);
  assert.match(audit, /conflictIds/);
  assert.match(audit, /displaySource === "manual"/);
});

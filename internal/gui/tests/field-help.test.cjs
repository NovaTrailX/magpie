// 真实页面与隔离 API：说明不占高度，鼠标与键盘均可读取，保存和状态仍可用。
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");
const { expect } = require("playwright/test");
const assets = path.resolve(__dirname, "../assets");
const relay = {
  id: "relay", name: "Relay", icon: "generic", chat: "https://relay.example.com/v1", responses: "", anthropic: "", catalog: "",
  models: [{ id: "model-a", name: "Model A", on: true }], agents: [], fallback: [], headers: {},
  key: { set: true, masked: "sk-…one" }, keyList: [], balanceToken: { takes: false, set: false }, proxy: "", maxConcurrency: null,
};
function serve(lang, theme, posts) {
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = ${JSON.stringify({ lang, theme, web: true })};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme } });
    if (url.pathname === "/api/providers") return json({ providers: [relay], presets: [], excluded: [], gateway: { running: true, window: true } });
    if (url.pathname.startsWith("/api/")) {
      if (route.request().method() === "POST") posts.push(url.pathname);
      return json({});
    }
    const file = url.pathname === "/app.js" && process.env.MAGPIE_HELP_APP
      ? process.env.MAGPIE_HELP_APP : path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file), contentType });
  };
}
for (const engine of process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"]) {
  for (const lang of process.env.HELP_LANG ? [process.env.HELP_LANG] : ["en", "zh", "zh-TW", "ja", "de"]) {
    test(`${engine} ${lang}: field help is compact, described and reachable`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(() => browser.close());
      const theme = lang === "en" ? "light" : "dark";
      const page = await browser.newPage({ viewport: { width: 900, height: 760 }, reducedMotion: "reduce", colorScheme: theme });
      page.setDefaultTimeout(15000);
      const errors = [], posts = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", serve(lang, theme, posts));
      await page.goto("http://magpie.test/?view=providers");
      await page.locator('.row.provider[data-id="relay"]').click();
      const input = page.locator(".editor input.concurrency"), wrap = input.locator("..");
      await input.waitFor();
      assert.equal(await wrap.locator(".help-mark").count(), 1, "field instructions have one help marker");
      const marker = wrap.locator(".help-mark"), source = wrap.locator(".hint"), pop = page.locator(".help-pop");
      const description = await source.textContent();
      assert(await source.isHidden(), "instructions do not occupy a row");
      assert.equal(await input.getAttribute("aria-describedby"), await source.getAttribute("id"));
      assert.equal(await marker.getAttribute("aria-describedby"), await source.getAttribute("id"));
      await expect(input).toHaveAccessibleDescription(description);
      await expect(marker).toHaveAccessibleDescription(description);
      assert.equal(await marker.getAttribute("type"), "button");
      for (const selector of ["input.concurrency", "input.rpm", "input.queue-limit", "input.queue-wait", "input.price-rate", "input.compacts"]) {
        const box = page.locator(`.editor ${selector}`);
        assert.equal(await box.count(), 1, selector);
        assert.equal(await box.locator("xpath=ancestor::*[contains(@class,'has-help')][1]").locator(".help-mark").count(), 1, selector);
      }
      if (lang === "zh") {
        const notes = await page.locator(".editor input.concurrency, .editor input.rpm, .editor input.queue-limit, .editor input.queue-wait, .editor input.price-rate").evaluateAll((boxes) => boxes.map((box) => box.closest(".has-help").querySelector('[role="tooltip"]').textContent));
        for (const note of notes) {
          assert(note.endsWith("。"), "同页的完整字段说明以句号结尾");
          assert(!/[；;]/.test(note), "限流说明不再用分号串接规则");
        }
      }
      const widths = await page.locator(".editor input.concurrency, .editor input.rpm, .editor input.queue-limit, .editor input.queue-wait, .editor input.price-rate").evaluateAll((boxes) => boxes.map((box) => box.getBoundingClientRect().width));
      assert(Math.max(...widths) - Math.min(...widths) < 1, "numeric provider fields have the same width");
      // 点击标签仍聚焦原控件；真实 Tab 顺序可到达说明标记。
      const id = await input.getAttribute("id");
      await page.locator(`label[for="${id}"]`).click();
      assert(await input.evaluate((e) => e === document.activeElement));
      await page.keyboard.press("Tab");
      assert(await marker.evaluate((e) => e === document.activeElement));
      await pop.waitFor();
      assert.equal(await pop.textContent(), description);
      await page.keyboard.press("Escape");
      assert.equal(await pop.count(), 0, "Escape dismisses help first");
      assert(await input.isVisible(), "Escape leaves the editor open");
      assert(await marker.evaluate((e) => e === document.activeElement), "dismissal keeps keyboard focus");
      await page.keyboard.press("Tab");
      assert.equal(await pop.count(), 0, "Tab leaves help");

      await marker.hover();
      await pop.waitFor();
      const before = await input.boundingBox();
      await pop.hover();
      await page.waitForTimeout(220);
      assert(await pop.isVisible(), "the pointer can enter the help to read it");
      assert.deepEqual(await input.boundingBox(), before, "help does not move the field");
      await page.mouse.move(1, 1);
      await pop.waitFor({ state: "detached" });

      if (lang === "zh") {
        const compact = page.locator(".editor input.compacts");
        const compactWrap = compact.locator("xpath=ancestor::*[contains(@class,'has-help')][1]");
        const full = await compactWrap.locator('[role="tooltip"]').textContent();
        assert(full.includes("\n"), "压缩阈值的操作与默认规则分行说明");
        await expect(compact).toHaveAccessibleDescription(full.replace(/\s+/g, " ").trim());
        await compactWrap.locator(".help-mark").focus();
        await pop.waitFor();
        assert.equal(await pop.textContent(), full, "浮层保留说明中的主动换行");
        const rows = await pop.evaluate((box) => {
          const text = box.firstChild, line = text.textContent.indexOf("\n") + 1;
          const range = document.createRange();
          range.setStart(text, 0); range.setEnd(text, 1);
          const first = range.getBoundingClientRect().top;
          range.setStart(text, line); range.setEnd(text, line + 1);
          return { first, next: range.getBoundingClientRect().top };
        });
        assert(rows.next > rows.first, "主动换行在页面中实际显示为下一行");
        if (process.env.ARTIFACT_DIR && engine === "chromium") {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          await pop.screenshot({ path: path.join(process.env.ARTIFACT_DIR, "chinese-help-lines.png") });
        }
        await page.keyboard.press("Escape");
        await page.keyboard.press("Tab");
      }

      // 窄窗口、长说明与底部锚点都由浮层定位器约束。
      await page.setViewportSize({ width: 360, height: 480 });
      const narrowWidths = await page.locator(".editor input.concurrency, .editor input.rpm, .editor input.queue-limit, .editor input.queue-wait, .editor input.price-rate").evaluateAll((boxes) => boxes.map((box) => box.getBoundingClientRect().width));
      assert(Math.max(...narrowWidths) - Math.min(...narrowWidths) < 1, "numeric fields also align in a narrow window");
      await marker.scrollIntoViewIfNeeded();
      await marker.hover();
      await pop.waitFor();
      const bounds = await pop.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= 360, "help stays inside the narrow viewport");
      assert(bounds.y >= 0 && bounds.y + bounds.height <= 480, "help stays inside the short viewport");
      if (process.env.ARTIFACT_DIR && lang === "zh" && engine === "chromium") {
        await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, "field-help-zh.png") });
      }
      await page.keyboard.press("Escape");

      // 组合控件保留原描述，并将说明关联到按钮；短状态独立可见。
      await page.evaluate(() => {
        const group = el("div"), box = input("", "128k"), choose = el("button", "", "Choose");
        box.id = "help-test-input";
        const old = el("span", "", "Existing description"); old.id = "help-test-existing";
        box.setAttribute("aria-describedby", old.id);
        group.append(box, choose, old);
        const host = el("div", "editor"); host.id = "help-test-host";
        host.style.cssText = "position:fixed;inset:40px 8px auto;z-index:25;display:block";
        host.append(...field("Example", group, "Default and zero rules"), el("div", "hint", "Unsaved"));
        document.body.append(host);
      });
      const custom = page.locator("#help-test-host");
      const ids = (await custom.locator("input").getAttribute("aria-describedby")).split(" ");
      assert.equal(ids.length, 2);
      assert.equal(ids[0], "help-test-existing");
      assert.equal(await custom.getByRole("button", { name: "Choose", exact: true }).getAttribute("aria-describedby"), ids[1]);
      assert(await custom.getByText("Unsaved", { exact: true }).isVisible());
      await custom.locator(".help-mark").focus();
      await pop.waitFor();
      await custom.evaluate((e) => e.remove());
      await pop.waitFor({ state: "detached" });
      if (lang === "zh") {
        await page.keyboard.press("Escape");
        await page.locator(".editor").waitFor({ state: "detached" });
        const layout = await page.locator("#view-providers").boundingBox();
        await page.evaluate(() => status(withNotice(t("Saved"), "Cline reads its provider as a session starts — open sessions keep the model they have; new ones use this. Reload VS Code's window for its extension."), "warn", 15000));
        const notice = page.locator("#status");
        assert((await notice.textContent()).includes("\n"), "真实登录提示按操作分行");
        assert(await notice.evaluate((e) => e.classList.contains("lift")), "没有弹窗时，多行状态仍浮起显示");
        assert.equal(await notice.innerText(), await notice.textContent(), "状态栏保留登录提示的换行");
        const bounds = await notice.boundingBox();
        assert(bounds.x >= 0 && bounds.x + bounds.width <= 360, "多行提示不超出窄窗口");
        assert(bounds.y >= 0 && bounds.y + bounds.height <= 480, "多行提示不超出短窗口");
        assert.deepEqual(await page.locator("#view-providers").boundingBox(), layout, "多行提示不挤动页面布局");
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(posts, [], "reading help makes no API writes");
    });
  }
}

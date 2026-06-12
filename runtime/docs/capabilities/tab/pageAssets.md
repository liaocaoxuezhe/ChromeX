# pageAssets 能力

列举并打包当前页面已加载的资源（图片、CSS、JS、字体、媒体等）。

通过 `tab.capabilities` 发现并获取：

```js
const caps = await tab.capabilities.list();        // [{ id: "pageAssets", description }]
const cap = await tab.capabilities.get("pageAssets");
```

## 方法

- `await cap.list()`
  返回当前页面已加载资源列表，每项包含 `{ name, type, size }`。

- `await cap.bundle({ outputDir })`
  将资源下载为 base64 并写入 `outputDir`（自动创建目录，文件名从 URL 提取并去重）。
  返回 `{ outputDir, files: [路径数组], errors: [{ name, reason }] }`。
  单个资源失败记入 `errors` 不中断整体；单次总大小有上限（超限报明确错误）。

- `await cap.documentation()`
  返回本文档。

## 示例

```js
const cap = await tab.capabilities.get("pageAssets");
const list = await cap.list();
const { files, errors } = await cap.bundle({ outputDir: "/tmp/page-assets" });
```

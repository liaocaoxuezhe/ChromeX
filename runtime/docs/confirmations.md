## 用户确认策略

本文档说明 Link2Chrome 的安全确认机制。在自动化操作可能产生副作用时，系统会要求确认。

### 哪些操作需要确认

以下操作在配置了 `confirmAction` 回调时会触发确认：

- `click`、`dblclick`、`hover`、`press` — 与页面元素交互。
- `fill`、`type` — 向输入框写入文本。
- `selectOption` — 选择下拉框选项。
- `check`、`uncheck`、`setChecked` — 更改复选框或开关状态。
- `setFiles` — 上传文件。
- `cua.click`、`cua.type`、`cua.drag` — CUA 视口级操作。
- `clipboard.writeText`、`clipboard.write` — 修改剪贴板内容。
- `dialog.accept`、`dialog.dismiss` — 处理浏览器对话框。

### 如何跳过确认

若你的运行环境不需要确认（例如内部自动化测试），可在创建 Client 时不传入 `confirmAction`，此时所有 `safety` 级别为 `no-confirm` 的操作会直接执行。需要确认的操作会在没有 `confirmAction` 时抛出错误。

```js
const client = createLink2ChromeClient({ transport });
// 未传入 confirmAction，则 safety 操作会直接执行或按策略报错
```

### 确认回调签名

```ts
type ConfirmAction = (action: {
  type: string;
  target?: object;
  text?: string;
  safety?: { level: string; reason: string };
}) => Promise<boolean>;
```

返回 `true` 表示允许执行，`false` 表示拒绝并抛出错误。

### 安全原则

- 不要自动确认涉及敏感数据（密码、支付信息、个人身份信息）的操作。
- 不要自动确认安装扩展、授予摄像头/麦克风权限、下载可执行文件等高风险行为。
- 对表单提交、发送消息、购买操作等具有外部副作用的行为，应在执行前描述清楚具体操作内容和目标站点。

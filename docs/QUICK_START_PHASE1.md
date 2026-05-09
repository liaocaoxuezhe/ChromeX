# Link2Chrome 第一阶段优化 - 快速启动指南

## 一、部署步骤

### 1. 重新加载 Chrome Extension

1. 打开 Chrome 浏览器
2. 访问 `chrome://extensions/`
3. 找到 "Link2Chrome" 扩展
4. 点击 🔄 **重新加载** 按钮

### 2. 重启 Claude Code

**方法 A: 完全重启 Claude Code 应用**
- 退出 Claude Code
- 重新打开 Claude Code
- 等待 MCP Server 自动连接

**方法 B: 仅重启 MCP Server(调试用)**
```bash
cd /Users/zhangyu/PycharmProjects/Link2Chrome
source server/venv/bin/activate
python -m server.main
```

### 3. 验证连接

在 Claude Code 中执行:
```
请执行 browser_diagnose 查看连接状态
```

应该看到:
```
=== Link2Chrome 诊断 ===

WebSocket 连接: 已连接
Extension 版本: 2025-02-03-v4
...
```

## 二、测试新功能

### 测试 1: JavaScript 脚本执行

**场景**: 提取页面中所有链接数量

**命令**:
```
请在当前页面执行以下脚本:
document.querySelectorAll('a').length
```

**预期结果**:
```
脚本执行成功
结果:
42  (实际数量)
```

### 测试 2: 智能等待

**场景**: 等待搜索框可见

**命令**:
```
请等待搜索框可见 (选择器: input[type='search'])
```

**预期结果**:
```
元素可见性等待: 已出现
选择器: input[type='search']
```

### 测试 3: Debugger 冲突修复

**场景**: 连续导航多个页面

**命令**:
```
请依次导航到以下页面:
1. https://www.baidu.com
2. https://www.zhihu.com
3. https://www.xiaohongshu.com
```

**预期结果**:
- 每次导航都成功完成
- 没有 "Another debugger already attached" 错误
- 日志中显示 "导航前已 detach debugger"

### 测试 4: Vision 降级策略

**场景**: 模拟 Vision API 超时,验证降级

**准备**: 临时设置超时为 1 秒
```bash
# 编辑 .env 文件
VISION_TIMEOUT=1
```

**命令**:
```
导航到 https://www.baidu.com
请点击搜索框
```

**预期结果**:
```
⚠️ Vision API 超时,已使用降级策略
方法: css_selector
选择器: input[type='search']
结果: {...}
```

**恢复**: 设置回 `VISION_TIMEOUT=30`

### 测试 5: 预定义脚本库

**场景**: 使用小红书笔记提取脚本

**命令**:
```
导航到 https://www.xiaohongshu.com/explore
执行小红书笔记提取脚本
```

可以使用:
```python
browser_execute_script({
  "script": "从 script_library 获取 xiaohongshu_extract_notes"
})
```

## 三、常见问题

### Q1: Extension 无法连接到 MCP Server

**症状**: `browser_diagnose` 显示 "Chrome Extension 未连接"

**解决**:
1. 检查 Extension 是否已加载: `chrome://extensions/`
2. 查看 Extension 控制台: 右键扩展图标 → "管理扩展" → "检查视图:Service Worker"
3. 查看是否有 WebSocket 连接错误
4. 尝试重新加载 Extension

### Q2: Vision API 仍然超时

**症状**: 即使设置了 `VISION_TIMEOUT=30`,仍然等待很久

**解决**:
1. 确认 `.env` 文件已保存
2. 重启 Claude Code(环境变量需要重新加载)
3. 检查网络连接到火山引擎 API

### Q3: Debugger 冲突仍然出现

**症状**: 导航时出现 "Another debugger already attached"

**解决**:
1. 检查是否有其他调试工具(DevTools)打开
2. 手动执行 `browser_detach_debugger`
3. 刷新当前标签页

### Q4: JavaScript 脚本执行失败

**症状**: `browser_execute_script` 返回错误

**可能原因**:
- 页面未加载完成 → 先使用 `browser_wait_for_condition`
- 脚本语法错误 → 检查 JavaScript 语法
- 权限问题 → 某些 chrome:// 页面无法执行脚本

## 四、性能监控

### 查看日志

**主日志**:
```bash
python server/view_logs.py -t main -n 50
```

**错误日志**:
```bash
python server/view_logs.py -t error
```

**操作日志**:
```bash
python server/view_logs.py -t operations -f  # 实时追踪
```

### 关键指标

在日志中搜索:
- `"Vision API 超时"` - 计数降级次数
- `"导航前已 detach"` - 验证 debugger 管理
- `"脚本执行成功"` - JavaScript 执行成功率

## 五、回滚步骤

如果遇到严重问题需要回滚:

### 1. Git 回滚
```bash
cd /Users/zhangyu/PycharmProjects/Link2Chrome
git stash  # 保存当前修改
git checkout 113592b  # 回到上一个版本
```

### 2. 配置回滚
编辑 `.env`:
```env
VISION_TIMEOUT=60  # 恢复默认
VISION_FALLBACK_ENABLED=false  # 禁用降级
```

### 3. 重新加载
- 重新加载 Extension
- 重启 Claude Code

## 六、联系和反馈

如遇到问题或发现 Bug,请:
1. 查看日志: `python server/view_logs.py -t error`
2. 记录错误信息和复现步骤
3. 检查 `PHASE1_CHANGES.md` 中的已知问题

---

**祝使用愉快! 🎉**

下一步: 第二阶段将添加批量操作和小红书专用优化

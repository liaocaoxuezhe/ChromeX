# Link2Chrome 第一阶段优化 - 实施记录

## 实施日期
2026-02-06

## 概述
第一阶段主要解决关键 Bug(Debugger 冲突、Vision API 超时)并添加基础高性能工具。

## 新增文件

### 1. `server/debugger_manager.py`
- **功能**: Debugger 生命周期管理
- **解决问题**: "Another debugger is already attached" 冲突
- **核心方法**:
  - `ensure_clean_attach()`: 确保干净的 attach 状态
  - `detach_debugger()`: 主动 detach
  - `_detach_with_delay()`: 带延迟的 detach(300ms)

### 2. `server/script_library.py`
- **功能**: 预定义 JavaScript 脚本库
- **包含脚本**:
  - 通用脚本: `extract_table`, `extract_links`, `scroll_load_all`, `get_all_images`, `check_element_visible`
  - 小红书专用: `xiaohongshu_extract_notes`, `xiaohongshu_user_info`, `xiaohongshu_comments`
- **使用方式**: `get_script(script_name, **kwargs)`

### 3. `server/retry_manager.py`
- **功能**: 重试和降级策略
- **核心类**:
  - `RetryManager`: 指数退避重试
  - `VisionFallbackHandler`: Vision API 降级处理
  - `VisionTimeoutError`: 自定义超时异常
- **降级策略**: 从自然语言指令推断 CSS 选择器

### 4. `test/test_phase1_features.py`
- **功能**: 第一阶段功能测试
- **测试项目**: JavaScript 执行、元素等待、Debugger 管理、脚本库、Vision 降级

## 修改文件

### 1. `server/vision.py`
**改动**:
- 添加 `asyncio` 导入
- 将 Vision API 超时从 60s 降至 30s(可配置)
- 使用 `asyncio.wait_for()` + `asyncio.to_thread()` 实现超时控制
- 超时时抛出 `VisionTimeoutError` 而非返回 "none" 操作

**配置项**: `VISION_TIMEOUT` (默认 30 秒)

### 2. `server/main.py`
**新增 MCP 工具 (3个)**:
1. `browser_execute_script`: 执行 JavaScript 脚本
2. `browser_wait_for_condition`: 智能等待(visible/network_idle/custom)
3. `browser_detach_debugger`: 主动解除 debugger 附加

**改动**:
- 添加全局实例: `debugger_manager`, `vision_fallback_handler`
- 修改 `tool_action_vision`: 添加 Vision 超时降级逻辑
- 新增 3 个工具实现函数

### 3. `extension/background.js`
**新增命令 (3个)**:
1. `cmdExecuteScript`: 执行 Runtime.evaluate
2. `cmdWaitForCondition`: 实现 3 种等待模式
3. `cmdDetachDebugger`: 主动 detach debugger

**改动**:
- 修改 `cmdNavigate`: 导航前先 detach 已有 debugger(避免冲突)
- 在 `handleCommand` 中添加 3 个新命令的路由

### 4. `.env`
**新增配置**:
```env
# Vision 配置
VISION_TIMEOUT=30
VISION_RETRY_COUNT=2
VISION_FALLBACK_ENABLED=true

# Debugger 配置
DEBUGGER_DETACH_DELAY=300
DEBUGGER_AUTO_RECOVER=true

# 操作日志
LOG_OPERATIONS=true
```

## 技术要点

### Debugger 冲突解决方案
1. **问题**: 导航时 Chrome 可能已有 debugger attached
2. **解决**: 在 `cmdNavigate` 前主动 detach
3. **延迟**: detach 后等待 300ms,确保浏览器完成清理

### Vision API 降级策略
1. **超时检测**: 30秒超时(可配置)
2. **推断选择器**: 从指令中提取关键词匹配预定义映射表
3. **降级执行**: 使用 `browser_click` + CSS 选择器
4. **映射表**: 支持搜索框、登录按钮、小红书元素等常见场景

### 智能等待机制
1. **visible**: 轮询检查元素可见性(考虑 display/visibility/opacity/rect)
2. **network_idle**: 启用 Network domain,监听请求完成
3. **custom**: 执行自定义 JS 条件表达式

## 验证步骤

### 1. 重新加载 Extension
```bash
# 打开 chrome://extensions/
# 点击 Link2Chrome 的"重新加载"按钮
```

### 2. 重启 MCP Server
```bash
# 方式 1: 重启 Claude Code 应用
# 方式 2: 运行测试脚本
cd /Users/zhangyu/PycharmProjects/Link2Chrome
python test/test_phase1_features.py
```

### 3. 验证测试
#### 测试 1: Debugger 冲突修复
- 连续导航 5 个不同的 URL
- 预期: 无 "Another debugger already attached" 错误

#### 测试 2: Vision 降级
- 执行 `browser_action_vision` 指令: "点击搜索框"
- 如果 Vision API 超时,应自动降级到 CSS 选择器点击

#### 测试 3: JavaScript 执行
```python
browser_execute_script({
  "script": "document.querySelectorAll('a').length"
})
```

#### 测试 4: 智能等待
```python
browser_wait_for_condition({
  "condition_type": "visible",
  "selector": "input[type='search']",
  "timeout": 5000
})
```

## 性能基准(初步)

| 指标 | 优化前 | 优化后(目标) | 验证方法 |
|-----|-------|-------------|---------|
| Debugger 冲突率 | 7.9% | 0% | 10次连续导航 |
| Vision 超时时间 | 60s | 30s | 单次 vision 调用 |
| Vision 降级成功率 | N/A | >70% | 20次超时场景 |

## 下一步 (第二阶段)

1. 添加批量操作工具(`browser_batch_click`, `browser_extract_links`, `browser_scroll_until`)
2. 实现 Network 空闲监听
3. 优化小红书专用脚本
4. 性能测试和基准对比

## 已知问题

1. **Network idle 等待**: 当前实现较简单,可能需要调整活跃请求的阈值
2. **Vision 降级准确率**: 选择器推断基于关键词匹配,复杂场景可能失败
3. **Debugger 延迟**: 300ms 是经验值,某些慢速系统可能需要更长延迟

## 回滚方案

如遇到问题,可回滚到上一个版本:
```bash
git checkout 113592b  # backup current version
```

环境变量回滚:
```env
VISION_TIMEOUT=60  # 恢复到 60 秒
VISION_FALLBACK_ENABLED=false  # 禁用降级
```

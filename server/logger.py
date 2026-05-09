"""
日志模块 - 提供文件日志记录功能
支持控制台和文件双重输出，自动日志轮转
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import sys
from datetime import datetime
from pathlib import Path

_ACTIVE_LOG_DIR: Path | None = None


def _ensure_writable_log_dir(path: Path) -> Path | None:
    """返回可写日志目录，不可写时返回 None。"""
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".write_test"
        with open(probe, "a", encoding="utf-8"):
            pass
        probe.unlink(missing_ok=True)
        return path
    except OSError:
        return None


def _resolve_log_dir(log_dir: str | Path | None = None) -> Path:
    """解析并缓存可写日志目录。"""
    global _ACTIVE_LOG_DIR

    if _ACTIVE_LOG_DIR is not None and log_dir is None:
        return _ACTIVE_LOG_DIR

    candidates: list[Path] = []

    env_log_dir = os.getenv("LINK2CHROME_LOG_DIR")
    if env_log_dir:
        candidates.append(Path(env_log_dir).expanduser())

    if log_dir is not None:
        candidates.append(Path(log_dir).expanduser())
    else:
        project_root = Path(__file__).parent.parent
        candidates.append(project_root / "logs")

    tmp_root = Path(os.getenv("TMPDIR", "/tmp")).expanduser()
    candidates.append(tmp_root / "link2chrome-logs")

    for candidate in candidates:
        writable_dir = _ensure_writable_log_dir(candidate)
        if writable_dir is not None:
            _ACTIVE_LOG_DIR = writable_dir
            return writable_dir

    raise PermissionError("没有可写的日志目录")


def setup_logging(
    log_dir: str = None,
    log_level: str = "INFO",
    max_bytes: int = 10 * 1024 * 1024,  # 10MB
    backup_count: int = 5,
    console_enabled: bool = False,  # 默认禁用控制台日志，避免干扰 MCP stdio 通信
) -> logging.Logger:
    """
    设置日志系统

    Args:
        log_dir: 日志目录，默认为项目根目录下的 logs/ 文件夹
        log_level: 日志级别 (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        max_bytes: 单个日志文件最大大小（字节）
        backup_count: 保留的备份文件数量

    Returns:
        根日志记录器
    """
    # 确定日志目录；不可写时自动降级到临时目录
    log_dir = _resolve_log_dir(log_dir)

    # 日志文件名按日期生成
    date_str = datetime.now().strftime("%Y-%m-%d")
    log_file = log_dir / f"link2chrome_{date_str}.log"

    # 根日志记录器
    root_logger = logging.getLogger("link2chrome")
    root_logger.setLevel(getattr(logging, log_level.upper()))

    # 清除现有处理器（避免重复添加）
    root_logger.handlers.clear()

    # 格式化器
    detailed_formatter = logging.Formatter(
        fmt="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # 1. 控制台处理器 - 输出到 stderr（可选，避免干扰 MCP stdio 通信）
    if console_enabled:
        console_handler = logging.StreamHandler(sys.stderr)
        console_handler.setLevel(logging.INFO)
        console_handler.setFormatter(detailed_formatter)
        root_logger.addHandler(console_handler)

    error_log_file = log_dir / f"link2chrome_error_{date_str}.log"

    try:
        # 2. 文件处理器 - 按大小轮转
        file_handler = logging.handlers.RotatingFileHandler(
            filename=log_file,
            maxBytes=max_bytes,
            backupCount=backup_count,
            encoding="utf-8",
        )
        file_handler.setLevel(getattr(logging, log_level.upper()))
        file_handler.setFormatter(detailed_formatter)
        root_logger.addHandler(file_handler)

        # 3. 错误文件处理器 - 只记录 ERROR 及以上级别
        error_file_handler = logging.handlers.RotatingFileHandler(
            filename=error_log_file,
            maxBytes=max_bytes,
            backupCount=backup_count,
            encoding="utf-8",
        )
        error_file_handler.setLevel(logging.ERROR)
        error_file_handler.setFormatter(detailed_formatter)
        root_logger.addHandler(error_file_handler)
    except OSError:
        # 文件日志降级失败时，至少保留一个安全的空处理器，避免初始化中断。
        root_logger.addHandler(logging.NullHandler())

    # 记录启动信息
    root_logger.info("=" * 60)
    root_logger.info("Link2Chrome 日志系统已启动")
    root_logger.info(f"日志目录: {log_dir}")
    root_logger.info(f"主日志文件: {log_file}")
    root_logger.info(f"错误日志文件: {error_log_file}")
    root_logger.info(f"日志级别: {log_level}")
    root_logger.info("=" * 60)

    return root_logger


def get_logger(name: str = None) -> logging.Logger:
    """
    获取命名日志记录器

    Args:
        name: 日志记录器名称，None 则返回根记录器

    Returns:
        日志记录器
    """
    if name:
        return logging.getLogger(f"link2chrome.{name}")
    return logging.getLogger("link2chrome")


class OperationLogger:
    """
    操作日志记录器 - 专门记录用户操作和工具调用
    """

    def __init__(self, logger: logging.Logger = None):
        self.logger = logger or get_logger()
        self.operation_log_file = None

    def _get_operation_log_path(self) -> Path:
        """获取操作日志文件路径"""
        log_dir = _resolve_log_dir() / "operations"
        log_dir.mkdir(parents=True, exist_ok=True)
        date_str = datetime.now().strftime("%Y-%m-%d")
        return log_dir / f"operations_{date_str}.log"

    def _ensure_file_handler(self):
        """确保文件处理器已创建"""
        if self.operation_log_file is None:
            log_path = self._get_operation_log_path()
            self.operation_log_file = open(log_path, "a", encoding="utf-8")

    def log_operation(self, tool_name: str, arguments: dict, result_summary: str = None, error: str = None):
        """
        记录一次操作

        Args:
            tool_name: 工具名称
            arguments: 调用参数
            result_summary: 结果摘要
            error: 错误信息（如果有）
        """
        self._ensure_file_handler()

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]

        lines = [
            f"[{timestamp}] OPERATION: {tool_name}",
            f"  Arguments: {arguments}",
        ]

        if error:
            lines.append(f"  ERROR: {error}")
        elif result_summary:
            lines.append(f"  Result: {result_summary}")

        lines.append("-" * 60)

        log_line = "\n".join(lines) + "\n"
        self.operation_log_file.write(log_line)
        self.operation_log_file.flush()

        # 同时记录到常规日志
        if error:
            self.logger.error(f"操作失败 [{tool_name}]: {error}")
        else:
            self.logger.info(f"操作执行 [{tool_name}]: {result_summary or '完成'}")

    def log_connection_event(self, event: str, details: str = None):
        """记录连接事件"""
        self._ensure_file_handler()
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]

        line = f"[{timestamp}] CONNECTION: {event}"
        if details:
            line += f" | {details}"
        line += "\n"

        self.operation_log_file.write(line)
        self.operation_log_file.flush()

    def close(self):
        """关闭操作日志文件"""
        if self.operation_log_file:
            self.operation_log_file.close()
            self.operation_log_file = None

    def __del__(self):
        """析构时关闭文件"""
        self.close()


# 全局操作日志记录器实例
_operation_logger: OperationLogger = None


def get_operation_logger() -> OperationLogger:
    """获取全局操作日志记录器"""
    global _operation_logger
    if _operation_logger is None:
        _operation_logger = OperationLogger()
    return _operation_logger

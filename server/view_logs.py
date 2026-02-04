#!/usr/bin/env python3
"""
日志查看工具 - 方便查看 Link2Chrome 的日志文件
"""

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path


def get_logs_dir() -> Path:
    """获取日志目录"""
    return Path(__file__).parent.parent / "logs"


def list_log_files():
    """列出所有日志文件"""
    logs_dir = get_logs_dir()
    if not logs_dir.exists():
        print(f"日志目录不存在: {logs_dir}")
        return

    print("=" * 60)
    print("Link2Chrome 日志文件")
    print("=" * 60)

    # 主日志文件
    main_logs = sorted(logs_dir.glob("link2chrome_*.log"))
    if main_logs:
        print("\n主日志文件:")
        for log_file in main_logs:
            size = log_file.stat().st_size
            size_str = f"{size / 1024:.1f} KB" if size < 1024 * 1024 else f"{size / (1024 * 1024):.2f} MB"
            print(f"  - {log_file.name:<35} {size_str:>10}")

    # 错误日志文件
    error_logs = sorted(logs_dir.glob("link2chrome_error_*.log"))
    if error_logs:
        print("\n错误日志文件:")
        for log_file in error_logs:
            size = log_file.stat().st_size
            size_str = f"{size / 1024:.1f} KB" if size < 1024 * 1024 else f"{size / (1024 * 1024):.2f} MB"
            print(f"  - {log_file.name:<35} {size_str:>10}")

    # 操作日志文件
    operations_dir = logs_dir / "operations"
    if operations_dir.exists():
        operation_logs = sorted(operations_dir.glob("operations_*.log"))
        if operation_logs:
            print("\n操作日志文件:")
            for log_file in operation_logs:
                size = log_file.stat().st_size
                size_str = f"{size / 1024:.1f} KB" if size < 1024 * 1024 else f"{size / (1024 * 1024):.2f} MB"
                print(f"  - {log_file.name:<35} {size_str:>10}")

    print("\n" + "=" * 60)


def view_log_file(log_type: str = "main", lines: int = 50, follow: bool = False):
    """
    查看日志文件内容

    Args:
        log_type: 日志类型 (main, error, operations)
        lines: 显示的行数
        follow: 是否持续跟踪（类似 tail -f）
    """
    logs_dir = get_logs_dir()
    date_str = datetime.now().strftime("%Y-%m-%d")

    if log_type == "main":
        log_file = logs_dir / f"link2chrome_{date_str}.log"
    elif log_type == "error":
        log_file = logs_dir / f"link2chrome_error_{date_str}.log"
    elif log_type == "operations":
        log_file = logs_dir / "operations" / f"operations_{date_str}.log"
    else:
        print(f"未知日志类型: {log_type}")
        return

    if not log_file.exists():
        print(f"日志文件不存在: {log_file}")
        return

    if follow:
        # 类似 tail -f
        print(f"正在跟踪日志文件: {log_file}")
        print("按 Ctrl+C 停止\n")
        try:
            with open(log_file, "r", encoding="utf-8") as f:
                # 先跳到文件末尾
                f.seek(0, 2)
                while True:
                    line = f.readline()
                    if line:
                        print(line, end="")
                    else:
                        import time
                        time.sleep(0.1)
        except KeyboardInterrupt:
            print("\n\n已停止跟踪")
    else:
        # 显示最后 n 行
        print(f"日志文件: {log_file}")
        print("=" * 60)

        try:
            with open(log_file, "r", encoding="utf-8") as f:
                all_lines = f.readlines()
                # 显示最后 n 行
                for line in all_lines[-lines:]:
                    print(line, end="")
        except Exception as e:
            print(f"读取日志文件失败: {e}")


def clear_logs():
    """清空所有日志文件"""
    logs_dir = get_logs_dir()
    if not logs_dir.exists():
        print("日志目录不存在")
        return

    confirm = input("确定要清空所有日志文件吗？这将删除 logs/ 目录下的所有内容。(yes/no): ")
    if confirm.lower() != "yes":
        print("已取消")
        return

    import shutil
    try:
        shutil.rmtree(logs_dir)
        print("日志文件已清空")
    except Exception as e:
        print(f"清空日志失败: {e}")


def main():
    parser = argparse.ArgumentParser(
        description="Link2Chrome 日志查看工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例:
  python view_logs.py                    # 列出所有日志文件
  python view_logs.py -t main            # 查看今天的主日志（最后50行）
  python view_logs.py -t error -n 100    # 查看今天的错误日志（最后100行）
  python view_logs.py -t operations -f   # 实时跟踪操作日志
  python view_logs.py --clear            # 清空所有日志文件
        """
    )

    parser.add_argument(
        "-t", "--type",
        choices=["main", "error", "operations"],
        default="main",
        help="日志类型 (默认: main)"
    )
    parser.add_argument(
        "-n", "--lines",
        type=int,
        default=50,
        help="显示的行数 (默认: 50)"
    )
    parser.add_argument(
        "-f", "--follow",
        action="store_true",
        help="持续跟踪日志输出（类似 tail -f）"
    )
    parser.add_argument(
        "-l", "--list",
        action="store_true",
        help="列出所有日志文件"
    )
    parser.add_argument(
        "--clear",
        action="store_true",
        help="清空所有日志文件"
    )

    args = parser.parse_args()

    if args.clear:
        clear_logs()
    elif args.list:
        list_log_files()
    elif args.follow or args.lines != 50:
        view_log_file(args.type, args.lines, args.follow)
    else:
        # 默认行为：列出日志文件
        list_log_files()


if __name__ == "__main__":
    main()

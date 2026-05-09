#!/usr/bin/env python3
"""
测试视觉模型 API 连接和调用
用于诊断 Doubao Seed 模型的连接问题
"""

import base64
import os
import sys
from io import BytesIO

from PIL import Image
from dotenv import load_dotenv
from openai import OpenAI

# 加载环境变量
env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
load_dotenv(env_path)

def create_test_image() -> str:
    """创建一个简单的测试图片（红色方块），返回 base64"""
    img = Image.new('RGB', (800, 600), color='red')

    # 添加一些文字
    from PIL import ImageDraw
    draw = ImageDraw.Draw(img)

    # 绘制一个蓝色矩形作为"按钮"
    draw.rectangle([300, 250, 500, 350], fill='blue', outline='white', width=3)

    # 转换为 base64
    buffer = BytesIO()
    img.save(buffer, format='JPEG', quality=85)
    return base64.b64encode(buffer.getvalue()).decode('utf-8')


def test_vision_api():
    """测试视觉模型 API"""

    # 1. 检查环境变量
    print("=" * 60)
    print("1. 检查环境变量配置")
    print("=" * 60)

    api_key = os.getenv("DOUBAO_API_KEY")
    base_url = os.getenv("DOUBAO_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
    model = os.getenv("DOUBAO_MODEL", "doubao-seed-1.8-thinking-250528")

    print(f"DOUBAO_API_KEY: {'✓ 已设置' if api_key else '✗ 未设置'}")
    print(f"DOUBAO_BASE_URL: {base_url}")
    print(f"DOUBAO_MODEL: {model}")
    print()

    if not api_key:
        print("❌ 错误: DOUBAO_API_KEY 未设置")
        print("请在 .env 文件中配置 DOUBAO_API_KEY")
        return False

    # 2. 创建测试图片
    print("=" * 60)
    print("2. 创建测试图片")
    print("=" * 60)
    print("生成 800x600 的测试图片（红色背景 + 蓝色矩形）...")
    image_b64 = create_test_image()
    print(f"✓ 图片已生成（base64 长度: {len(image_b64)} 字符）")
    print()

    # 3. 初始化客户端
    print("=" * 60)
    print("3. 初始化 OpenAI 客户端")
    print("=" * 60)
    try:
        client = OpenAI(api_key=api_key, base_url=base_url)
        print("✓ 客户端已初始化")
    except Exception as e:
        print(f"❌ 客户端初始化失败: {e}")
        return False
    print()

    # 4. 调用 API
    print("=" * 60)
    print("4. 调用视觉模型 API")
    print("=" * 60)
    print(f"模型: {model}")
    print("请求: 识别图片中的蓝色矩形...")
    print()

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": "你是一个图像分析助手。请用中文描述你看到的内容。"
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "请描述这张图片中有什么内容？颜色、形状、位置等。"
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{image_b64}"
                            }
                        }
                    ]
                }
            ],
            max_tokens=500,
            temperature=0.1,
            timeout=60.0
        )

        result = response.choices[0].message.content
        print("=" * 60)
        print("✅ API 调用成功！")
        print("=" * 60)
        print("模型返回:")
        print(result)
        print()
        print("=" * 60)
        print("✅ 测试通过：视觉模型 API 工作正常")
        print("=" * 60)
        return True

    except Exception as e:
        print("=" * 60)
        print("❌ API 调用失败")
        print("=" * 60)
        print(f"错误类型: {type(e).__name__}")
        print(f"错误信息: {e}")
        print()

        # 打印详细的错误信息
        import traceback
        print("详细错误堆栈:")
        traceback.print_exc()
        print()

        print("=" * 60)
        print("可能的原因:")
        print("=" * 60)
        print("1. API Key 无效或已过期")
        print("2. 模型名称不正确")
        print("3. Base URL 配置错误")
        print("4. 网络连接问题")
        print("5. API 服务暂时不可用")
        print()

        return False


if __name__ == "__main__":
    success = test_vision_api()
    sys.exit(0 if success else 1)

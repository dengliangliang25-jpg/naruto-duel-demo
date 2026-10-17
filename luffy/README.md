# luffy（路飞）基础帧 — batch 1

## 画布与朝向
- 画布：`320×436` RGBA（每帧 PNG + WEBP）
- 脚底基线：约 `y = 427`（距底约 9px）
- 默认朝向：**面朝右**
- 头身：跟 idle 对齐

## 目录
| 目录 | 帧数 | 含义 |
|------|------|------|
| `idle/` | 01–08 | 站立呼吸微动 |
| `run/` | 01–08 | 跑步循环 |
| `hitstun/` | 01–06 | 受击后仰踉跄 |
| `knockdown/` | 01–06 | 倒地（倾倒→躺平） |

## 预览
- `/workspace/char/luffy/preview_base_sheet.jpg` — 上行 idle×8，下行 run×8
- `/workspace/char/luffy/preview_hitstun.jpg`
- `/workspace/char/luffy/preview_knock.jpg`

## 制作备注
- GenerateImage + idle 参考；统一 rembg → 去近白边缘 → 缩放入 320×436、脚底对齐
- 技能帧与二档（gear2）不在本批

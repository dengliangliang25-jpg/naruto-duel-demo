# fushiguro（伏黑惠）— batch 1

## 画布与朝向
- 画布：`320×436` RGBA（每帧 PNG + WEBP）
- 脚底基线：约 `y = 427`（距底约 9px）
- 默认朝向：**面朝右**
- IDLE_H ≈ 378（比例对齐基准）

## Batch 1 基础
| 目录 | 帧数 | 含义 |
|------|------|------|
| `idle/` | 01–08 | 站立呼吸微动（黑发刺猬头 + 咒术高专深蓝制服） |
| `run/` | 01–08 | 跑步循环 |
| `hitstun/` | 01–06 | 受击后仰踉跄（痛感，无攻击姿） |
| `knockdown/` | 01–06 | 倒地（倾倒→躺平） |

## 外观锁死（常态）
- 伏黑惠：黑色刺猬短发、深色高专制服（黑/深蓝夹克+裤、白衬衫领、黑鞋）
- 严肃冷淡表情；基础帧无式神
- 动漫赛璐璐、粗黑线、全身立绘

## 备注
- raw：`/workspace/char/fushiguro/raw/{idle,run,hitstun,knockdown}/`
- gen：`/workspace/char/fushiguro/gen_batch1/`
- 预览：`/workspace/char/fushiguro/preview_{idle,run,hitstun,knock,base_sheet}.jpg`
- 处理：单 session rembg + defringe；朝左翻正；脚≈y427；比例跟 idle

## 未交付（后续批）
- 技能 / 领域帧不在本批

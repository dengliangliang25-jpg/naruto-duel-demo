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


## Batch 2 技能
| 目录 | 帧数 | 含义 |
|------|------|------|
| `attack/` | 01–06 | 普攻·影刺（脚下黑影尖刺伸出再收回） |
| `skill_dogs/` | 01–06 | 玉犬（手印召唤→两只黑犬扑咬） |
| `skill_nue/` | 01–06 | 鵺（鸟翼式神飞出+电球） |
| `skill_elephant/` | 01–06 | 满象（象头喷高压水柱） |
| `skill_shadow/` | 01–06 | 影换（没入影子→空影→他处冒出） |

预览：`/workspace/char/fushiguro/preview_{attack,dogs,nue,elephant,shadow}.jpg`

### Batch2 备注
- gen：`/workspace/char/fushiguro/gen_batch2/`
- raw：`/workspace/char/fushiguro/raw/{attack,skill_dogs,skill_nue,skill_elephant,skill_shadow}/`
- 单 session rembg + 黑影/水电特效保护 + defringe；朝右翻正；比例跟 idle（IDLE_H≈355）
- 嵌合庭不在本批

## 未交付（后续批）
- 嵌合暗翳庭（大招）不在本批

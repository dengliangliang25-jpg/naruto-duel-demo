# ichigo（黑崎一护）— batch 1+2+3

## 画布与朝向
- 画布：`320×436` RGBA（每帧 PNG + WEBP）
- 脚底基线：约 `y = 427`（距底约 9px）；`fx_mugetsu` 为居中特效层，不锁脚底
- 默认朝向：**面朝右**

## Batch 1 基础
| 目录 | 帧数 | 含义 |
|------|------|------|
| `idle/` | 01–08 | 站立呼吸微动（橙发黑死霸装，右手/侧持斩月） |
| `run/` | 01–08 | 跑步循环，刀随身 |
| `hitstun/` | 01–06 | 受击后仰踉跄 |
| `knockdown/` | 01–06 | 倒地（倾倒→躺平） |

## 外观锁死（常态）
- 黑崎一护：橙色刺猬头、黑色死神死霸装（黑上衣黑裤、白腰带、草鞋黑袜）
- 巨大斩月（宽刃 cleaver）
- 动漫赛璐璐、粗黑线、全身立绘

## Batch 2 技能
| 目录 | 帧数 | 含义 |
|------|------|------|
| `attack/` | 01–06 | 普攻·斩月（举刀→斜上斩→收刀） |
| `skill_getsuga/` | 01–06 | 月牙天冲（挥刀+青色新月刀气） |
| `skill_flash/` | 01–06 | 瞬步（起步→残影→落点） |
| `skill_block/` | 01–06 | 挡刀架势 + 格挡反击斩 |

预览：`/workspace/char/ichigo/preview_{attack,getsuga,flash,block}.jpg`

## Batch 3 bankai + 无月
| 目录 | 帧数 | 含义 |
|------|------|------|
| `bankai_idle/` | 01–08 | bankai 站立呼吸（黑大衣天锁斩月 + 短黑刀，橙发，朝右） |
| `bankai_run/` | 01–08 | bankai 跑步 |
| `bankai_attack/` | 01–06 | bankai 普攻（两段小连斩感） |
| `skill_bankai/` | 01–06 | 变身：常态→披黑衣/出短刀 |
| `skill_mugetsu/` | 01–06 | 无月人物：黑衣咏唱→超大斩击（长黑发终局黑衣） |
| `fx_mugetsu/` | 01–06 | 无月特效层：黑紫气/巨大斩击弧（可叠在人物上） |

预览：`/workspace/char/ichigo/preview_{bankai_idle,bankai_run,bankai_attack,bankai,mugetsu,fx_mugetsu}.jpg`

### Batch3 外观
- **bankai**：黑色天锁斩月大衣（披风式长衣、下摆碎裂）、短刀斩月、橙发仍在、面朝右；比例对齐常态 idle（IDLE_H≈377）
- **无月**：长黑发、黑衣/绷带裹身咏唱感→巨大黑紫斩击（非橙发 bankai）

## 备注
- raw：`/workspace/char/ichigo/raw/{…}/`
- gen：`/workspace/char/ichigo/gen_batch3/{bankai_idle,bankai_run,bankai_attack,skill_bankai,skill_mugetsu,fx_mugetsu}_XX.jpg`
- Batch3：单 session rembg + 黑底 hybrid 抠图（黑衣黑底保留身体）+ defringe；无月/FX 保留紫黑气；朝右翻正；脚≈y427

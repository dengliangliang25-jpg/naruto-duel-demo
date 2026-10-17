# ichigo（黑崎一护）— batch 1+2（pages31a 接入）

## 画布与朝向
- 画布：`320×436` RGBA（每帧 PNG + WEBP）
- 脚底基线：约 `y = 427`（距底约 9px）
- 默认朝向：**面朝右**

## Batch 1 基础
| 目录 | 帧数 | 含义 |
|------|------|------|
| `idle/` | 01–08 | 站立呼吸微动（橙发黑死霸装，右手/侧持斩月） |
| `run/` | 01–08 | 跑步循环，刀随身 |
| `hitstun/` | 01–06 | 受击后仰踉跄 |
| `knockdown/` | 01–06 | 倒地（倾倒→躺平） |

## 外观锁死
- 黑崎一护：橙色刺猬头、黑色死神死霸装（黑上衣黑裤、白腰带、草鞋黑袜）
- 巨大斩月（宽刃 cleaver）
- 动漫赛璐璐、粗黑线、全身立绘

## 预览
`/workspace/char/ichigo/preview_{idle,run,hitstun,knock,base_sheet}.jpg`  
（`base_sheet` = 上行 idle×8，下行 run×8）

## Batch 2 技能
| 目录 | 帧数 | 含义 |
|------|------|------|
| `attack/` | 01–06 | 普攻·斩月（举刀→斜上斩→收刀） |
| `skill_getsuga/` | 01–06 | 月牙天冲（挥刀+青色新月刀气） |
| `skill_flash/` | 01–06 | 瞬步（起步→残影→落点） |
| `skill_block/` | 01–06 | 挡刀架势 + 格挡反击斩 |

预览：`/workspace/char/ichigo/preview_{attack,getsuga,flash,block}.jpg`

## 备注
- bankai / 无月 **不在本批**
- raw：`/workspace/char/ichigo/raw/{idle,run,hitstun,knockdown,attack,skill_getsuga,skill_flash,skill_block}/`
- gen：`/workspace/char/ichigo/gen_batch2/{attack,getsuga,flash,block}_XX.jpg`（真 GenerateImage 专用姿势，非 idle 叠特效）
- Batch2：rembg/黑底混合抠图 + defringe；getsuga 保留青色新月刀气；朝右；脚≈y427

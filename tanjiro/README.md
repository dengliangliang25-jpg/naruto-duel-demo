# 炭治郎 (水/火 剑士) — Phase 1 assets

Canvas: **320×400** RGBA PNG. Character faces **RIGHT**. Foot / ground line at **y=380**.
Playback: **6 key frames only** (`01.png`–`06.png`). No crossfade in-betweens — earlier ghost tweens were dropped.

## Folder layout

```
tanjiro/
  portrait.png          # 256×256 head crop
  idle/01-08.png        # breathing loop from 普攻 body/01
  water|fire/
    普攻|二型|四型|一型|二型_反击斩/
      01-06.png         # composite (body + fx)
      body/01-06.png
      fx/01-06.png
  ult/
    一段_变身/          # body + water→fire aura fx
    二段/               # body + fire fx from gapped 2×3 sheet
```

Fire set reuses water **body** poses with fire **fx**. `二型_反击斩` body from New Bot patch; slash fx borrowed from 四型 (no dedicated counter fx sheet).

Suggested timing per action (scale to durations below): startup 01–02 · active 03–04 · recovery 05–06.

## Mechanics (doc + Phase-1 defaults for open questions)

| Skill | Path | Startup | Active | 金刚体 | Chakra | Damage / notes |
|---|---|---|---|---|---|---|
| 普攻 | `*/普攻` | 0.12s | 1 hit | none | 0 | base 12; no combo yet |
| 技能1 水之呼吸·二型 | `*/二型` + `*/二型_反击斩` | 0.15s | barrier **1.5s** | from barrier spawn until counter slash ends | 25 | barrier: **radius 0.8 body-width**, height **1.6× body**, centered on self; on hit while barrier up → play `二型_反击斩` behind attacker (1 trigger, barrier ends); counter dmg = 普攻×1.5 |
| 技能2 水之呼吸·四型 | `*/四型` | 0.10s | dash **2.5 body-widths** | first **0.3s** | 20 | dmg 18; read “零件三秒” as 0.3s |
| 技能3 水之呼吸·一型 | `*/一型` | 0.18s | 1 hit | none | 22 | dmg 20; lands **1 body-width** ahead, then **flip facing 180°** |
| 大招一段 火之形态 | `ult/一段_变身` | 0.4s | until chakra 0 | none | **halve** current (not clear); no regen in form | water→fire fx; **dmg ×2**, move **×1.25**, startup **×0.7**, CD **×1.4**; chakra drains **8/s** while in form; exit at 0 |
| 大招二段 全屏瞬斩 | `ult/二段` | 0.2s | **1.5s** + finisher | whole duration | **clears** all | **requires fire form**; full-screen blink slashes then teleport behind nearest enemy for horizontal slash; last hit at **0.5× game speed for 0.35s** (global slow-mo) |

### 金刚体 definition (default)
**CC immunity only** (no stun/knockback/pull), **no damage reduction**. Still take HP damage.

### Cooldown defaults (seconds, water form)
普攻 0.35 · 二型 8 · 四型 6 · 一型 7 · 大招一段 20 · 大招二段 0 (consumes form / chakra)

In fire form apply CD ×1.4 to 二型/四型/一型.

## Build / QA
- Rebuild: `python3 /workspace/p_tanjiro/build2.py`
- Contact sheets (red foot line): `/workspace/p_tanjiro/{water,fire,ult}_*.png`
- Slicer: gap-aware when white gaps exist; valley-split on packed 1×6; forced 2×3 for `大招/二段/特效/sheet_留白2x3.jpg`

## Still soft / asset notes
- Packed original sheets (普攻/二型/四型 body) use valley cuts — occasional soft edge between neighbors.
- `一段_变身` fx frames 05–06 may still clip slightly on canvas width 320.
- `二型_反击斩` source frame 02 is intentionally faint in the sheet.
- Counter slash has no dedicated fx; 四型 slash overlay is a stand-in.
- Ult 二段 body sheet includes a training-dummy prop in one pose — leave or mask in Phase 2.

(function () {
  "use strict";

  var canvas = document.getElementById("arena");
  var ctx = canvas.getContext("2d");
  // pages20: never silently draw nothing. Broken images get a red placeholder box;
  // images still in flight are skipped (match start is gated on loading anyway).
    // pages23: route atlas frames through drawFrame; broken images get a red box.
  (function guardDrawImage() {
    var raw = ctx.drawImage;
    ctx.drawImage = function (img) {
      if (img && img.sheetPath) {
        var a = arguments;
        if (a.length >= 5) drawFrame(img, a[1], a[2], a[3], a[4]);
        return;
      }
      if (img && img.tagName === "IMG" && !(img.complete && img.naturalWidth > 0)) {
        if (img._err) {
          var a2 = arguments, x, y, w, h;
          if (a2.length >= 9) { x = a2[5]; y = a2[6]; w = a2[7]; h = a2[8]; }
          else if (a2.length >= 5) { x = a2[1]; y = a2[2]; w = a2[3]; h = a2[4]; }
          else { x = a2[1]; y = a2[2]; w = 60; h = 120; }
          ctx.save();
          ctx.strokeStyle = "#ff3030"; ctx.lineWidth = 2;
          ctx.fillStyle = "rgba(255,40,40,0.25)";
          ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
          ctx.restore();
        }
        return;
      }
      return raw.apply(ctx, arguments);
    };
  })();
  var W = 1280;
  var H = 720;
  var MIN_Y = 418;
  var MAX_Y = 662;
  var FAR_L = 430;
  var FAR_R = 850;
  var NEAR_L = 160;
  var NEAR_R = 1120;

  var keysDown = Object.create(null);
  var time = 0;
  var shake = 0;
  var koId = null;
  // Flow states: intro | mode | charSelect | countdown | fight | roundEnd | result
  var matchState = "intro";
  var countLeft = 3;
  var matchTime = 60;
  var matchResult = null;
  var gameMode = "ai"; // ai | vs | coop | practice
  // pages29: practice defaults — opponent does NOT auto-attack; player can toggle 「自动打我」.
  // Arrow keys move the right-side sparring partner; panel / UIO… keys force-cast their skills.
  var practiceAutoAttack = false;
  var practiceDummy = true; // kept as alias of !practiceAutoAttack for older debug helpers
  var practiceNoCdAll = false; // retained for debug helpers; UI no longer exposes per-skill CD toggles
  var practiceNoCd = {}; // skillId -> bool (debug only)
  var practicePanel = false;
  var practiceAiPick = null; // pages31f
  var countdownPhase = "round"; // round | fight
  var playerSide = "L"; // which side the human controls in AI mode
  var coopAiKits = ["pain", "obito"]; // filled on beginMatch
  var selectedChar = "obito"; // roster id chosen in char select (solo)
  var selectedL = null; // 2P left pick
  var selectedR = null; // 2P right pick
  var vsAssignSide = "L"; // which slot receives the next card click in 2P
  var selectedScroll = null; // solo human scroll id
  var selectedScrollL = null; // 2P left scroll
  var selectedScrollR = null; // 2P right scroll
  var charHover = -1;
  // pages23: spritesheet loader. Each kit is 1–3 webp atlases (~5 total) plus ~15
  // core images. fetch+blob decode; match load exclusive; 30s stall → retry UI.
  var ASSET_V = "pages31g";
  var ASSET_GROUPS = { core: [], obito: [], pain: [], tanjiro: [], gojo: [], luffy: [], ichigo: [], fushiguro: [] };
  var assetErrors = [];
  var LOAD_CONCURRENCY = 6;
  var MAX_TRIES = 10;
  var loadQueue = [];
  var loadActive = 0;
  var loadMode = "idle"; // idle | match | prefetch
  var matchLoadStartedAt = 0;
  var matchStall = false;
  var sheetManifest = null;
  var sheetImgs = {};
  var frameCache = {};
  var coreReady = false;

  // pages24: mirror hosts. Each file is pinned to one host (round-robin) so the browser
  // opens several independent connections; a retry moves the file to the next host.
  var ASSET_COMMIT = "5151b51e016d71bb38f201beb23cb37160a1ad55";
  // pages31c: relative first; raw.githubusercontent before jsdelivr (China often stalls on jsDelivr).
  var MIRRORS = [""].concat(ASSET_COMMIT.indexOf("__") === 0 ? [] : [
    "https://raw.githubusercontent.com/dengliangliang25-jpg/naruto-duel-demo/" + ASSET_COMMIT + "/",
    "https://cdn.jsdelivr.net/gh/dengliangliang25-jpg/naruto-duel-demo@" + ASSET_COMMIT + "/",
    "https://gcore.jsdelivr.net/gh/dengliangliang25-jpg/naruto-duel-demo@" + ASSET_COMMIT + "/",
    "https://testingcf.jsdelivr.net/gh/dengliangliang25-jpg/naruto-duel-demo@" + ASSET_COMMIT + "/"
  ]);
  var mirrorRR = 0;
  function mirrorUrl(img, attempt) {
    if (img._mirror == null) img._mirror = (mirrorRR++) % MIRRORS.length;
    var h = MIRRORS[(img._mirror + attempt) % MIRRORS.length];
    var rel = img._rel || String(img._src).split("?")[0];
    if (!h) return rel + "?v=" + ASSET_V + (attempt ? "&r=" + attempt + "_" + Math.floor(Math.random() * 1e6) : "");
    return h + encodeURI(rel) + (attempt ? "?r=" + attempt + "_" + Math.floor(Math.random() * 1e6) : "");
  }
  function assetUrl(src) {
    var base = String(src).split("?")[0];
    if (!/\.webp$/i.test(base) && !/\.json$/i.test(base)) base = base.replace(/\.png$/i, ".webp");
    return base + "?v=" + ASSET_V;
  }

  function Frame(sheetPath, sx, sy, sw, sh) {
    this.sheetPath = sheetPath;
    this.sx = sx; this.sy = sy; this.sw = sw; this.sh = sh;
    this.width = sw; this.height = sh;
    this.naturalWidth = sw; this.naturalHeight = sh;
    this.tagName = "IMG";
  }
  Object.defineProperty(Frame.prototype, "complete", { get: function () {
    var sh = sheetImgs[this.sheetPath]; return !!(sh && sh._ok);
  }});
  Object.defineProperty(Frame.prototype, "_ok", { get: function () { return this.complete; }});
  Object.defineProperty(Frame.prototype, "_err", { get: function () {
    var sh = sheetImgs[this.sheetPath]; return !!(sh && sh._err);
  }});
  Object.defineProperty(Frame.prototype, "_started", { get: function () {
    var sh = sheetImgs[this.sheetPath]; return !!(sh && sh._started);
  }});

  function drawFrame(img, dx, dy, dw, dh) {
    if (!img) return;
    if (img.sheetPath) {
      var sheet = sheetImgs[img.sheetPath];
      if (!sheet || !sheet._ok) {
        if (img._err) {
          ctx.save(); ctx.strokeStyle = "#ff3030"; ctx.lineWidth = 2;
          ctx.fillStyle = "rgba(255,40,40,0.25)";
          ctx.fillRect(dx, dy, dw, dh); ctx.strokeRect(dx, dy, dw, dh); ctx.restore();
        }
        return;
      }
      ctx.drawImage(sheet._bmp || sheet, img.sx, img.sy, img.sw, img.sh, dx, dy, dw, dh);
      return;
    }
    if (!(img.complete && img.naturalWidth > 0)) {
      if (img._err) {
        ctx.save(); ctx.strokeStyle = "#ff3030"; ctx.lineWidth = 2;
        ctx.fillStyle = "rgba(255,40,40,0.25)";
        ctx.fillRect(dx, dy, dw, dh); ctx.strokeRect(dx, dy, dw, dh); ctx.restore();
      }
      return;
    }
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  function pumpLoads() {
    var rotated = 0;
    while (loadActive < LOAD_CONCURRENCY && loadQueue.length) {
      var job = loadQueue.shift();
      if (!job || job.img._ok || job.img._err || job.img._inflight) continue;
      if (job.prio === "prefetch" && loadActive >= 1) { loadQueue.push(job); rotated++; if (rotated >= loadQueue.length) break; continue; }
      if (loadMode === "match" && job.prio === "prefetch") {
        loadQueue.push(job);
        rotated++;
        if (rotated >= loadQueue.length) break;
        continue;
      }
      rotated = 0;
      startLoad(job);
    }
  }

  // pages24 loader. Root cause found on the desktop Chrome: its egress proxy throttles
  // some connections to a few KB/s, so a fetch body can trickle forever. Every stage now
  // has a hard wall-clock deadline (Promise.race); a slow file is aborted and re-requested
  // on a fresh connection. Decode: createImageBitmap → <img>.decode() → plain <img>,
  // each raced against a timeout. An independent setInterval watchdog drives the retry UI.
  var lastLoadProgress = 0;  // last time a FILE completed (not bytes)
  var decodingCount = 0;
  var inflightJobs = [];     // {img, stage, t0, deadline}
  var DECODE_MS = 6000;
  function noteProgress() { lastLoadProgress = performance.now(); }
  function withTimeout(promise, ms, label) {
    return Promise.race([promise, new Promise(function (_, rej) {
      setTimeout(function () { var e = new Error(label + " timeout"); e.isTimeout = true; rej(e); }, ms);
    })]);
  }
  function fileName(u) { return String(u || "").split("?")[0].split("/").slice(-2).join("/"); }
  function startLoad(job) {
    var img = job.img;
    img._inflight = true;
    img._started = true;
    loadActive++;
    var tryN = (img._tries || 0);
    var url = mirrorUrl(img, tryN);
    img._lastUrl = url;
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    img._ctrl = ctrl;
    var bytes = img._bytes || 120000;
    var dlMs = 7000 + Math.round(bytes / 40); // 40 KB/s floor + 7s headroom
    var rec = { img: img, stage: "下载", t0: performance.now(), deadline: performance.now() + dlMs, url: url };
    inflightJobs.push(rec);
    var finished = false;
    function finish() {
      if (finished) return false;
      finished = true;
      img._inflight = false;
      loadActive--;
      var k = inflightJobs.indexOf(rec);
      if (k >= 0) inflightJobs.splice(k, 1);
      return true;
    }
    function failRetry(reason) {
      img._tries = (img._tries || 0) + 1;
      img._lastFail = reason;
      if (window.console) console.warn("[asset retry " + img._tries + "] " + fileName(img._src) + " · " + reason);
      if (img._tries >= MAX_TRIES) {
        img._err = true;
        assetErrors.push(fileName(img._src) + "（" + reason + "）");
        if (window.console) console.error("[asset failed] " + img._src + " · " + reason);
        pumpLoads();
        return;
      }
      // back off a little so a throttled/403 mirror gets a breather, then try the next host
      setTimeout(function () { loadQueue.unshift(job); pumpLoads(); }, Math.min(3000, 400 * img._tries));
    }
    function done(how) {
      img._decodedBy = how;
      img._ok = true;
      noteProgress();
      pumpLoads();
    }
    function decodeBlob(blob) {
      // network slot is freed here; decode runs on its own deadline.
      rec.stage = "解码";
      rec.deadline = performance.now() + DECODE_MS * 2 + 1000;
      var bmpTry = (img._isSheet && typeof createImageBitmap === "function" && !window.__NO_BITMAP__)
        ? withTimeout(createImageBitmap(blob), DECODE_MS, "createImageBitmap").then(function (bmp) { img._bmp = bmp; return "bitmap"; })
        : Promise.reject(new Error("skip bitmap"));
      return bmpTry.catch(function () {
        img._bmp = null;
        var obj = URL.createObjectURL(blob);
        var loaded = new Promise(function (res, rej) {
          img.onload = function () { res("img"); };
          img.onerror = function () { rej(new Error("img onerror")); };
        });
        img.src = obj;
        var dec = img.decode ? img.decode().then(function () { return "img.decode"; }) : loaded;
        return withTimeout(dec, DECODE_MS, "img.decode").catch(function () {
          // decode() hung or rejected: fall back to the plain <img> load event.
          return withTimeout(loaded, DECODE_MS, "img.onload");
        });
      });
    }
    var p = (typeof fetch === "function")
      ? withTimeout(fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.blob();
        }), dlMs, "下载")
      : new Promise(function (res, rej) { img.onload = function () { res(null); }; img.onerror = rej; img.src = url; });
    p.then(function (blob) {
      if (!blob) return "img";
      // Free the network slot now so the next file can start downloading.
      img._inflight = false; loadActive--; finished = true;
      var k = inflightJobs.indexOf(rec); if (k >= 0) inflightJobs.splice(k, 1);
      decodingCount++;
      img._decoding = true;
      var drec = { img: img, stage: "解码", t0: performance.now(), deadline: performance.now() + DECODE_MS * 2 + 1000 };
      inflightJobs.push(drec);
      return decodeBlob(blob).then(function (how) {
        decodingCount--; img._decoding = false;
        var k2 = inflightJobs.indexOf(drec); if (k2 >= 0) inflightJobs.splice(k2, 1);
        return how;
      }, function (e) {
        decodingCount--; img._decoding = false;
        var k3 = inflightJobs.indexOf(drec); if (k3 >= 0) inflightJobs.splice(k3, 1);
        throw e;
      });
    }).then(function (how) {
      if (!finished) finish();
      done(how);
    }, function (e) {
      if (ctrl) try { ctrl.abort(); } catch (e0) {}
      var wasDownloading = !finished;
      if (wasDownloading) finish();
      if (img._softCancel) {
        img._softCancel = false;
        img._ctrl = null;
        loadQueue.push({ img: img, prio: "prefetch" });
        pumpLoads();
        return;
      }
      failRetry((e && e.message) || "error");
    });
  }
  // Independent watchdog — does not depend on progress events or rAF.
  setInterval(function () {
    if (matchState !== "loading") return;
    var now = performance.now();
    if (now - lastLoadProgress > 30000) matchStall = true;
  }, 1000);
  function loadStatusLines() {
    var now = performance.now(), out = [], i, r;
    for (i = 0; i < inflightJobs.length && out.length < 4; i++) {
      r = inflightJobs[i];
      var lu = r.img._lastUrl || "", hostTag = "pages";
      if (lu.indexOf("raw.githubusercontent") >= 0) hostTag = "raw";
      else if (lu.indexOf("jsdelivr") >= 0) hostTag = lu.split("/")[2].split(".")[0];
      out.push(fileName(r.img._src) + " @" + hostTag + " · " + r.stage + " " + ((now - r.t0) / 1000).toFixed(0) + "s" + (r.img._tries ? " · 第" + (r.img._tries + 1) + "次" : ""));
    }
    return out;
  }

  function regImg(img, src, group, prio) {
    if (!ASSET_GROUPS[group]) group = "core";
    img._src = assetUrl(src);
    img._rel = String(img._src).split("?")[0];
    img._started = false;
    img._prio = prio || (group === "core" ? "core" : "kit");
    ASSET_GROUPS[group].push(img);
    return img;
  }
  function enqueue(img, prio) {
    if (img._ok || img._err || img._inflight) return;
    var pr = prio || img._prio || "kit";
    var job = { img: img, prio: pr };
    if (pr === "match" || pr === "core") loadQueue.unshift(job);
    else loadQueue.push(job);
    pumpLoads();
  }
  function ensureGroups(list, prio) {
    var i, j, g;
    for (i = 0; i < list.length; i++) {
      g = ASSET_GROUPS[list[i]] || [];
      for (j = 0; j < g.length; j++) enqueue(g[j], prio);
    }
  }
  function retryFailed(list) {
    // Only failed files are re-requested; anything already loaded/decoding is kept.
    var i, j, g;
    for (i = 0; i < list.length; i++) {
      g = ASSET_GROUPS[list[i]] || [];
      for (j = 0; j < g.length; j++) {
        if (g[j]._err) { g[j]._err = false; g[j]._tries = 0; }
      }
    }
    assetErrors = [];
    matchStall = false;
    noteProgress();
    loadMode = "match";
    ensureGroups(list, "match");
  }
  function groupProgress(list) {
    var i, j, g, tot = 0, done = 0, err = 0;
    for (i = 0; i < list.length; i++) {
      g = ASSET_GROUPS[list[i]] || [];
      for (j = 0; j < g.length; j++) {
        tot++;
        if (g[j]._err) err++;
        else if (g[j]._ok) done++;
      }
    }
    return { tot: tot, done: done, err: err };
  }
  function groupForPath(path) {
    var head = String(path).split("/")[0];
    return ASSET_GROUPS[head] && head !== "core" ? head : "core";
  }

  function framesFromStrip(folder, prefix, count) {
    var arr = [], i, n;
    for (i = 1; i <= count; i++) {
      n = i < 10 ? "0" + i : String(i);
      arr.push({ _id: folder + "/" + prefix + "_" + n, _kit: groupForPath(folder) });
    }
    return arr;
  }
  function framesNumbered(folder, count) {
    var arr = [], i, n;
    for (i = 1; i <= count; i++) {
      n = i < 10 ? "0" + i : String(i);
      arr.push({ _id: folder + "/" + n, _kit: groupForPath(folder) });
    }
    return arr;
  }
  function bindKitFrames(kitId) {
    var info = sheetManifest && sheetManifest.kits[kitId];
    if (!info) return;
    function bindArr(arr) {
      var i, id, meta, sheetFile, fr;
      for (i = 0; i < arr.length; i++) {
        if (!arr[i] || !arr[i]._id) continue;
        id = arr[i]._id;
        meta = info.frames[id];
        if (!meta) { if (window.console) console.error("[frame missing] " + id); continue; }
        sheetFile = info.sheets[meta.sheet];
        fr = frameCache[id];
        if (!fr) { fr = new Frame(sheetFile, meta.x, meta.y, meta.sw || meta.w, meta.sh || meta.h); fr.width = fr.naturalWidth = meta.w; fr.height = fr.naturalHeight = meta.h; frameCache[id] = fr; }
        arr[i] = fr;
      }
    }
    if (kitId === "obito") {
      bindArr(obito.idle); bindArr(obito.walk); bindArr(obito.run); bindArr(obito.breath);
      bindArr(obito.firebreath); bindArr(obito.phase); bindArr(obito.tele); bindArr(obito.punch);
      bindArr(obito.cloth); bindArr(obito.knock);
    } else if (kitId === "pain") {
      bindArr(pain.idle); bindArr(pain.walk); bindArr(pain.run); bindArr(pain.dash);
      bindArr(pain.back); bindArr(pain.jump); bindArr(pain.land); bindArr(pain.turn);
      bindArr(pain.combo); bindArr(pain.kick); bindArr(pain.rod); bindArr(pain.push);
      bindArr(pain.repulse); bindArr(pain.pullCast); bindArr(pain.pullFx); bindArr(pain.cloth);
    } else if (kitId === "tanjiro") {
      bindArr(tanjiro.idle); bindArr(tanjiro.run); bindArr(tanjiro.ult1); bindArr(tanjiro.ult2);
      bindArr(tanjiro.water.atk); bindArr(tanjiro.water.water2); bindArr(tanjiro.water.water2c);
      bindArr(tanjiro.water.water4); bindArr(tanjiro.water.water1);
      bindArr(tanjiro.fire.atk); bindArr(tanjiro.fire.water2); bindArr(tanjiro.fire.water2c);
      bindArr(tanjiro.fire.water4); bindArr(tanjiro.fire.water1);
      bindArr(tanjiro.hitstun); bindArr(tanjiro.knock);
    } else if (kitId === "gojo") {
      bindArr(gojo.idle); bindArr(gojo.run); bindArr(gojo.hitstun); bindArr(gojo.knock);
      bindArr(gojo.atk); bindArr(gojo.blue); bindArr(gojo.red); bindArr(gojo.blink);
      bindArr(gojo.infinity); bindArr(gojo.infinityLoop); bindArr(gojo.domain);
    } else if (kitId === "luffy") {
      bindArr(luffy.idle); bindArr(luffy.run); bindArr(luffy.hitstun); bindArr(luffy.knock);
      bindArr(luffy.atk); bindArr(luffy.gatling); bindArr(luffy.pistol); bindArr(luffy.balloon);
      bindArr(luffy.gear2Idle); bindArr(luffy.gear2Run); bindArr(luffy.gear2Atk); bindArr(luffy.spear);
    } else if (kitId === "ichigo") {
      bindArr(ichigo.idle); bindArr(ichigo.run); bindArr(ichigo.hitstun); bindArr(ichigo.knock);
      bindArr(ichigo.atk); bindArr(ichigo.getsuga); bindArr(ichigo.flash); bindArr(ichigo.block);
      bindArr(ichigo.bankaiIdle); bindArr(ichigo.bankaiRun); bindArr(ichigo.bankaiAtk);
      bindArr(ichigo.bankai); bindArr(ichigo.mugetsu); bindArr(ichigo.mugetsuFx);
    } else if (kitId === "fushiguro") {
      bindArr(fushiguro.idle); bindArr(fushiguro.run); bindArr(fushiguro.hitstun); bindArr(fushiguro.knock);
      bindArr(fushiguro.atk); bindArr(fushiguro.dogs); bindArr(fushiguro.nue);
      bindArr(fushiguro.elephant); bindArr(fushiguro.shadow); bindArr(fushiguro.domain);
    }
  }
  function registerKitSheets(kitId) {
    var info = sheetManifest && sheetManifest.kits[kitId];
    if (!info) return;
    var i, path, img;
    for (i = 0; i < info.sheets.length; i++) {
      path = info.sheets[i];
      if (sheetImgs[path]) continue;
      img = regImg(new Image(), path, kitId, "kit");
      img._isSheet = true;
      img._bytes = (info.bytes && info.bytes[i]) || 300000;
      sheetImgs[path] = img;
    }
    bindKitFrames(kitId);
  }

  var cardImgs = {};
  (function loadCards() {
    var ids = ["obito", "pain", "tanjiro", "gojo", "luffy", "ichigo", "fushiguro"];
    var i;
    for (i = 0; i < ids.length; i++) {
      var img = regImg(new Image(), "cards/" + ids[i] + ".png", "core", "core");
      enqueue(img, "core");
      cardImgs[ids[i]] = img;
    }
  })();
  // pages30j: 通灵栏 = 4 密卷 + 熊猫 + 鲛鲨（同一 picker）
  var SCROLL_DEFS = [
    { id: "scroll_quake", name: "霸体", role: "密卷", color: "#e07030", icon: "icons/icon_01.png", max: 18.2, cost: 18, dmg: 0 },
    { id: "scroll_bolt", name: "回蓝", role: "密卷", color: "#40c0ff", icon: "icons/icon_02.png", max: 20.8, cost: 0, dmg: 0 },
    { id: "scroll_blade", name: "清CD", role: "密卷", color: "#f0c040", icon: "icons/icon_03.png", max: 23.4, cost: 12, dmg: 0 },
    { id: "scroll_gale", name: "驱散", role: "密卷", color: "#5080ff", icon: "icons/icon_04.png", max: 15.6, cost: 16, dmg: 0 },
    { id: "summon_panda", name: "熊猫", role: "通灵", color: "#f0e8d8", icon: "icons/summon_panda.png", body: "icons/summon_panda_body.png", max: 16.0, cost: 14, dmg: 28 },
    { id: "summon_shark", name: "鲛鲨", role: "通灵", color: "#6aa0c8", icon: "icons/summon_shark.png", body: "icons/shark_drop.png", max: 16.0, cost: 14, dmg: 28 }
  ];
  var scrollImgs = {};
  var pandaBodyImg = null;
  var sharkBodyImg = null;
  (function loadScrolls() {
    var i;
    for (i = 0; i < SCROLL_DEFS.length; i++) {
      var img = regImg(new Image(), SCROLL_DEFS[i].icon, "core", "core");
      enqueue(img, "core");
      scrollImgs[SCROLL_DEFS[i].id] = img;
    }
    pandaBodyImg = regImg(new Image(), "icons/summon_panda_body.png", "core", "core");
    enqueue(pandaBodyImg, "core");
    sharkBodyImg = regImg(new Image(), "icons/shark_drop.png", "core", "core");
    enqueue(sharkBodyImg, "core");
  })();
  function isTongLingId(id) {
    var s = String(id || "");
    return s.indexOf("scroll_") === 0 || s.indexOf("summon_") === 0;
  }
  function scrollById(id) {
    var i;
    for (i = 0; i < SCROLL_DEFS.length; i++) if (SCROLL_DEFS[i].id === id) return SCROLL_DEFS[i];
    return null;
  }
  function makeScrollSkill(def, keyLabel) {
    return {
      key: keyLabel || "V",
      name: def.name,
      role: def.role,
      cd: 0,
      max: def.max,
      cost: def.cost,
      scroll: true,
      color: def.color,
      dmg: def.dmg,
      iconId: def.id
    };
  }
  var roundIndex = 1;
  var roundWinsL = 0;
  var roundWinsR = 0;
  var roundEndLeft = 0;
  var matchWinner = null;
  var paused = false;
  var simSpeed = 1;
  var phaseSlow = 0;
  var hudHidden = false;
  var hudHits = [];
  var uiLatch = 0;
  var lastUiHit = null;
  var screenChangeAt = 0;
  var flowHint = document.getElementById("flowHint");
  var charRoster = [
    { id: "obito", name: "带土", unlocked: true, blurb: "虚化 · 喷火 · 空间" },
    { id: "pain", name: "佩恩天道", unlocked: true, blurb: "黑棒 · 气盾 · 吸引" },
    { id: "tanjiro", name: "炭治郎", unlocked: true, blurb: "水之呼吸 · 火之形态" },
    { id: "gojo", name: "五条悟", unlocked: true, blurb: "无下限 · 苍 · 赫 · 领域" },
    { id: "luffy", name: "路飞", unlocked: true, blurb: "橡胶 · 二档 · 金刚枪" },
    { id: "ichigo", name: "一护", unlocked: true, blurb: "斩月 · 天锁斩月 · 无月" },
    { id: "fushiguro", name: "伏黑惠", unlocked: true, blurb: "影法术 · 玉犬 · 嵌合庭" }
  ];
  var floaters = [];
  var projectiles = [];
  var spikes = [];
  var bursts = [];
  var ghosts = [];
  var rings = [];
  var sparks = [];
  var wheels = [];
  var swords = [];
  var voidSpace = false;
  var voidT = 0; // pages20: 切空间 lasts at most VOID_DUR seconds
  var VOID_DUR = 4;
  var voidUntil = 0; // performance.now() deadline
  var fightClock = { stamp: 0, accum: 0, limit: 60 };
  var arenaImg = regImg(new Image(), "arena-wide.png", "core", "core");
  enqueue(arenaImg, "core");
  var sharinganImg = regImg(new Image(), "sharingan.png", "core", "core");
  enqueue(sharinganImg, "core");

  // Bump when sprite PNGs change so browsers/CDN do not serve stale frames.
  function loadStrip(prefix, count, folder) {
    if (!folder) folder = "obito";
    return framesFromStrip(folder, prefix, count);
  }
  var obito = {
    idle: loadStrip("idle", 8),
    walk: loadStrip("walk", 8),
    run: loadStrip("run", 8),
    breath: loadStrip("breath", 8),
    firebreath: loadStrip("fire", 32, "obito/firebreath"),
    phase: loadStrip("phase", 8),
    tele: loadStrip("tele", 8),
    punch: loadStrip("punch", 8),
    cloth: loadStrip("cloth", 12, "obito/cloth_float"),
    knock: loadStrip("knock", 16, "obito/knockdown")
  };
  var portraitImgs = {};
  (function loadPortraits() {
    var ids = ["obito", "pain", "tanjiro", "gojo", "luffy", "ichigo", "fushiguro"];
    var i;
    for (i = 0; i < ids.length; i++) {
      var img = regImg(new Image(), "portraits/" + ids[i] + ".png", "core", "core");
      enqueue(img, "core");
      portraitImgs[ids[i]] = img;
    }
  })();
  // Body-height match (obito 180px, pain 143px) then both shrunk by the same
  // 0.72, then another 0.88 (same for both) so they sit smaller on the expanded field.
  // Foot pads stay in source px and are multiplied by these scales, so the shared
  // ground line still lines up.
  var obitoScale = 1.48 * 0.72 * 0.88;
  var painScale = 180 * obitoScale / 143;
  // Body frames were rekeyed at 3x. Draw scale is divided so on-screen height
  // stays the same. painIdleFootPad is still the pre-upscale pad (6); the PNGs
  // have 18 transparent rows under the idle soles, and 18 * (painScale/3) = 6*painScale.
  var painFrameScale = 3;
  var obitoIdleFootPad = 2;
  var painIdleFootPad = 6;
  // Per-idle-frame transparent rows under soles (source px). Used to keep feet planted while idle cycles.
  var obitoIdleFootPads = [2, 2, 2, 2, 2, 2, 2, 2];
  var painIdleFootPads = [21, 21, 21, 24, 24, 19];
  var painFootPads = {
    idle: [21, 21, 21, 24, 24, 19],
    cloth: [21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21],
    walk: [18, 20, 18, 18, 19, 20],
    run: [27, 21, 21, 24, 22, 19],
    dash: [18, 34, 21, 21, 18, 19],
    back: [20, 19, 18, 21, 22, 19],
    combo: [21, 21, 21, 21, 21, 18],
    kick: [20, 21, 21, 21, 21, 17],
    rod: [25, 25, 27, 29, 24, 17],
    push: [18, 19, 17, 17, 18, 18],
    turn: [18, 17, 23, 23, 19, 23],
    land: [21, 21, 21, 21, 19, 18],
    jump: [19, 20, 18, 18, 18, 18]
  };
  // Clamp action pads toward idle sole so feet stay planted (ignore sheet float/crop errors).
  (function clampPainPads() {
    var ref = 21;
    var k, i, arr;
    for (k in painFootPads) {
      arr = painFootPads[k];
      for (i = 0; i < arr.length; i++) {
        if (Math.abs(arr[i] - ref) > 12) arr[i] = ref;
      }
    }
  })();
  // Drop pain so its feet share obito's ground line (pain has more empty rows under the sandals).
  var painFootDrop = painIdleFootPad * painScale - obitoIdleFootPad * obitoScale;
  // Lowest-opaque row gap under each tele frame (source px). Larger than idle means the art floats.
  var teleFootPad = [3, 4, 6, 11, 8, 9, 7, 4];
  var pain = {
    idle: loadStrip("idle", 6, "pain"),
    walk: loadStrip("walk", 6, "pain"),
    run: loadStrip("run", 6, "pain"),
    dash: loadStrip("dash", 6, "pain"),
    back: loadStrip("back", 6, "pain"),
    jump: loadStrip("jump", 6, "pain"),
    land: loadStrip("land", 6, "pain"),
    turn: loadStrip("turn", 6, "pain"),
    combo: loadStrip("combo", 6, "pain"),
    kick: loadStrip("kick", 6, "pain"),
    rod: loadStrip("rod", 6, "pain"),
    push: loadStrip("push", 6, "pain"),
    repulse: loadStrip("repulse", 20, "pain/repulse"),
    pullCast: loadStrip("cast", 24, "pain/pull"),
    pullFx: loadStrip("fx", 24, "pain/pull"),
    cloth: loadStrip("cloth", 12, "pain/cloth_float")
  };
  function loadNumbered(folder, count) {
    return framesNumbered(folder, count);
  }
  function tanjiroFormFolder(fire) {
    return fire ? "tanjiro/fire" : "tanjiro/water";
  }
  var tanjiro = {
    idle: loadNumbered("tanjiro/idle", 8),
    run: loadNumbered("tanjiro/run", 8),
    water: {
      atk: loadNumbered("tanjiro/water/普攻", 6),
      water2: loadNumbered("tanjiro/water/二型", 6),
      water2c: loadNumbered("tanjiro/water/二型_反击斩", 6),
      water4: loadNumbered("tanjiro/water/四型", 6),
      water1: loadNumbered("tanjiro/water/一型", 6)
    },
    fire: {
      atk: loadNumbered("tanjiro/fire/普攻", 6),
      water2: loadNumbered("tanjiro/fire/二型", 6),
      water2c: loadNumbered("tanjiro/fire/二型_反击斩", 6),
      water4: loadNumbered("tanjiro/fire/四型", 6),
      water1: loadNumbered("tanjiro/fire/一型", 6)
    },
    ult1: loadNumbered("tanjiro/ult/一段_变身", 6),
    ult2: loadNumbered("tanjiro/ult/二段", 6),
    hitstun: loadNumbered("tanjiro/hitstun", 6),
    knock: loadNumbered("tanjiro/knockdown", 6)
  };
  // Match on-screen body height to Obito (~180 * obitoScale).
  // pages29: frames padded +36px on top so hair is not flush-cropped; foot line still ~20px above bottom.
  var tanjiroTopPad = 36;
  var tanjiroScale = (180 * obitoScale) / (360 + tanjiroTopPad);
  var tanjiroFootPad = 20; // empty rows under soles
  var tanjiroBodyW = 211 * tanjiroScale;
  var tanjiroBodyH = 360 * tanjiroScale;

  // pages30s: 五条悟 — +领域 skill_domain×6
  var gojo = {
    idle: loadNumbered("gojo/idle", 8),
    run: loadNumbered("gojo/run", 8),
    hitstun: loadNumbered("gojo/hitstun", 6),
    knock: loadNumbered("gojo/knockdown", 6),
    atk: loadNumbered("gojo/attack", 6),
    blue: loadNumbered("gojo/skill_ao", 6),
    red: loadNumbered("gojo/skill_aka", 6),
    blink: loadNumbered("gojo/skill_blink", 6),
    infinity: loadNumbered("gojo/skill_infinity", 6),
    infinityLoop: loadNumbered("gojo/infinity_loop", 4),
    domain: loadNumbered("gojo/skill_domain", 6)
  };
  // canvas 320×436；opaque ~145×390；脚底距底 ~7px；面朝右 → nativeDir +1
  var gojoFootPad = 7;
  var gojoScale = (180 * obitoScale) / 390;
  var gojoBodyW = 145 * gojoScale;
  var gojoBodyH = 390 * gojoScale;

  // pages30v: 路飞全套 — +二档 idle/run/attack + 金刚枪
  var luffy = {
    idle: loadNumbered("luffy/idle", 8),
    run: loadNumbered("luffy/run", 8),
    hitstun: loadNumbered("luffy/hitstun", 6),
    knock: loadNumbered("luffy/knockdown", 6),
    atk: loadNumbered("luffy/attack", 6),
    gatling: loadNumbered("luffy/skill_gatling", 6),
    pistol: loadNumbered("luffy/skill_pistol", 6),
    balloon: loadNumbered("luffy/skill_balloon", 6),
    gear2Idle: loadNumbered("luffy/gear2_idle", 8),
    gear2Run: loadNumbered("luffy/gear2_run", 8),
    gear2Atk: loadNumbered("luffy/gear2_attack", 6),
    spear: loadNumbered("luffy/skill_konggun", 6)
  };
  // canvas 320×436；面朝右 → nativeDir +1
  var luffyFootPad = 8;
  var luffyScale = (180 * obitoScale) / 436;
  var luffyBodyW = 145 * luffyScale;
  var luffyBodyH = 436 * luffyScale;

  // pages31b: 一护全套 — +bankai idle/run/attack + skill_bankai + mugetsu + fx_mugetsu
  var ichigo = {
    idle: loadNumbered("ichigo/idle", 8),
    run: loadNumbered("ichigo/run", 8),
    hitstun: loadNumbered("ichigo/hitstun", 6),
    knock: loadNumbered("ichigo/knockdown", 6),
    atk: loadNumbered("ichigo/attack", 6),
    getsuga: loadNumbered("ichigo/skill_getsuga", 6),
    flash: loadNumbered("ichigo/skill_flash", 6),
    block: loadNumbered("ichigo/skill_block", 6),
    bankaiIdle: loadNumbered("ichigo/bankai_idle", 8),
    bankaiRun: loadNumbered("ichigo/bankai_run", 8),
    bankaiAtk: loadNumbered("ichigo/bankai_attack", 6),
    bankai: loadNumbered("ichigo/skill_bankai", 6),
    mugetsu: loadNumbered("ichigo/skill_mugetsu", 6),
    mugetsuFx: loadNumbered("ichigo/fx_mugetsu", 6)
  };
  // canvas 320×436；opaque ~307×378；脚底距底 ~8px；面朝右 → nativeDir +1
  var ichigoFootPad = 8;
  var ichigoScale = (180 * obitoScale) / 436;
  var ichigoBodyW = 160 * ichigoScale;
  var ichigoBodyH = 378 * ichigoScale;

  // pages31d: 伏黑惠基础 — idle/run/hitstun/knock；技能桩可玩，专属帧第2批后补
  var fushiguro = {
    idle: loadNumbered("fushiguro/idle", 8),
    run: loadNumbered("fushiguro/run", 8),
    hitstun: loadNumbered("fushiguro/hitstun", 6),
    knock: loadNumbered("fushiguro/knockdown", 6),
    atk: loadNumbered("fushiguro/attack", 6),
    dogs: loadNumbered("fushiguro/skill_dogs", 6),
    nue: loadNumbered("fushiguro/skill_nue", 6),
    elephant: loadNumbered("fushiguro/skill_elephant", 6),
    shadow: loadNumbered("fushiguro/skill_shadow", 6),
    domain: loadNumbered("fushiguro/skill_domain", 8)
  };
  // pages31g: 返修帧与 idle 同身高，去掉 1.1；ox 清零
  var fushiSkillScale = 1.0;
  var fushiFrameOx = {
    atk: [0, 0, 0, 0, 0, 0],
    dogs: [0, 0, 0, 0, 0, 0],
    nue: [0, 0, 0, 0, 0, 0],
    elephant: [0, 0, 0, 0, 0, 0],
    shadow: [0, 0, 0, 0, 0, 0],
    domain: [0, 0, 0, 0, 0, 0, 0, 0]
  };
  // canvas 320×436；IDLE_H≈378；脚底距底 ~10px；面朝右 → nativeDir +1
  var fushiFootPad = 10;
  var fushiScale = (180 * obitoScale) / 436;
  var fushiBodyW = 110 * fushiScale;
  var fushiBodyH = 378 * fushiScale;

  var clothFps = 9;
  function plantCaster(f) {
    f.airH = 0;
    f.airV = 0;
    f.airborne = false;
    f.launchVx = 0;
    f.launchVy = 0;
  }
  // Repulsion sheet: frames 1-12 are F05-F16, 13-20 are F17-F24. Play once, no loop.
  // 16 fps (was 12) shortens the wind-up; short press still ends on F16, long on F24.
  var repulseFps = 16;
  // Startup before the shield is live, scaled with the fps change (0.15 * 12 / 16).
  var repulseWind = 0.15 * 12 / repulseFps;
  // Standing head-to-sole on this sheet is 171px; idle opaque span is 149px.
  var repulseScale = painScale * (149 / 171);
  // Source px from the sandal sole up from the bottom of every repulse frame.
  var repulseFootPad = 53;
  function repulseSpan(long) {
    return (long ? 20 : 12) / repulseFps;
  }
  // Pull (吸力) cast + black-core VFX: 24 frames synced by index.
  var pullCastFps = 18;
  var pullCastSpan = 24 / pullCastFps;
  var pullCastScale = painScale * (433 / 3) / 532;
  var pullCastFootPad = 6;
  var pullFxScale = 1.15;
  var pullActiveFrom = 8 / pullCastFps;
  var pullActiveUntil = 17 / pullCastFps;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function xLimits(y) {
    var span = MAX_Y - MIN_Y;
    var t = span === 0 ? 0 : (y - MIN_Y) / span;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return {
      min: FAR_L + (NEAR_L - FAR_L) * t,
      max: FAR_R + (NEAR_R - FAR_R) * t
    };
  }

  function clampSpot(x, y) {
    // Void space only swaps the backdrop. Keep the same playable plane so Pain
    // (and Obito) can still walk/fight after 切空间. The old 500–650 Y band
    // pinned fighters and felt like a hard freeze.
    return { x: clamp(x, 90, 1190), y: clamp(y, 430, 680) };
  }

  function boosted(f, amount) {
    if (voidSpace && isObito(f)) return Math.round(amount * 1.5);
    return amount;
  }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function makeFighter(id, name, x, palette) {
    return {
      id: id,
      name: name,
      x: x,
      y: 530,
      facing: id === "L" ? 1 : -1,
      hp: 120,
      maxHp: 120,
      chakra: 100,
      maxChakra: 100,
      palette: palette,
      weapon: id === "L" ? "blade" : "spear",
      anim: "idle",
      gait: "idle",
      animT: 0,
      animDur: 0.3,
      busy: 0,
      hitPending: false,
      dashT: 0,
      dashVx: 0,
      dashHit: false,
      flash: 0,
      invuln: 0,
      hurt: 0,
      stun: 0,
      airH: 0,
      airV: 0,
      launchVx: 0,
      launchVy: 0,
      airborne: false,
      hitLean: 0,
      hitLeanDir: 1,
      hitPushVx: 0,
      hitPushVy: 0,
      hitShake: 0,
      hitLight: false,
      downT: 0,
      downMax: 0,
      getUpT: 0,
      getUpMax: 0,
      knockPhase: null,
      knockT: 0,
      knockNoBlink: 0,
      hpChip: 100,
      barDmg: 0,
      barDmgT: 0,
      phase: 0,
      armor: 0,
      hyperArmor: 0,
      chakraLock: 0,
      aiIx: 0,
      aiIy: 0,
      aiThink: 0,
      skills: {}
    };
  }

  var left = makeFighter("L", "带土", 420, {
    body: "#24315c",
    trim: "#e8e4f2",
    glow: "#9eb6ff",
    deep: "#14182c",
    hot: "#f0d2c0"
  });
  var right = makeFighter("R", "佩恩天道", 860, {
    body: "#2c2428",
    trim: "#ff7a3a",
    glow: "#ffb067",
    deep: "#1a1214",
    hot: "#ff8a3a"
  });
  left.kit = "obito";
  right.kit = "pain";
  left.moveSpeed = 546;
  right.moveSpeed = 437;

  left.skills = {
    punch: { key: "Q", name: "掌击", role: "突进", cd: 0, max: 0.91, cost: 0 },
    phase: { key: "E", name: "虚化", role: "灵体", cd: 0, max: 7.8, cost: 30 },
    tele: { key: "R", name: "传送", role: "突进", cd: 0, max: 1.495, cost: 16 },
    breath: { key: "F", name: "喷火", role: "远程", cd: 0, max: 2.21, cost: 22 },
    space: { key: "C", name: "切空间", role: "空间", cd: 0, max: 1, cost: 0 }
  };
  right.skills = {
    thrust: { key: "U", name: "连击", role: "平A", cd: 0, max: 1.014, cost: 0 },
    fire: { key: "I", name: "黑棒", role: "远程", cd: 0, max: 1.495, cost: 18 },
    swap: { key: "O", name: "后撤", role: "闪避", cd: 0, max: 1.56, cost: 10 },
    spike: { key: "P", name: "气盾", role: "绝技", cd: 0, max: 10.4, cost: 28 },
    pull: { key: "J", name: "吸引", role: "控制", cd: 0, max: 3.38, cost: 18 },
    cleave: { key: "K", name: "重脚", role: "平A", cd: 0, max: 1.17, cost: 8 }
  };


  // Coop 2v2 partners (inactive unless gameMode === "coop")
  var left2 = makeFighter("L2", "带土", 460, {
    body: "#24315c",
    trim: "#e8e4f2",
    glow: "#9eb6ff",
    deep: "#14182c",
    hot: "#f0d2c0"
  });
  var right2 = makeFighter("R2", "佩恩天道", 940, {
    body: "#2c2428",
    trim: "#ff7a3a",
    glow: "#ffb067",
    deep: "#1a1214",
    hot: "#ff8a3a"
  });
  left2.kit = "obito";
  right2.kit = "pain";
  left2.moveSpeed = 546;
  right2.moveSpeed = 437;
  left2.skills = {};
  right2.skills = {};

  var leftOrder = ["punch", "phase", "tele", "breath", "space"];
  var rightOrder = ["thrust", "fire", "swap", "spike", "pull", "cleave"];
  var left2Order = ["punch", "phase", "tele", "breath", "space"];
  var right2Order = ["thrust", "fire", "swap", "spike", "pull", "cleave"];

  var KIT_DEFS = {
    obito: {
      name: "带土",
      weapon: "blade",
      speed: 546,
      palette: { body: "#24315c", trim: "#e8e4f2", glow: "#9eb6ff", deep: "#14182c", hot: "#f0d2c0" },
      order: ["punch", "phase", "tele", "breath", "space"],
      skills: {
        punch: { key: "Q", name: "掌击", role: "突进", cd: 0, max: 0.91, cost: 0 },
        phase: { key: "E", name: "虚化", role: "灵体", cd: 0, max: 7.8, cost: 30 },
        tele: { key: "R", name: "传送", role: "突进", cd: 0, max: 1.495, cost: 16 },
        breath: { key: "F", name: "喷火", role: "远程", cd: 0, max: 2.21, cost: 22 },
        space: { key: "C", name: "切空间", role: "空间", cd: 0, max: 1, cost: 0 }
      }
    },
    pain: {
      name: "佩恩天道",
      weapon: "spear",
      speed: 437,
      palette: { body: "#2c2428", trim: "#ff7a3a", glow: "#ffb067", deep: "#1a1214", hot: "#ff8a3a" },
      order: ["thrust", "fire", "swap", "spike", "pull", "cleave"],
      skills: {
        thrust: { key: "U", name: "连击", role: "平A", cd: 0, max: 1.014, cost: 0 },
        fire: { key: "I", name: "黑棒", role: "远程", cd: 0, max: 1.495, cost: 18 },
        swap: { key: "O", name: "后撤", role: "闪避", cd: 0, max: 1.56, cost: 10 },
        spike: { key: "P", name: "气盾", role: "绝技", cd: 0, max: 10.4, cost: 28 },
        pull: { key: "J", name: "吸引", role: "控制", cd: 0, max: 3.38, cost: 18 },
        cleave: { key: "K", name: "重脚", role: "平A", cd: 0, max: 1.17, cost: 8 }
      }
    },
    tanjiro: {
      name: "炭治郎",
      weapon: "blade",
      speed: 480,
      palette: { body: "#1e4a52", trim: "#7ad0c8", glow: "#5ee0d0", deep: "#0c1c22", hot: "#ff6a3a" },
      order: ["atk", "water2", "water4", "water1", "ult1", "ult2"],
      skills: {
        atk: { key: "Q", name: "普攻", role: "平A", cd: 0, max: 0.35, cost: 0 },
        water2: { key: "E", name: "二型", role: "防御", cd: 0, max: 8, cost: 25 },
        water4: { key: "R", name: "四型", role: "突进", cd: 0, max: 6, cost: 20 },
        water1: { key: "F", name: "一型", role: "斩击", cd: 0, max: 7, cost: 22 },
        ult1: { key: "C", name: "火之形态", role: "变身", cd: 0, max: 20, cost: 0 },
        ult2: { key: "V", name: "瞬斩", role: "大招", cd: 0, max: 0, cost: 0 }
      }
    },
    gojo: {
      name: "五条悟",
      weapon: "blade",
      speed: 520,
      palette: { body: "#1a2438", trim: "#e8f0ff", glow: "#6ab0ff", deep: "#0a1020", hot: "#ff4060" },
      order: ["atk", "blue", "red", "blink", "infinity", "domain"],
      skills: {
        atk: { key: "Q", name: "无下限拳", role: "平A", cd: 0, max: 0.4, cost: 0 },
        blue: { key: "E", name: "苍", role: "吸引", cd: 0, max: 3.4, cost: 18 },
        red: { key: "R", name: "赫", role: "远程", cd: 0, max: 2.2, cost: 22 },
        blink: { key: "F", name: "瞬步", role: "突进", cd: 0, max: 1.5, cost: 16 },
        infinity: { key: "C", name: "无下限", role: "灵体", cd: 0, max: 7.8, cost: 30 },
        domain: { key: "V", name: "领域", role: "绝技", cd: 0, max: 20, cost: 0 }
      }
    },
    luffy: {
      name: "路飞",
      weapon: "blade",
      speed: 500,
      palette: { body: "#c4282d", trim: "#f5d76e", glow: "#ff6b4a", deep: "#3a1014", hot: "#ff9040" },
      order: ["atk", "gatling", "pistol", "balloon", "gear2", "spear"],
      skills: {
        atk: { key: "Q", name: "橡胶拳", role: "平A", cd: 0, max: 0.4, cost: 0 },
        gatling: { key: "E", name: "机关枪", role: "连击", cd: 0, max: 6, cost: 20 },
        pistol: { key: "R", name: "橡胶枪", role: "突进", cd: 0, max: 1.5, cost: 16 },
        balloon: { key: "F", name: "气球", role: "防御", cd: 0, max: 8, cost: 25 },
        gear2: { key: "C", name: "二档", role: "变身", cd: 0, max: 20, cost: 0 },
        spear: { key: "V", name: "金刚枪", role: "大招", cd: 0, max: 0, cost: 0 }
      }
    },
    ichigo: {
      name: "一护",
      weapon: "blade",
      speed: 510,
      palette: { body: "#1a1420", trim: "#e8a040", glow: "#ff7a30", deep: "#0c0812", hot: "#ff5030" },
      order: ["atk", "getsuga", "flash", "block", "bankai", "mugetsu"],
      skills: {
        atk: { key: "Q", name: "斩月", role: "平A", cd: 0, max: 0.35, cost: 0 },
        getsuga: { key: "E", name: "月牙天冲", role: "远程", cd: 0, max: 2.2, cost: 22 },
        flash: { key: "R", name: "瞬步", role: "突进", cd: 0, max: 1.5, cost: 16 },
        block: { key: "F", name: "挡刀", role: "防御", cd: 0, max: 8, cost: 25 },
        bankai: { key: "C", name: "天锁斩月", role: "变身", cd: 0, max: 20, cost: 0 },
        mugetsu: { key: "V", name: "无月", role: "大招", cd: 0, max: 0, cost: 0 }
      }
    },
    fushiguro: {
      name: "伏黑惠",
      weapon: "blade",
      speed: 500,
      palette: { body: "#1a2438", trim: "#6a90c8", glow: "#5080ff", deep: "#0a1020", hot: "#a0c0ff" },
      order: ["atk", "dogs", "nue", "elephant", "shadow", "domain"],
      skills: {
        atk: { key: "Q", name: "影刺", role: "平A", cd: 0, max: 0.35, cost: 0 },
        dogs: { key: "E", name: "玉犬", role: "突进", cd: 0, max: 6, cost: 20 },
        nue: { key: "R", name: "鵺", role: "远程", cd: 0, max: 2.2, cost: 22 },
        elephant: { key: "F", name: "满象", role: "控制", cd: 0, max: 8, cost: 25 },
        shadow: { key: "C", name: "影换", role: "闪避", cd: 0, max: 1.56, cost: 10 },
        domain: { key: "V", name: "嵌合庭", role: "绝技", cd: 0, max: 20, cost: 0 }
      }
    }
  };

  function cloneSkills(src) {
    var out = {};
    var k;
    for (k in src) {
      out[k] = {
        key: src[k].key,
        name: src[k].name,
        role: src[k].role,
        cd: 0,
        max: src[k].max,
        cost: src[k].cost
      };
    }
    return out;
  }

  function applySideKit(f, kitId) {
    var def = KIT_DEFS[kitId];
    if (!def) return;
    f.kit = kitId;
    f.name = def.name;
    f.weapon = def.weapon;
    f.palette = {
      body: def.palette.body,
      trim: def.palette.trim,
      glow: def.palette.glow,
      deep: def.palette.deep,
      hot: def.palette.hot
    };
    f.skills = cloneSkills(def.skills);
    f.moveSpeed = def.speed;
    // Pain-only fields stay harmless on Obito
    if (kitId === "pain") {
      f.shield = f.shield || 0;
      f.shieldKey = false;
      f.shieldHit = false;
      f.repulseOn = false;
      f.repulseT = 0;
      f.repulseLong = false;
      f.pullOn = false;
      f.pullAnimT = 0;
      f.pullApplied = false;
    }
    f.baseMoveSpeed = def.speed;
    f.fireForm = false;
    f.barrierT = 0;
    f.barrierUsed = false;
    f.counterT = 0;
    f.ult2Phase = 0;
    f.ult2T = 0;
    f.ult2Hits = 0;
    f.domainT = 0;
    f.gear2 = false;
    f.bankai = false;
  }

  // pages20: fixed slots on both sides. Non-scroll skills fill slots 0..5 in order;
  // the 通灵 (密卷/召唤) always sits on slot 6 (left B / right L) for every kit.
  var SLOT_LABELS = { L: ["Q", "E", "R", "F", "C", "V", "B"], R: ["U", "I", "O", "P", "J", "K", "L"] };
  function slotIndexFor(order, i) {
    if (isTongLingId(order[i])) return 6;
    var n = 0, j;
    for (j = 0; j < i; j++) if (!isTongLingId(order[j])) n++;
    return n;
  }
  function labelSide(f, order, side) {
    var i;
    for (i = 0; i < order.length; i++) {
      if (f.skills[order[i]]) f.skills[order[i]].key = SLOT_LABELS[side][slotIndexFor(order, i)];
    }
  }

  function rebuildControlMap() {
    var leftKeys = ["q", "e", "r", "f", "c", "v", "b"];
    var rightKeys = ["u", "i", "o", "p", "j", "k", "l"];
    var map = {};
    var i;
    var p2 = isCoop() ? left2 : right;
    var p2Order = isCoop() ? left2Order : rightOrder;
    var p2Id = isCoop() ? "L2" : "R";
    for (i = 0; i < leftOrder.length; i++) map[leftKeys[slotIndexFor(leftOrder, i)]] = ["L", leftOrder[i]];
    labelSide(left, leftOrder, "L");
    for (i = 0; i < p2Order.length; i++) map[rightKeys[slotIndexFor(p2Order, i)]] = [p2Id, p2Order[i]];
    labelSide(p2, p2Order, "R");
    if (isCoop()) {
      labelSide(right, rightOrder, "R");
      labelSide(right2, right2Order, "R");
    }
    controlMap = map;
  }

  function attachScrollSkill(f, orderArr, scrollId, keyLabel) {
    var def = scrollById(scrollId);
    if (!def) return orderArr;
    // Drop any previous 通灵 skill ids from order/skills
    var cleaned = [];
    var i, sid;
    for (i = 0; i < orderArr.length; i++) {
      sid = orderArr[i];
      if (isTongLingId(sid)) {
        delete f.skills[sid];
      } else {
        cleaned.push(sid);
      }
    }
    f.skills[def.id] = makeScrollSkill(def, keyLabel);
    cleaned.push(def.id);
    f.scrollId = def.id;
    return cleaned;
  }

  function pickAiScroll(avoidId) {
    var pool = [];
    var i;
    for (i = 0; i < SCROLL_DEFS.length; i++) {
      if (SCROLL_DEFS[i].id !== avoidId) pool.push(SCROLL_DEFS[i].id);
    }
    if (!pool.length) return SCROLL_DEFS[0].id;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function applyMatchKits(kitL, kitR, scrollL, scrollR) {
    applySideKit(left, kitL || "obito");
    applySideKit(right, kitR || "pain");
    leftOrder = KIT_DEFS[left.kit].order.slice();
    rightOrder = KIT_DEFS[right.kit].order.slice();
    leftOrder = attachScrollSkill(left, leftOrder, scrollL, "B");
    rightOrder = attachScrollSkill(right, rightOrder, scrollR, "L");
    rebuildControlMap();
  }

  function applyCoopMatchKits(kitP1, kitP2, kitA1, kitA2, scrollP1, scrollP2, scrollA1, scrollA2) {
    applySideKit(left, kitP1 || "obito");
    applySideKit(left2, kitP2 || "pain");
    applySideKit(right, kitA1 || "pain");
    applySideKit(right2, kitA2 || "obito");
    leftOrder = KIT_DEFS[left.kit].order.slice();
    left2Order = KIT_DEFS[left2.kit].order.slice();
    rightOrder = KIT_DEFS[right.kit].order.slice();
    right2Order = KIT_DEFS[right2.kit].order.slice();
    leftOrder = attachScrollSkill(left, leftOrder, scrollP1, "B");
    left2Order = attachScrollSkill(left2, left2Order, scrollP2, "L");
    rightOrder = attachScrollSkill(right, rightOrder, scrollA1, "L");
    right2Order = attachScrollSkill(right2, right2Order, scrollA2, "L");
    rebuildControlMap();
  }

  function fighterByKit(kitId) {
    var all = activeFighters();
    var i;
    for (i = 0; i < all.length; i++) if (all[i].kit === kitId) return all[i];
    return null;
  }

  function isObito(f) { return f && f.kit === "obito"; }
  function isPain(f) { return f && f.kit === "pain"; }
  function isTanjiro(f) { return f && f.kit === "tanjiro"; }
  function isGojo(f) { return f && f.kit === "gojo"; }
  function isLuffy(f) { return f && f.kit === "luffy"; }
  function isIchigo(f) { return f && f.kit === "ichigo"; }
  function isFushiguro(f) { return f && f.kit === "fushiguro"; }

  function isCoop() { return gameMode === "coop"; }

  function activeFighters() {
    if (isCoop()) return [left, left2, right, right2];
    return [left, right];
  }

  function teamOf(f) {
    if (!f) return null;
    if (f.id === "L" || f.id === "L2") return "L";
    return "R";
  }

  function fighterByOwner(id) {
    if (id === "L") return left;
    if (id === "R") return right;
    if (id === "L2") return left2;
    if (id === "R2") return right2;
    return null;
  }

  function livingEnemies(f) {
    var t = teamOf(f);
    var all = activeFighters();
    var out = [];
    var i;
    for (i = 0; i < all.length; i++) {
      if (teamOf(all[i]) !== t && all[i].hp > 0) out.push(all[i]);
    }
    return out;
  }

  function nearestEnemy(f) {
    var enemies = livingEnemies(f);
    var i;
    if (!enemies.length) {
      var all = activeFighters();
      for (i = 0; i < all.length; i++) {
        if (teamOf(all[i]) !== teamOf(f)) enemies.push(all[i]);
      }
    }
    if (!enemies.length) return f === left ? right : left;
    var best = enemies[0];
    var bestD = 1e12;
    for (i = 0; i < enemies.length; i++) {
      var dx = enemies[i].x - f.x;
      var dy = enemies[i].y - f.y;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = enemies[i]; }
    }
    return best;
  }

  function other(f) { return nearestEnemy(f); }

  function livingHumans() {
    var all = activeFighters();
    var out = [];
    var i;
    for (i = 0; i < all.length; i++) {
      if (humanControls(all[i]) && all[i].hp > 0) out.push(all[i]);
    }
    return out;
  }

  function nearestHuman(f) {
    var humans = livingHumans();
    var i;
    if (!humans.length) return nearestEnemy(f);
    var best = humans[0];
    var bestD = 1e12;
    for (i = 0; i < humans.length; i++) {
      var dx = humans[i].x - f.x;
      var dy = humans[i].y - f.y;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = humans[i]; }
    }
    return best;
  }

  function projectileOwner(ownerId) {
    return fighterByOwner(ownerId) || left;
  }

  function projectileFoe(ownerId, px, py) {
    var owner = projectileOwner(ownerId);
    var enemies = livingEnemies(owner);
    var i;
    if (!enemies.length) return nearestEnemy(owner);
    if (px == null) return nearestEnemy(owner);
    var best = enemies[0];
    var bestD = 1e12;
    for (i = 0; i < enemies.length; i++) {
      var dx = enemies[i].x - px;
      var dy = (enemies[i].y - 74) - py;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = enemies[i]; }
    }
    return best;
  }

  function teamAlive(side) {
    var all = activeFighters();
    var i;
    for (i = 0; i < all.length; i++) {
      if (teamOf(all[i]) === side && all[i].hp > 0) return true;
    }
    return false;
  }

  function teamHp(side) {
    var all = activeFighters();
    var sum = 0;
    var i;
    for (i = 0; i < all.length; i++) {
      if (teamOf(all[i]) === side) sum += Math.max(0, all[i].hp);
    }
    return sum;
  }

  function declareKoWinner(winnerSide) {
    koId = winnerSide;
    finishRound(winnerSide);
  }

  function onFighterKilled(target) {
    if (isCoop()) {
      var deadTeam = teamOf(target);
      if (!teamAlive(deadTeam)) declareKoWinner(deadTeam === "L" ? "R" : "L");
      return;
    }
    declareKoWinner(target.id === "L" ? "R" : "L");
  }

  function unlockedKitIds() {
    var ids = [];
    var i;
    for (i = 0; i < charRoster.length; i++) {
      if (charRoster[i].unlocked) ids.push(charRoster[i].id);
    }
    return ids.length ? ids : ["obito", "pain"];
  }

  function pickRandomKit() {
    var ids = unlockedKitIds();
    return ids[Math.floor(Math.random() * ids.length)];
  }

  function resetOneFighter(f, facing) {
    f.facing = facing;
    f.hp = f.maxHp;
    f.chakra = f.maxChakra;
    f.anim = "idle";
    f.busy = 0;
    f.dashT = 0;
    f.flash = 0;
    f.invuln = 0;
    f.phase = 0;
    f.hurt = 0;
    f.stun = 0;
    f.airH = 0;
    f.airV = 0;
    f.launchVx = 0;
    f.launchVy = 0;
    f.airborne = false;
    f.hitLean = 0;
    f.hitLeanDir = facing;
    f.hitPushVx = 0;
    f.hitPushVy = 0;
    f.hitShake = 0;
    f.hitLight = false;
    f.downT = 0;
    f.downMax = 0;
    f.getUpT = 0;
    f.getUpMax = 0;
    f.knockPhase = null;
    f.knockT = 0;
    f.knockNoBlink = 0;
    f.hpChip = f.maxHp;
    f.barDmg = 0;
    f.barDmgT = 0;
    f.hitPending = false;
    f.aiIx = 0;
    f.aiIy = 0;
    f.aiThink = 0;
    var k;
    for (k in f.skills) f.skills[k].cd = 0;
    f.shield = 0;
    f.shieldKey = false;
    f.shieldHit = false;
    f.armor = 0;
    f.hyperArmor = 0;
    f.chakraLock = 0;
    f.rooted = 0;
    f.pullT = 0;
    f.pullFx = 0;
    f.pullOn = false;
    f.pullAnimT = 0;
    f.pullApplied = false;
    f.shieldWind = 0;
    f.repulseOn = false;
    f.repulseT = 0;
    f.repulseLong = false;
    f.fireForm = false;
    f.pendingFireForm = false;
    f.barrierT = 0;
    f.barrierUsed = false;
    f.counterT = 0;
    f.ult2Phase = 0;
    f.ult2T = 0;
    f.ult2Hits = 0;
    f.domainT = 0;
    f.gear2 = false;
    f.bankai = false;
    f.balloonT = 0;
    f.blockT = 0;
    if (f.baseMoveSpeed) f.moveSpeed = f.baseMoveSpeed;
  }

  function reset() {
    if (isCoop()) {
      left.x = 340; left.y = 500;
      left2.x = 460; left2.y = 560;
      right.x = 820; right.y = 500;
      right2.x = 940; right2.y = 560;
      resetOneFighter(left, 1);
      resetOneFighter(left2, 1);
      resetOneFighter(right, -1);
      resetOneFighter(right2, -1);
    } else {
      left.x = 420; left.y = 530;
      right.x = 860; right.y = 530;
      resetOneFighter(left, 1);
      resetOneFighter(right, -1);
    }
    projectiles.length = 0;
    spikes.length = 0;
    bursts.length = 0;
    ghosts.length = 0;
    rings.length = 0;
    sparks.length = 0;
    wheels.length = 0;
    swords.length = 0;
    floaters.length = 0;
    shake = 0;
    koId = null;
    voidSpace = false;
    voidT = 0;
    voidUntil = 0;
    phaseSlow = 0;
  }

  function spawnFloater(x, y, text, color) {
    floaters.push({ x: x, y: y, text: text, color: color, life: 0.75, max: 0.75 });
  }

  var LAUNCH_DMG = 12;
  var LAUNCH_G = 980;
  var IMPACT_K = 0.022;

  function isAirborne(f) {
    return !!(f && (f.airborne || (f.airH || 0) > 0.5));
  }

  function isDowned(f) {
    return !!(f && ((f.downT || 0) > 0 || (f.getUpT || 0) > 0));
  }

  function fighterDrawTilt(f) {
    // World-space lean: positive rotates so the head moves right (canvas y-down).
    var dir = f.hitLeanDir || 1;
    var local;
    var flat = Math.PI * 0.40; // ~72°, not a hard 90° snap
    if ((f.downT || 0) > 0) {
      var dMax = f.downMax || f.downT || 0.01;
      var held = 1 - (f.downT / dMax);
      if (held < 0) held = 0;
      if (held > 1) held = 1;
      // Ease into the lie: start from air tilt, settle flat (no instant 90°).
      var u = held < 0.35 ? (held / 0.35) : 1;
      u = u * u * (3 - 2 * u);
      local = flat * (0.78 + 0.22 * u);
    } else if ((f.getUpT || 0) > 0 && (f.getUpMax || 0) > 0) {
      var t = f.getUpT / f.getUpMax; // 1=flat → 0=upright
      // Ease-out stand: leave the floor sooner, finish smoothly.
      var eased = Math.pow(t, 1.55);
      local = flat * eased;
    } else if (isAirborne(f)) {
      var hNorm = (f.airH || 0) / 180;
      if (hNorm < 0) hNorm = 0;
      if (hNorm > 1) hNorm = 1;
      var rising = (f.airV || 0) > 40;
      if (rising) local = 0.22 + hNorm * 0.48;
      else local = 0.30 + hNorm * 0.62;
    } else if ((f.hitLean || 0) > 0.001) {
      local = f.hitLean;
    } else {
      return 0;
    }
    return dir * local;
  }

  function hurt(target, amount, color, opts) {
    opts = opts || {};
    if (koId || target.hp <= 0 || target.invuln > 0 || target.phase > 0 || target.shield > 0) return false;
    if (isDowned(target) && !opts.fromImpact) return false;
    amount = Math.max(1, Math.round(amount * 2 / 3));
    var hyper = (target.hyperArmor || 0) > 0 && !opts.ignoreArmor;
    target.hp = Math.max(0, target.hp - amount);
    target.flash = 0;
    target.hurt = 0.14;
    target.hpChip = Math.min(target.maxHp, Math.max(target.hpChip != null ? target.hpChip : target.maxHp, target.hp + amount));
    target.chipHold = 0.5;
    target.barDmg = amount;
    target.barDmgT = 0.85;
    shake = Math.min(14, shake + 4.5 + Math.min(4, amount * 0.12));
    spawnFloater(target.x + (Math.random() * 16 - 8), target.y - 148 - (target.airH || 0), String(amount), color);
    if (hyper) {
      // 霸体: take damage, keep acting; immune to stun / knockback / launch from normal hits.
      // Grab/pull still moves the target via castPull (does not rely on hurt launch).
      spawnFloater(target.x + (Math.random() * 10 - 5), target.y - 178 - (target.airH || 0), "霸体", "#e07030");
      if (isTanjiro(target) && (target.barrierT || 0) > 0 && !target.barrierUsed) {
        var atkH = opts.attacker || other(target);
        triggerTanjiroCounter(target, atkH);
      }
      if (target.hp <= 0) onFighterKilled(target);
      return true;
    }
    var stunDur = 0.08 + amount * 0.035;
    if (stunDur > 0.85) stunDur = 0.85;
    target.stun = Math.max(target.stun || 0, stunDur);
    target.busy = 0;
    target.dashT = 0;
    target.anim = "idle";
    target.hitPending = false;
    target.hitPending2 = false;
    target.teleBlinked = false;
    if (!opts.noLaunch) {
      spawnFloater(target.x + (Math.random() * 10 - 5), target.y - 178 - (target.airH || 0), "僵直", "#ffe7a0");
    }
    // Hit flash / sparkle removed; damage numbers kept via floaters.
    var i;
    if (!opts.noLaunch) {
      var atk = other(target);
      var dx = target.x - atk.x;
      var dy = target.y - atk.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = dx / len;
      var ny = dy / len;
      var hitDir = nx >= 0 ? 1 : -1;
      target.hitLeanDir = hitDir;
      if (amount >= LAUNCH_DMG) {
        // Heavy: launch arc. Higher damage → faster and farther.
        var hSpd = 140 + amount * 22;
        target.launchVx = nx * hSpd;
        target.launchVy = ny * hSpd * 0.55;
        target.airV = 260 + amount * 20;
        target.airH = Math.max(target.airH || 0, 16);
        target.airborne = true;
        target.invuln = Math.max(target.invuln || 0, 8);
        target.hitLean = 0;
        target.hitLight = false;
        target.hitPushVx = 0;
        target.hitPushVy = 0;
        target.downT = 0;
        target.getUpT = 0;
        target.knockPhase = "air";
        target.knockT = 0;
        spawnFloater(target.x, target.y - 200, "击飞", "#ffd0a0");
      } else {
        // Light: grounded lean-back stagger, small slide, no vertical launch.
        var leanAdd = (10 + amount * 0.65) * Math.PI / 180;
        var leanCap = 18 * Math.PI / 180;
        target.hitLean = Math.min(leanCap, Math.max(target.hitLean || 0, leanAdd) + leanAdd * 0.35);
        // pages21: knockback tiers. Slide distance ≈ v0 / 9 px.
        // light ≈ 25px · mid (≥6 dmg) ≈ 60px · heavy (Pain K 重脚 / opts.heavy) ≈ 125px.
        var atkT = opts.attacker || atk;
        var tierV = 225;
        if (opts.heavy || (atkT && atkT.anim === "kick")) tierV = 1125;
        else if (amount >= 6) tierV = 540;
        target.hitPushVx = hitDir * tierV;
        target.hitTier = tierV;
        target.hitPushVy = (Math.random() * 2 - 1) * 8;
        target.hitShake = 0.16;
        target.hitLight = true;
        target.airborne = false;
        target.airH = 0;
        target.airV = 0;
        target.launchVx = 0;
        target.launchVy = 0;
      }
    }
    if (target.hp <= 0) onFighterKilled(target);
    return true;
  }

  function landFighter(f) {
    var impactVy = Math.abs(f.airV || 0);
    f.airH = 0;
    f.airV = 0;
    f.launchVx = 0;
    f.launchVy = 0;
    f.airborne = false;
    f.invuln = 0;
    var impactDmg = Math.round(IMPACT_K * impactVy);
    if (impactDmg < 2) impactDmg = 2;
    if (impactDmg > 15) impactDmg = 15;
    shake = Math.min(16, shake + 3 + impactDmg * 0.2);
    bursts.push({
      x: f.x,
      y: f.y - 20,
      life: 0.36,
      max: 0.36,
      kind: "impact",
      facing: 1,
      scale: 1.6 + impactDmg * 0.06
    });
    rings.push({ x: f.x, y: f.y, life: 0.35, max: 0.35, color: "#e8dcc0" });
    f.knockPhase = "down";
    f.knockT = 0;
    hurt(f, impactDmg, "#ffe7a0", { noLaunch: true, fromImpact: true });
    spawnFloater(f.x, f.y - 160, "落地 " + impactDmg, "#ffc878");
    // Knockdown: shorter hard-flat, smoother get-up. Invulnerable through both.
    f.downT = 0.40;
    f.downMax = 0.40;
    f.getUpT = 0;
    f.getUpMax = 0;
    f.hitLean = Math.PI * 0.40;
    f.hitLight = false;
    f.hitPushVx = 0;
    f.hitPushVy = 0;
    f.stun = Math.max(f.stun || 0, 0.40 + 0.52);
    f.invuln = Math.max(f.invuln || 0, 0.40 + 0.52);
    f.knockNoBlink = Math.max(f.knockNoBlink || 0, 0.40 + 0.52);
    f.gait = "idle";
    f.anim = "idle";
  }

  function syncFlowHint() {
    if (!flowHint) return;
    if (matchState === "intro") {
      flowHint.style.display = "block";
      flowHint.textContent = "点击 / 按任意键继续";
    } else {
      flowHint.style.display = "none";
    }
  }

  function goIntro() {
    matchState = "intro"; screenChangeAt = performance.now();
    paused = false;
    syncFlowHint();
  }

  function goMode() {
    matchState = "mode"; screenChangeAt = performance.now();
    paused = false;
    syncFlowHint();
  }

  function goCharSelect() {
    matchState = "charSelect"; screenChangeAt = performance.now();
    paused = false;
    if (gameMode === "vs" || gameMode === "coop") {
      selectedL = null;
      selectedR = null;
      selectedScrollL = null;
      selectedScrollR = null;
      vsAssignSide = "L";
    } else {
      selectedChar = selectedChar || "obito";
      selectedScroll = selectedScroll || null;
    }
    syncFlowHint();
  }

  function applyPlayerPick(charId) {
    selectedChar = charId;
    if (charId === "pain") playerSide = "R";
    else playerSide = "L";
  }

  function vsCanConfirm() {
    return !!(selectedL && selectedR && selectedL !== selectedR);
  }

  function pickVsCard(charId) {
    var c = null;
    var i;
    for (i = 0; i < charRoster.length; i++) {
      if (charRoster[i].id === charId) c = charRoster[i];
    }
    if (!c || !c.unlocked) return;
    // One-click fill: empty LEFT first, then empty RIGHT. Distinct only.
    // If both filled, replace the focused side (click a box to focus). Optional slot-tap still works.
    if (!selectedL) {
      if (selectedR === charId) return;
      selectedL = charId;
      vsAssignSide = selectedR ? "L" : "R";
      return;
    }
    if (!selectedR) {
      if (selectedL === charId) return;
      selectedR = charId;
      vsAssignSide = "L";
      return;
    }
    if (vsAssignSide === "L") {
      if (selectedR === charId) return;
      selectedL = charId;
    } else {
      if (selectedL === charId) return;
      selectedR = charId;
    }
  }

  function beginMatch() {
    roundIndex = 1;
    roundWinsL = 0;
    roundWinsR = 0;
    matchWinner = null;
    matchResult = null;
    if (gameMode === "coop") {
      playerSide = "L";
      coopAiKits = [pickRandomKit(), pickRandomKit()];
      var scrollP1 = selectedScrollL || SCROLL_DEFS[0].id;
      var scrollP2 = selectedScrollR || SCROLL_DEFS[1].id;
      applyCoopMatchKits(
        selectedL || "obito",
        selectedR || "pain",
        coopAiKits[0],
        coopAiKits[1],
        scrollP1,
        scrollP2,
        pickAiScroll(scrollP1),
        pickAiScroll(scrollP2)
      );
    } else if (gameMode === "vs") {
      playerSide = "L"; // both human; sticks stay L/R
      applyMatchKits(
        selectedL || "obito",
        selectedR || "pain",
        selectedScrollL || SCROLL_DEFS[0].id,
        selectedScrollR || SCROLL_DEFS[1].id
      );
    } else {
      // Solo / practice: player picks one unlocked kit; AI gets another unlocked kit.
      var humanKit = selectedChar || "obito";
      var unlocked = unlockedKitIds();
      var aiPool = [];
      var ui;
      for (ui = 0; ui < unlocked.length; ui++) if (unlocked[ui] !== humanKit) aiPool.push(unlocked[ui]);
      var aiKit = aiPool.length ? aiPool[Math.floor(Math.random() * aiPool.length)] : "pain";
      // pages31f: 练习模式固定上一个对手（或面板里「换对手」选的）
      if (gameMode === "practice" && practiceAiPick && practiceAiPick !== humanKit && aiPool.indexOf(practiceAiPick) >= 0) aiKit = practiceAiPick;
      if (window.__DUEL_AIKIT__ && window.__DUEL_AIKIT__ !== humanKit) aiKit = window.__DUEL_AIKIT__;
      if (gameMode === "practice") practiceAiPick = aiKit;
      var humanScroll = selectedScroll || SCROLL_DEFS[0].id;
      var aiScroll = pickAiScroll(humanScroll);
      if (humanKit === "pain") {
        playerSide = "R";
        applyMatchKits(aiKit, humanKit, aiScroll, humanScroll);
      } else {
        playerSide = "L";
        applyMatchKits(humanKit, aiKit, humanScroll, aiScroll);
      }
    }
    startAfterLoad();
  }


  // pages31c: when a match starts, drop in-flight prefetch of unused kits so
  // concurrency slots go to this fight's sheets (fixes 24/36 stalls on ichigo).
  function abortNonMatchInflight(keepList) {
    var keep = {}, i, j, g, rec, img;
    for (i = 0; i < keepList.length; i++) {
      g = ASSET_GROUPS[keepList[i]] || [];
      for (j = 0; j < g.length; j++) keep[g[j]._rel] = true;
    }
    for (i = inflightJobs.slice(), j = 0; j < i.length; j++) {
      rec = i[j];
      img = rec.img;
      if (keep[img._rel]) continue;
      if (rec.stage !== "下载") continue;
      img._softCancel = true;
      if (img._ctrl) try { img._ctrl.abort(); } catch (e1) {}
    }
  }
  var loadKits = [];
  var loadT = 0;
  function startAfterLoad() {
    var fs = activeFighters();
    var i;
    loadKits = [];
    for (i = 0; i < fs.length; i++) if (fs[i].kit && loadKits.indexOf(fs[i].kit) < 0) loadKits.push(fs[i].kit);
    // Register atlas images for the kits in this match, then load exclusively.
    for (i = 0; i < loadKits.length; i++) registerKitSheets(loadKits[i]);
    loadMode = "match";
    matchStall = false;
    matchLoadStartedAt = performance.now();
    noteProgress();
    abortNonMatchInflight(loadKits.concat(["core"]));
    ensureGroups(loadKits.concat(["core"]), "match");
    loadT = 0;
    var pr = groupProgress(loadKits.concat(["core"]));
    if (sheetManifest && pr.done >= pr.tot && pr.err === 0) { loadMode = "idle"; beginCountdown(); return; }
    matchState = "loading";
    syncFlowHint();
  }
  function drawLoading() {
    hudHits = [];
    var pr = groupProgress(loadKits.concat(["core"]));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0c0d14";
    ctx.fillRect(0, 0, W, H);
    var bw = Math.min(420, W * 0.6), bx = (W - bw) / 2, by = H / 2;
    ctx.fillStyle = "#fff";
    ctx.font = "bold 22px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("加载角色素材…", W / 2, by - 24);
    ctx.fillStyle = "#333";
    ctx.fillRect(bx, by, bw, 14);
    ctx.fillStyle = "#f0a030";
    ctx.fillRect(bx, by, bw * (pr.tot ? pr.done / pr.tot : 1), 14);
    ctx.fillStyle = "#ccc";
    ctx.font = "14px sans-serif";
    ctx.fillText(pr.done + " / " + pr.tot, W / 2, by + 36);
    var sl = loadStatusLines(), si;
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "rgba(190,200,215,0.75)";
    for (si = 0; si < sl.length; si++) ctx.fillText(sl[si], W / 2, by + 140 + si * 18);
    var stalled = matchStall;
    if (stalled) matchStall = true;
    if (pr.err || matchStall) {
      ctx.fillStyle = "#ff6060";
      if (pr.err) ctx.fillText("有 " + pr.err + " 张失败：" + String(assetErrors[0] || "").split("?")[0], W / 2, by + 60);
      else ctx.fillText("加载卡住超过 30 秒，请重试（已加载 " + pr.done + "/" + pr.tot + "）", W / 2, by + 60);
      flowButton(W / 2 - 170, by + 80, 160, 40, "重试", true, function () {
        matchStall = false;
        retryFailed(loadKits.concat(["core"]));
      });
      flowButton(W / 2 + 10, by + 80, 160, 40, "返回菜单", false, function () { loadMode = "idle"; goMode(); });
    } else {
      ctx.fillStyle = "rgba(200,210,220,0.6)";
      ctx.fillText("素材加载齐全后自动开始 · 仅加载本局角色", W / 2, by + 60);
    }
  }

  function fightClockReset(limit) {
    fightClock.limit = limit || 60;
    fightClock.accum = 0;
    fightClock.stamp = 0;
  }
  // pages25: the round clock only advances while the fight is actually on screen. Each frame
  // adds real elapsed ms, capped at 250ms, so a hidden/background tab or a long hitch can no
  // longer make the clock jump (that is how 60→37 showed up in ~11s of watched time).
  function fightClockTick() {
    if (!fightClock.stamp) return;
    var now = performance.now();
    var d = now - fightClock.stamp;
    if (d > 0) fightClock.accum += Math.min(d, 250);
    fightClock.stamp = now;
  }
  function fightClockPause() {
    if (fightClock.stamp) {
      fightClockTick();
      fightClock.stamp = 0;
    }
  }
  function fightClockResume() {
    if (!fightClock.stamp) fightClock.stamp = performance.now();
  }
  function fightClockElapsed() {
    var t = fightClock.accum;
    if (fightClock.stamp) t += Math.min(250, Math.max(0, performance.now() - fightClock.stamp));
    return t / 1000;
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) fightClockPause();
    else if (matchState === "fight" && !paused) fightClockResume();
  });
  function beginCountdown() {
    reset();
    matchState = "countdown";
    countdownPhase = "round";
    countLeft = 1.35;
    matchTime = (gameMode === "practice") ? 99999 : 60;
    matchResult = null;
    koId = null;
    paused = false;
    roundEndLeft = 0;
    syncFlowHint();
  }

  function roundBannerText() {
    if (gameMode === "practice") return "练习";
    if (roundIndex >= 3) return "最终回";
    if (roundIndex === 1) return "第一回";
    if (roundIndex === 2) return "第二回";
    return "第" + roundIndex + "回";
  }

  function skillNoCd(f, id) {
    if (gameMode !== "practice") return false;
    if (practiceNoCdAll) return true;
    return !!(practiceNoCd && practiceNoCd[id]);
  }

  function applySkillCd(f, sk, id) {
    if (!sk) return;
    if (skillNoCd(f, id)) { sk.cd = 0; return; }
    var mul = (voidSpace && isObito(f)) ? 0.65 : 1;
    if (isTanjiro(f) && f.fireForm && (id === "water2" || id === "water4" || id === "water1")) mul *= 1.4;
    if (isIchigo(f) && f.bankai && (id === "getsuga" || id === "flash" || id === "block" || id === "atk")) mul *= 1.25;
    if (isFushiguro(f) && id === "shadow" && (f.domainT || 0) > 0) mul *= 0.5;
    sk.cd = sk.max * mul;
  }
  function tanjiroStartup(f, base) {
    return (isTanjiro(f) && f.fireForm) ? base * 0.7 : base;
  }
  function tanjiroDmg(f, base) {
    var d = base;
    if (isTanjiro(f) && f.fireForm) d *= 2;
    return Math.round(d);
  }
  function tanjiroSet(f) {
    return f.fireForm ? tanjiro.fire : tanjiro.water;
  }

  function finishMatch(result) {
    if (matchState === "result") return;
    matchState = "result";
    matchResult = result;
    matchWinner = result;
    syncFlowHint();
  }

  function finishRound(result) {
    if (matchState !== "fight") return;
    matchResult = result;
    if (gameMode === "practice") {
      finishMatch(result === "draw" ? "draw" : result);
      return;
    }
    if (result === "L") roundWinsL += 1;
    else if (result === "R") roundWinsR += 1;
    if (roundWinsL >= 2 || roundWinsR >= 2 || roundIndex >= 3) {
      var final = "draw";
      if (roundWinsL > roundWinsR) final = "L";
      else if (roundWinsR > roundWinsL) final = "R";
      finishMatch(final);
      return;
    }
    matchState = "roundEnd";
    roundEndLeft = 2.2;
    syncFlowHint();
  }

  // Menu only needs cards + scroll icons (loaded once, kept for the session).
  function coreAssetsReady() {
    var k, im;
    for (k in cardImgs) { im = cardImgs[k]; if (!im._ok && !im._err) return false; }
    for (k in scrollImgs) { im = scrollImgs[k]; if (!im._ok && !im._err) return false; }
    if (pandaBodyImg && !pandaBodyImg._ok && !pandaBodyImg._err) return false;
    if (sharkBodyImg && !sharkBodyImg._ok && !sharkBodyImg._err) return false;
    return true;
  }
  // pages26: phone mode
  var mobileMode = (function () {
    try { localStorage.removeItem("duelDevice"); var v = localStorage.getItem("duelDeviceManual"); if (v === "mobile") return true; if (v === "pc") return false; } catch (e) {}
    var ua = navigator.userAgent || "";
    var coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    var touch = ("ontouchstart" in window) || (navigator.maxTouchPoints || 0) > 0;
    var small = Math.min(screen.width, screen.height) <= 820;
    return /Mobi|Android|iPhone|iPad|iPod/i.test(ua) || (touch && coarse && small);
  })();
  function setMobileMode(on) {
    mobileMode = !!on;
    try { localStorage.setItem("duelDeviceManual", on ? "mobile" : "pc"); } catch (e) {}
    if (mobileMode && (gameMode === "vs" || gameMode === "coop")) gameMode = "ai";
  }
  function isPortrait() { return mobileMode && window.innerHeight > window.innerWidth; }
  function drawDeviceToggle() {
    flowButton(W - 170, 16, 154, 34, mobileMode ? "手机模式 ⇄ 电脑" : "电脑模式 ⇄ 手机", false, function () { setMobileMode(!mobileMode); });
  }
  function isMenuState() {
    return matchState === "intro" || matchState === "mode" || matchState === "charSelect" || matchState === "result";
  }

  function humanControls(f) {
    if (gameMode === "vs") return true;
    if (gameMode === "coop") return f.id === "L" || f.id === "L2";
    return f.id === playerSide;
  }

  function aiFighter() {
    return playerSide === "L" ? right : left;
  }

  function humanFighter() {
    return playerSide === "L" ? left : right;
  }

  function endByTime() {
    if (isCoop()) {
      var hpL = teamHp("L");
      var hpR = teamHp("R");
      if (hpL > hpR) finishRound("L");
      else if (hpR > hpL) finishRound("R");
      else finishRound("draw");
      return;
    }
    if (left.hp > right.hp) finishRound("L");
    else if (right.hp > left.hp) finishRound("R");
    else finishRound("draw");
  }

  // pages31g: 释放技能前/技能结束后面向对手（背身技除外）
  function faceTowardFoe(f) {
    if (!f || f.hp <= 0) return;
    var foe = nearestEnemy(f);
    if (foe && foe !== f && Math.abs(foe.x - f.x) > 4) f.facing = foe.x >= f.x ? 1 : -1;
  }
  function tryCast(f, id) {
    if (!f || f.hp <= 0) return;
    if (paused || matchState !== "fight" || koId) return;
    var sk = f.skills[id];
    if (!sk) return;
    // pages25: a second 切空间 press always leaves the void at once (even mid hit-stun / in the air)
    if ((id === "space" || id === "dash") && voidSpace) {
      if (performance.now() - (f.voidEnterAt || 0) < 250) return; // key bounce guard
      castSpace(f);
      sk.cd = sk.max || 1;
      return;
    }
    if ((f.stun || 0) > 0 || isAirborne(f)) { bufferCast(f, id); return; }
    if (sk.cd > 0) return;
    if ((id === "phase" || id === "needle" || id === "infinity") && f.phase > 0) return;
    if (id === "ult2" && !(isTanjiro(f) && f.fireForm)) {
      // pages25: V is fire-form only; say so instead of silently ignoring the key
      if (humanControls(f) && f.anim !== "t_ult2" && performance.now() - (f.ult2At || 0) > 2600 && performance.now() - (f.needFireHintAt || 0) > 600) {
        f.needFireHintAt = performance.now();
        spawnFloater(f.x, f.y - 190, "需火之形态（先按" + ((f.skills.ult1 && f.skills.ult1.key) || "C") + "）", "#ffb070");
      }
      return;
    }
    if (id === "spear" && !(isLuffy(f) && f.gear2)) {
      if (humanControls(f) && performance.now() - (f.needGearHintAt || 0) > 600) {
        f.needGearHintAt = performance.now();
        spawnFloater(f.x, f.y - 190, "需二档（先按" + ((f.skills.gear2 && f.skills.gear2.key) || "C") + "）", "#ffb070");
      }
      return;
    }
    if (id === "mugetsu" && !(isIchigo(f) && f.bankai)) {
      if (humanControls(f) && performance.now() - (f.needBankaiHintAt || 0) > 600) {
        f.needBankaiHintAt = performance.now();
        spawnFloater(f.x, f.y - 190, "需天锁斩月（先按" + ((f.skills.bankai && f.skills.bankai.key) || "C") + "）", "#ffb070");
      }
      return;
    }
    if (id === "ult1" && isTanjiro(f) && f.fireForm) return;
    if (id === "gear2" && isLuffy(f) && f.gear2) return;
    if (id === "bankai" && isIchigo(f) && f.bankai) return;
    var cost = sk.cost || 0;
    if (id === "ult1" && isTanjiro(f)) cost = Math.floor((f.chakra || 0) * 0.5);
    if (id === "domain" && (isGojo(f) || isFushiguro(f))) cost = Math.floor((f.chakra || 0) * 0.5);
    if (id === "gear2" && isLuffy(f)) cost = Math.floor((f.chakra || 0) * 0.5);
    if (id === "bankai" && isIchigo(f)) cost = Math.floor((f.chakra || 0) * 0.5);
    if ((f.chakra || 0) < cost) return;
    // Using any other Obito skill during 虚化 drops out of it right away.
    if (isObito(f) && f.phase > 0 && id !== "phase") endPhase(f);
    if (isGojo(f) && f.phase > 0 && id !== "infinity") endPhase(f);
    if (id === "space" || id === "dash") {
      castSpace(f);
      f.voidEnterAt = performance.now();
      f.chakra -= cost;
      return;
    }
    if (id === "spike") {
      castShield(f, 1);
      return;
    }
    if (id === "phase" || id === "needle") {
      faceTowardFoe(f);
      castNeedle(f);
      f.chakra -= cost;
      applySkillCd(f, sk, id);
      return;
    }
    if (id === "infinity" && isGojo(f)) {
      faceTowardFoe(f);
      castGojoInfinity(f);
      f.chakra -= cost;
      applySkillCd(f, sk, id);
      return;
    }
    if (f.busy > 0 || f.dashT > 0 || (f.counterT || 0) > 0 || (f.ult2Phase || 0) > 0) { bufferCast(f, id); return; }
    f.castBuf = null;
    // pages25: any new action ends a lingering 吸引 so its pose/fx cannot look like J fired again
    if (f.pullOn || f.pullFx > 0) { f.pullOn = false; f.pullFx = 0; }
    // pages31g: 技能出手时面向对手（背身技由各自 cast 再改）
    if (id !== "tele" && id !== "back" && id !== "swap" && id !== "balloon") faceTowardFoe(f);
    f.chakra -= cost;
    applySkillCd(f, sk, id);
    if (id === "punch") beginMelee(f, "punch", 0.56, 0.24);
    else if (id === "slash") beginMelee(f, "slash", 0.28, 0.08);
    else if (id === "thrust") beginMelee(f, "combo", 0.72, 0.22, 0.48);
    else if (id === "cleave") beginMelee(f, "kick", 0.62, 0.34);
    else if (id === "breath") castBreath(f);
    else if (id === "fire") castRod(f);
    else if (id === "wave") castWave(f);
    else if (id === "tele" || id === "back") castBackstep(f);
    else if (id === "swap") castRetreat(f);
    else if (id === "pull") castPull(f);
    else if (id === "atk") {
      if (isGojo(f)) castGojoAtk(f);
      else if (isLuffy(f)) castLuffyAtk(f);
      else if (isIchigo(f)) castIchigoAtk(f);
      else if (isFushiguro(f)) castFushiAtk(f);
      else castTanjiroAtk(f);
    }
    else if (id === "water2") castTanjiroWater2(f);
    else if (id === "water4") castTanjiroWater4(f);
    else if (id === "water1") castTanjiroWater1(f);
    else if (id === "ult1") castTanjiroUlt1(f);
    else if (id === "ult2") castTanjiroUlt2(f);
    else if (id === "blue") castGojoBlue(f);
    else if (id === "red") castGojoRed(f);
    else if (id === "blink") castGojoBlink(f);
    else if (id === "domain") {
      if (isFushiguro(f)) castFushiDomain(f);
      else castGojoDomain(f);
    }
    else if (id === "gatling") castLuffyGatling(f);
    else if (id === "pistol") castLuffyPistol(f);
    else if (id === "balloon") castLuffyBalloon(f);
    else if (id === "gear2") castLuffyGear2(f);
    else if (id === "spear") castLuffySpear(f);
    else if (id === "getsuga") castIchigoGetsuga(f);
    else if (id === "flash") castIchigoFlash(f);
    else if (id === "block") castIchigoBlock(f);
    else if (id === "bankai") castIchigoBankai(f);
    else if (id === "mugetsu") castIchigoMugetsu(f);
    else if (id === "dogs") castFushiDogs(f);
    else if (id === "nue") castFushiNue(f);
    else if (id === "elephant") castFushiElephant(f);
    else if (id === "shadow") castFushiShadow(f);
    else if (isTongLingId(id)) castScroll(f, id);
  }

  // pages25: a press made while the fighter is still finishing a move is kept for 0.35s and
  // fired the moment it can be (fixes "pressed Q / P right after another skill, nothing happened").
  function bufferCast(f, id) {
    if (!humanControls(f)) return;
    f.castBuf = { id: id, until: performance.now() + 350 };
  }
  function pumpCastBuffer(f) {
    var b = f.castBuf;
    if (!b) return;
    if (performance.now() > b.until) { f.castBuf = null; return; }
    if (f.busy > 0 || f.dashT > 0 || (f.counterT || 0) > 0 || (f.ult2Phase || 0) > 0 || (f.stun || 0) > 0 || isAirborne(f)) return;
    f.castBuf = null;
    if (b.id === "spike") { castShield(f, 3); return; }
    tryCast(f, b.id);
  }

  function castTanjiroAtk(f) {
    var start = tanjiroStartup(f, 0.12);
    var dur = start + 0.38;
    plantCaster(f);
    beginMelee(f, "t_atk", dur, start + 0.08);
    f.meleeDmg = tanjiroDmg(f, 12);
    f.meleeRange = tanjiroBodyW * 1.35;
    // pages25: visible sword arc (the 普攻 sheet frames are close to the idle pose)
    f.atkSwing = (f.atkSwing || 0) + 1;
    var up = f.atkSwing % 2 === 0;
    spawnSlash(f.x + f.facing * tanjiroBodyW * 0.38, f.y - tanjiroBodyH * 0.5, f.facing, {
      delay: start, life: 0.26, r: tanjiroBodyW * 0.62, width: 15,
      a0: up ? 1.3 : -1.9, a1: up ? -1.4 : 1.0,
      color: f.fireForm ? "#ffb060" : "#8ee8ff", glow: f.fireForm ? "#ff6a2a" : "#3ec8ff"
    });
  }
  function castTanjiroWater2(f) {
    var start = tanjiroStartup(f, 0.15);
    plantCaster(f);
    f.anim = "t_water2";
    f.animT = 0;
    f.animDur = start + 0.45;
    f.busy = f.animDur;
    f.hitPending = false;
    f.barrierT = 1.5;
    f.barrierUsed = false;
    f.hyperArmor = Math.max(f.hyperArmor || 0, 1.5 + 0.55);
    spawnFloater(f.x, f.y - 170, "水柱", f.palette.glow);
    rings.push({ x: f.x, y: f.y - 40, life: 0.45, max: 0.45, color: "#5ee0d0", r0: 20, r1: tanjiroBodyW * 0.9 });
  }
  function castTanjiroWater4(f) {
    var start = tanjiroStartup(f, 0.10);
    plantCaster(f);
    f.anim = "t_water4";
    f.animT = 0;
    f.animDur = start + 0.42;
    f.busy = f.animDur;
    f.hitPending = false;
    f.hyperArmor = Math.max(f.hyperArmor || 0, 0.3);
    var moveT = 0.22;
    f.dashT = start + moveT;
    f.dashVx = f.facing * (tanjiroBodyW * 2.5) / moveT;
    f.dashVy = 0;
    f.dashHit = false;
    f.dashDmg = tanjiroDmg(f, 18);
    f.dashDelay = start;
  }
  function castTanjiroWater1(f) {
    var start = tanjiroStartup(f, 0.18);
    plantCaster(f);
    f.anim = "t_water1";
    f.animT = 0;
    f.animDur = start + 0.42;
    f.busy = f.animDur;
    f.hitPending = true;
    f.hitAt = start + 0.06;
    f.meleeDmg = tanjiroDmg(f, 20);
    f.meleeRange = tanjiroBodyW * 1.5;
    f.water1Blink = false;
    f.water1At = start;
  }
  function castTanjiroUlt1(f) {
    plantCaster(f);
    f.anim = "t_ult1";
    f.animT = 0;
    f.animDur = 0.4 + 0.35;
    f.busy = f.animDur;
    f.hitPending = false;
    f.pendingFireForm = true;
    spawnFloater(f.x, f.y - 180, "火之形态", "#ff6a3a");
    rings.push({ x: f.x, y: f.y - 50, life: 0.6, max: 0.6, color: "#ff6a3a", r0: 24, r1: 200 });
  }
  function enterFireForm(f) {
    f.fireForm = true;
    f.pendingFireForm = false;
    f.moveSpeed = (f.baseMoveSpeed || 480) * 1.25;
    spawnFloater(f.x, f.y - 160, "燃烧", "#ff8a40");
  }
  function exitFireForm(f) {
    if (!f.fireForm) return;
    f.fireForm = false;
    f.moveSpeed = f.baseMoveSpeed || 480;
    spawnFloater(f.x, f.y - 160, "熄灭", "#88c0c8");
  }
  function castTanjiroUlt2(f) {
    f.ult2At = performance.now(); // pages26: no 需火之形态 hint during/just after the V multi-hit
    if (f.castBuf && f.castBuf.id === "ult2") f.castBuf = null;
    plantCaster(f);
    f.anim = "t_ult2";
    f.animT = 0;
    f.animDur = 0.2 + 1.5 + 0.35;
    f.busy = f.animDur;
    f.hitPending = false;
    f.ult2Phase = 1;
    f.ult2T = 0;
    f.ult2Hits = 0;
    f.hyperArmor = Math.max(f.hyperArmor || 0, f.animDur);
    f.chakra = 0;
    f.invuln = Math.max(f.invuln || 0, 0.25);
    spawnFloater(f.x, f.y - 180, "瞬斩", "#ffd0a0");
  }
  function triggerTanjiroCounter(defender, attacker) {
    if (!isTanjiro(defender) || defender.barrierUsed || !(defender.barrierT > 0)) return;
    if (!attacker || attacker.hp <= 0) return;
    defender.barrierUsed = true;
    defender.barrierT = 0;
    plantCaster(defender);
    var behind = clampSpot(attacker.x - attacker.facing * tanjiroBodyW * 0.85, attacker.y);
    defender.x = behind.x;
    defender.y = behind.y;
    defender.facing = attacker.x >= defender.x ? 1 : -1;
    defender.anim = "t_counter";
    defender.animT = 0;
    defender.animDur = 0.55;
    defender.busy = 0.55;
    defender.counterT = 0.55;
    defender.hitPending = true;
    defender.hitAt = 0.22;
    defender.meleeDmg = tanjiroDmg(defender, 18);
    defender.meleeRange = tanjiroBodyW * 1.6;
    defender.hyperArmor = Math.max(defender.hyperArmor || 0, 0.55);
    spawnFloater(defender.x, defender.y - 170, "反击", defender.palette.glow);
    spawnSlash(defender.x + defender.facing * tanjiroBodyW * 0.4, defender.y - tanjiroBodyH * 0.5, defender.facing, {
      delay: 0.16, life: 0.32, r: tanjiroBodyW * 0.75, width: 19, a0: -2.2, a1: 1.2,
      color: defender.fireForm ? "#ffb060" : "#9af0ff", glow: defender.fireForm ? "#ff5a20" : "#30d0ff"
    });
  }
  // pages25: 二型 stance that was never struck still ends with the 反击斩 swing (forward),
  // so the counter animation is visible even against a passive dummy.
  function tanjiroStanceFinisher(f) {
    if (f.hp <= 0 || isAirborne(f) || (f.stun || 0) > 0 || (f.ult2Phase || 0) > 0) return;
    plantCaster(f);
    var foeS = other(f);
    if (foeS && foeS.hp > 0) f.facing = foeS.x >= f.x ? 1 : -1;
    f.anim = "t_counter";
    f.animT = 0;
    f.animDur = 0.5;
    f.busy = 0.5;
    f.hitPending = true;
    f.hitAt = 0.2;
    f.meleeDmg = tanjiroDmg(f, 12);
    f.meleeRange = tanjiroBodyW * 1.5;
    spawnSlash(f.x + f.facing * tanjiroBodyW * 0.4, f.y - tanjiroBodyH * 0.5, f.facing, {
      delay: 0.14, life: 0.3, r: tanjiroBodyW * 0.72, width: 17, a0: -2.2, a1: 1.2,
      color: f.fireForm ? "#ffb060" : "#9af0ff", glow: f.fireForm ? "#ff5a20" : "#30d0ff"
    });
  }

  function castScroll(f, id) {
    var sk = f.skills[id];
    var def = scrollById(id);
    var opp = other(f);
    var color = (def && def.color) || (sk && sk.color) || "#fff";
    f.anim = "cast";
    f.animT = 0;
    f.animDur = 0.42;
    f.busy = 0.28;
    f.hitPending = false;
    spawnFloater(f.x, f.y - 170, (def && def.name) || "通灵", color);
    bursts.push({
      x: f.x + f.facing * 24,
      y: f.y - 90,
      life: 0.4,
      max: 0.4,
      kind: "flash",
      facing: f.facing || 1,
      scale: 1.6
    });
    if (id === "scroll_quake") {
      // 霸体 4s: immune to stun / knockback / launch; still movable by pull/grab.
      f.hyperArmor = Math.max(f.hyperArmor || 0, 4);
      rings.push({ x: f.x, y: f.y - 40, life: 0.55, max: 0.55, color: color, r0: 24, r1: 160 });
      rings.push({ x: f.x, y: f.y - 40, life: 0.75, max: 0.75, color: "#ff9040", r0: 10, r1: 120 });
    } else if (id === "scroll_bolt") {
      // Instant full chakra + lock full for 10s.
      f.chakra = f.maxChakra;
      f.chakraLock = Math.max(f.chakraLock || 0, 10);
      rings.push({ x: f.x, y: f.y - 50, life: 0.5, max: 0.5, color: color, r0: 18, r1: 180 });
      var bi;
      for (bi = 0; bi < 10; bi++) {
        sparks.push({
          x: f.x + (Math.random() * 40 - 20),
          y: f.y - 60 - Math.random() * 80,
          vx: (Math.random() - 0.5) * 120,
          vy: -80 - Math.random() * 120,
          life: 0.4,
          max: 0.4,
          color: color,
          size: 5 + Math.random() * 4
        });
      }
    } else if (id === "scroll_blade") {
      // Reset kit skill CDs; this scroll stays on its own CD.
      var ck;
      for (ck in f.skills) {
        if (ck === id) continue;
        if (isTongLingId(ck)) continue;
        f.skills[ck].cd = 0;
      }
      rings.push({ x: f.x, y: f.y - 40, life: 0.45, max: 0.45, color: color, r0: 16, r1: 150 });
      bursts.push({
        x: f.x, y: f.y - 90,
        life: 0.35, max: 0.35, kind: "impact", facing: f.facing || 1, scale: 1.4
      });
    } else if (id === "scroll_gale") {
      // Radius burst: 1s stun + dispel enemy 霸体.
      var radius = 300;
      rings.push({ x: f.x, y: f.y - 40, life: 0.55, max: 0.55, color: color, r0: 28, r1: radius });
      rings.push({ x: f.x, y: f.y - 40, life: 0.4, max: 0.4, color: "#a0c0ff", r0: 10, r1: 200 });
      var dxg = opp.x - f.x;
      var dyg = opp.y - f.y;
      if (Math.sqrt(dxg * dxg + dyg * dyg) <= radius && opp.phase <= 0 && opp.invuln <= 0 && opp.shield <= 0 && !isDowned(opp)) {
        if ((opp.hyperArmor || 0) > 0) {
          opp.hyperArmor = 0;
          spawnFloater(opp.x, opp.y - 200, "驱散霸体", "#a0c8ff");
        }
        opp.stun = Math.max(opp.stun || 0, 1);
        opp.busy = 0;
        opp.dashT = 0;
        opp.hitPending = false;
        opp.hitPending2 = false;
        opp.hitLight = true;
        opp.hitLean = Math.max(opp.hitLean || 0, 12 * Math.PI / 180);
        opp.hitLeanDir = opp.x >= f.x ? 1 : -1;
        opp.airborne = false;
        opp.airH = 0;
        opp.airV = 0;
        opp.launchVx = 0;
        opp.launchVy = 0;
        spawnFloater(opp.x, opp.y - 170, "僵直", "#cfe0ff");
        bursts.push({
          x: opp.x, y: opp.y - 80,
          life: 0.35, max: 0.35, kind: "impact", facing: opp.facing || 1, scale: 1.5
        });
      }
    } else if (id === "summon_panda") {
      // pages30l: 熊猫下落砸击换用户抠图；施放者获 4s 霸体（pages30k）
      var landX = f.x + f.facing * 130;
      var landY = f.y - 40;
      if (opp && opp.hp > 0) {
        landX = opp.x;
        landY = opp.y - 40;
      }
      f.hyperArmor = Math.max(f.hyperArmor || 0, 4);
      spawnFloater(f.x, f.y - 190, "通灵·熊猫", color);
      spawnFloater(f.x, f.y - 210, "霸体 4s", "#e07030");
      projectiles.push({
        kind: "panda_drop",
        x: landX,
        y: -60,
        vx: 0,
        vy: 980,
        landY: landY,
        r: 78,
        dmg: (def && def.dmg) || 28,
        owner: f.id,
        life: 2.8,
        age: 0,
        hit: false,
        landed: false,
        scale: 1
      });
    } else if (id === "summon_shark") {
      // pages30j: 鲛鲨从上垂直落下（同熊猫）
      var landXs = f.x + f.facing * 130;
      var landYs = f.y - 40;
      if (opp && opp.hp > 0) {
        landXs = opp.x;
        landYs = opp.y - 40;
      }
      spawnFloater(f.x, f.y - 190, "通灵·鲛鲨", color);
      projectiles.push({
        kind: "shark_drop",
        x: landXs,
        y: -60,
        vx: 0,
        vy: 980,
        landY: landYs,
        r: 78,
        dmg: (def && def.dmg) || 28,
        owner: f.id,
        life: 2.8,
        age: 0,
        hit: false,
        landed: false,
        scale: 1
      });
    }
  }

  // pages30m: 五条悟技能桩（无专属技能帧前用 idle + 现有效果）
  function castGojoAtk(f) {
    f.anim = "g_atk";
    f.animT = 0;
    f.animDur = 0.4;
    f.busy = 0.36;
    f.hitPending = true;
    f.hitAt = 0.12;
    f.meleeDmg = boosted(f, 12);
    f.meleeRange = gojoBodyW * 1.35;
    f.meleeLaunch = false;
    rings.push({ x: f.x + f.facing * gojoBodyW * 0.45, y: f.y - gojoBodyH * 0.45, life: 0.28, max: 0.28, color: "rgba(160,200,255,0.7)", r0: 10, r1: gojoBodyW * 0.7 });
  }
  function castGojoBlue(f) {
    f.anim = "g_blue";
    f.animT = 0;
    f.animDur = 0.8;
    f.busy = 0.8;
    f.armor = Math.max(f.armor || 0, 0.2);
    f.hitPending = false;
    var bx = f.x + f.facing * gojoBodyW * 1.5;
    var by = f.y - gojoBodyH * 0.45;
    rings.push({ x: bx, y: by, life: 0.7, max: 0.7, color: "#4080ff", r0: 24, r1: 180 });
    var foes = activeFighters(), i;
    for (i = 0; i < foes.length; i++) {
      var t = foes[i];
      if (!t || t === f || t.hp <= 0 || t.team === f.team) continue;
      var dx = t.x - bx, dy = (t.y - gojoBodyH * 0.4) - by;
      if (dx * dx + dy * dy < 180 * 180) {
        t.x += (bx - t.x) * 0.55;
        hurt(t, boosted(f, 10), "#4080ff", { noLaunch: true });
      }
    }
  }
  function castGojoRed(f) {
    var dir = f.facing < 0 ? -1 : 1;
    f.anim = "g_red";
    f.animT = 0;
    f.animDur = 0.45;
    f.busy = 0.4;
    f.hitPending = false;
    projectiles.push({
      kind: "wave",
      x: f.x + dir * 42,
      y: f.y - gojoBodyH * 0.5,
      vx: dir * 640,
      vy: 0,
      r: 22,
      dmg: boosted(f, 18),
      owner: f.id,
      life: 0.9,
      color: "#ff4060"
    });
    rings.push({ x: f.x + dir * 50, y: f.y - gojoBodyH * 0.5, life: 0.3, max: 0.3, color: "#ff4060", r0: 8, r1: 48 });
  }
  function castGojoBlink(f) {
    f.anim = "g_blink";
    f.animT = 0;
    f.animDur = 0.28;
    f.busy = 0.28;
    f.hitPending = false;
    ghosts.push({
      x: f.x, y: f.y, facing: f.facing, life: 0.28, max: 0.28,
      palette: f.palette, weapon: f.weapon, owner: f.id, kit: f.kit
    });
    f.invuln = Math.max(f.invuln || 0, 0.15);
    var spot = clampSpot(f.x + f.facing * 220, f.y);
    spot.x = clamp(spot.x, 175, W - 175);
    f.x = spot.x;
    f.y = spot.y;
  }
  function castGojoInfinity(f) {
    // pages30r: 施放条 skill_infinity×6，随后 phase 期间播 infinity_loop
    f.anim = "g_inf";
    f.animT = 0;
    f.animDur = 0.4;
    f.busy = 0.36;
    f.hitPending = false;
    f.phase = 2.5;
    f.phaseEye = 0;
    phaseSlow = 0.35;
    spawnFloater(f.x, f.y - 170, "无下限", "#a0c8ff");
  }
  function castGojoDomain(f) {
    f.anim = "g_domain";
    f.animT = 0;
    f.animDur = 0.5;
    f.busy = 0.5;
    f.armor = Math.max(f.armor || 0, 0.4);
    f.hitPending = false;
    f.domainT = 4;
    f.chakraLock = Math.max(f.chakraLock || 0, 4);
    spawnFloater(f.x, f.y - 190, "领域展开", "#c080ff");
    rings.push({ x: f.x, y: f.y - 40, life: 0.8, max: 0.8, color: "rgba(160,80,255,0.7)", r0: 40, r1: 350 });
  }

  // pages30v: 路飞技能 — atk/gatling/pistol/balloon + gear2/spear 专属帧
  function castLuffyAtk(f) {
    f.anim = "l_atk";
    f.animT = 0;
    f.animDur = 0.4;
    f.busy = 0.36;
    f.hitPending = true;
    f.hitAt = 0.12;
    f.meleeDmg = boosted(f, f.gear2 ? 18 : 12);
    f.meleeRange = luffyBodyW * 1.4;
    f.meleeLaunch = false;
    rings.push({ x: f.x + f.facing * luffyBodyW * 0.5, y: f.y - luffyBodyH * 0.45, life: 0.28, max: 0.28, color: "rgba(255,120,80,0.7)", r0: 10, r1: luffyBodyW * 0.75 });
  }
  function castLuffyGatling(f) {
    f.anim = "l_gatling";
    f.animT = 0;
    f.animDur = 0.9;
    f.busy = 0.9;
    f.hyperArmor = Math.max(f.hyperArmor || 0, 0.9);
    f.hitPending = true;
    f.hitAt = 0.2;
    f.hitPending2 = true;
    f.hitAt2 = 0.55;
    f.meleeDmg = boosted(f, f.gear2 ? 14 : 9);
    f.meleeRange = luffyBodyW * 1.5;
    f.meleeLaunch = false;
    rings.push({ x: f.x + f.facing * luffyBodyW * 0.55, y: f.y - luffyBodyH * 0.42, life: 0.85, max: 0.85, color: "rgba(255,160,60,0.55)", r0: 16, r1: luffyBodyW * 1.1 });
  }
  function castLuffyPistol(f) {
    f.anim = "l_pistol";
    f.animT = 0;
    f.animDur = 0.35;
    f.busy = 0.35;
    f.armor = Math.max(f.armor || 0, 0.25);
    f.hitPending = true;
    f.hitAt = 0.18;
    f.meleeDmg = boosted(f, f.gear2 ? 20 : 14);
    f.meleeRange = luffyBodyW * 1.6;
    f.meleeLaunch = false;
    ghosts.push({
      x: f.x, y: f.y, facing: f.facing, life: 0.25, max: 0.25,
      palette: f.palette, weapon: f.weapon, owner: f.id, kit: f.kit
    });
    var spot = clampSpot(f.x + f.facing * 200, f.y);
    spot.x = clamp(spot.x, 175, W - 175);
    f.x = spot.x;
    f.y = spot.y;
  }
  function castLuffyBalloon(f) {
    f.anim = "l_balloon";
    f.animT = 0;
    f.animDur = 1.2;
    f.busy = 1.2;
    f.hitPending = false;
    f.armor = Math.max(f.armor || 0, 1.2);
    f.balloonT = 1.2;
    spawnFloater(f.x, f.y - 170, "气球", "#ffd070");
    rings.push({ x: f.x, y: f.y - luffyBodyH * 0.4, life: 1.1, max: 1.1, color: "rgba(255,200,120,0.45)", r0: 20, r1: luffyBodyW * 1.4 });
  }
  function castLuffyGear2(f) {
    f.anim = "l_gear2";
    f.animT = 0;
    f.animDur = 0.4;
    f.busy = 0.4;
    f.armor = Math.max(f.armor || 0, 0.3);
    f.hitPending = false;
    f.gear2 = true;
    // pages30x: 减半只由 tryCast 的 cost=floor(chakra*0.5) 做一次；此处不再二次减半
    f.moveSpeed = (f.baseMoveSpeed || 500) * 1.25;
    spawnFloater(f.x, f.y - 190, "二档", "#ff6040");
  }
  function exitLuffyGear2(f) {
    if (!f.gear2) return;
    f.gear2 = false;
    f.chakraLock = 0;
    f.moveSpeed = f.baseMoveSpeed || 500;
    spawnFloater(f.x, f.y - 160, "二档结束", "#c08070");
  }
  function castLuffySpear(f) {
    f.anim = "l_spear";
    f.animT = 0;
    f.animDur = 0.7;
    f.busy = 0.7;
    f.hyperArmor = Math.max(f.hyperArmor || 0, 0.7);
    f.hitPending = true;
    f.hitAt = 0.35;
    f.meleeDmg = boosted(f, 36);
    f.meleeRange = 400;
    f.meleeLaunch = true;
    f.chakra = 0;
    exitLuffyGear2(f);
    spawnFloater(f.x, f.y - 190, "金刚枪", "#ffe7a0");
    rings.push({ x: f.x + f.facing * 120, y: f.y - luffyBodyH * 0.45, life: 0.5, max: 0.5, color: "rgba(255,220,120,0.7)", r0: 12, r1: 90 });
  }

  // pages31b: 一护技能全套帧；查克拉同二档：tryCast 减半一次、−8/s、无 chakraLock=999
  function castIchigoAtk(f) {
    f.anim = "i_atk";
    f.animT = 0;
    f.animDur = 0.4;
    f.busy = 0.36;
    f.hitPending = true;
    f.hitAt = 0.12;
    f.meleeDmg = boosted(f, f.bankai ? 20 : 13);
    f.meleeRange = ichigoBodyW * 1.35;
    f.meleeLaunch = false;
    rings.push({ x: f.x + f.facing * ichigoBodyW * 0.5, y: f.y - ichigoBodyH * 0.45, life: 0.28, max: 0.28, color: "rgba(255,140,60,0.7)", r0: 10, r1: ichigoBodyW * 0.75 });
  }
  function castIchigoGetsuga(f) {
    var dir = f.facing < 0 ? -1 : 1;
    var dmgMul = f.bankai ? 1.6 : 1;
    var pr = f.bankai ? 30 : 22;
    f.anim = "i_getsuga";
    f.animT = 0;
    f.animDur = 0.45;
    f.busy = 0.4;
    f.hitPending = false;
    projectiles.push({
      kind: "wave",
      x: f.x + dir * 48,
      y: f.y - ichigoBodyH * 0.5,
      vx: dir * 620,
      vy: 0,
      r: pr,
      dmg: boosted(f, Math.round(18 * dmgMul)),
      owner: f.id,
      life: 0.95,
      color: "#ff7a30"
    });
    rings.push({ x: f.x + dir * 55, y: f.y - ichigoBodyH * 0.5, life: 0.3, max: 0.3, color: "#ff7a30", r0: 8, r1: 52 });
  }
  function castIchigoFlash(f) {
    f.anim = "i_flash";
    f.animT = 0;
    f.animDur = 0.28;
    f.busy = 0.28;
    f.hitPending = false;
    ghosts.push({
      x: f.x, y: f.y, facing: f.facing, life: 0.28, max: 0.28,
      palette: f.palette, weapon: f.weapon, owner: f.id, kit: f.kit
    });
    f.invuln = Math.max(f.invuln || 0, 0.12);
    var spot = clampSpot(f.x + f.facing * 220, f.y);
    spot.x = clamp(spot.x, 175, W - 175);
    f.x = spot.x;
    f.y = spot.y;
  }
  function castIchigoBlock(f) {
    f.anim = "i_block";
    f.animT = 0;
    f.animDur = 1.0;
    f.busy = 1.0;
    f.hitPending = false;
    f.armor = Math.max(f.armor || 0, 1.0);
    f.blockT = 1.0;
    spawnFloater(f.x, f.y - 170, "挡刀", "#e8a040");
    rings.push({ x: f.x + f.facing * 30, y: f.y - ichigoBodyH * 0.4, life: 0.9, max: 0.9, color: "rgba(232,160,64,0.45)", r0: 16, r1: ichigoBodyW * 0.9 });
  }
  function castIchigoBankai(f) {
    f.anim = "i_bankai";
    f.animT = 0;
    f.animDur = 0.4;
    f.busy = 0.4;
    f.armor = Math.max(f.armor || 0, 0.35);
    f.hitPending = false;
    f.bankai = true;
    // 减半只由 tryCast cost=floor(chakra*0.5) 做一次；此处不再二次减半
    f.moveSpeed = (f.baseMoveSpeed || 510) * 1.2;
    spawnFloater(f.x, f.y - 190, "天锁斩月", "#ff5030");
  }
  function exitIchigoBankai(f) {
    if (!f.bankai) return;
    f.bankai = false;
    f.chakraLock = 0;
    f.moveSpeed = f.baseMoveSpeed || 510;
    spawnFloater(f.x, f.y - 160, "天锁结束", "#c08070");
  }
  function castIchigoMugetsu(f) {
    f.anim = "i_mugetsu";
    f.animT = 0;
    f.animDur = 1.7;
    f.busy = 1.7;
    f.hyperArmor = Math.max(f.hyperArmor || 0, 1.7);
    f.hitPending = true;
    f.hitAt = 1.2;
    f.meleeDmg = boosted(f, 42);
    f.meleeRange = 520;
    f.meleeLaunch = true;
    f.chakra = 0;
    exitIchigoBankai(f);
    spawnFloater(f.x, f.y - 190, "无月", "#202028");
    rings.push({ x: f.x, y: f.y - ichigoBodyH * 0.4, life: 0.8, max: 0.8, color: "rgba(20,20,28,0.75)", r0: 30, r1: 420 });
  }

  // pages31f: 伏黑技能（对照 04_伏黑惠.md）。判定统一在 resolveFushi（hitAt 到点触发）
  function castFushiAtk(f) {
    f.anim = "f_atk";
    f.animT = 0;
    f.animDur = 0.42;
    f.busy = 0.38;
    f.hitPending = true;
    f.hitAt = 0.1;
  }
  function castFushiDogs(f) {
    f.anim = "f_dogs";
    f.animT = 0;
    f.animDur = 0.9;
    f.busy = 0.9;
    f.hyperArmor = Math.max(f.hyperArmor || 0, 0.2);
    f.hitPending = true;
    f.hitAt = 0.2;
    f.fushiDogsT = 0;
    f.fushiDogsHit = {};
  }
  function castFushiNue(f) {
    f.anim = "f_nue";
    f.animT = 0;
    f.animDur = 0.6;
    f.busy = 0.5;
    f.hitPending = true;
    f.hitAt = 0.25;
  }
  function castFushiElephant(f) {
    f.anim = "f_elephant";
    f.animT = 0;
    f.animDur = 1.3;
    f.busy = 1.3;
    f.hyperArmor = Math.max(f.hyperArmor || 0, 0.3);
    f.hitPending = true;
    f.hitAt = 0.3;
    f.fushiWaterT = 0;
    f.fushiWaterHit = {};
  }
  function castFushiShadow(f) {
    f.anim = "f_shadow";
    f.animT = 0;
    f.animDur = 0.42;
    f.busy = 0.36;
    f.hitPending = true;
    f.hitAt = 0.08;
    f.fushiShadowMoved = false;
  }
  function fushiInBox(f, t, x0, x1, halfDepth) {
    var dir = f.facing < 0 ? -1 : 1;
    var rel = (t.x - f.x) * dir;
    return rel >= x0 && rel <= x1 && Math.abs(t.y - f.y) <= halfDepth;
  }
  function resolveFushi(f) {
    var foes = livingEnemies(f), i, t;
    var dir = f.facing < 0 ? -1 : 1;
    if (f.anim === "f_atk") {
      // 影刺：身前 ≈110px，单段，不耗蓝
      for (i = 0; i < foes.length; i++) {
        t = foes[i];
        if (fushiInBox(f, t, -10, 110, 60)) hurt(t, boosted(f, 9), f.palette.glow, { attacker: f });
      }
    } else if (f.anim === "f_dogs") {
      // 玉犬：前摇 0.2s 后犬冲 0.7s，路径 ≈280px，咬中盒 ≈90px（每目标一次）
      f.fushiDogsT = 0.7;
    } else if (f.anim === "f_nue") {
      // 鵺：前摇 0.25s 吐电球，最远 ≈480px
      projectiles.push({
        kind: "wave",
        x: f.x + dir * 50,
        y: f.y - fushiBodyH * 0.55,
        vx: dir * 560,
        vy: 0,
        r: 20,
        dmg: boosted(f, 16),
        owner: f.id,
        life: 430 / 560,
        color: "#9ad0ff"
      });
      rings.push({ x: f.x + dir * 55, y: f.y - fushiBodyH * 0.55, life: 0.3, max: 0.3, color: "#9ad0ff", r0: 8, r1: 46 });
    } else if (f.anim === "f_elephant") {
      // 满象：起手 0.3s 后喷水 1.0s，水柱 ≈320×80px；命中击退 + 移速×0.5 持续 1.5s
      f.fushiWaterT = 1.0;
    } else if (f.anim === "f_shadow") {
      // 影换：0.08s 没入，0.2s 无敌，面朝方向位移 ≈160px
      f.invuln = Math.max(f.invuln || 0, 0.2);
      f.fushiShadowAt = 0.2;
    }
  }
  function updateFushiSkills(f, dt) {
    var foes, i, t, dir = f.facing < 0 ? -1 : 1;
    if ((f.fushiDogsT || 0) > 0) {
      f.fushiDogsT = Math.max(0, f.fushiDogsT - dt);
      var reach = 280 * (1 - f.fushiDogsT / 0.7);
      foes = livingEnemies(f);
      for (i = 0; i < foes.length; i++) {
        t = foes[i];
        if (f.fushiDogsHit[t.id]) continue;
        if (fushiInBox(f, t, 0, Math.max(90, reach + 45), 45)) {
          if (hurt(t, boosted(f, fushiDomainMul(f, t, 14)), f.palette.glow, { attacker: f })) f.fushiDogsHit[t.id] = true;
        }
      }
      if (f.anim !== "f_dogs") f.fushiDogsT = 0;
    }
    if ((f.fushiWaterT || 0) > 0) {
      f.fushiWaterT = Math.max(0, f.fushiWaterT - dt);
      foes = livingEnemies(f);
      for (i = 0; i < foes.length; i++) {
        t = foes[i];
        if (f.fushiWaterHit[t.id]) continue;
        if (fushiInBox(f, t, 0, 320, 40)) {
          if (hurt(t, boosted(f, fushiDomainMul(f, t, 10)), "#9ad0ff", { attacker: f, heavy: true })) {
            f.fushiWaterHit[t.id] = true;
            t.fushiSlowT = 1.5;
            spawnFloater(t.x, t.y - 196, "减速", "#9ad0ff");
          }
        }
      }
      if (f.anim !== "f_elephant") f.fushiWaterT = 0;
    }
    if (f.anim === "f_shadow" && !f.fushiShadowMoved && f.fushiShadowAt != null && f.animT >= f.fushiShadowAt) {
      f.fushiShadowMoved = true;
      var spot = clampSpot(f.x + dir * 160, f.y);
      f.x = clamp(spot.x, 70, W - 70);
      f.y = spot.y;
    }
  }
  function fushiDomainMul(f, t, dmg) {
    // 嵌合庭内式神伤害 ×1.4
    if ((f.domainT || 0) > 0) {
      var dx = t.x - f.x, dy = t.y - f.y;
      if (dx * dx + dy * dy < 320 * 320) return Math.round(dmg * 1.4);
    }
    return dmg;
  }
  function castFushiDomain(f) {
    f.anim = "f_domain";
    f.animT = 0;
    f.animDur = 0.45;
    f.busy = 0.45;
    f.hyperArmor = Math.max(f.hyperArmor || 0, 0.45);
    f.hitPending = false;
    f.domainT = 5;
    f.chakraLock = Math.max(f.chakraLock || 0, 5);
    spawnFloater(f.x, f.y - 190, "嵌合暗翳庭", "#5080ff");
    rings.push({ x: f.x, y: f.y - 20, life: 0.6, max: 0.6, color: "rgba(20,20,40,0.8)", r0: 40, r1: 320 });
  }

    function beginMelee(f, anim, dur, hitAt, hitAt2) {
    f.anim = anim;
    f.animT = 0;
    f.animDur = dur;
    f.hitAt = hitAt;
    f.hitPending = true;
    f.hitAt2 = hitAt2 || 0;
    f.hitPending2 = !!hitAt2;
    f.busy = dur;
  }

  function launchAt(f, kind, speed, r, dmg, life, originOff, chest) {
    var opp = other(f);
    var x0 = f.x + f.facing * originOff;
    var y0 = f.y - chest;
    var tx = opp.x;
    var ty = opp.y - chest;
    var dx = tx - x0;
    var dy = ty - y0;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    projectiles.push({
      kind: kind,
      x: x0,
      y: y0,
      vx: dx / len * speed,
      vy: dy / len * speed,
      r: r,
      dmg: dmg,
      owner: f.id,
      life: life
    });
  }

  function endPhase(f) {
    f.phase = 0;
    f.phaseEye = 0;
    phaseSlow = 0;
  }

  function castNeedle(f) {
    f.phase = (voidSpace && isObito(f)) ? 4.5 : 3;
    f.phaseEye = 0;
    phaseSlow = 0.5;
    spawnFloater(f.x, f.y - 170, "无敌", "#d5dde4");
  }

  // pages29: firebreath art tip locked at source (36,124); mouth world offset relative to feet.
  var FIREBREATH_TIP_X = 36;
  var FIREBREATH_TIP_Y = 124;
  var FIREBREATH_MOUTH_OX = 28; // forward from body center
  var FIREBREATH_MOUTH_OY = -118; // up from feet (fixed — do not bob with frame content)
  function castBreath(f) {
    var dir = f.facing < 0 ? -1 : 1;
    f.anim = "breath";
    f.animT = 0;
    // pages30f: 32 frames at ~40fps ≈ 0.8s (playback 2x / duration half).
    f.animDur = 0.8;
    f.busy = 0.72;
    f.hitPending = false;
    projectiles.push({
      kind: "firebreath",
      x: f.x + dir * FIREBREATH_MOUTH_OX,
      y: f.y + FIREBREATH_MOUTH_OY,
      vx: 0,
      vy: 0,
      r: 20,
      dmg: boosted(f, 15),
      owner: f.id,
      facing: f.facing,
      life: 0.8,
      age: 0,
      fps: 40,
      drawScale: 1.1,
      hit: false,
      tickAcc: 0
    });
  }

  function castFire(f) {
    var dir = f.facing < 0 ? -1 : 1;
    f.anim = "cast";
    f.animT = 0;
    f.animDur = 0.28;
    f.busy = 0.26;
    f.hitPending = false;
    projectiles.push({
      kind: "fire",
      x: f.x + dir * 42,
      y: f.y - 78,
      vx: dir * 624,
      vy: 0,
      r: 18,
      dmg: 15,
      owner: f.id,
      life: 2.4,
      age: 0,
      scale: 0.28,
      seed: Math.random() * 10
    });
  }

  function castWave(f) {
    var dir = f.facing < 0 ? -1 : 1;
    f.anim = "cast";
    f.animT = 0;
    f.animDur = 0.2;
    f.busy = 0.16;
    f.hitPending = false;
    projectiles.push({
      kind: "wave",
      x: f.x + dir * 36,
      y: f.y - 72,
      vx: dir * 560,
      vy: 0,
      r: 12,
      dmg: boosted(f, 11),
      owner: f.id,
      life: 0.9
    });
  }

  function blinkStrike(f) {
    var dir = f.facing < 0 ? -1 : 1;
    ghosts.push({
      x: f.x, y: f.y, facing: f.facing, life: 0.28, max: 0.28,
      palette: f.palette, weapon: f.weapon, owner: f.id, kit: f.kit
    });
    f.invuln = (voidSpace && isObito(f)) ? 0.4 : 0.25;
    var spot = clampSpot(f.x + dir * 1050, f.y);
    // pages20: keep the blink landing inside the visible play area (clear of the on-screen sticks).
    spot.x = clamp(spot.x, 175, W - 175);
    f.x = spot.x;
    f.y = spot.y;
    var opp = other(f);
    var dx = opp.x - f.x;
    var dy = opp.y - f.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var ahead = Math.atan2(dy, dx * f.facing);
    if (Math.abs(ahead) < Math.PI * 0.72 && dist < 112) {
      hurt(opp, boosted(f, 8), f.palette.glow);
    }
  }

  function castBackstep(f) {
    f.anim = "tele";
    f.animT = 0;
    f.animDur = 0.76;
    f.busy = 0.76;
    f.hitPending = false;
    f.teleBlinked = false;
  }

  function castRod(f) {
    var dir = f.facing < 0 ? -1 : 1;
    var palm = palmOf(f);
    f.anim = "rod";
    f.animT = 0;
    f.animDur = 0.55;
    f.busy = 0.4;
    f.hitPending = false;
    projectiles.push({
      kind: "rod",
      x: palm.x,
      y: palm.y,
      sweepX: f.x, // first step sweeps from Pain's body so point-blank casts still connect
      vx: dir * 900,
      vy: 0,
      r: 5,
      dmg: 15,
      owner: f.id,
      life: 1.45
    });
  }

  function painBodyH() {
    return 168 * painScale;
  }

  function shieldRadius() {
    return painBodyH() * 0.78;
  }

  function shieldWave(angle, spin) {
    return 1
      + 0.11 * Math.sin(angle * 3 + spin)
      + 0.07 * Math.sin(angle * 5 - spin * 1.35)
      + 0.045 * Math.sin(angle * 8 + spin * 0.65);
  }

  function shieldCenter(f) {
    var r = shieldRadius();
    return { x: f.x, y: f.y - r };
  }

  function palmOf(f) {
    return { x: f.x + f.facing * 78 * painScale, y: f.y - 108 * painScale };
  }

  function shieldAxes() {
    var rad = shieldRadius();
    return { rx: rad * 0.62, ry: rad * 0.92 };
  }

  function castShield(f, dur) {
    if (paused || matchState !== "fight" || koId || (f.stun || 0) > 0 || isAirborne(f)) return false;
    var sk = f.skills.spike;
    if (!sk || sk.cd > 0 || f.shield > 0 || f.shieldWind > 0) return false;
    if (f.busy > 0 || f.dashT > 0) { bufferCast(f, "spike"); return false; }
    f.castBuf = null;
    if (f.pullOn || f.pullFx > 0) { f.pullOn = false; f.pullFx = 0; }
    if ((f.chakra || 0) < (sk.cost || 0)) return false;
    f.chakra -= sk.cost || 0;
    f.shield = 0;
    f.shieldWind = repulseWind;
    f.repulseOn = true;
    plantCaster(f);
    f.repulseT = 0;
    f.repulseLong = true;
    f.shieldPlan = repulseSpan(true) - repulseWind;
    f.shieldDur = f.shieldPlan;
    f.shieldHit = false;
    f.anim = "idle";
    f.animT = 0;
    f.animDur = 0.2;
    f.busy = repulseWind;
    f.hitPending = false;
    return true;
  }

  function shieldPressDown(f) {
    f.shieldKeyAt = performance.now();
    if (castShield(f, 3)) f.shieldKey = true;
  }

  function shieldPressUp(f) {
    if (!f.shieldKey) return;
    f.shieldKey = false;
    // pages25: a tap now gets the full 20-frame 气盾 (~1.1s of dome) instead of the 12-frame short one
    var long = true;
    f.repulseLong = long;
    var remain = repulseSpan(long) - (f.repulseT || 0);
    if (remain < 0.05) remain = 0.05;
    if (f.shieldWind > 0) {
      f.shieldPlan = Math.max(0.05, remain - f.shieldWind);
      f.shieldDur = f.shieldPlan;
      return;
    }
    if (!(f.shield > 0)) return;
    f.shield = remain;
    f.shieldDur = repulseSpan(long) - repulseWind;
  }

  function castPull(f) {
    f.anim = "pull";
    f.animT = 0;
    f.animDur = pullCastSpan;
    f.busy = pullCastSpan * 0.92;
    f.hitPending = false;
    f.pullOn = true;
    f.pullAnimT = 0;
    f.pullApplied = false;
    f.pullFx = pullCastSpan;
    plantCaster(f);
  }

  function applyPullGrab(f) {
    if (f.pullApplied) return;
    f.pullApplied = true;
    var opp = other(f);
    var palm = palmOf(f);
    if (opp.phase > 0 || opp.invuln > 0 || opp.shield > 0) return;
    var pdx = Math.abs(opp.x - palm.x);
    var pdy = Math.abs((opp.y - 70) - palm.y);
    if (pdx > 600 || pdy > 240) return;
    opp.pullT = 0.34;
    opp.pullToX = palm.x - f.facing * 30;
    opp.pullToY = f.y;
    opp.pullHit = false;
    opp.rooted = 0;
  }

  function castRetreat(f) {
    var dir = f.facing < 0 ? 1 : -1;
    var gi;
    for (gi = 0; gi < 3; gi++) {
      ghosts.push({
        x: f.x + dir * gi * 48, y: f.y, facing: f.facing,
        life: 0.42 - gi * 0.08, max: 0.42,
        palette: f.palette, weapon: f.weapon, owner: f.id, kit: f.kit,
        alpha: 0.78 - gi * 0.18
      });
    }
    f.invuln = 0.28;
    var spot = clampSpot(f.x + dir * 340, f.y);
    f.x = spot.x;
    f.y = spot.y;
    f.anim = "back";
    f.animT = 0;
    f.animDur = 0.48;
    f.busy = 0.42;
    f.hitPending = false;
  }

  function castSpace(f) {
    voidSpace = !voidSpace;
    voidT = voidSpace ? VOID_DUR : 0;
    voidUntil = voidSpace ? (performance.now() + VOID_DUR * 1000) : 0;
    f.anim = "cast";
    f.animT = 0;
    f.animDur = 0.2;
    f.busy = 0.1;
    f.hitPending = false;
    // Buffs (damage/CD/phase length) stay Obito-only via boosted()/castNeedle.
    // Never freeze the opponent: clear pull/root locks and keep both movable.
    left.pullT = 0;
    right.pullT = 0;
    left.rooted = 0;
    right.rooted = 0;
    var a = clampSpot(left.x, left.y);
    var b = clampSpot(right.x, right.y);
    left.x = a.x;
    left.y = a.y;
    right.x = b.x;
    right.y = b.y;
    var sdx = right.x - left.x;
    var sdy = right.y - left.y;
    var ad = Math.sqrt(sdx * sdx + sdy * sdy);
    if (ad < 56) {
      var push = (56 - (ad > 0.01 ? ad : 0.01)) * 0.5;
      var nx = ad > 0.01 ? sdx / ad : 1;
      var ny = ad > 0.01 ? sdy / ad : 0;
      a = clampSpot(left.x - nx * push, left.y - ny * push);
      b = clampSpot(right.x + nx * push, right.y + ny * push);
      left.x = a.x;
      left.y = a.y;
      right.x = b.x;
      right.y = b.y;
    }
    var oKit = fighterByKit("obito");
    if (!voidSpace && oKit && oKit.phase > 3) oKit.phase = 3;
    spawnFloater(f.x, f.y - 160, voidSpace ? "进入" : "返回", f.palette.glow);
  }

  function castArmor(f) {
    f.armor = 6;
    f.skills.spike.cd = 0;
    f.anim = "cast";
    f.animT = 0;
    f.animDur = 0.28;
    f.busy = 0.16;
    f.hitPending = false;
    spawnFloater(f.x, f.y - 180, "剑使", "#e2b6ff");
  }

  function castSwap(f) {
    var opp = other(f);
    var dx = opp.x - f.x;
    var dy = opp.y - f.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = opp.x + dx / len * 118;
    var ny = opp.y + dy / len * 118;
    var spot = clampSpot(nx, ny);
    nx = spot.x;
    ny = spot.y;
    if (Math.sqrt((nx - opp.x) * (nx - opp.x) + (ny - opp.y) * (ny - opp.y)) < 72) {
      var edge = xLimits(clamp(opp.y, MIN_Y, MAX_Y));
      nx = f.x <= opp.x ? edge.max : edge.min;
      ny = clamp(opp.y, MIN_Y, MAX_Y);
      spot = clampSpot(nx, ny);
      nx = spot.x;
      ny = spot.y;
    }
    rings.push({ x: f.x, y: f.y, life: 0.35, max: 0.35, color: f.palette.glow });
    f.x = nx;
    f.y = ny;
    rings.push({ x: f.x, y: f.y, life: 0.4, max: 0.4, color: f.palette.trim });
    f.invuln = 0.14;
    f.anim = "swap";
    f.animT = 0;
    f.animDur = 0.22;
    f.busy = 0.18;
    f.hitPending = false;
  }

  function planarDist(ax, ay, bx, by) {
    var dx = ax - bx;
    var dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function spawnComboFlash(f) {
    bursts.push({
      kind: "flash",
      x: f.x + f.facing * 78,
      y: f.y - 96,
      life: 0.16,
      max: 0.16,
      facing: f.facing
    });
  }

  function spawnKickBurst(f) {
    // pages25: visible 重脚 sweep (crescent + dust) on top of the impact flash
    spawnSlash(f.x + f.facing * 30, f.y - 60, f.facing, { life: 0.28, r: 84, width: 18, a0: 1.25, a1: -0.75, color: "#ffe2b0", glow: "#ff9a40" });
    bursts.push({
      kind: "impact",
      x: f.x + f.facing * 108,
      y: f.y - 64,
      life: 0.26,
      max: 0.26,
      facing: f.facing
    });
  }


  function updateTanjiroUlt2(f, dt) {
    // Phase 1 (0–1.5s after 0.2 startup): blink slashes around nearest enemies
    // Phase 2: teleport behind nearest foe + horizontal finisher + slow-mo
    var start = 0.2;
    var t = f.ult2T || 0;
    plantCaster(f);
    if (t < start) return;
    var active = t - start;
    if (active < 1.5) {
      var tick = Math.floor(active / 0.28);
      if (tick > (f.ult2Hits || 0) && tick < 5) {
        f.ult2Hits = tick;
        var foes = livingEnemies(f);
        var foe = foes.length ? foes[tick % foes.length] : other(f);
        if (foe) {
          var ang = Math.random() * Math.PI * 2;
          var rad = 90 + Math.random() * 70;
          var spot = clampSpot(foe.x + Math.cos(ang) * rad, foe.y + Math.sin(ang) * rad * 0.35);
          ghosts.push({ x: f.x, y: f.y, facing: f.facing, life: 0.2, max: 0.2, palette: f.palette, weapon: f.weapon, owner: f.id, kit: f.kit });
          f.x = spot.x;
          f.y = spot.y;
          f.facing = foe.x >= f.x ? 1 : -1;
          hurt(foe, tanjiroDmg(f, 10), f.palette.hot, { attacker: f });
          bursts.push({ x: foe.x, y: foe.y - 80, life: 0.22, max: 0.22, kind: "impact", facing: f.facing, scale: 1.2 });
        }
      }
      return;
    }
    if (f.ult2Phase === 1) {
      f.ult2Phase = 2;
      var foe2 = other(f);
      if (foe2) {
        var behind = clampSpot(foe2.x - foe2.facing * tanjiroBodyW * 1.1, foe2.y);
        ghosts.push({ x: f.x, y: f.y, facing: f.facing, life: 0.28, max: 0.28, palette: f.palette, weapon: f.weapon, owner: f.id, kit: f.kit });
        f.x = behind.x;
        f.y = behind.y;
        f.facing = foe2.x >= f.x ? 1 : -1;
        hurt(foe2, tanjiroDmg(f, 22), f.palette.hot, { attacker: f });
        phaseSlow = Math.max(phaseSlow || 0, 0.35);
        spawnFloater(foe2.x, foe2.y - 190, "终击", "#ffe7a0");
        bursts.push({ x: foe2.x, y: foe2.y - 70, life: 0.35, max: 0.35, kind: "impact", facing: f.facing, scale: 1.8 });
      }
      exitFireForm(f);
    }
  }

  function resolveMelee(f) {
    if (isFushiguro(f) && f.anim && f.anim.indexOf("f_") === 0) { resolveFushi(f); return; }
    var opp = other(f);
    var dx = opp.x - f.x;
    var dy = opp.y - f.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var ahead = Math.atan2(dy, dx * f.facing);
    var inFront = Math.abs(ahead) < Math.PI * 0.72;
    if (f.anim === "slash" || f.anim === "punch") {
      if (inFront && dist < 124) hurt(opp, boosted(f, 8), f.palette.glow);
    } else if (f.anim === "thrust") {
      if (inFront && dist < 150) hurt(opp, 9, right.palette.glow);
    } else if (f.anim === "cleave") {
      if (inFront && dist < 128) hurt(opp, 14, right.palette.glow);
    } else if (f.anim === "combo") {
      if (inFront && dist < 132) hurt(opp, 8, right.palette.glow);
    } else if (f.anim === "kick") {
      if (inFront && dist < 156) hurt(opp, 16, right.palette.glow);
    } else if (f.anim === "t_water1") {
      // dash-through slash: hits anything within range or anything the blink passed over
      var rng1 = f.meleeRange || (tanjiroBodyW * 1.5);
      var x0w = f.water1From != null ? f.water1From : f.x;
      var passed = opp.x >= Math.min(x0w, f.x) - 20 && opp.x <= Math.max(x0w, f.x) + 20 && Math.abs(dy) < 90;
      if (dist < rng1 || passed) hurt(opp, f.meleeDmg || 20, f.palette.glow, { attacker: f });
    } else if (f.anim === "t_atk" || f.anim === "t_counter") {
      var rng = f.meleeRange || (tanjiroBodyW * 1.4);
      if (inFront && dist < rng) hurt(opp, f.meleeDmg || 12, f.palette.glow, { attacker: f });
    } else if (f.anim === "g_atk" || f.anim === "l_atk" || f.anim === "l_gatling" || f.anim === "l_pistol" || f.anim === "l_spear" || f.anim === "i_atk" || f.anim === "i_mugetsu") {
      var rngL = f.meleeRange || (luffyBodyW * 1.4);
      if (inFront && dist < rngL) hurt(opp, f.meleeDmg || 12, f.palette.glow, { attacker: f, launch: !!f.meleeLaunch });
    }
  }

  function walkFighter(f, dt) {
    if (f.rooted > 0 || f.pullT > 0 || (f.stun || 0) > 0 || isAirborne(f) || isDowned(f)) {
      f.gait = "idle";
      return;
    }
    var ix = 0;
    var iy = 0;
    if (!humanControls(f)) {
      // AI still acts in void space — no special freeze when voidSpace is on.
      ix = f.aiIx || 0;
      iy = f.aiIy || 0;
      // pages29 practice: arrow keys manually steer the right-side sparring partner.
      if (gameMode === "practice" && f === aiFighter()) {
        var pix = 0, piy = 0;
        if (keysDown.ArrowLeft) pix -= 1;
        if (keysDown.ArrowRight) pix += 1;
        if (keysDown.ArrowUp) piy -= 1;
        if (keysDown.ArrowDown) piy += 1;
        if (pix !== 0 || piy !== 0) { ix = pix; iy = piy; }
      }
    } else if (f.id === "L") {
      // Obito: WASD + left stick
      if (keysDown.a) ix -= 1;
      if (keysDown.d) ix += 1;
      if (keysDown.w) iy -= 1;
      if (keysDown.s) iy += 1;
      ix += sticks[0].nx;
      iy += sticks[0].ny;
    } else {
      // Pain: always arrow keys (incl. depth via Up/Down). Never WASD.
      if (keysDown.ArrowLeft) ix -= 1;
      if (keysDown.ArrowRight) ix += 1;
      if (keysDown.ArrowUp) iy -= 1;
      if (keysDown.ArrowDown) iy += 1;
      // Mobile: human-as-Pain uses left stick; VS uses right stick.
      if ((gameMode === "ai" || gameMode === "practice") && playerSide === "R") {
        ix += sticks[0].nx;
        iy += sticks[0].ny;
      } else {
        ix += sticks[1].nx;
        iy += sticks[1].ny;
      }
    }
    // pages31g: 摇杆残余视为停步。站位/跑动/越过对手后一律面朝对手
    // （不再跟移动方向改 facing，避免越过对手后背对）。背身技在 cast 里自行改。
    if (Math.abs(ix) < 0.2) ix = 0;
    if (Math.abs(iy) < 0.2) iy = 0;
    if (ix === 0 && iy === 0) {
      f.gait = "idle";
      if (!(f.busy > 0) && !(f.dashT > 0) && !(f.counterT > 0) && !(f.ult2Phase > 0)) {
        faceTowardFoe(f);
      }
      return;
    }
    f.gait = "run";
    var len = Math.sqrt(ix * ix + iy * iy);
    var speed = f.moveSpeed || (isObito(f) ? 546 : 437);
    if ((f.fushiSlowT || 0) > 0) speed *= 0.5; // pages31f: 满象命中减速
    var step = clampSpot(f.x + ix / len * speed * dt, f.y + iy / len * speed * dt);
    // pages31f/g: 顶墙/被挡住原地不动时不播跑步（松键立即站立）
    if (Math.abs(step.x - f.x) + Math.abs(step.y - f.y) < speed * dt * 0.05) f.gait = "idle";
    f.x = step.x;
    f.y = step.y;
    if (!(f.busy > 0) && !(f.dashT > 0) && !(f.counterT > 0) && !(f.ult2Phase > 0)) {
      faceTowardFoe(f);
    }
  }

  function updateOneAI(f, dt) {
    if (!f || f.hp <= 0) return;
    var opp = isCoop() ? nearestHuman(f) : ((gameMode === "ai" || gameMode === "practice") ? humanFighter() : nearestEnemy(f));
    if (!opp) return;
    if ((f.stun || 0) > 0 || f.rooted > 0 || f.pullT > 0 || isAirborne(f) || isDowned(f)) {
      f.aiIx = 0;
      f.aiIy = 0;
      return;
    }
    var dx = opp.x - f.x;
    var dy = opp.y - f.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    if (dx < 0) f.facing = -1;
    else if (dx > 0) f.facing = 1;
    f.aiThink = (f.aiThink || 0) - dt;
    var wantX = 0;
    var wantY = 0;
    var ideal = 118;
    if (dist > ideal + 28) {
      wantX = dx / dist;
      wantY = dy / dist * 0.55;
    } else if (dist < ideal - 36) {
      wantX = -dx / dist;
      wantY = -dy / dist * 0.35;
    } else {
      wantY = (dy > 18 ? 0.35 : (dy < -18 ? -0.35 : 0));
      if (Math.abs(dy) < 12 && Math.random() < 0.01) wantX = (Math.random() < 0.5 ? -0.2 : 0.2);
    }
    if (opp.phase > 0 && dist < 160) {
      wantX = -dx / dist;
      wantY = (Math.random() - 0.5) * 0.4;
    }
    f.aiIx = wantX;
    f.aiIy = wantY;
    if (f.busy > 0 || f.dashT > 0 || f.shield > 0 || f.shieldWind > 0) return;
    if (f.aiThink > 0) return;
    // pages29: practice default = no auto-attack (player triggers enemy skills manually)
    if (gameMode === "practice" && !practiceAutoAttack) return;
    // pages23: slower AI decision cadence (was 0.18–0.40s).
    f.aiThink = 0.55 + Math.random() * 0.45;
    if (isPain(f)) {
      if (dist < 130 && f.skills.thrust && f.skills.thrust.cd <= 0 && f.chakra >= (f.skills.thrust.cost || 0)) {
        tryCast(f, "thrust");
        return;
      }
      if (dist < 150 && f.skills.cleave && f.skills.cleave.cd <= 0 && f.chakra >= (f.skills.cleave.cost || 0) && Math.random() < 0.14) {
        tryCast(f, "cleave");
        return;
      }
      if (dist > 160 && dist < 520 && f.skills.fire && f.skills.fire.cd <= 0 && f.chakra >= (f.skills.fire.cost || 0) && Math.random() < 0.06) {
        tryCast(f, "fire");
        return;
      }
      if (dist < 110 && f.skills.swap && f.skills.swap.cd <= 0 && f.chakra >= (f.skills.swap.cost || 0) && Math.random() < 0.16) {
        tryCast(f, "swap");
        return;
      }
      if (dist > 90 && dist < 420 && f.skills.pull && f.skills.pull.cd <= 0 && f.chakra >= (f.skills.pull.cost || 0) && Math.random() < 0.14) {
        tryCast(f, "pull");
        return;
      }
      if (dist < 150 && f.skills.spike && f.skills.spike.cd <= 0 && f.chakra >= (f.skills.spike.cost || 0) && Math.random() < 0.09) {
        tryCast(f, "spike");
        return;
      }
    } else if (isGojo(f)) {
      if (dist < 130 && f.skills.atk && f.skills.atk.cd <= 0) {
        tryCast(f, "atk");
        return;
      }
      if (dist > 90 && dist < 420 && f.skills.blue && f.skills.blue.cd <= 0 && f.chakra >= 18 && Math.random() < 0.14) {
        tryCast(f, "blue");
        return;
      }
      if (dist > 140 && dist < 520 && f.skills.red && f.skills.red.cd <= 0 && f.chakra >= 22 && Math.random() < 0.12) {
        tryCast(f, "red");
        return;
      }
      if (dist > 100 && dist < 360 && f.skills.blink && f.skills.blink.cd <= 0 && f.chakra >= 16 && Math.random() < 0.16) {
        tryCast(f, "blink");
        return;
      }
      if (dist < 200 && f.skills.infinity && f.skills.infinity.cd <= 0 && f.chakra >= 30 && f.phase <= 0 && Math.random() < 0.06) {
        tryCast(f, "infinity");
        return;
      }
      if (f.skills.domain && f.skills.domain.cd <= 0 && Math.random() < 0.05) {
        tryCast(f, "domain");
        return;
      }
      if (f.scrollId && f.skills[f.scrollId] && f.skills[f.scrollId].cd <= 0 && f.chakra >= (f.skills[f.scrollId].cost || 0) && Math.random() < 0.05) {
        tryCast(f, f.scrollId);
        return;
      }
    } else if (isLuffy(f)) {
      if (f.gear2 && f.skills.spear && Math.random() < 0.14) {
        tryCast(f, "spear");
        return;
      }
      if (!f.gear2 && dist < 220 && f.skills.gear2 && f.skills.gear2.cd <= 0 && f.chakra > 40 && Math.random() < 0.05) {
        tryCast(f, "gear2");
        return;
      }
      if (dist < 130 && f.skills.atk && f.skills.atk.cd <= 0) {
        tryCast(f, "atk");
        return;
      }
      if (dist < 180 && f.skills.gatling && f.skills.gatling.cd <= 0 && f.chakra >= 20 && Math.random() < 0.16) {
        tryCast(f, "gatling");
        return;
      }
      if (dist > 100 && dist < 360 && f.skills.pistol && f.skills.pistol.cd <= 0 && f.chakra >= 16 && Math.random() < 0.16) {
        tryCast(f, "pistol");
        return;
      }
      if (dist < 150 && f.skills.balloon && f.skills.balloon.cd <= 0 && f.chakra >= 25 && Math.random() < 0.06) {
        tryCast(f, "balloon");
        return;
      }
      if (f.scrollId && f.skills[f.scrollId] && f.skills[f.scrollId].cd <= 0 && f.chakra >= (f.skills[f.scrollId].cost || 0) && Math.random() < 0.05) {
        tryCast(f, f.scrollId);
        return;
      }
    } else if (isIchigo(f)) {
      if (f.bankai && f.skills.mugetsu && Math.random() < 0.12) {
        tryCast(f, "mugetsu");
        return;
      }
      if (!f.bankai && dist < 220 && f.skills.bankai && f.skills.bankai.cd <= 0 && f.chakra > 40 && Math.random() < 0.05) {
        tryCast(f, "bankai");
        return;
      }
      if (dist < 130 && f.skills.atk && f.skills.atk.cd <= 0) {
        tryCast(f, "atk");
        return;
      }
      if (dist > 140 && dist < 520 && f.skills.getsuga && f.skills.getsuga.cd <= 0 && f.chakra >= 22 && Math.random() < 0.14) {
        tryCast(f, "getsuga");
        return;
      }
      if (dist > 100 && dist < 360 && f.skills.flash && f.skills.flash.cd <= 0 && f.chakra >= 16 && Math.random() < 0.16) {
        tryCast(f, "flash");
        return;
      }
      if (dist < 150 && f.skills.block && f.skills.block.cd <= 0 && f.chakra >= 25 && Math.random() < 0.06) {
        tryCast(f, "block");
        return;
      }
      if (f.scrollId && f.skills[f.scrollId] && f.skills[f.scrollId].cd <= 0 && f.chakra >= (f.skills[f.scrollId].cost || 0) && Math.random() < 0.05) {
        tryCast(f, f.scrollId);
        return;
      }
    } else if (isFushiguro(f)) {
      if ((f.domainT || 0) <= 0 && dist < 280 && f.skills.domain && f.skills.domain.cd <= 0 && f.chakra > 40 && Math.random() < 0.05) {
        tryCast(f, "domain");
        return;
      }
      if (dist < 130 && f.skills.atk && f.skills.atk.cd <= 0) {
        tryCast(f, "atk");
        return;
      }
      if (dist < 280 && f.skills.dogs && f.skills.dogs.cd <= 0 && f.chakra >= 20 && Math.random() < 0.14) {
        tryCast(f, "dogs");
        return;
      }
      if (dist > 140 && dist < 480 && f.skills.nue && f.skills.nue.cd <= 0 && f.chakra >= 22 && Math.random() < 0.14) {
        tryCast(f, "nue");
        return;
      }
      if (dist < 300 && f.skills.elephant && f.skills.elephant.cd <= 0 && f.chakra >= 25 && Math.random() < 0.1) {
        tryCast(f, "elephant");
        return;
      }
      if (dist < 200 && f.skills.shadow && f.skills.shadow.cd <= 0 && f.chakra >= 10 && Math.random() < 0.1) {
        tryCast(f, "shadow");
        return;
      }
      if (f.scrollId && f.skills[f.scrollId] && f.skills[f.scrollId].cd <= 0 && f.chakra >= (f.skills[f.scrollId].cost || 0) && Math.random() < 0.05) {
        tryCast(f, f.scrollId);
        return;
      }
    } else if (isTanjiro(f)) {
      if (f.fireForm && f.skills.ult2 && Math.random() < 0.16) {
        tryCast(f, "ult2");
        return;
      }
      if (!f.fireForm && dist < 220 && f.skills.ult1 && f.skills.ult1.cd <= 0 && f.chakra > 40 && Math.random() < 0.06) {
        tryCast(f, "ult1");
        return;
      }
      if (dist < 130 && f.skills.atk && f.skills.atk.cd <= 0) {
        tryCast(f, "atk");
        return;
      }
      if (dist < 200 && f.skills.water4 && f.skills.water4.cd <= 0 && f.chakra >= 20 && Math.random() < 0.2) {
        tryCast(f, "water4");
        return;
      }
      if (dist < 160 && f.skills.water1 && f.skills.water1.cd <= 0 && f.chakra >= 22 && Math.random() < 0.16) {
        tryCast(f, "water1");
        return;
      }
      if (dist < 150 && f.skills.water2 && f.skills.water2.cd <= 0 && f.chakra >= 25 && Math.random() < 0.06) {
        tryCast(f, "water2");
        return;
      }
      if (f.scrollId && f.skills[f.scrollId] && f.skills[f.scrollId].cd <= 0 && f.chakra >= (f.skills[f.scrollId].cost || 0) && Math.random() < 0.05) {
        tryCast(f, f.scrollId);
        return;
      }
    } else {
      if (dist < 130 && f.skills.punch && f.skills.punch.cd <= 0) {
        tryCast(f, "punch");
        return;
      }
      if (dist > 140 && dist < 420 && f.skills.breath && f.skills.breath.cd <= 0 && f.chakra >= (f.skills.breath.cost || 0) && Math.random() < 0.2) {
        tryCast(f, "breath");
        return;
      }
      if (dist > 100 && dist < 360 && f.skills.tele && f.skills.tele.cd <= 0 && f.chakra >= (f.skills.tele.cost || 0) && Math.random() < 0.16) {
        tryCast(f, "tele");
        return;
      }
      if (dist < 160 && f.skills.phase && f.skills.phase.cd <= 0 && f.chakra >= (f.skills.phase.cost || 0) && f.phase <= 0 && Math.random() < 0.06) {
        tryCast(f, "phase");
        return;
      }
      if (f.skills.space && f.skills.space.cd <= 0 && Math.random() < 0.08) {
        tryCast(f, "space");
        return;
      }
      if (f.scrollId && f.skills[f.scrollId] && f.skills[f.scrollId].cd <= 0 && f.chakra >= (f.skills[f.scrollId].cost || 0) && Math.random() < 0.06) {
        tryCast(f, f.scrollId);
        return;
      }
    }
  }

  function updateAI(dt) {
    if (matchState !== "fight" || koId) return;
    if (gameMode === "vs") return;
    // pages29: practice without 「自动打我」 still lets the sparring partner stand/move
    // (and accept arrow-key steering / forced casts); only auto skill casting is skipped.
    if (gameMode === "coop") {
      updateOneAI(right, dt);
      updateOneAI(right2, dt);
      return;
    }
    updateOneAI(aiFighter(), dt);
  }

  // pages25: hard keep-in-view pass after every simulation step. Knockback / launches / pulls
  // used to move fighters directly and could push one past the left edge (lost round 1 at ~16s).
  function update(dt) {
    updateCore(dt);
    var fs = activeFighters(), i;
    for (i = 0; i < fs.length; i++) {
      var f = fs[i];
      if (!f) continue;
      if (f.x < 70) { f.x = 70; if (f.hitPushVx < 0) f.hitPushVx = 0; if (f.launchVx < 0) f.launchVx = 0; if (f.dashVx < 0) f.dashVx = 0; }
      if (f.x > W - 70) { f.x = W - 70; if (f.hitPushVx > 0) f.hitPushVx = 0; if (f.launchVx > 0) f.launchVx = 0; if (f.dashVx > 0) f.dashVx = 0; }
      if (f.y < 430) f.y = 430;
      if (f.y > 690) f.y = 690;
      // pages31e: 击飞飞行/倒地/起身时横躺姿态更宽，边距放大到整个人物可见（所有角色）
      if (isAirborne(f) || isDowned(f) || f.knockPhase === "air" || f.knockPhase === "down") {
        if (f.x < KNOCK_EDGE) { f.x = KNOCK_EDGE; if (f.launchVx < 0) f.launchVx = 0; if (f.hitPushVx < 0) f.hitPushVx = 0; }
        if (f.x > W - KNOCK_EDGE) { f.x = W - KNOCK_EDGE; if (f.launchVx > 0) f.launchVx = 0; if (f.hitPushVx > 0) f.hitPushVx = 0; }
      }
    }
    if (matchState === "fight") separateBodies(dt);
  }
  var KNOCK_EDGE = 220;
  // pages31g: 身体不重叠（全角色）。走位边界与 clampSpot 一致（90..1190）；
  // 在 update 钳制之后硬保证 |dx|>=SEP_DX；贴墙者钉住，只挡推的人；松键/顶人立即站立。
  var SEP_DX = 68, SEP_DY = 150;
  var WALK_LO = 90, WALK_HI = 1190;
  function fighterXLimits(f) {
    if (isAirborne(f) || isDowned(f) || f.knockPhase === "air" || f.knockPhase === "down") {
      return { lo: KNOCK_EDGE, hi: W - KNOCK_EDGE };
    }
    return { lo: WALK_LO, hi: WALK_HI };
  }
  function separateBodies(dt) {
    var fs = activeFighters(), i, j, a, b;
    for (i = 0; i < fs.length; i++) {
      for (j = i + 1; j < fs.length; j++) {
        a = fs[i]; b = fs[j];
        if (!a || !b || a.hp <= 0 || b.hp <= 0) continue;
        if (isAirborne(a) || isAirborne(b)) continue;
        if ((a.dashT || 0) > 0 || (b.dashT || 0) > 0 || (a.phase || 0) > 0 || (b.phase || 0) > 0) continue;
        var dy = b.y - a.y;
        if (Math.abs(dy) >= SEP_DY) continue;
        var dx = b.x - a.x;
        if (Math.abs(dx) >= SEP_DX) continue;
        var dir = dx > 0.5 ? 1 : (dx < -0.5 ? -1 : ((a.x + b.x) / 2 >= W / 2 ? -1 : 1));
        var la = fighterXLimits(a), lb = fighterXLimits(b);
        var pinEps = 1.5;
        var aPinOut = dir > 0 ? (a.x - la.lo <= pinEps) : (la.hi - a.x <= pinEps);
        var bPinOut = dir > 0 ? (lb.hi - b.x <= pinEps) : (b.x - lb.lo <= pinEps);
        if (bPinOut && !aPinOut) {
          a.x = clamp(b.x - dir * SEP_DX, la.lo, la.hi);
          a.gait = "idle";
        } else if (aPinOut && !bPinOut) {
          b.x = clamp(a.x + dir * SEP_DX, lb.lo, lb.hi);
          b.gait = "idle";
        } else if (aPinOut && bPinOut) {
          if (dir > 0) { b.x = lb.hi; a.x = clamp(b.x - SEP_DX, la.lo, la.hi); }
          else { a.x = la.lo; b.x = clamp(a.x + SEP_DX, lb.lo, lb.hi); }
          a.gait = "idle"; b.gait = "idle";
        } else {
          var mid = (a.x + b.x) / 2;
          var na = mid - dir * (SEP_DX / 2);
          var nb = mid + dir * (SEP_DX / 2);
          if (na < la.lo) { nb += la.lo - na; na = la.lo; }
          if (na > la.hi) { nb -= na - la.hi; na = la.hi; }
          if (nb < lb.lo) { na -= lb.lo - nb; nb = lb.lo; }
          if (nb > lb.hi) { na += nb - lb.hi; nb = lb.hi; }
          a.x = clamp(na, la.lo, la.hi);
          b.x = clamp(nb, lb.lo, lb.hi);
        }
      }
    }
  }
  function updateCore(dt) {
    // pages23: 切空间 uses wall-clock so simSpeed / low FPS cannot stretch it past 4s.
    if (voidSpace) {
      var leftMs = voidUntil - performance.now();
      voidT = Math.max(0, leftMs / 1000);
      if (leftMs <= 0) {
        voidSpace = false;
        voidT = 0;
        voidUntil = 0;
        var oKitV = fighterByKit("obito");
        if (oKitV && oKitV.phase > 3) oKitV.phase = 3;
        if (oKitV) spawnFloater(oKitV.x, oKitV.y - 160, "返回", oKitV.palette.glow);
      }
    }
    time += dt;
    if (shake > 0) shake = Math.max(0, shake - dt * 18);

    var roster = activeFighters();
    var i;
    for (i = 0; i < roster.length; i++) {
      var f = roster[i];
      if (f.hp <= 0) {
        if (isIchigo(f) && f.bankai) exitIchigoBankai(f);
        if (isLuffy(f) && f.gear2) exitLuffyGear2(f);
        f.gait = "idle";
        f.dashT = 0;
        f.aiIx = 0;
        f.aiIy = 0;
        continue;
      }
      var sk;
      for (sk in f.skills) {
        if (f.skills[sk].cd > 0) f.skills[sk].cd = Math.max(0, f.skills[sk].cd - dt);
      }
      if (f.hyperArmor > 0) {
        f.hyperArmor = Math.max(0, f.hyperArmor - dt);
      }
      if (f.chakraLock > 0) {
        f.chakraLock = Math.max(0, f.chakraLock - dt);
        f.chakra = f.maxChakra;
      } else if (isLuffy(f) && f.gear2) {
        f.chakra = Math.max(0, (f.chakra || 0) - 8 * dt);
        if (f.chakra <= 0) exitLuffyGear2(f);
      } else if (isIchigo(f) && f.bankai) {
        f.chakra = Math.max(0, (f.chakra || 0) - 8 * dt);
        if (f.chakra <= 0) exitIchigoBankai(f);
      } else if (isTanjiro(f) && f.fireForm) {
        f.chakra = Math.max(0, f.chakra - 8 * dt);
        if (f.chakra <= 0) exitFireForm(f);
      } else if (f.chakra < f.maxChakra) {
        f.chakra = Math.min(f.maxChakra, f.chakra + 11.2 * dt);
      }
      if (isTanjiro(f) && (f.barrierT || 0) > 0) {
        f.barrierT = Math.max(0, f.barrierT - dt);
        if (f.barrierT <= 0 && !f.barrierUsed) {
          f.barrierUsed = true;
          if (f.busy <= 0 && f.dashT <= 0) tanjiroStanceFinisher(f);
        }
      }
      if (isTanjiro(f) && (f.counterT || 0) > 0) {
        f.counterT = Math.max(0, f.counterT - dt);
        plantCaster(f);
      }
      if (isGojo(f) && (f.domainT || 0) > 0) {
        f.domainT = Math.max(0, f.domainT - dt);
      if ((f.balloonT || 0) > 0) f.balloonT = Math.max(0, f.balloonT - dt);
      if ((f.blockT || 0) > 0) f.blockT = Math.max(0, f.blockT - dt);
        if (f.domainT > 0) {
          var foesD = activeFighters(), di;
          for (di = 0; di < foesD.length; di++) {
            var td = foesD[di];
            if (!td || td === f || td.hp <= 0 || td.team === f.team) continue;
            var ddx = td.x - f.x, ddy = td.y - f.y;
            if (ddx * ddx + ddy * ddy < 350 * 350) {
              td.x += (f.x - td.x) * 0.002;
              if (!td._gojoDomainTick) td._gojoDomainTick = 0;
              td._gojoDomainTick += dt;
              if (td._gojoDomainTick >= 0.5) {
                td._gojoDomainTick = 0;
                hurt(td, 2, "#c080ff", { noLaunch: true });
              }
            }
          }
        }
      }
      if (isFushiguro(f) && (f.domainT || 0) > 0) {
        f.domainT = Math.max(0, f.domainT - dt);
        if (f.domainT > 0) {
          var foesF = activeFighters(), fi;
          for (fi = 0; fi < foesF.length; fi++) {
            var tf = foesF[fi];
            if (!tf || tf === f || tf.hp <= 0 || tf.team === f.team) continue;
            var fdx = tf.x - f.x, fdy = tf.y - f.y;
            if (fdx * fdx + fdy * fdy < 320 * 320) {
              if (!tf._fushiDomainTick) tf._fushiDomainTick = 0;
              tf._fushiDomainTick += dt;
              if (tf._fushiDomainTick >= 0.6) {
                tf._fushiDomainTick = 0;
                tf.stun = Math.max(tf.stun || 0, 0.25);
                tf.hitLight = true;
              }
            }
          }
        }
      }
      if (f.flash > 0) f.flash = Math.max(0, f.flash - dt);
      if (f.invuln > 0) f.invuln = Math.max(0, f.invuln - dt);
      if (f.phase > 0) {
        f.phaseEye = (f.phaseEye || 0) + dt;
        f.phase = Math.max(0, f.phase - dt);
        if (f.phase <= 0) f.phaseEye = 0;
      }
      if (f.armor > 0) {
        f.armor -= dt;
        if (f.armor <= 0) {
          f.armor = 0;
          if (f.skills.spike) applySkillCd(f, f.skills.spike, "spike");
        }
      }
      if (f.pullOn) {
        f.pullAnimT = (f.pullAnimT || 0) + dt;
        if (f.pullAnimT >= pullActiveFrom && !f.pullApplied) applyPullGrab(f);
        if (f.pullAnimT >= pullCastSpan) {
          f.pullOn = false;
          f.pullAnimT = pullCastSpan;
          if (f.anim === "pull") { f.anim = "idle"; f.animT = 0; f.animDur = 0.2; }
        }
      }
      if (f.pullFx > 0) f.pullFx = Math.max(0, f.pullFx - dt);
      if (f.rooted > 0) {
        f.rooted = Math.max(0, f.rooted - dt);
        f.dashT = 0;
      }
      if (f.pullT > 0) {
        var pullPrev = f.pullT;
        f.pullT -= dt;
        f.dashT = 0;
        var pu = pullPrev > 0.0001 ? Math.min(1, dt / pullPrev) : 1;
        var pulled = clampSpot(f.x + (f.pullToX - f.x) * pu, f.y + (f.pullToY - f.y) * pu);
        f.x = pulled.x;
        f.y = pulled.y;
        if (f.pullT <= 0) {
          f.pullT = 0;
          var landed = clampSpot(f.pullToX, f.pullToY);
          f.x = landed.x;
          f.y = landed.y;
          f.rooted = 1;
          if (!f.pullHit) {
            f.pullHit = true;
            hurt(f, 14, "#cfe6ff");
          }
        }
      }
      if (f.repulseOn) f.repulseT = (f.repulseT || 0) + dt;
      if (f.shieldWind > 0) {
        f.shieldWind -= dt;
        if (f.shieldWind <= 0) {
          f.shieldWind = 0;
          f.shield = f.shieldPlan || 1;
          f.shieldDur = f.shield;
          f.shieldHit = false;
        }
      }
      if (f.shield > 0) {
        f.shield -= dt;
        var oppS = other(f);
        var sc = shieldCenter(f);
        var rad = shieldRadius();
        var sdx = oppS.x - sc.x;
        var sdy = (oppS.y - 80) - sc.y;
        var sd = Math.sqrt(sdx * sdx + sdy * sdy);
        if (sd < rad) {
          var snx = sd > 0.01 ? sdx / sd : (f.facing || 1);
          var sny = sd > 0.01 ? sdy / sd : 0;
          var ox = sc.x + snx * (rad + 10);
          var oy = sc.y + sny * (rad + 10) + 80;
          var shoved = clampSpot(ox, oy);
          oppS.x = shoved.x;
          oppS.y = shoved.y;
          if (!f.shieldHit) {
            f.shieldHit = true;
            hurt(oppS, 16, "#d7ecff");
          }
        } else {
          f.shieldHit = false;
        }
        if (f.shield <= 0) {
          f.shield = 0;
          f.shieldKey = false;
          f.repulseOn = false;
          if (f.skills.spike) f.skills.spike.cd = f.skills.spike.max;
        }
      }
      if (f.hurt > 0) f.hurt = Math.max(0, f.hurt - dt);
      if (f.stun > 0) f.stun = Math.max(0, f.stun - dt);
      if (f.busy > 0) f.busy = Math.max(0, f.busy - dt);
      if (f.castBuf) pumpCastBuffer(f);
      if (f.hitShake > 0) f.hitShake = Math.max(0, f.hitShake - dt);
      if (f.barDmgT > 0) f.barDmgT = Math.max(0, f.barDmgT - dt);
      if (f.hpChip == null) f.hpChip = f.hp;
      if (f.chipHold > 0) f.chipHold = Math.max(0, f.chipHold - dt);
      if (f.hpChip > f.hp) {
        // pages21: white chip holds briefly, then drains slowly so it reads as white.
        if (!(f.chipHold > 0)) f.hpChip = Math.max(f.hp, f.hpChip - f.maxHp * 0.3 * dt);
      } else {
        f.hpChip = f.hp;
      }
      if (f.knockPhase) f.knockT = (f.knockT || 0) + dt;
      if (f.knockPhase === "down" && !isDowned(f) && !isAirborne(f)) {
        f.knockPhase = null;
        f.knockT = 0;
      }

      // Skill casters / Pain actions keep both feet on the ground.
      if (f.pullOn || f.repulseOn || (f.shieldWind || 0) > 0) plantCaster(f);
      if (isPain(f) && (f.busy > 0 || f.anim === "combo" || f.anim === "kick" || f.anim === "rod" || f.anim === "push" || f.anim === "back" || f.anim === "pull" || f.anim === "cast")) plantCaster(f);
      if (isTanjiro(f) && (f.busy > 0 || (f.ult2Phase || 0) > 0 || (f.counterT || 0) > 0 || f.anim.indexOf("t_") === 0)) plantCaster(f);
      if (isGojo(f) && (f.busy > 0 || (f.anim && f.anim.indexOf("g_") === 0))) plantCaster(f);
      if (isLuffy(f) && (f.busy > 0 || (f.anim && f.anim.indexOf("l_") === 0))) plantCaster(f);
      if (isIchigo(f) && (f.busy > 0 || (f.anim && f.anim.indexOf("i_") === 0))) plantCaster(f);
      if (isFushiguro(f) && (f.busy > 0 || (f.anim && f.anim.indexOf("f_") === 0))) plantCaster(f);
      if (isFushiguro(f)) updateFushiSkills(f, dt);
      if ((f.fushiSlowT || 0) > 0) f.fushiSlowT = Math.max(0, f.fushiSlowT - dt);
      if (isAirborne(f)) {
        f.dashT = 0;
        f.gait = "idle";
        f.airV = (f.airV || 0) - LAUNCH_G * dt;
        f.airH = (f.airH || 0) + f.airV * dt;
        var flySpot = clampSpot(f.x + (f.launchVx || 0) * dt, f.y + (f.launchVy || 0) * dt);
        f.x = flySpot.x;
        f.y = flySpot.y;
        // Soft drag so arc settles.
        f.launchVx = (f.launchVx || 0) * Math.max(0, 1 - 0.35 * dt);
        f.launchVy = (f.launchVy || 0) * Math.max(0, 1 - 0.35 * dt);
        if (f.airH <= 0) {
          landFighter(f);
        } else {
          // Stay invulnerable for the whole flight.
          f.invuln = Math.max(f.invuln || 0, 0.05);
        }
        continue;
      }

      // Grounded light-hit slide.
      if ((f.hitPushVx || 0) !== 0 || (f.hitPushVy || 0) !== 0) {
        var pushSpot = clampSpot(f.x + (f.hitPushVx || 0) * dt, f.y + (f.hitPushVy || 0) * dt);
        f.x = pushSpot.x;
        f.y = pushSpot.y;
        f.hitPushVx = (f.hitPushVx || 0) * Math.max(0, 1 - 9 * dt);
        f.hitPushVy = (f.hitPushVy || 0) * Math.max(0, 1 - 9 * dt);
        if (Math.abs(f.hitPushVx) < 4) f.hitPushVx = 0;
        if (Math.abs(f.hitPushVy) < 4) f.hitPushVy = 0;
      }

      // Knockdown lie-down then get-up.
      if ((f.downT || 0) > 0) {
        f.downT -= dt;
        f.dashT = 0;
        f.gait = "idle";
        f.invuln = Math.max(f.invuln || 0, 0.05);
        f.stun = Math.max(f.stun || 0, 0.05);
        if (f.downT <= 0) {
          f.downT = 0;
          f.downMax = 0;
          f.getUpT = 0.52;
          f.getUpMax = 0.52;
        }
        continue;
      }
      if ((f.getUpT || 0) > 0) {
        f.getUpT -= dt;
        f.dashT = 0;
        f.gait = "idle";
        f.invuln = Math.max(f.invuln || 0, 0.05);
        f.stun = Math.max(f.stun || 0, 0.05);
        f.knockNoBlink = Math.max(f.knockNoBlink || 0, 0.05);
        if (f.getUpT <= 0) {
          f.getUpT = 0;
          f.getUpMax = 0;
          f.hitLean = 0;
          f.hitLight = false;
          f.invuln = Math.max(f.invuln || 0, 0.12);
          // pages30d: no white invuln blink right after standing up
          f.knockNoBlink = Math.max(f.knockNoBlink || 0, 0.55);
        }
        continue;
      }
      if ((f.knockNoBlink || 0) > 0) f.knockNoBlink = Math.max(0, f.knockNoBlink - dt);

      // Ease out light lean after stun ends.
      if ((f.stun || 0) <= 0 && (f.hitLean || 0) > 0) {
        f.hitLean = Math.max(0, f.hitLean - dt * 1.4);
        if (f.hitLean <= 0.01) {
          f.hitLean = 0;
          f.hitLight = false;
        }
      }

      if (f.dashT > 0) {
        f.dashT -= dt;
        if ((f.dashDelay || 0) > 0) {
          f.dashDelay = Math.max(0, f.dashDelay - dt);
          plantCaster(f);
        } else {
        var prevX = f.x;
        var prevY = f.y;
        var dashSpot = clampSpot(f.x + f.dashVx * dt, f.y + (f.dashVy || 0) * dt);
        f.x = dashSpot.x;
        f.y = dashSpot.y;
        if (!f.dashHit && !koId) {
          var opp = other(f);
          var abx = f.x - prevX;
          var aby = f.y - prevY;
          var apx = opp.x - prevX;
          var apy = opp.y - prevY;
          var ab2 = abx * abx + aby * aby;
          var t = ab2 > 0.0001 ? (apx * abx + apy * aby) / ab2 : 0;
          if (t < 0) t = 0;
          if (t > 1) t = 1;
          var cx = prevX + abx * t;
          var cy = prevY + aby * t;
          if (planarDist(opp.x, opp.y, cx, cy) < 48) {
            if (hurt(opp, f.dashDmg || 16, f.palette.glow, { attacker: f })) f.dashHit = true;
          }
        }
        }
        if (f.dashT <= 0) {
          f.dashT = 0;
          f.dashDelay = 0;
          f.dashDmg = 0;
          if (f.anim === "t_water4") { /* keep anim until animDur */ }
          else f.anim = "idle";
        }
      } else {
        if (!koId && f.busy <= 0) walkFighter(f, dt);
        else if (!koId && f.anim === "punch" && f.animT < f.animDur * 0.45) {
          var lunge = clampSpot(f.x + f.facing * 560 * dt, f.y);
          f.x = lunge.x;
          f.y = lunge.y;
        }
        if (f.anim !== "idle") {
        f.animT += dt;
        if (f.anim === "tele" && !f.teleBlinked && f.animT >= f.animDur * 0.5) {
          blinkStrike(f);
          f.teleBlinked = true;
        }
        if (f.anim === "t_water1" && !f.water1Blink && f.animT >= (f.water1At || 0)) {
          f.water1Blink = true;
          var spot1 = clampSpot(f.x + f.facing * tanjiroBodyW, f.y);
          ghosts.push({ x: f.x, y: f.y, facing: f.facing, life: 0.25, max: 0.25, palette: f.palette, weapon: f.weapon, owner: f.id, kit: f.kit });
          var fromX1 = f.x, dir1 = f.facing;
          f.x = spot1.x;
          f.y = spot1.y;
          f.water1From = fromX1;
          // pages25: the slash passes through; turn to face the foe (doc: flip 180° after passing)
          var foe1 = other(f);
          f.facing = (foe1 && foe1.hp > 0) ? (foe1.x >= f.x ? 1 : -1) : -f.facing;
          plantCaster(f);
          spawnSlash((fromX1 + f.x) / 2, f.y - tanjiroBodyH * 0.48, dir1, {
            life: 0.34, r: Math.abs(f.x - fromX1) * 0.5 + tanjiroBodyW * 0.55, width: 20, squash: 0.32,
            a0: -2.6, a1: 0.5, color: f.fireForm ? "#ffb060" : "#7fe0ff", glow: f.fireForm ? "#ff5a20" : "#2ab8ff"
          });
        }
        if (f.anim === "t_ult1" && f.pendingFireForm && f.animT >= 0.4) {
          enterFireForm(f);
        }
        if ((f.ult2Phase || 0) > 0 && f.anim === "t_ult2") {
          f.ult2T = (f.ult2T || 0) + dt;
          updateTanjiroUlt2(f, dt);
        }
        if (f.hitPending && f.animT >= f.hitAt) {
          f.hitPending = false;
          if (f.anim === "combo") spawnComboFlash(f);
          if (f.anim === "kick") spawnKickBurst(f);
          resolveMelee(f);
        }
        if (f.hitPending2 && f.animT >= f.hitAt2) {
          f.hitPending2 = false;
          if (f.anim === "combo") spawnComboFlash(f);
          resolveMelee(f);
        }
        if (f.animT >= f.animDur) {
          if (f.anim === "t_ult2") {
            exitFireForm(f);
            f.ult2Phase = 0;
          }
          f.anim = "idle";
          faceTowardFoe(f);
        }
        }
      }
    }

    if (koId == null) {
      var sep = activeFighters();
      var a, b, sdx, sdy, ad, push, nx, ny, ls, rs;
      for (a = 0; a < sep.length; a++) {
        if (sep[a].hp <= 0 || sep[a].dashT > 0 || isAirborne(sep[a])) continue;
        for (b = a + 1; b < sep.length; b++) {
          if (sep[b].hp <= 0 || sep[b].dashT > 0 || isAirborne(sep[b])) continue;
          sdx = sep[b].x - sep[a].x;
          sdy = sep[b].y - sep[a].y;
          ad = Math.sqrt(sdx * sdx + sdy * sdy);
          if (ad < 68 && ad > 0.01) {
            push = (68 - ad) * 0.5;
            nx = sdx / ad;
            ny = sdy / ad;
            ls = clampSpot(sep[a].x - nx * push, sep[a].y - ny * push);
            rs = clampSpot(sep[b].x + nx * push, sep[b].y + ny * push);
            sep[a].x = ls.x;
            sep[a].y = ls.y;
            sep[b].x = rs.x;
            sep[b].y = rs.y;
          }
        }
      }
    }

    for (i = projectiles.length - 1; i >= 0; i--) {
      var p = projectiles[i];
      p.life -= dt;
      if (p.kind === "firebreath") {
        p.age = (p.age || 0) + dt;
        var ownerFb = projectileOwner(p.owner);
        var dirFb = ownerFb.facing < 0 ? -1 : 1;
        p.facing = ownerFb.facing;
        // pages29: pin stream origin to mouth every tick (no vertical bob from frame size).
        p.x = ownerFb.x + dirFb * FIREBREATH_MOUTH_OX;
        p.y = ownerFb.y + FIREBREATH_MOUTH_OY;
        var targetFb = projectileFoe(p.owner, p.x + dirFb * 200, p.y);
        var prog = p.age / 0.8;
        if (prog > 1) prog = 1;
        // Reach grows as the stream extends; scaled to half with the smaller VFX.
        var reach = 110 + 350 * Math.min(1, prog / 0.35);
        var midX = p.x + dirFb * reach * 0.52;
        var midY = p.y + 18;
        var halfW = reach * 0.48;
        var halfH = 55 + 20 * Math.min(1, prog / 0.4);
        var inBeam = Math.abs(targetFb.x - midX) < halfW && Math.abs((targetFb.y - 74) - midY) < halfH;
        if (inBeam && !p.hit && prog > 0.12) {
          if (targetFb.phase > 0 || targetFb.invuln > 0) {
            /* phased: breath passes through */
          } else if (hurt(targetFb, p.dmg, ownerFb.palette.glow, { attacker: ownerFb })) {
            p.hit = true;
            rings.push({ x: targetFb.x, y: targetFb.y, life: 0.28, max: 0.28, color: "#ff8a3a" });
          }
        }
        if (p.life <= 0) projectiles.splice(i, 1);
        continue;
      }
      if (p.kind === "panda_drop" || p.kind === "shark_drop") {
        p.age = (p.age || 0) + dt;
        if (!p.landed) {
          p.y += (p.vy || 980) * dt;
          if (p.y >= (p.landY != null ? p.landY : 490)) {
            p.y = p.landY != null ? p.landY : 490;
            p.landed = true;
            p.vy = 0;
            p.life = Math.min(p.life, 0.55);
            var dropCol = p.kind === "shark_drop" ? "#6aa0c8" : "#f0e8d8";
            rings.push({ x: p.x, y: p.y + 30, life: 0.4, max: 0.4, color: dropCol, r0: 20, r1: 140 });
            bursts.push({ x: p.x, y: p.y + 20, life: 0.35, max: 0.35, kind: "impact", facing: 1, scale: 1.8 });
            var ownerPd = projectileOwner(p.owner);
            var foesPd = livingEnemies(ownerPd);
            var pi;
            for (pi = 0; pi < foesPd.length; pi++) {
              var tgt = foesPd[pi];
              if (tgt.phase > 0 || tgt.invuln > 0) continue;
              if (planarDist(p.x, p.y, tgt.x, tgt.y - 60) < (p.r || 78)) {
                if (hurt(tgt, p.dmg || 28, ownerPd.palette.glow, { attacker: ownerPd })) {
                  p.hit = true;
                  spawnFloater(tgt.x, tgt.y - 160, "通灵砸", dropCol);
                }
              }
            }
          }
        }
        if (p.life <= 0) projectiles.splice(i, 1);
        continue;
      }
      // pages25: remember where this step started so fast shots are tested as a swept segment
      // (900px/s at 20fps moves ~45px per step, more than the old 22px hit radius).
      var px0 = (p.sweepX != null) ? p.sweepX : p.x;
      p.sweepX = null;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === "fire") {
        p.age = (p.age || 0) + dt;
        var u = p.age / 0.2;
        if (u > 1) u = 1;
        u = 1 - (1 - u) * (1 - u);
        p.scale = 0.28 + 2.495 * u;
      }
      var ownerProj = projectileOwner(p.owner);
      var enemiesHit = livingEnemies(ownerProj);
      var ei;
      var hitAny = false;
      for (ei = 0; ei < enemiesHit.length; ei++) {
        var target = enemiesHit[ei];
        var chestY = target.y - (p.kind === "fire" ? 78 : 74);
        var hitR = p.kind === "fire" ? 28 * (p.scale || 0.28) : (p.kind === "push" ? 46 : (p.kind === "rod" ? 22 : (p.kind === "wave" ? 28 : 20)));
        var sweptHit = false;
        if (p.kind === "rod" || p.kind === "wave" || p.kind === "push") {
          // body box of the target: half width ~30, from feet up to ~head height
          var bodyTop = target.y - 175, bodyBot = target.y - 10;
          var segL = Math.min(px0, p.x) - (p.kind === "push" ? 30 : 8), segR = Math.max(px0, p.x) + (p.kind === "push" ? 30 : 8);
          sweptHit = target.x + 30 >= segL && target.x - 30 <= segR && p.y >= bodyTop && p.y <= bodyBot;
        }
        if (sweptHit || planarDist(p.x, p.y, target.x, chestY) < hitR) {
          if (target.phase > 0 || target.invuln > 0) {
            /* ethereal: projectile passes through and is not a hit */
          } else if (hurt(target, p.dmg, ownerProj.palette.glow, { attacker: ownerProj })) {
            if (p.kind === "push") {
              var away = p.vx < 0 ? -1 : 1;
              var shoved = clampSpot(target.x + away * 110, target.y);
              target.x = shoved.x;
              target.y = shoved.y;
            }
            if (p.kind === "fire") {
              rings.push({ x: target.x, y: target.y, life: 0.25, max: 0.25, color: "#ff8a3a" });
            }
            if (p.kind === "rod") {
              // pages25: visible impact where the 黑棒 connects
              bursts.push({ x: target.x - (p.vx > 0 ? 18 : -18), y: Math.max(target.y - 160, Math.min(target.y - 40, p.y)), life: 0.22, max: 0.22, kind: "impact", facing: p.vx > 0 ? 1 : -1, scale: 0.8 });
            }
            hitAny = true;
            break;
          }
        }
      }
      if (hitAny) {
        projectiles.splice(i, 1);
        continue;
      }
      if (p.life <= 0 || p.x < -60 || p.x > W + 60 || p.y < 80 || p.y > H + 40) projectiles.splice(i, 1);
    }

    for (i = swords.length - 1; i >= 0; i--) {
      var sw = swords[i];
      var px0 = sw.x;
      var py0 = sw.y;
      sw.life -= dt;
      sw.x += sw.vx * dt;
      sw.y += sw.vy * dt;
      if (!sw.hit) {
        var swordOwner = projectileOwner(sw.owner || "R");
        var foes = livingEnemies(swordOwner);
        var fi;
        var abx = sw.x - px0;
        var aby = sw.y - py0;
        for (fi = 0; fi < foes.length; fi++) {
          var foe = foes[fi];
          var apx = foe.x - px0;
          var apy = (foe.y - 74) - py0;
          var ab2 = abx * abx + aby * aby;
          var tt = ab2 > 0.0001 ? (apx * abx + apy * aby) / ab2 : 0;
          if (tt < 0) tt = 0;
          if (tt > 1) tt = 1;
          if (planarDist(foe.x, foe.y - 74, px0 + abx * tt, py0 + aby * tt) < 48) {
            if (foe.phase > 0 || foe.invuln > 0) {
              /* phased: the sword passes through and is not a hit */
            } else {
              hurt(foe, 23, "#ffe56a");
              sw.hit = true;
              break;
            }
          }
        }
      }
      if (sw.life <= 0 || sw.x < -120 || sw.x > W + 120 || sw.y < -120 || sw.y > H + 120) swords.splice(i, 1);
    }

    for (i = spikes.length - 1; i >= 0; i--) {
      var s = spikes[i];
      s.t += dt;
      if (!s.done && s.t >= s.delay) {
        s.done = true;
        var spikeOwner = projectileOwner(s.owner);
        var spikeVictims = livingEnemies(spikeOwner);
        var svi;
        for (svi = 0; svi < spikeVictims.length; svi++) {
          var victim = spikeVictims[svi];
          if (planarDist(victim.x, victim.y, s.x, s.y) <= s.radius + 10) {
            if (victim.phase <= 0 && victim.invuln <= 0) hurt(victim, s.dmg, s.glow);
          }
        }
      }
      if (s.t > s.delay + 0.42) spikes.splice(i, 1);
    }

    for (i = ghosts.length - 1; i >= 0; i--) {
      ghosts[i].life -= dt;
      if (ghosts[i].life <= 0) ghosts.splice(i, 1);
    }
    for (i = rings.length - 1; i >= 0; i--) {
      rings[i].life -= dt;
      if (rings[i].life <= 0) rings.splice(i, 1);
    }
    for (i = wheels.length - 1; i >= 0; i--) {
      wheels[i].life -= dt;
      if (wheels[i].life <= 0) wheels.splice(i, 1);
    }
    for (i = bursts.length - 1; i >= 0; i--) {
      if (bursts[i].delay > 0) { bursts[i].delay -= dt; continue; }
      bursts[i].life -= dt;
      if (bursts[i].life <= 0) bursts.splice(i, 1);
    }
    for (i = sparks.length - 1; i >= 0; i--) {
      var sp = sparks[i];
      sp.life -= dt;
      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
      sp.vy += 420 * dt;
      if (sp.life <= 0) sparks.splice(i, 1);
    }
    for (i = floaters.length - 1; i >= 0; i--) {
      floaters[i].life -= dt;
      floaters[i].y -= 42 * dt;
      if (floaters[i].life <= 0) floaters.splice(i, 1);
    }
  }

  function roundRect(x, y, w, h, r) {
    var rr = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawPine(x, y, sc) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sc, sc);
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.beginPath();
    ctx.ellipse(0, 2, 16, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#3d3428";
    ctx.fillRect(-3, -18, 6, 20);
    ctx.fillStyle = "#2f4634";
    ctx.beginPath();
    ctx.moveTo(0, -78);
    ctx.lineTo(26, -20);
    ctx.lineTo(-26, -20);
    ctx.fill();
    ctx.fillStyle = "#3e5a42";
    ctx.beginPath();
    ctx.moveTo(0, -58);
    ctx.lineTo(20, -8);
    ctx.lineTo(-20, -8);
    ctx.fill();
    ctx.restore();
  }

  function drawLantern(x, y, sc) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sc, sc);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.ellipse(0, 2, 12, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#6d6256";
    ctx.fillRect(-8, -8, 16, 8);
    ctx.fillRect(-3, -28, 6, 22);
    ctx.fillStyle = "#f0c56a";
    ctx.fillRect(-7, -40, 14, 12);
    ctx.fillStyle = "#8a8176";
    ctx.beginPath();
    ctx.moveTo(-11, -42);
    ctx.lineTo(0, -54);
    ctx.lineTo(11, -42);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawStage() {
    if (voidSpace) {
      ctx.fillStyle = "#07080d";
      ctx.fillRect(0, 0, W, H);
      var vg = ctx.createLinearGradient(0, 0, 0, H);
      vg.addColorStop(0, "#10131a");
      vg.addColorStop(1, "#07080c");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
      // Ground band aligned with the normal playable Y (430–680), not a thin strip.
      ctx.strokeStyle = "rgba(214, 222, 232, 0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(36, 560);
      ctx.lineTo(W - 36, 560);
      ctx.stroke();
      ctx.fillStyle = "#12151c";
      ctx.fillRect(0, 562, W, H - 562);
      return;
    }
    if (arenaImg.complete && arenaImg.naturalWidth > 0) {
      // Slight overscan so edges feel full without shifting the ground line.
      var zoom = 1.06;
      var dw = W * zoom;
      var dh = H * zoom;
      var dx = (W - dw) / 2;
      var dy = (H - dh) / 2 + 6;
      ctx.drawImage(arenaImg, dx, dy, dw, dh);
    } else {
      ctx.fillStyle = "#6d583c";
      ctx.fillRect(0, 0, W, H);
    }
    // Soft side fill + vignette (keep ground readable).
    var sideL = ctx.createLinearGradient(0, 0, 90, 0);
    sideL.addColorStop(0, "rgba(8,10,14,0.55)");
    sideL.addColorStop(1, "rgba(8,10,14,0)");
    ctx.fillStyle = sideL;
    ctx.fillRect(0, 0, 110, H);
    var sideR = ctx.createLinearGradient(W, 0, W - 90, 0);
    sideR.addColorStop(0, "rgba(8,10,14,0.55)");
    sideR.addColorStop(1, "rgba(8,10,14,0)");
    ctx.fillStyle = sideR;
    ctx.fillRect(W - 110, 0, 110, H);
    var vig = ctx.createRadialGradient(W / 2, H * 0.42, H * 0.2, W / 2, H * 0.5, H * 0.78);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(0.72, "rgba(0,0,0,0.08)");
    vig.addColorStop(1, "rgba(0,0,0,0.42)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);
    var topShade = ctx.createLinearGradient(0, 0, 0, 120);
    topShade.addColorStop(0, "rgba(6,8,12,0.45)");
    topShade.addColorStop(1, "rgba(6,8,12,0)");
    ctx.fillStyle = topShade;
    ctx.fillRect(0, 0, W, 130);
  }

  function drawHumanoid(x, groundY, facing, palette, weapon, anim, animT, animDur, flash, alpha, hurt, shade) {
    var sc = 2;
    if (shade) {
      alpha *= 0.55;
      palette = { body: "#2a2d33", trim: "#8b949e", glow: "#b7c0c8", deep: "#14161a", hot: "#9aa3ab" };
    }
    ctx.save();
    ctx.translate(x, groundY);
    ctx.scale(facing * sc, sc);
    ctx.globalAlpha = alpha;
    var bob = anim === "dash" ? 0 : Math.sin(time * 2.6 + x * 0.01) * 2.2;
    var lean = 0;
    var arm = -0.4;
    var thrust = 0;
    var slash = 0;
    if (anim === "slash") {
      var u = clamp(animT / animDur, 0, 1);
      slash = Math.sin(u * Math.PI);
      arm = lerp(-1.4, 0.9, u);
      lean = slash * 6;
    } else if (anim === "thrust") {
      var u2 = clamp(animT / animDur, 0, 1);
      thrust = Math.sin(Math.min(1, u2 * 1.3) * Math.PI);
      arm = -0.05;
      lean = thrust * 10;
    } else if (anim === "dash") {
      lean = 14;
      arm = -0.8;
    } else if (anim === "cast") {
      arm = -1.05;
      lean = 4;
    } else if (anim === "blink" || anim === "swap") {
      bob -= 6;
    }
    if (hurt > 0) lean -= 6;

    ctx.translate(lean, bob);

    var skin = flash > 0 ? "#f4fbff" : palette.hot;
    var cloth = flash > 0 ? "#ffffff" : palette.body;
    var edge = flash > 0 ? "#ffffff" : palette.trim;

    ctx.strokeStyle = edge;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-8, -46);
    ctx.lineTo(-12, -18);
    ctx.moveTo(6, -46);
    ctx.lineTo(10 + (anim === "dash" ? 8 : 0), -16);
    ctx.stroke();

    ctx.fillStyle = cloth;
    roundRect(-16, -104, 32, 60, 8);
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = flash > 0 ? "#ffffff" : palette.deep;
    ctx.fillRect(-10, -96, 20, 8);

    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(2, -118, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = 2;
    ctx.stroke();

    if (weapon === "blade") {
      ctx.fillStyle = edge;
      ctx.beginPath();
      ctx.moveTo(-4, -128);
      ctx.lineTo(10, -122);
      ctx.lineTo(-2, -112);
      ctx.fill();
    } else {
      ctx.strokeStyle = edge;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-8, -132);
      ctx.lineTo(0, -120);
      ctx.lineTo(8, -132);
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(8, -86);
    ctx.rotate(arm);
    ctx.strokeStyle = skin;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(26, 6);
    ctx.stroke();

    if (weapon === "blade") {
      ctx.translate(26, 6);
      ctx.rotate(-0.6 + slash * 0.2);
      ctx.fillStyle = flash > 0 ? "#ffffff" : palette.glow;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(28, -16, 46, 4);
      ctx.quadraticCurveTo(24, 8, 0, 6);
      ctx.fill();
      if (slash > 0.15) {
        ctx.globalAlpha = alpha * slash;
        ctx.strokeStyle = palette.glow;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(6, -4, 34 + slash * 10, -1.3, 0.95);
        ctx.stroke();
      }
    } else {
      ctx.translate(26, 6);
      var ext = 18 + thrust * 62;
      ctx.strokeStyle = flash > 0 ? "#ffffff" : palette.trim;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-6, 0);
      ctx.lineTo(ext, 0);
      ctx.stroke();
      ctx.fillStyle = flash > 0 ? "#ffffff" : palette.glow;
      ctx.beginPath();
      ctx.moveTo(ext, 0);
      ctx.lineTo(ext - 12, -5);
      ctx.lineTo(ext - 12, 5);
      ctx.fill();
      if (thrust > 0.2) {
        ctx.globalAlpha = alpha * thrust * 0.8;
        ctx.strokeStyle = palette.glow;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(8, -3);
        ctx.lineTo(ext - 8, -3);
        ctx.moveTo(8, 3);
        ctx.lineTo(ext - 8, 3);
        ctx.stroke();
      }
    }
    ctx.restore();
    if (shade) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, alpha * 1.15);
      ctx.strokeStyle = "rgba(226,232,238,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(2, -118, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      roundRect(-18, -108, 36, 64, 10);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  function drawVoidArmor(f) {
    var sc = 2;
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.scale((f.facing < 0 ? -1 : 1) * sc, sc);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    ctx.globalAlpha = 0.55;
    ctx.fillStyle = "#5b2e96";
    ctx.beginPath();
    ctx.moveTo(-18, -148);
    ctx.lineTo(-78, -214);
    ctx.lineTo(-36, -168);
    ctx.lineTo(-62, -186);
    ctx.lineTo(-8, -142);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 0.62;
    ctx.fillStyle = "#7c46c4";
    ctx.beginPath();
    ctx.moveTo(6, -28);
    ctx.quadraticCurveTo(78, -55, 52, -148);
    ctx.quadraticCurveTo(28, -196, -36, -168);
    ctx.quadraticCurveTo(-62, -110, -18, -28);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = "rgba(42, 12, 72, 0.55)";
    ctx.lineWidth = 2;
    ctx.stroke();

    var rib;
    ctx.strokeStyle = "rgba(232, 206, 255, 0.45)";
    ctx.lineWidth = 2;
    for (rib = 0; rib < 7; rib++) {
      var yy = -48 - rib * 15;
      ctx.beginPath();
      ctx.moveTo(-30, yy + 4);
      ctx.quadraticCurveTo(8, yy - 10, 46, yy + 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 0.72;
    ctx.fillStyle = "#9460dc";
    ctx.beginPath();
    ctx.ellipse(-6, -158, 54, 24, -0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(40, 10, 70, 0.45)";
    ctx.stroke();

    ctx.strokeStyle = "#6a38b0";
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.moveTo(18, -132);
    ctx.quadraticCurveTo(78, -118, 108, -86);
    ctx.stroke();
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(108, -86);
    ctx.lineTo(146, -62);
    ctx.stroke();
    ctx.fillStyle = "#a56ee6";
    ctx.beginPath();
    ctx.arc(154, -56, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 220, 90, 0.85)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(120, -78);
    ctx.lineTo(168, -48);
    ctx.stroke();

    ctx.globalAlpha = 0.84;
    ctx.fillStyle = "#8d58d4";
    ctx.beginPath();
    ctx.moveTo(-6, -178);
    ctx.quadraticCurveTo(8, -214, 40, -192);
    ctx.quadraticCurveTo(64, -178, 52, -158);
    ctx.lineTo(28, -150);
    ctx.quadraticCurveTo(4, -156, -10, -168);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffe14a";
    ctx.beginPath();
    ctx.ellipse(24, -182, 7, 4, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#3a2200";
    ctx.beginPath();
    ctx.arc(26, -182, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#3a1868";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(34, -164);
    ctx.lineTo(50, -158);
    ctx.stroke();

    ctx.strokeStyle = "rgba(110, 62, 186, 0.8)";
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.moveTo(-6, -30);
    ctx.lineTo(-14, -2);
    ctx.moveTo(18, -30);
    ctx.lineTo(26, 0);
    ctx.stroke();
    ctx.restore();
  }

  function obitoImage(set, index) {
    if (!set || !set.length) return null;
    var i = index % set.length;
    if (i < 0) i += set.length;
    var img = set[i];
    if (!img || !img.complete || !img.naturalWidth) return null;
    return img;
  }

  function drawObitoAt(x, groundY, facing, set, index, alpha, phased, footDrop, tilt, shakeAmp, scaleMul) {
    var img = obitoImage(set, index);
    if (!img) return;
    var sc = obitoScale * (scaleMul || 1);
    var sx = 0;
    var sy = 0;
    if (shakeAmp && shakeAmp > 0) {
      sx = (Math.random() * 2 - 1) * shakeAmp * 5;
      sy = (Math.random() * 2 - 1) * shakeAmp * 2.5;
      sc = sc * (1 - Math.min(0.08, shakeAmp * 0.35));
    }
    var dw = img.width * sc;
    var dh = img.height * sc;
    ctx.save();
    // Plant canvas bottom on ground; empty top padding of knock cells does not shrink the body.
    ctx.translate(x + sx, groundY + 2 + (footDrop || 0) + sy);
    if (tilt) ctx.rotate(tilt);
    ctx.scale(facing < 0 ? -1 : 1, 1);
    ctx.globalAlpha = alpha;
    // 虚化 keeps the normal colours; only alpha (set by the caller) makes it see-through.
    ctx.drawImage(img, -dw / 2, -dh, dw, dh);
    ctx.restore();
  }

  function drawSharingan(f, bodyH) {
    if (!sharinganImg.complete || sharinganImg.naturalWidth <= 0) return;
    var size = bodyH * 1.4;
    ctx.save();
    ctx.translate(f.x, f.y + 2 - bodyH * 0.5);
    ctx.rotate(time * Math.PI * 4);
    ctx.drawImage(sharinganImg, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  function drawObito(f) {
    var set = obito.idle;
    var idx = 0;
    var alpha = 1;
    var reacting = isAirborne(f) || isDowned(f) || ((f.stun || 0) > 0 && f.hitLight);
    if ((f.knockPhase === "air" || isAirborne(f)) && obito.knock && obito.knock[0] && obito.knock[0].complete) {
      set = obito.knock;
      idx = Math.min(10, Math.floor((f.knockT || 0) * 18));
    } else if ((f.knockPhase === "down" || isDowned(f) || (f.getUpT || 0) > 0 || (f.downT || 0) > 0) && obito.knock && obito.knock[0] && obito.knock[0].complete) {
      set = obito.knock;
      var kt = f.knockT || 0;
      if ((f.getUpT || 0) > 0) {
        // Hold last downed frames through get-up — never fall back to tilted idle
        idx = 15;
      } else if (kt < 0.12) idx = 11;
      else if (kt < 0.28) idx = 12;
      else if (kt < 0.45) idx = 13;
      else if (kt < 0.65) idx = 14;
      else idx = 15;
    } else if (reacting) {
      set = obito.idle;
      idx = 0;
    } else if (f.anim === "tele") {
      set = obito.tele;
      var half = f.animDur * 0.5;
      var tu = f.teleBlinked ? (f.animT - half) / half : f.animT / half;
      if (tu < 0) tu = 0;
      if (tu > 0.999) tu = 0.999;
      idx = (f.teleBlinked ? 4 : 0) + Math.floor(tu * 4);
    } else if (f.anim === "punch" || f.anim === "breath") {
      if (f.anim === "punch") set = obito.punch;
      else set = obito.breath;
      var u = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (u < 0) u = 0;
      if (u > 0.999) u = 0.999;
      idx = Math.floor(u * 8);
    } else if (f.gait === "run" || f.gait === "walk") {
      set = obito.run;
      idx = Math.floor(time * 11) % 8;
    } else {
      set = obito.idle;
      idx = 0;
      if (obito.cloth[0] && obito.cloth[0].complete && obito.cloth[0].naturalWidth > 0) {
        set = obito.cloth;
        idx = Math.floor(time * clothFps) % 12;
      }
    }
    var phased = f.phase > 0;
    var knocking = set === obito.knock;
    var gettingUp = (f.getUpT || 0) > 0 || (f.downT || 0) > 0 || !!f.knockPhase || isDowned(f);
    // pages30d: knockdown/air/getUp stay fully opaque — never invuln blink / tilted idle ghost
    if (knocking || gettingUp) {
      alpha = 1;
      phased = false;
    } else if (phased) {
      alpha = 0.45;
    } else if (f.anim !== "tele" && f.invuln > 0 && !isDowned(f) && !isAirborne(f) && !(f.knockPhase) && !(f.knockNoBlink > 0) && Math.sin(time * 40) > 0) {
      alpha *= 0.45;
    }
    if (phased && phaseSlow > 0) {
      var bodyFrame = obitoImage(set, idx);
      var bodyH = bodyFrame ? bodyFrame.height * obitoScale : 280;
      drawSharingan(f, bodyH);
    }
    var footDrop = 0;
    var knockBoost = 1;
    if (set === obito.tele) {
      var pad = teleFootPad[idx];
      if (pad == null) pad = obitoIdleFootPad;
      footDrop = (pad - obitoIdleFootPad) * obitoScale;
    } else if (set === obito.idle) {
      var ipad = obitoIdleFootPads[idx];
      if (ipad == null) ipad = obitoIdleFootPads[0];
      footDrop = (ipad - obitoIdleFootPads[0]) * obitoScale;
    } else if (knocking) {
      // pages30d: art sets knock 11–16 logical size to 225×257; extra boost so downed body ≈ standing
      footDrop = 0;
      var kimg = obitoImage(set, idx);
      if (kimg && kimg.width >= 200) knockBoost = 1.55;
      else knockBoost = 1.05;
    }
    drawObitoAt(f.x, f.y - (f.airH || 0), f.facing, set, idx, alpha, phased, footDrop, knocking ? 0 : fighterDrawTilt(f), knocking ? 0 : (f.hitShake || 0), knockBoost);
  }

  function drawGroundShadow(f) {
    var body = isObito(f) ? obitoScale : (isTanjiro(f) ? tanjiroScale * 1.15 : (isGojo(f) ? gojoScale * 1.1 : (isLuffy(f) ? luffyScale * 1.1 : (isIchigo(f) ? ichigoScale * 1.1 : (isFushiguro(f) ? fushiScale * 1.1 : painScale)))));
    var lunging = f.anim === "punch" || f.anim === "tele" || f.anim === "breath" || f.anim === "thrust" || f.anim === "cleave" || f.anim === "slash" || f.anim === "dash" || f.anim === "swap" || f.anim === "combo" || f.anim === "kick" || f.anim === "rod" || f.anim === "push" || f.anim === "back" || (f.anim && f.anim.indexOf("t_") === 0);
    var rx = 32;
    var ry = 9;
    var ox = 0;
    if (lunging || f.gait === "run") {
      rx = 56;
      ry = 6;
      ox = 14;
    } else if (f.gait === "walk") {
      rx = 42;
      ry = 8;
      ox = 6;
    }
    if (isDowned(f)) {
      rx = 58;
      ry = 7;
      ox = 0;
    }
    var lift = f.airH || 0;
    var shrink = 1 / (1 + lift * 0.004);
    ctx.save();
    ctx.translate(f.x, f.y + 4);
    ctx.scale(f.facing < 0 ? -1 : 1, 1);
    ctx.scale(body * shrink, body * shrink);
    ctx.globalAlpha = 0.38 * shrink;
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.beginPath();
    ctx.ellipse(ox, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function painImage(set, index) {
    if (!set || !set.length) return null;
    var i = index % set.length;
    if (i < 0) i += set.length;
    var img = set[i];
    if (!img || !img.complete || !img.naturalWidth) return null;
    return img;
  }

  function drawPainRepulse(x, groundY, facing, index, alpha) {
    var img = painImage(pain.repulse, index);
    if (!img) return false;
    var dw = img.width * repulseScale;
    var dh = img.height * repulseScale;
    var y = groundY + 2 + painFootDrop - painIdleFootPad * painScale + repulseFootPad * repulseScale;
    ctx.save();
    ctx.translate(x, y);
    // Pain art faces left; flip when facing right (opposite of Obito).
    ctx.scale(facing < 0 ? 1 : -1, 1);
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, -dw / 2, -dh, dw, dh);
    ctx.restore();
    return true;
  }

  function drawPainPullCast(x, groundY, facing, index, alpha) {
    var img = painImage(pain.pullCast, index);
    if (!img) return false;
    var dw = img.width * pullCastScale;
    var dh = img.height * pullCastScale;
    var y = groundY + 2 + painFootDrop - painIdleFootPad * painScale + pullCastFootPad * pullCastScale;
    ctx.save();
    ctx.translate(x, y);
    // Cast sheet faces right (same as push/attack strips).
    ctx.scale(facing < 0 ? -1 : 1, 1);
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, -dw / 2, -dh, dw, dh);
    ctx.restore();
    return true;
  }

  // Native facing of each pain strip: idle (and the repulse sheet) is drawn facing
  // left, while run/walk/dash/back and the attack strips are drawn facing right.
  function painNativeLeft(set) {
    return set === pain.idle || set === pain.turn || set === pain.cloth;
  }

  function drawPainAt(x, groundY, facing, set, index, alpha, footDrop, tilt, shakeAmp) {
    var img = painImage(set, index);
    if (!img) return;
    var sc = painScale / painFrameScale;
    var sx = 0;
    var sy = 0;
    if (shakeAmp && shakeAmp > 0) {
      sx = (Math.random() * 2 - 1) * shakeAmp * 5;
      sy = (Math.random() * 2 - 1) * shakeAmp * 2.5;
      sc = sc * (1 - Math.min(0.08, shakeAmp * 0.35));
    }
    var dw = img.width * sc;
    var dh = img.height * sc;
    ctx.save();
    ctx.translate(x + sx, groundY + 2 + painFootDrop + (footDrop || 0) + sy);
    if (tilt) ctx.rotate(tilt);
    // Flip so the art always looks along `facing` (-1 left, 1 right).
    var nativeDir = painNativeLeft(set) ? -1 : 1;
    ctx.scale((facing < 0 ? -1 : 1) * nativeDir, 1);
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, -dw / 2, -dh, dw, dh);
    ctx.restore();
  }

  function drawPain(f) {
    if (f.pullOn && !isAirborne(f) && !isDowned(f) && !(f.hitLight && (f.stun || 0) > 0)) {
      var pidx = Math.floor((f.pullAnimT || 0) * pullCastFps);
      if (pidx < 0) pidx = 0;
      if (pidx > 23) pidx = 23;
      if (drawPainPullCast(f.x, f.y, f.facing, pidx, 1)) return;
    }
    if (f.repulseOn && !isAirborne(f) && !isDowned(f) && !(f.hitLight && (f.stun || 0) > 0)) {
      var last = f.repulseLong === false ? 11 : 19;
      var ridx = Math.floor((f.repulseT || 0) * repulseFps);
      if (ridx < 0) ridx = 0;
      if (ridx > last) ridx = last;
      if (drawPainRepulse(f.x, f.y, f.facing, ridx, 1)) return;
    }
    var set = pain.idle;
    var idx = 0;
    var alpha = 1;
    if ((f.downT || 0) > 0) {
      set = pain.land;
      idx = Math.min(5, 3 + Math.floor((0.72 - Math.max(0, f.downT)) / 0.72 * 3));
    } else if ((f.getUpT || 0) > 0 && (f.getUpMax || 0) > 0) {
      set = pain.land;
      var gu = f.getUpT / f.getUpMax;
      idx = Math.min(5, Math.floor(gu * 4));
    } else if (isAirborne(f)) {
      set = pain.jump;
      var ju = (f.airH || 0) / 220;
      if (ju > 0.999) ju = 0.999;
      idx = Math.min(5, Math.floor(ju * 6));
    } else if (f.hitLight && (f.stun || 0) > 0) {
      set = pain.back;
      var bu = 1 - Math.min(1, (f.stun || 0) / 0.55);
      idx = Math.min(5, Math.floor(bu * 4));
    } else if (f.anim === "combo" || f.anim === "kick" || f.anim === "rod" || f.anim === "push" || f.anim === "back" || f.anim === "pull") {
      if (f.anim === "combo") set = pain.combo;
      else if (f.anim === "kick") set = pain.kick;
      else if (f.anim === "rod") set = pain.rod;
      else if (f.anim === "push") set = pain.push;
      else if (f.anim === "pull") set = pain.push;
      else set = pain.back;
      var u = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (u < 0) u = 0;
      if (u > 0.999) u = 0.999;
      idx = Math.floor(u * 6);
      // pages25: rod_04 in the source strip is only the flying rod (no body) — Pain vanished for
      // a frame and the drawn rod looked like it flew through the target. Hold the throw pose instead.
      if (f.anim === "rod" && idx === 3) idx = 2;
    } else if (f.gait === "run" || f.gait === "walk") {
      set = pain.run;
      idx = Math.floor(time * 11) % 6;
    } else {
      set = pain.idle;
      idx = 0;
      if (pain.cloth[0] && pain.cloth[0].complete && pain.cloth[0].naturalWidth > 0) {
        set = pain.cloth;
        idx = Math.floor(time * clothFps) % 12;
      }
    }
    if (f.invuln > 0 && !isDowned(f) && !isAirborne(f) && Math.sin(time * 40) > 0) alpha *= 0.45;
    var footDrop = 0;
    var padKey = null;
    if (set === pain.idle) padKey = "idle";
    else if (set === pain.cloth) padKey = "cloth";
    else if (set === pain.walk) padKey = "walk";
    else if (set === pain.run) padKey = "run";
    else if (set === pain.dash) padKey = "dash";
    else if (set === pain.back) padKey = "back";
    else if (set === pain.combo) padKey = "combo";
    else if (set === pain.kick) padKey = "kick";
    else if (set === pain.rod) padKey = "rod";
    else if (set === pain.push) padKey = "push";
    else if (set === pain.turn) padKey = "turn";
    else if (set === pain.land) padKey = "land";
    else if (set === pain.jump) padKey = "jump";
    if (padKey && painFootPads[padKey]) {
      var ppad = painFootPads[padKey][idx];
      if (ppad == null) ppad = painFootPads[padKey][0];
      footDrop = (ppad - 21) * painScale / painFrameScale;
    }
    // Pain skills/actions: never float on airH
    var drawAir = (f.airH || 0);
    if (f.pullOn || f.repulseOn || f.busy > 0 || f.anim === "combo" || f.anim === "kick" || f.anim === "rod" || f.anim === "push" || f.anim === "back" || f.anim === "pull") drawAir = 0;
    drawPainAt(f.x, f.y - drawAir, f.facing, set, idx, alpha, footDrop, fighterDrawTilt(f), f.hitShake || 0);
  }

  function drawHyperArmorAura(f) {
    if (!(f.hyperArmor > 0)) return;
    var t = time || 0;
    var pulse = 0.55 + 0.45 * Math.sin(t * 8);
    var ax = f.x;
    var ay = f.y - 70 - (f.airH || 0);
    ctx.save();
    ctx.globalAlpha = 0.28 + 0.18 * pulse;
    ctx.strokeStyle = "#ff7a30";
    ctx.lineWidth = 4;
    ctx.shadowColor = "#ff9040";
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.ellipse(ax, ay, 52 + pulse * 6, 78 + pulse * 4, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.16 + 0.1 * pulse;
    ctx.fillStyle = "rgba(255,110,40,0.25)";
    ctx.beginPath();
    ctx.ellipse(ax, ay, 40, 64, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }


  function tanjiroImage(set, index) {
    if (!set || !set.length) return null;
    var i = index % set.length;
    if (i < 0) i += set.length;
    var img = set[i];
    if (!img || !img.complete || !img.naturalWidth) return null;
    return img;
  }
  // pages28: Tanjiro sheets were drawn facing different ways. Idle/walk/atk face LEFT;
  // dash/lunge sets mostly face RIGHT. Flip with a nativeDir so facing matches movement.
  function tanjiroNativeDir(set) {
    if (!set) return 1;
    // pages30e: idle/atk sheets face LEFT in source art; nativeDir -1 so facing+1 draws facing right.
    if (set === tanjiro.idle || set === tanjiro.water.atk || set === tanjiro.fire.atk) return -1;
    if (set === tanjiro.water.water2c || set === tanjiro.fire.water2c) return -1;
    // pages30g: run art faces RIGHT → nativeDir +1
    if (set === tanjiro.run) return 1;
    // hitstun/knockdown + dash/lunge sets face RIGHT in source
    if (set === tanjiro.hitstun || set === tanjiro.knock) return 1;
    // 二型 / 四型 / 一型 / 大招
    return 1;
  }
  function drawTanjiroAt(x, groundY, facing, set, index, alpha, tilt, shakeAmp) {
    var img = tanjiroImage(set, index);
    if (!img) return;
    var sc = tanjiroScale;
    var sx = 0;
    var sy = 0;
    if (shakeAmp && shakeAmp > 0) {
      sx = (Math.random() * 2 - 1) * shakeAmp * 5;
      sy = (Math.random() * 2 - 1) * shakeAmp * 2.5;
      sc = sc * (1 - Math.min(0.08, shakeAmp * 0.35));
    }
    var dw = img.width * sc;
    var dh = img.height * sc;
    // Plant soles: source foot line ~20px above PNG bottom.
    var y = groundY + 2 + tanjiroFootPad * sc;
    ctx.save();
    ctx.translate(x + sx, y + sy);
    if (tilt) ctx.rotate(tilt);
    var nativeDir = tanjiroNativeDir(set);
    ctx.scale((facing < 0 ? -1 : 1) * nativeDir, 1);
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, -dw / 2, -dh, dw, dh);
    ctx.restore();
  }
  function drawTanjiroBarrier(f) {
    if (!(f.barrierT > 0) || f.barrierUsed) return;
    var r = tanjiroBodyW * 0.8;
    var h = tanjiroBodyH * 1.6;
    var pulse = 0.55 + 0.45 * Math.sin(time * 10);
    ctx.save();
    ctx.translate(f.x, f.y - h * 0.42);
    ctx.globalAlpha = 0.22 + 0.16 * pulse;
    ctx.strokeStyle = "#5ee0d0";
    ctx.lineWidth = 3;
    ctx.shadowColor = "#7af0e0";
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, h * 0.5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.12 + 0.08 * pulse;
    ctx.fillStyle = "rgba(80,220,210,0.35)";
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.85, h * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  function drawTanjiro(f) {
    drawTanjiroBarrier(f);
    var set = tanjiro.idle;
    var idx = 0;
    var alpha = 1;
    var form = tanjiroSet(f);
    var reacting = isAirborne(f) || isDowned(f) || ((f.stun || 0) > 0 && f.hitLight);
    var drawFacing = f.facing;
    // pages29: during hit reaction face away from knock direction so right-facing art recoils backward correctly
    if (reacting && (f.hitLeanDir || 0)) {
      drawFacing = (f.hitLeanDir > 0) ? -1 : 1;
    }
    if ((f.knockPhase === "air" || isAirborne(f)) && tanjiro.knock && tanjiro.knock[0] && tanjiro.knock[0].complete) {
      set = tanjiro.knock;
      // 6 frames: 0 hit · 1-2 air · 3 tumble  — map by knockT
      var kat = f.knockT || 0;
      if (kat < 0.08) idx = 0;
      else if (kat < 0.22) idx = 1;
      else if (kat < 0.40) idx = 2;
      else idx = 3;
    } else if ((f.knockPhase === "down" || isDowned(f)) && tanjiro.knock && tanjiro.knock[0] && tanjiro.knock[0].complete) {
      set = tanjiro.knock;
      var kdt = f.knockT || 0;
      if ((f.getUpT || 0) > 0) idx = 5;
      else if (kdt < 0.18) idx = 4;
      else idx = 5;
    } else if (f.hitLight && (f.stun || 0) > 0 && tanjiro.hitstun && tanjiro.hitstun[0] && tanjiro.hitstun[0].complete) {
      set = tanjiro.hitstun;
      // progress through flinch: early frames = impact, later = recover
      var su = 1 - Math.min(1, (f.stun || 0) / 0.55);
      idx = Math.min(5, Math.floor(su * 6));
    } else if (reacting) {
      set = tanjiro.idle;
      idx = 0;
    } else if (f.anim === "t_atk") {
      set = form.atk;
      var u = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (u < 0) u = 0; if (u > 0.999) u = 0.999;
      idx = Math.min(5, Math.floor(u * 6));
    } else if (f.anim === "t_water2") {
      set = form.water2;
      var u2 = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (u2 < 0) u2 = 0; if (u2 > 0.999) u2 = 0.999;
      idx = Math.min(5, Math.floor(u2 * 6));
    } else if (f.anim === "t_counter") {
      set = form.water2c;
      var uc = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (uc < 0) uc = 0; if (uc > 0.999) uc = 0.999;
      idx = Math.min(5, Math.floor(uc * 6));
    } else if (f.anim === "t_water4") {
      set = form.water4;
      var u4 = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (u4 < 0) u4 = 0; if (u4 > 0.999) u4 = 0.999;
      idx = Math.min(5, Math.floor(u4 * 6));
    } else if (f.anim === "t_water1") {
      set = form.water1;
      var u1 = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (u1 < 0) u1 = 0; if (u1 > 0.999) u1 = 0.999;
      idx = Math.min(5, Math.floor(u1 * 6));
    } else if (f.anim === "t_ult1") {
      set = tanjiro.ult1;
      var uu = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (uu < 0) uu = 0; if (uu > 0.999) uu = 0.999;
      idx = Math.min(5, Math.floor(uu * 6));
    } else if (f.anim === "t_ult2") {
      set = tanjiro.ult2;
      var u7 = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (u7 < 0) u7 = 0; if (u7 > 0.999) u7 = 0.999;
      idx = Math.min(5, Math.floor(u7 * 6));
    } else if ((f.barrierT || 0) > 0 && !f.barrierUsed && f.gait !== "run" && f.gait !== "walk") {
      // pages25: hold the 二型 guard pose for the whole stance instead of dropping to idle
      set = form.water2;
      idx = 3 + (Math.floor(time * 6) % 2);
    } else if (f.gait === "run" || f.gait === "walk") {
      // pages30g: dedicated run strip (8 frames); fall back to idle if unbound
      set = (tanjiro.run && tanjiro.run[0] && tanjiro.run[0].complete) ? tanjiro.run : tanjiro.idle;
      idx = Math.floor(time * 10) % 8;
    } else {
      set = tanjiro.idle;
      idx = Math.floor(time * 8) % 8;
    }
    if (f.invuln > 0 && !isDowned(f) && !isAirborne(f) && Math.sin(time * 40) > 0) alpha *= 0.45;
    // pages25: small forward lunge on sword swings so the strike reads even with subtle frames
    var lungeX = 0, swingTilt = 0;
    if (!reacting && (f.anim === "t_atk" || f.anim === "t_counter" || f.anim === "t_water1")) {
      var lu = f.animDur > 0 ? Math.min(1, f.animT / f.animDur) : 1;
      lungeX = f.facing * Math.sin(Math.PI * lu) * tanjiroBodyW * 0.16;
      swingTilt = f.facing * Math.sin(Math.PI * lu) * 0.06;
    }
    if (f.fireForm) drawTanjiroFireAura(f, true);
    var drawAir = (f.airH || 0);
    if (f.busy > 0 || (f.ult2Phase || 0) > 0 || (f.counterT || 0) > 0 || (f.anim && f.anim.indexOf("t_") === 0)) drawAir = 0;
    // pages29: hitstun/knockdown skip lean tilt — the art already carries the pose
    var tiltUse = (set === tanjiro.hitstun || set === tanjiro.knock) ? 0 : (fighterDrawTilt(f) + swingTilt);
    drawTanjiroAt(f.x + lungeX, f.y - drawAir, drawFacing, set, idx, alpha, tiltUse, f.hitShake || 0);
    if (f.fireForm) drawTanjiroFireAura(f, false);
  }
  // pages25: 火之形态 needs to read at a glance: glow + flickering flame tongues + embers.
  function drawTanjiroFireAura(f, behind) {
    var cx = f.x, top = f.y - tanjiroBodyH * 1.02, h = tanjiroBodyH;
    var w = tanjiroBodyW * 0.62;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    if (behind) {
      var g = ctx.createRadialGradient(cx, f.y - h * 0.48, 8, cx, f.y - h * 0.48, h * 0.75);
      g.addColorStop(0, "rgba(255,140,40,0.42)");
      g.addColorStop(0.55, "rgba(255,70,20,0.20)");
      g.addColorStop(1, "rgba(255,40,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, f.y - h * 0.48, w * 1.25, h * 0.72, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    var n = behind ? 9 : 5, i;
    for (i = 0; i < n; i++) {
      var ph = (time * (2.2 + (i % 3) * 0.5) + i * 0.37) % 1;
      var fxp = cx + (((i * 0.618) % 1) - 0.5) * w * (behind ? 2.0 : 1.4);
      var fy = f.y - h * 0.08 - ph * h * (behind ? 1.0 : 0.75);
      var fs = (1 - ph) * (behind ? 22 : 13) + 4;
      ctx.globalAlpha = (1 - ph) * (behind ? 0.75 : 0.55);
      var fg = ctx.createRadialGradient(fxp, fy, 1, fxp, fy, fs);
      fg.addColorStop(0, "rgba(255,240,180,1)");
      fg.addColorStop(0.4, "rgba(255,150,40,0.9)");
      fg.addColorStop(1, "rgba(255,60,0,0)");
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(fxp - fs * 0.6, fy + fs * 0.4);
      ctx.quadraticCurveTo(fxp - fs * 0.5, fy - fs * 0.6, fxp + Math.sin(time * 9 + i) * fs * 0.3, fy - fs * 1.6);
      ctx.quadraticCurveTo(fxp + fs * 0.5, fy - fs * 0.6, fxp + fs * 0.6, fy + fs * 0.4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }


  function gojoImage(set, index) {
    if (!set || !set.length) return null;
    var i = index % set.length;
    if (i < 0) i += set.length;
    var img = set[i];
    if (!img || !img.complete || !img.naturalWidth) return null;
    return img;
  }
  // pages30m: gojo art faces RIGHT → nativeDir +1
  function gojoNativeDir(set) {
    return 1;
  }
  function drawGojoAt(x, groundY, facing, set, index, alpha, tilt, shakeAmp) {
    var img = gojoImage(set, index);
    if (!img) return;
    var sc = gojoScale;
    var sx = 0;
    var sy = 0;
    if (shakeAmp && shakeAmp > 0) {
      sx = (Math.random() * 2 - 1) * shakeAmp * 5;
      sy = (Math.random() * 2 - 1) * shakeAmp * 2.5;
      sc = sc * (1 - Math.min(0.08, shakeAmp * 0.35));
    }
    var dw = img.width * sc;
    var dh = img.height * sc;
    var y = groundY + 2 + gojoFootPad * sc;
    ctx.save();
    ctx.translate(x + sx, y + sy);
    if (tilt) ctx.rotate(tilt);
    var nativeDir = gojoNativeDir(set);
    ctx.scale((facing < 0 ? -1 : 1) * nativeDir, 1);
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, -dw / 2, -dh, dw, dh);
    ctx.restore();
  }
  function drawGojoInfinityAura(f) {
    if (!(f.phase > 0)) return;
    var pulse = 0.55 + 0.45 * Math.sin(time * 9);
    ctx.save();
    ctx.translate(f.x, f.y - gojoBodyH * 0.45);
    ctx.globalAlpha = 0.18 + 0.12 * pulse;
    ctx.strokeStyle = "#a0c8ff";
    ctx.lineWidth = 3;
    ctx.shadowColor = "#c8e0ff";
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.ellipse(0, 0, gojoBodyW * 0.85, gojoBodyH * 0.55, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  function drawGojoDomainRing(f) {
    if (!(f.domainT > 0)) return;
    var pulse = 0.5 + 0.5 * Math.sin(time * 4);
    ctx.save();
    ctx.globalAlpha = 0.14 + 0.08 * pulse;
    ctx.strokeStyle = "#c080ff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(f.x, f.y - 20, 350, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  function drawGojo(f) {
    drawGojoDomainRing(f);
    drawGojoInfinityAura(f);
    var set = gojo.idle;
    var idx = 0;
    var alpha = 1;
    var reacting = isAirborne(f) || isDowned(f) || ((f.stun || 0) > 0 && f.hitLight);
    var drawFacing = f.facing;
    if (reacting && (f.hitLeanDir || 0)) {
      drawFacing = (f.hitLeanDir > 0) ? -1 : 1;
    }
    if ((f.knockPhase === "air" || isAirborne(f)) && gojo.knock && gojo.knock[0] && gojo.knock[0].complete) {
      set = gojo.knock;
      var kat = f.knockT || 0;
      if (kat < 0.08) idx = 0;
      else if (kat < 0.22) idx = 1;
      else if (kat < 0.40) idx = 2;
      else idx = 3;
    } else if ((f.knockPhase === "down" || isDowned(f)) && gojo.knock && gojo.knock[0] && gojo.knock[0].complete) {
      set = gojo.knock;
      var kdt = f.knockT || 0;
      if ((f.getUpT || 0) > 0) idx = 5;
      else if (kdt < 0.18) idx = 4;
      else idx = 5;
    } else if (f.hitLight && (f.stun || 0) > 0 && gojo.hitstun && gojo.hitstun[0] && gojo.hitstun[0].complete) {
      set = gojo.hitstun;
      var su = 1 - Math.min(1, (f.stun || 0) / 0.55);
      idx = Math.min(5, Math.floor(su * 6));
    } else if (reacting) {
      set = gojo.idle;
      idx = 0;
    } else if (f.anim === "g_atk" && gojo.atk && gojo.atk[0] && gojo.atk[0].complete) {
      set = gojo.atk;
      var ua = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (ua < 0) ua = 0; if (ua > 0.999) ua = 0.999;
      idx = Math.min(5, Math.floor(ua * 6));
    } else if (f.anim === "g_blue" && gojo.blue && gojo.blue[0] && gojo.blue[0].complete) {
      set = gojo.blue;
      var ub = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (ub < 0) ub = 0; if (ub > 0.999) ub = 0.999;
      idx = Math.min(5, Math.floor(ub * 6));
    } else if (f.anim === "g_red" && gojo.red && gojo.red[0] && gojo.red[0].complete) {
      set = gojo.red;
      var ur = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (ur < 0) ur = 0; if (ur > 0.999) ur = 0.999;
      idx = Math.min(5, Math.floor(ur * 6));
    } else if (f.anim === "g_blink" && gojo.blink && gojo.blink[0] && gojo.blink[0].complete) {
      set = gojo.blink;
      var uk = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (uk < 0) uk = 0; if (uk > 0.999) uk = 0.999;
      idx = Math.min(5, Math.floor(uk * 6));
    } else if (f.anim === "g_inf" && gojo.infinity && gojo.infinity[0] && gojo.infinity[0].complete) {
      set = gojo.infinity;
      var ui = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (ui < 0) ui = 0; if (ui > 0.999) ui = 0.999;
      idx = Math.min(5, Math.floor(ui * 6));
    } else if (f.anim === "g_domain" && gojo.domain && gojo.domain[0] && gojo.domain[0].complete) {
      set = gojo.domain;
      var ud = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (ud < 0) ud = 0; if (ud > 0.999) ud = 0.999;
      idx = Math.min(5, Math.floor(ud * 6));
    } else if (f.anim && f.anim.indexOf("g_") === 0) {
      set = gojo.idle;
      idx = Math.min(7, Math.floor(((f.animT || 0) / Math.max(0.01, f.animDur || 0.4)) * 8));
    } else if (f.phase > 0 && gojo.infinityLoop && gojo.infinityLoop[0] && gojo.infinityLoop[0].complete) {
      // pages30r: 无下限持续循环（phase 剩余期间）
      set = gojo.infinityLoop;
      idx = Math.floor(time * 8) % 4;
    } else if (f.gait === "run" || f.gait === "walk") {
      // pages30n: run = 土豪过审定稿
      set = (gojo.run && gojo.run[0] && gojo.run[0].complete) ? gojo.run : gojo.idle;
      idx = Math.floor(time * 10) % 8;
    } else {
      set = gojo.idle;
      idx = Math.floor(time * 8) % 8;
    }
    if (f.phase > 0) alpha = 0.55;
    else if (f.invuln > 0 && !isDowned(f) && !isAirborne(f) && Math.sin(time * 40) > 0) alpha *= 0.45;
    var drawAir = (f.airH || 0);
    if (f.busy > 0 || (f.anim && f.anim.indexOf("g_") === 0)) drawAir = 0;
    var tiltUse = (set === gojo.hitstun || set === gojo.knock) ? 0 : fighterDrawTilt(f);
    drawGojoAt(f.x, f.y - drawAir, drawFacing, set, idx, alpha, tiltUse, f.hitShake || 0);
  }

  function luffyImage(set, index) {
    if (!set || !set.length) return null;
    var i = index % set.length;
    if (i < 0) i += set.length;
    var img = set[i];
    if (!img || !img.complete || !img.naturalWidth) return null;
    return img;
  }
  // pages30t: luffy art faces RIGHT → nativeDir +1
  function luffyNativeDir(set) {
    return 1;
  }
  function drawLuffyAt(x, groundY, facing, set, index, alpha, tilt, shakeAmp) {
    var img = luffyImage(set, index);
    if (!img) return;
    var sc = luffyScale;
    var sx = 0;
    var sy = 0;
    if (shakeAmp && shakeAmp > 0) {
      sx = (Math.random() * 2 - 1) * shakeAmp * 5;
      sy = (Math.random() * 2 - 1) * shakeAmp * 2.5;
      sc = sc * (1 - Math.min(0.08, shakeAmp * 0.35));
    }
    var dw = img.width * sc;
    var dh = img.height * sc;
    var y = groundY + 2 + luffyFootPad * sc;
    ctx.save();
    ctx.translate(x + sx, y + sy);
    if (tilt) ctx.rotate(tilt);
    var nativeDir = luffyNativeDir(set);
    ctx.scale((facing < 0 ? -1 : 1) * nativeDir, 1);
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, -dw / 2, -dh, dw, dh);
    ctx.restore();
  }
  function drawLuffy(f) {
    var set = luffy.idle;
    var idx = 0;
    var alpha = 1;
    var reacting = isAirborne(f) || isDowned(f) || ((f.stun || 0) > 0 && f.hitLight);
    var drawFacing = f.facing;
    if (reacting && (f.hitLeanDir || 0)) {
      drawFacing = (f.hitLeanDir > 0) ? -1 : 1;
    }
    if ((f.knockPhase === "air" || isAirborne(f)) && luffy.knock && luffy.knock[0] && luffy.knock[0].complete) {
      set = luffy.knock;
      var kat = f.knockT || 0;
      if (kat < 0.08) idx = 0;
      else if (kat < 0.22) idx = 1;
      else if (kat < 0.40) idx = 2;
      else idx = 3;
    } else if ((f.knockPhase === "down" || isDowned(f)) && luffy.knock && luffy.knock[0] && luffy.knock[0].complete) {
      set = luffy.knock;
      var kdt = f.knockT || 0;
      if ((f.getUpT || 0) > 0) idx = 5;
      else if (kdt < 0.18) idx = 4;
      else idx = 5;
    } else if (f.hitLight && (f.stun || 0) > 0 && luffy.hitstun && luffy.hitstun[0] && luffy.hitstun[0].complete) {
      set = luffy.hitstun;
      var su = 1 - Math.min(1, (f.stun || 0) / 0.55);
      idx = Math.min(5, Math.floor(su * 6));
    } else if (reacting) {
      set = luffy.idle;
      idx = 0;
    } else if (f.anim === "l_atk" && ((f.gear2 && luffy.gear2Atk && luffy.gear2Atk[0] && luffy.gear2Atk[0].complete) || (luffy.atk && luffy.atk[0] && luffy.atk[0].complete))) {
      set = (f.gear2 && luffy.gear2Atk && luffy.gear2Atk[0] && luffy.gear2Atk[0].complete) ? luffy.gear2Atk : luffy.atk;
      var ua = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (ua < 0) ua = 0; if (ua > 0.999) ua = 0.999;
      idx = Math.min(5, Math.floor(ua * 6));
    } else if (f.anim === "l_gatling" && luffy.gatling && luffy.gatling[0] && luffy.gatling[0].complete) {
      set = luffy.gatling;
      var ug = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (ug < 0) ug = 0; if (ug > 0.999) ug = 0.999;
      idx = Math.min(5, Math.floor(ug * 6));
    } else if (f.anim === "l_pistol" && luffy.pistol && luffy.pistol[0] && luffy.pistol[0].complete) {
      set = luffy.pistol;
      var up = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (up < 0) up = 0; if (up > 0.999) up = 0.999;
      idx = Math.min(5, Math.floor(up * 6));
    } else if (f.anim === "l_balloon" && luffy.balloon && luffy.balloon[0] && luffy.balloon[0].complete) {
      set = luffy.balloon;
      var ub = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (ub < 0) ub = 0; if (ub > 0.999) ub = 0.999;
      idx = Math.min(5, Math.floor(ub * 6));
    } else if (f.anim === "l_gear2" && ((luffy.gear2Atk && luffy.gear2Atk[0] && luffy.gear2Atk[0].complete) || (luffy.gear2Idle && luffy.gear2Idle[0] && luffy.gear2Idle[0].complete))) {
      // pages30v: 二档变身闪 — 优先播 gear2_attack 前几帧，短促
      set = (luffy.gear2Atk && luffy.gear2Atk[0] && luffy.gear2Atk[0].complete) ? luffy.gear2Atk : luffy.gear2Idle;
      var ug2 = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (ug2 < 0) ug2 = 0; if (ug2 > 0.999) ug2 = 0.999;
      idx = (set === luffy.gear2Atk) ? Math.min(5, Math.floor(ug2 * 6)) : Math.min(7, Math.floor(ug2 * 8));
    } else if (f.anim === "l_spear" && luffy.spear && luffy.spear[0] && luffy.spear[0].complete) {
      set = luffy.spear;
      var usp = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (usp < 0) usp = 0; if (usp > 0.999) usp = 0.999;
      idx = Math.min(5, Math.floor(usp * 6));
    } else if (f.anim && f.anim.indexOf("l_") === 0) {
      set = (f.gear2 && luffy.gear2Idle && luffy.gear2Idle[0] && luffy.gear2Idle[0].complete) ? luffy.gear2Idle : luffy.idle;
      idx = Math.min(7, Math.floor(((f.animT || 0) / Math.max(0.01, f.animDur || 0.4)) * 8));
    } else if (f.gait === "run" || f.gait === "walk") {
      if (f.gear2 && luffy.gear2Run && luffy.gear2Run[0] && luffy.gear2Run[0].complete) set = luffy.gear2Run;
      else set = (luffy.run && luffy.run[0] && luffy.run[0].complete) ? luffy.run : luffy.idle;
      idx = Math.floor(time * 10) % 8;
    } else {
      if (f.gear2 && luffy.gear2Idle && luffy.gear2Idle[0] && luffy.gear2Idle[0].complete) set = luffy.gear2Idle;
      else set = luffy.idle;
      idx = Math.floor(time * 8) % 8;
    }
    if (f.invuln > 0 && !isDowned(f) && !isAirborne(f) && Math.sin(time * 40) > 0) alpha *= 0.45;
    if (f.gear2) alpha = Math.min(1, alpha * 1.05);
    var drawAir = (f.airH || 0);
    if (f.busy > 0 || (f.anim && f.anim.indexOf("l_") === 0)) drawAir = 0;
    var tiltUse = (set === luffy.hitstun || set === luffy.knock) ? 0 : fighterDrawTilt(f);
    drawLuffyAt(f.x, f.y - drawAir, drawFacing, set, idx, alpha, tiltUse, f.hitShake || 0);
    if (f.gear2) {
      var pulse = 0.55 + 0.45 * Math.sin(time * 10);
      ctx.save();
      ctx.translate(f.x, f.y - luffyBodyH * 0.45);
      ctx.globalAlpha = 0.12 + 0.1 * pulse;
      ctx.strokeStyle = "#ff8040";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(0, 0, luffyBodyW * 0.9, luffyBodyH * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function ichigoImage(set, index) {
    if (!set || !set.length) return null;
    var i = index % set.length;
    if (i < 0) i += set.length;
    var img = set[i];
    if (!img || !img.complete || !img.naturalWidth) return null;
    return img;
  }
  // pages30y: ichigo art faces RIGHT → nativeDir +1
  function ichigoNativeDir(set) {
    return 1;
  }
  function drawIchigoAt(x, groundY, facing, set, index, alpha, tilt, shakeAmp) {
    var img = ichigoImage(set, index);
    if (!img) return;
    var sc = ichigoScale;
    var sx = 0;
    var sy = 0;
    if (shakeAmp && shakeAmp > 0) {
      sx = (Math.random() * 2 - 1) * shakeAmp * 5;
      sy = (Math.random() * 2 - 1) * shakeAmp * 2.5;
      sc = sc * (1 - Math.min(0.08, shakeAmp * 0.35));
    }
    var dw = img.width * sc;
    var dh = img.height * sc;
    var y = groundY + 2 + ichigoFootPad * sc;
    ctx.save();
    ctx.translate(x + sx, y + sy);
    if (tilt) ctx.rotate(tilt);
    var nativeDir = ichigoNativeDir(set);
    ctx.scale((facing < 0 ? -1 : 1) * nativeDir, 1);
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, -dw / 2, -dh, dw, dh);
    ctx.restore();
  }
  function drawIchigo(f) {
    var set = ichigo.idle;
    var idx = 0;
    var alpha = 1;
    var reacting = isAirborne(f) || isDowned(f) || ((f.stun || 0) > 0 && f.hitLight);
    var drawFacing = f.facing;
    var drawMugetsuFx = false;
    if (reacting && (f.hitLeanDir || 0)) {
      drawFacing = (f.hitLeanDir > 0) ? -1 : 1;
    }
    if ((f.knockPhase === "air" || isAirborne(f)) && ichigo.knock && ichigo.knock[0] && ichigo.knock[0].complete) {
      set = ichigo.knock;
      var kat = f.knockT || 0;
      if (kat < 0.08) idx = 0;
      else if (kat < 0.22) idx = 1;
      else if (kat < 0.40) idx = 2;
      else idx = 3;
    } else if ((f.knockPhase === "down" || isDowned(f)) && ichigo.knock && ichigo.knock[0] && ichigo.knock[0].complete) {
      set = ichigo.knock;
      var kdt = f.knockT || 0;
      if ((f.getUpT || 0) > 0) idx = 5;
      else if (kdt < 0.18) idx = 4;
      else idx = 5;
    } else if (f.hitLight && (f.stun || 0) > 0 && ichigo.hitstun && ichigo.hitstun[0] && ichigo.hitstun[0].complete) {
      set = ichigo.hitstun;
      var su = 1 - Math.min(1, (f.stun || 0) / 0.55);
      idx = Math.min(5, Math.floor(su * 6));
    } else if (reacting) {
      set = (f.bankai && ichigo.bankaiIdle && ichigo.bankaiIdle[0] && ichigo.bankaiIdle[0].complete) ? ichigo.bankaiIdle : ichigo.idle;
      idx = 0;
    } else if (f.anim === "i_atk" && ((f.bankai && ichigo.bankaiAtk && ichigo.bankaiAtk[0] && ichigo.bankaiAtk[0].complete) || (ichigo.atk && ichigo.atk[0] && ichigo.atk[0].complete))) {
      set = (f.bankai && ichigo.bankaiAtk && ichigo.bankaiAtk[0] && ichigo.bankaiAtk[0].complete) ? ichigo.bankaiAtk : ichigo.atk;
      var ua = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (ua < 0) ua = 0; if (ua > 0.999) ua = 0.999;
      idx = Math.min(5, Math.floor(ua * 6));
    } else if (f.anim === "i_getsuga" && ichigo.getsuga && ichigo.getsuga[0] && ichigo.getsuga[0].complete) {
      set = ichigo.getsuga;
      var ug = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (ug < 0) ug = 0; if (ug > 0.999) ug = 0.999;
      idx = Math.min(5, Math.floor(ug * 6));
    } else if (f.anim === "i_flash" && ichigo.flash && ichigo.flash[0] && ichigo.flash[0].complete) {
      set = ichigo.flash;
      var uf = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (uf < 0) uf = 0; if (uf > 0.999) uf = 0.999;
      idx = Math.min(5, Math.floor(uf * 6));
    } else if (f.anim === "i_block" && ichigo.block && ichigo.block[0] && ichigo.block[0].complete) {
      set = ichigo.block;
      var ub = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (ub < 0) ub = 0; if (ub > 0.999) ub = 0.999;
      idx = Math.min(5, Math.floor(ub * 6));
    } else if (f.anim === "i_bankai" && ((ichigo.bankai && ichigo.bankai[0] && ichigo.bankai[0].complete) || (ichigo.bankaiIdle && ichigo.bankaiIdle[0] && ichigo.bankaiIdle[0].complete))) {
      set = (ichigo.bankai && ichigo.bankai[0] && ichigo.bankai[0].complete) ? ichigo.bankai : ichigo.bankaiIdle;
      var ubk = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (ubk < 0) ubk = 0; if (ubk > 0.999) ubk = 0.999;
      idx = (set === ichigo.bankai) ? Math.min(5, Math.floor(ubk * 6)) : Math.min(7, Math.floor(ubk * 8));
    } else if (f.anim === "i_mugetsu" && ichigo.mugetsu && ichigo.mugetsu[0] && ichigo.mugetsu[0].complete) {
      set = ichigo.mugetsu;
      var um = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (um < 0) um = 0; if (um > 0.999) um = 0.999;
      idx = Math.min(5, Math.floor(um * 6));
      drawMugetsuFx = true;
    } else if (f.anim && f.anim.indexOf("i_") === 0) {
      set = (f.bankai && ichigo.bankaiIdle && ichigo.bankaiIdle[0] && ichigo.bankaiIdle[0].complete) ? ichigo.bankaiIdle : ichigo.idle;
      idx = Math.min(7, Math.floor(((f.animT || 0) / Math.max(0.01, f.animDur || 0.4)) * 8));
    } else if (f.gait === "run" || f.gait === "walk") {
      if (f.bankai && ichigo.bankaiRun && ichigo.bankaiRun[0] && ichigo.bankaiRun[0].complete) set = ichigo.bankaiRun;
      else set = (ichigo.run && ichigo.run[0] && ichigo.run[0].complete) ? ichigo.run : ichigo.idle;
      idx = Math.floor(time * 10) % 8;
    } else {
      if (f.bankai && ichigo.bankaiIdle && ichigo.bankaiIdle[0] && ichigo.bankaiIdle[0].complete) set = ichigo.bankaiIdle;
      else set = ichigo.idle;
      idx = Math.floor(time * 8) % 8;
    }
    if (f.invuln > 0 && !isDowned(f) && !isAirborne(f) && Math.sin(time * 40) > 0) alpha *= 0.45;
    if (f.bankai) alpha = Math.min(1, alpha * 1.05);
    var drawAir = (f.airH || 0);
    if (f.busy > 0 || (f.anim && f.anim.indexOf("i_") === 0)) drawAir = 0;
    var tiltUse = (set === ichigo.hitstun || set === ichigo.knock) ? 0 : fighterDrawTilt(f);
    // pages31b: 无月特效层叠在人物下/上（先 FX 后人物可读斩击弧）
    if (drawMugetsuFx && ichigo.mugetsuFx && ichigo.mugetsuFx[0] && ichigo.mugetsuFx[0].complete) {
      drawIchigoAt(f.x, f.y - drawAir, drawFacing, ichigo.mugetsuFx, idx, Math.min(1, alpha * 0.95), 0, 0);
    }
    drawIchigoAt(f.x, f.y - drawAir, drawFacing, set, idx, alpha, tiltUse, f.hitShake || 0);
    if (drawMugetsuFx && ichigo.mugetsuFx && ichigo.mugetsuFx[0] && ichigo.mugetsuFx[0].complete) {
      drawIchigoAt(f.x, f.y - drawAir, drawFacing, ichigo.mugetsuFx, idx, Math.min(1, alpha * 0.55), 0, 0);
    }
    if (f.bankai && f.anim !== "i_mugetsu") {
      var pulse = 0.55 + 0.45 * Math.sin(time * 10);
      ctx.save();
      ctx.translate(f.x, f.y - ichigoBodyH * 0.45);
      ctx.globalAlpha = 0.12 + 0.1 * pulse;
      ctx.strokeStyle = "#ff5030";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(0, 0, ichigoBodyW * 0.95, ichigoBodyH * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function fushiImage(set, index) {
    if (!set || !set.length) return null;
    var i = index % set.length;
    if (i < 0) i += set.length;
    var img = set[i];
    if (!img || !img.complete || !img.naturalWidth) return null;
    return img;
  }
  // pages31d: fushiguro art faces RIGHT → nativeDir +1
  function fushiNativeDir(set) {
    return 1;
  }
  function drawFushiAt(x, groundY, facing, set, index, alpha, tilt, shakeAmp, scaleMul, srcOx) {
    var img = fushiImage(set, index);
    if (!img) return;
    var sc = fushiScale * (scaleMul || 1);
    var sx = 0;
    var sy = 0;
    if (shakeAmp && shakeAmp > 0) {
      sx = (Math.random() * 2 - 1) * shakeAmp * 5;
      sy = (Math.random() * 2 - 1) * shakeAmp * 2.5;
      sc = sc * (1 - Math.min(0.08, shakeAmp * 0.35));
    }
    var dw = img.width * sc;
    var dh = img.height * sc;
    var y = groundY + 2 + fushiFootPad * sc;
    ctx.save();
    ctx.translate(x + sx, y + sy);
    if (tilt) ctx.rotate(tilt);
    var nativeDir = fushiNativeDir(set);
    ctx.scale((facing < 0 ? -1 : 1) * nativeDir, 1);
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, -dw / 2 + (srcOx || 0) * sc, -dh, dw, dh);
    ctx.restore();
  }
  function drawFushiguro(f) {
    var set = fushiguro.idle;
    var idx = 0;
    var alpha = 1;
    var skillKey = null;
    var reacting = isAirborne(f) || isDowned(f) || ((f.stun || 0) > 0 && f.hitLight);
    var drawFacing = f.facing;
    if (reacting && (f.hitLeanDir || 0)) {
      drawFacing = (f.hitLeanDir > 0) ? -1 : 1;
    }
    if ((f.knockPhase === "air" || isAirborne(f)) && fushiguro.knock && fushiguro.knock[0] && fushiguro.knock[0].complete) {
      set = fushiguro.knock;
      var kat = f.knockT || 0;
      if (kat < 0.08) idx = 0;
      else if (kat < 0.22) idx = 1;
      else if (kat < 0.40) idx = 2;
      else idx = 3;
    } else if ((f.knockPhase === "down" || isDowned(f)) && fushiguro.knock && fushiguro.knock[0] && fushiguro.knock[0].complete) {
      set = fushiguro.knock;
      var kdt = f.knockT || 0;
      if ((f.getUpT || 0) > 0) idx = 5;
      else if (kdt < 0.18) idx = 4;
      else idx = 5;
    } else if (f.hitLight && (f.stun || 0) > 0 && fushiguro.hitstun && fushiguro.hitstun[0] && fushiguro.hitstun[0].complete) {
      set = fushiguro.hitstun;
      var su = 1 - Math.min(1, (f.stun || 0) / 0.55);
      idx = Math.min(5, Math.floor(su * 6));
    } else if (reacting) {
      set = fushiguro.idle;
      idx = 0;
    } else if (f.anim && f.anim.indexOf("f_") === 0) {
      var fkey = { f_atk: "atk", f_dogs: "dogs", f_nue: "nue", f_elephant: "elephant", f_shadow: "shadow", f_domain: "domain" }[f.anim];
      var fset = fkey ? fushiguro[fkey] : null;
      var up = f.animDur > 0 ? f.animT / f.animDur : 1;
      if (up < 0) up = 0; if (up > 0.999) up = 0.999;
      if (fset && fset[0] && fset[0].complete) {
        set = fset;
        var nfr = fset.length || 6;
        idx = Math.min(nfr - 1, Math.floor(up * nfr));
        skillKey = fkey;
      } else {
        set = fushiguro.idle;
        idx = Math.min(7, Math.floor(up * 8));
      }
    } else if (f.gait === "run" || f.gait === "walk") {
      set = (fushiguro.run && fushiguro.run[0] && fushiguro.run[0].complete) ? fushiguro.run : fushiguro.idle;
      idx = Math.floor(time * 10) % 8;
    } else {
      set = fushiguro.idle;
      idx = Math.floor(time * 8) % 8;
    }
    if (f.invuln > 0 && skillKey !== "shadow" && !isDowned(f) && !isAirborne(f) && Math.sin(time * 40) > 0) alpha *= 0.45;
    var drawAir = (f.airH || 0);
    if (f.busy > 0 || (f.anim && f.anim.indexOf("f_") === 0)) drawAir = 0;
    var tiltUse = (set === fushiguro.hitstun || set === fushiguro.knock || skillKey) ? 0 : fighterDrawTilt(f);
    var oxArr = skillKey ? fushiFrameOx[skillKey] : null;
    drawFushiAt(f.x, f.y - drawAir, drawFacing, set, idx, alpha, tiltUse, f.hitShake || 0, skillKey ? fushiSkillScale : 1, oxArr ? (oxArr[idx] || 0) : 0);
    if ((f.domainT || 0) > 0) {
      var pulse = 0.55 + 0.45 * Math.sin(time * 8);
      ctx.save();
      ctx.translate(f.x, f.y - 8);
      ctx.globalAlpha = 0.1 + 0.08 * pulse;
      ctx.strokeStyle = "#5080ff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(0, 0, 160, 28, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawFighter(f) {
    drawGroundShadow(f);
    drawHyperArmorAura(f);
    if (isObito(f)) {
      drawObito(f);
      return;
    }
    if (isTanjiro(f)) {
      drawTanjiro(f);
      return;
    }
    if (isGojo(f)) {
      drawGojo(f);
      return;
    }
    if (isLuffy(f)) {
      drawLuffy(f);
      return;
    }
    if (isIchigo(f)) {
      drawIchigo(f);
      return;
    }
    if (isFushiguro(f)) {
      drawFushiguro(f);
      return;
    }
    drawPain(f);
  }

  function drawEnergySword(sw) {
    ctx.save();
    ctx.translate(sw.x, sw.y);
    ctx.rotate(Math.atan2(sw.vy, sw.vx || 0.001));
    ctx.fillStyle = "rgba(168, 96, 255, 0.35)";
    ctx.beginPath();
    ctx.moveTo(-78, 0);
    ctx.lineTo(8, -8);
    ctx.lineTo(8, 8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#fff6c2";
    ctx.beginPath();
    ctx.moveTo(-6, -2.5);
    ctx.lineTo(62, 0);
    ctx.lineTo(-6, 2.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffe14a";
    ctx.fillRect(-4, -1.2, 36, 2.4);
    ctx.restore();
  }

  function drawGhost(g) {
    var a = Math.max(0, g.life / g.max) * (g.alpha || 0.45);
    if (g.kit === "obito" || (!g.kit && g.owner === "L")) {
      drawObitoAt(g.x, g.y, g.facing, obito.idle, 0, a);
      return;
    }
    if (g.kit === "tanjiro") {
      drawTanjiroAt(g.x, g.y, g.facing, tanjiro.idle, 0, a, 0, 0);
      return;
    }
    if (g.kit === "gojo") {
      drawGojoAt(g.x, g.y, g.facing, gojo.idle, 0, a, 0, 0);
      return;
    }
    if (g.kit === "luffy") {
      drawLuffyAt(g.x, g.y, g.facing, luffy.idle, 0, a, 0, 0);
      return;
    }
    if (g.kit === "ichigo") {
      drawIchigoAt(g.x, g.y, g.facing, ichigo.idle, 0, a, 0, 0);
      return;
    }
    if (g.kit === "fushiguro") {
      drawFushiAt(g.x, g.y, g.facing, fushiguro.idle, 0, a, 0, 0);
      return;
    }
    if (g.kit === "pain" || (!g.kit && g.owner === "R")) {
      drawPainAt(g.x, g.y, g.facing, pain.idle, 0, a);
      return;
    }
    drawHumanoid(g.x, g.y, g.facing, g.palette, g.weapon, "blink", 0, 1, 0, a, 0);
  }

  function drawOneProjectile(p) {
      if (p.kind === "panda_drop" || p.kind === "shark_drop") {
        var pImg = p.kind === "shark_drop" ? sharkBodyImg : pandaBodyImg;
        if (pImg && pImg.complete && pImg.naturalWidth > 0) {
          var bob = p.landed ? Math.sin((p.age || 0) * 18) * 3 : 0;
          var sc = 0.72 * (p.scale || 1);
          var dw = pImg.naturalWidth * sc;
          var dh = pImg.naturalHeight * sc;
          ctx.save();
          ctx.globalAlpha = p.landed ? Math.max(0.25, Math.min(1, (p.life || 0) / 0.35)) : 1;
          ctx.drawImage(pImg, p.x - dw / 2, p.y - dh / 2 + bob, dw, dh);
          ctx.restore();
        } else {
          ctx.save();
          ctx.fillStyle = p.kind === "shark_drop" ? "rgba(106,160,200,0.95)" : "rgba(240,232,216,0.95)";
          ctx.beginPath();
          ctx.arc(p.x, p.y, 42, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        return;
      }
      if (p.kind === "firebreath") {
        var fbFrames = obito.firebreath;
        var fps = p.fps || 20;
        var fi = Math.floor((p.age || 0) * fps);
        if (fi < 0) fi = 0;
        if (fi >= fbFrames.length) fi = fbFrames.length - 1;
        var fbImg = fbFrames[fi];
        if (fbImg && fbImg.complete && fbImg.naturalWidth > 0) {
          var scb = p.drawScale || 1.1;
          var dwb = fbImg.naturalWidth * scb;
          var dhb = fbImg.naturalHeight * scb;
          var face = (p.facing != null ? p.facing : 1);
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.scale(face < 0 ? -1 : 1, 1);
          // pages29: art tip (36,124) glued to mouth — only the stream extends forward.
          ctx.globalCompositeOperation = "source-over";
          ctx.drawImage(fbImg, -FIREBREATH_TIP_X * scb, -FIREBREATH_TIP_Y * scb, dwb, dhb);
          ctx.restore();
        }
        return;
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(p.vy || 0, p.vx || 0.001));
      if (p.kind === "fire") ctx.scale(p.scale || 1, p.scale || 1);
      if (p.kind === "rod") {
        // Thin black rod: much narrower body, slightly shorter length.
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = "#f2f6ff";
        ctx.fillRect(-68, -2.2, 104, 4.4);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#f4f7ff";
        ctx.fillRect(-58, -2.6, 96, 5.2);
        ctx.fillStyle = "#2a2a2e";
        ctx.fillRect(-54, -1.8, 90, 3.6);
        ctx.fillStyle = "#8d93a3";
        ctx.fillRect(-54, -0.55, 90, 1.1);
        ctx.fillStyle = "#111216";
        ctx.beginPath();
        ctx.moveTo(46, 0);
        ctx.lineTo(36, -2.4);
        ctx.lineTo(36, 2.4);
        ctx.fill();
        ctx.fillStyle = "#111216";
        ctx.beginPath();
        ctx.moveTo(-54, 0);
        ctx.lineTo(-46, -2.2);
        ctx.lineTo(-46, 2.2);
        ctx.fill();
      } else if (p.kind === "push") {
        ctx.strokeStyle = "rgba(230, 230, 240, 0.9)";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(0, 0, 26, -1.2, 1.2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(180, 170, 255, 0.55)";
        ctx.beginPath();
        ctx.arc(-10, 0, 18, -1, 1);
        ctx.stroke();
      } else if (p.kind === "wave") {
        ctx.strokeStyle = "#7af7ff";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(0, 0, 18, -1.2, 1.2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(122,247,255,0.45)";
        ctx.beginPath();
        ctx.arc(-8, 0, 12, -1, 1);
        ctx.stroke();
      } else if (p.kind === "needle") {
        ctx.strokeStyle = "rgba(122,247,255,0.35)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-26, 0);
        ctx.lineTo(0, 0);
        ctx.stroke();
        ctx.fillStyle = "#e9ffff";
        ctx.fillRect(0, -1.5, 18, 3);
        ctx.fillStyle = "#3ef0e0";
        ctx.beginPath();
        ctx.moveTo(18, 0);
        ctx.lineTo(10, -3.5);
        ctx.lineTo(10, 3.5);
        ctx.fill();
      } else {
        var seed = p.seed || 0;
        var flick = 0.72 + 0.28 * Math.sin(time * 32 + seed);
        var flick2 = 0.65 + 0.35 * Math.sin(time * 47 + seed * 1.7);
        var tail = 62 * flick;
        var glow = ctx.createRadialGradient(10, 0, 2, 6, 0, 40);
        glow.addColorStop(0, "rgba(255, 230, 120, 0.55)");
        glow.addColorStop(0.45, "rgba(255, 120, 20, 0.28)");
        glow.addColorStop(1, "rgba(255, 60, 0, 0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.ellipse(-6, 0, 48, 28, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255, 110, 16, 0.92)";
        ctx.beginPath();
        ctx.moveTo(8, -12);
        ctx.lineTo(-tail * 0.45, -16 * flick2);
        ctx.lineTo(-tail, -5 * flick);
        ctx.lineTo(-tail * 0.62, 1);
        ctx.lineTo(-tail * 0.92, 9 * flick2);
        ctx.lineTo(-tail * 0.35, 14 * flick);
        ctx.lineTo(6, 13);
        ctx.closePath();
        ctx.fill();
        var k;
        ctx.fillStyle = "rgba(255, 150, 30, 0.88)";
        for (k = 0; k < 3; k++) {
          var wob = Math.sin(time * 36 + seed + k * 2.2);
          var tx = -16 - k * 16 * flick;
          var ty = (k - 1) * 8 * wob;
          ctx.beginPath();
          ctx.moveTo(tx + 14, ty - 2);
          ctx.lineTo(tx - 12 * flick2, ty - 7 - wob * 4);
          ctx.lineTo(tx - 4, ty + 6 + wob * 2);
          ctx.closePath();
          ctx.fill();
        }
        var body = ctx.createRadialGradient(8, 0, 2, 4, 0, 24);
        body.addColorStop(0, "#ffb43a");
        body.addColorStop(0.5, "#ff6410");
        body.addColorStop(1, "rgba(180, 30, 0, 0.05)");
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(6, 0, 24, 15 * (0.88 + 0.12 * flick), 0, 0, Math.PI * 2);
        ctx.fill();
        var core = ctx.createRadialGradient(16, 0, 1, 14, 0, 14);
        core.addColorStop(0, "#fffef6");
        core.addColorStop(0.35, "#ffe14a");
        core.addColorStop(1, "rgba(255, 150, 20, 0)");
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.ellipse(14, 0, 13, 8, 0, 0, Math.PI * 2);
        ctx.fill();
        for (k = 0; k < 4; k++) {
          var e = Math.sin(time * 24 + seed * 3 + k * 1.4);
          var ex = -30 - k * 13 - e * 5;
          var ey = Math.cos(time * 19 + k * 1.8) * (5 + k * 2.4);
          ctx.globalAlpha = 0.45 + 0.5 * Math.abs(e);
          ctx.fillStyle = k % 2 === 0 ? "#ffd15a" : "#ff8a1e";
          ctx.beginPath();
          ctx.ellipse(ex, ey, 2.4 + (k % 2) * 1.6, 1.8, e * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
  }

  function drawSpikes() {
    var i, k;
    for (i = 0; i < spikes.length; i++) {
      var s = spikes[i];
      var warn = s.t < s.delay;
      var grow = warn ? 0 : clamp((s.t - s.delay) / 0.08, 0, 1);
      var fade = warn ? 1 : 1 - clamp((s.t - s.delay) / 0.42, 0, 1);
      ctx.save();
      ctx.globalAlpha = (warn ? 0.85 : fade);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      var sy = s.y;
      ctx.beginPath();
      ctx.ellipse(s.x, sy, s.radius, 14, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (warn) {
        var pulse = 0.5 + 0.5 * Math.sin(time * 18);
        ctx.globalAlpha = 0.25 + pulse * 0.25;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.ellipse(s.x, sy, s.radius * (0.35 + 0.65 * (s.t / s.delay)), 12, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!warn) {
        ctx.globalAlpha = fade;
        for (k = -1; k <= 1; k++) {
          var h = (k === 0 ? 78 : 52) * grow;
          var bx = s.x + k * 18;
          ctx.fillStyle = k === 0 ? s.glow : s.color;
          ctx.beginPath();
          ctx.moveTo(bx - 8, sy);
          ctx.lineTo(bx, sy - h);
          ctx.lineTo(bx + 8, sy);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  function drawWheels() {
    var i, k;
    for (i = 0; i < wheels.length; i++) {
      var w = wheels[i];
      var fade = w.life < 0.35 ? w.life / 0.35 : 1;
      ctx.save();
      ctx.translate(w.x, w.y - 86);
      ctx.rotate(w.spin + (w.max - w.life) * 7.5);
      ctx.globalAlpha = 0.9 * fade;
      ctx.strokeStyle = "#e02020";
      ctx.fillStyle = "rgba(180, 16, 16, 0.18)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, 50, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 2;
      for (k = 0; k < 8; k++) {
        var a = k * Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 16, Math.sin(a) * 16);
        ctx.lineTo(Math.cos(a) * 50, Math.sin(a) * 50);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // pages25: crescent sword-trail used by Tanjiro's Q / F / E counter (no dedicated fx sheet).
  function drawSlashArc(b, u) {
    var sweep = Math.min(1, u * 2.4);
    var fade = u < 0.45 ? 1 : Math.max(0, 1 - (u - 0.45) / 0.55);
    var r = b.r || 90;
    var a0 = b.a0 != null ? b.a0 : -1.9, a1 = b.a1 != null ? b.a1 : 0.9;
    var aEnd = a0 + (a1 - a0) * sweep;
    var aStart = a1 >= a0 ? Math.max(a0, aEnd - (a1 - a0) * 0.75) : Math.min(a0, aEnd - (a1 - a0) * 0.75);
    var ccw = a1 < a0;
    ctx.scale(b.facing < 0 ? -1 : 1, b.squash || 1);
    var steps = 14, k;
    ctx.lineCap = "round";
    for (k = 0; k < steps; k++) {
      var t0 = aStart + (aEnd - aStart) * (k / steps);
      var t1 = aStart + (aEnd - aStart) * ((k + 1) / steps);
      var w = (b.width || 16) * (0.25 + 0.75 * (k / steps));
      ctx.globalAlpha = fade * (0.25 + 0.75 * (k / steps));
      ctx.strokeStyle = b.color || "#8ee8ff";
      ctx.shadowColor = b.glow || b.color || "#8ee8ff";
      ctx.shadowBlur = 18;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.arc(0, 0, r, t0, t1, ccw);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = w * 0.32;
      ctx.beginPath();
      ctx.arc(0, 0, r, t0, t1, ccw);
      ctx.stroke();
    }
  }
  function spawnSlash(x, y, facing, opts) {
    var b = { kind: "slash", x: x, y: y, facing: facing || 1, life: 0.3, max: 0.3, r: 90, width: 16, color: "#8ee8ff", delay: 0 };
    var k;
    for (k in (opts || {})) b[k] = opts[k];
    b.max = b.life;
    bursts.push(b);
    return b;
  }

  function drawBursts() {
    var i;
    for (i = 0; i < bursts.length; i++) {
      var b = bursts[i];
      if (b.delay > 0) continue;
      var u = 1 - b.life / b.max;
      ctx.save();
      if (b.kind === "slash") {
        ctx.translate(b.x, b.y);
        drawSlashArc(b, u);
        ctx.restore();
        continue;
      }
      ctx.translate(b.x, b.y);
      if (b.kind === "flash") {
        ctx.scale(b.facing < 0 ? -1 : 1, 1);
        ctx.globalAlpha = Math.max(0, b.life / b.max);
        ctx.fillStyle = "rgba(255, 244, 210, 0.95)";
        ctx.beginPath();
        ctx.moveTo(-10, 0);
        ctx.lineTo(54 + u * 26, -16 - u * 8);
        ctx.lineTo(36, 0);
        ctx.lineTo(54 + u * 26, 16 + u * 8);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "rgba(255, 150, 60, 0.85)";
        ctx.beginPath();
        ctx.moveTo(-4, 0);
        ctx.lineTo(28, -7);
        ctx.lineTo(18, 0);
        ctx.lineTo(28, 7);
        ctx.closePath();
        ctx.fill();
      } else if (b.kind === "impact") {
        var sc = b.scale || 1;
        ctx.scale(sc, sc);
        ctx.globalAlpha = Math.max(0, b.life / b.max);
        var glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 56 + u * 40);
        glow.addColorStop(0, "rgba(255,255,255,0.95)");
        glow.addColorStop(0.25, "rgba(255,220,120,0.85)");
        glow.addColorStop(0.55, "rgba(255,90,40,0.45)");
        glow.addColorStop(1, "rgba(255,40,20,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(0, 0, 56 + u * 40, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,246,210,0.95)";
        ctx.lineWidth = 3.5;
        var k;
        for (k = 0; k < 10; k++) {
          var a = k * Math.PI / 5 + u * 0.6;
          var inner = 6 + u * 8;
          var outer = 34 + u * 52;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
          ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
          ctx.stroke();
        }
        ctx.fillStyle = "rgba(255,250,230,0.9)";
        ctx.beginPath();
        ctx.arc(0, 0, 10 + u * 10, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalAlpha = Math.max(0, b.life / b.max);
        ctx.strokeStyle = "#fff6d8";
        ctx.fillStyle = "rgba(255, 186, 80, 0.8)";
        ctx.lineWidth = 3;
        var k;
        for (k = 0; k < 8; k++) {
          var a = k * Math.PI / 4 + 0.2;
          var inner = 8 + u * 6;
          var outer = 28 + u * 46;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
          ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(0, 0, 10 + u * 16, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function traceShield(rx, ry, spin, scale) {
    var steps = 48;
    var i;
    ctx.beginPath();
    for (i = 0; i <= steps; i++) {
      var a = (i / steps) * Math.PI * 2;
      var w = shieldWave(a, spin) * scale;
      var x = Math.cos(a) * rx * w;
      var y = Math.sin(a) * ry * w;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function traceStreak(rx, ry, spin, scale, from, span) {
    var steps = 18;
    var i;
    ctx.beginPath();
    for (i = 0; i <= steps; i++) {
      var t = i / steps;
      var a = from + span * t;
      var w = shieldWave(a, spin * 0.35) * scale * (0.72 + 0.28 * Math.sin(t * Math.PI));
      var x = Math.cos(a) * rx * w;
      var y = Math.sin(a) * ry * w;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  function drawAirShield(f) {
    if (!(f.shield > 0)) return;
    var r = shieldRadius();
    var c = shieldCenter(f);
    var fade = f.shield < 0.25 ? f.shield / 0.25 : 1;
    ctx.save();
    ctx.translate(c.x, c.y);
    var glow = ctx.createRadialGradient(-r * 0.2, -r * 0.28, r * 0.08, 0, 0, r);
    glow.addColorStop(0, "rgba(255, 255, 255, 0.42)");
    glow.addColorStop(0.35, "rgba(186, 216, 255, 0.22)");
    glow.addColorStop(1, "rgba(120, 170, 220, 0.02)");
    ctx.globalAlpha = fade;
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.85 * fade;
    ctx.strokeStyle = "rgba(236, 246, 255, 0.95)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.55 * fade;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(-r * 0.08, -r * 0.1, r * 0.72, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.8 * fade;
    ctx.strokeStyle = "rgba(226, 240, 255, 0.95)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(f.x, f.y, r * 1.42, r * 0.2, 0, 0.15, Math.PI - 0.15);
    ctx.stroke();
    ctx.globalAlpha = 0.28 * fade;
    ctx.fillStyle = "rgba(190, 220, 255, 0.9)";
    ctx.beginPath();
    ctx.ellipse(f.x, f.y + 2, r * 1.2, r * 0.11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawPullStreams(f) {
    if (!(f.pullOn || f.pullFx > 0)) return;
    var frames = pain.pullFx;
    if (!frames || !frames.length) return;
    var tAnim = f.pullOn ? (f.pullAnimT || 0) : Math.max(0, pullCastSpan - (f.pullFx || 0));
    var fi = Math.floor(tAnim * pullCastFps);
    if (fi < 0) fi = 0;
    if (fi > 23) fi = 23;
    var img = painImage(frames, fi);
    if (!img) return;
    var palm = palmOf(f);
    var ax = palm.x;
    var ay = palm.y;
    if (fi < 8) {
      ax = f.x + f.facing * 56 * painScale;
      ay = f.y - 100 * painScale;
    }
    var dw = img.width * pullFxScale;
    var dh = img.height * pullFxScale;
    var fade = 1;
    if (!f.pullOn && f.pullFx > 0) fade = Math.min(1, f.pullFx / 0.25);
    ctx.save();
    ctx.translate(ax, ay);
    ctx.scale(f.facing < 0 ? -1 : 1, 1);
    ctx.globalAlpha = fade;
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  function drawRings() {
    var i;
    for (i = 0; i < rings.length; i++) {
      var r = rings[i];
      var u = 1 - r.life / r.max;
      ctx.save();
      ctx.globalAlpha = r.life / r.max;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, 18 + u * 70, 8 + u * 16, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawSparks() {
    var i;
    for (i = 0; i < sparks.length; i++) {
      var s = sparks[i];
      var sz = s.size || 3;
      ctx.globalAlpha = Math.max(0, s.life / s.max);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, sz * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(s.x - sz * 0.2, s.y - sz, sz * 0.4, sz * 2);
    }
    ctx.globalAlpha = 1;
  }

  function drawHp(f) {
    var w = 92;
    var h = 8;
    var x = f.x - w / 2;
    var depth = (f.y - MIN_Y) / (MAX_Y - MIN_Y);
    var y = f.y - 150 * (0.78 + depth * 0.3);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    roundRect(x - 1, y - 1, w + 2, h + 2, 3);
    ctx.fill();
    var ratio = f.hp / f.maxHp;
    ctx.fillStyle = ratio > 0.35 ? f.palette.trim : "#ff4d6a";
    roundRect(x, y, Math.max(0, w * ratio), h, 3);
    ctx.fill();
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = f.palette.glow;
    ctx.fillText(f.name, f.x, y - 6);
    ctx.textAlign = "left";
  }

  function drawFloaters() {
    ctx.textAlign = "center";
    ctx.font = "bold 20px sans-serif";
    var i;
    for (i = 0; i < floaters.length; i++) {
      var t = floaters[i];
      ctx.globalAlpha = Math.max(0, t.life / t.max);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
  }

  function icon(id, cx, cy, color) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    if (id === "punch" || id === "slash") {
      ctx.beginPath();
      ctx.arc(0, 4, 14, Math.PI * 0.9, Math.PI * 2.15);
      ctx.stroke();
    } else if (id === "phase" || id === "needle") {
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-11, 0);
      ctx.lineTo(11, 0);
      ctx.moveTo(0, -11);
      ctx.lineTo(0, 11);
      ctx.stroke();
    } else if (id === "tele" || id === "back") {
      ctx.beginPath();
      ctx.moveTo(-10, -7);
      ctx.lineTo(8, 0);
      ctx.lineTo(-10, 7);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(4, 0);
      ctx.lineTo(14, 0);
      ctx.stroke();
    } else if (id === "space" || id === "dash") {
      ctx.strokeRect(-12, -8, 10, 16);
      ctx.strokeRect(2, -8, 10, 16);
    } else if (id === "thrust") {
      ctx.beginPath();
      ctx.moveTo(-14, 0);
      ctx.lineTo(8, 0);
      ctx.moveTo(14, 0);
      ctx.lineTo(4, -5);
      ctx.lineTo(4, 5);
      ctx.fill();
    } else if (id === "breath" || id === "fire") {
      ctx.beginPath();
      ctx.arc(0, 2, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.arc(-6, 2, 6, 0, Math.PI * 2);
      ctx.fill();
    } else if (id === "swap") {
      ctx.beginPath();
      ctx.arc(-6, 0, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(2, -6);
      ctx.lineTo(12, 0);
      ctx.lineTo(2, 6);
      ctx.stroke();
    } else if (id === "pull") {
      ctx.beginPath();
      ctx.moveTo(-12, -6);
      ctx.lineTo(2, -6);
      ctx.moveTo(-12, 6);
      ctx.lineTo(2, 6);
      ctx.moveTo(6, 0);
      ctx.lineTo(-2, -5);
      ctx.moveTo(6, 0);
      ctx.lineTo(-2, 5);
      ctx.stroke();
    } else if (id === "spike") {
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 11, time * 6, time * 6 + 1.4);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 6, -time * 8, -time * 8 + 2);
      ctx.stroke();
    } else if (id === "wave") {
      ctx.beginPath();
      ctx.arc(2, 0, 10, -1.2, 1.2);
      ctx.stroke();
    } else if (id === "cleave") {
      ctx.beginPath();
      ctx.moveTo(-12, 6);
      ctx.quadraticCurveTo(0, -12, 12, 4);
      ctx.stroke();
    } else if (id === "atk") {
      ctx.beginPath();
      ctx.moveTo(-10, 8);
      ctx.lineTo(2, -10);
      ctx.lineTo(6, -6);
      ctx.lineTo(-6, 12);
      ctx.closePath();
      ctx.stroke();
    } else if (id === "water2") {
      ctx.beginPath();
      ctx.ellipse(0, 0, 8, 12, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-6, 4);
      ctx.quadraticCurveTo(0, -2, 6, 4);
      ctx.stroke();
    } else if (id === "water4") {
      ctx.beginPath();
      ctx.moveTo(-12, 0);
      ctx.lineTo(10, 0);
      ctx.moveTo(4, -6);
      ctx.lineTo(12, 0);
      ctx.lineTo(4, 6);
      ctx.stroke();
    } else if (id === "water1") {
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0.2, Math.PI * 1.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(8, -8);
      ctx.lineTo(2, 2);
      ctx.stroke();
    } else if (id === "ult1") {
      ctx.beginPath();
      ctx.arc(0, 2, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(4, -2);
      ctx.lineTo(-4, -2);
      ctx.closePath();
      ctx.fill();
    } else if (id === "ult2" || id === "spear") {
      ctx.beginPath();
      ctx.moveTo(-12, -4);
      ctx.lineTo(12, -4);
      ctx.moveTo(-12, 4);
      ctx.lineTo(12, 4);
      ctx.moveTo(-4, -8);
      ctx.lineTo(8, 0);
      ctx.lineTo(-4, 8);
      ctx.stroke();
    } else if (id === "gatling") {
      ctx.beginPath();
      ctx.moveTo(-10, 8);
      ctx.lineTo(2, -10);
      ctx.lineTo(8, -6);
      ctx.lineTo(-4, 12);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-4, 6);
      ctx.lineTo(8, -8);
      ctx.stroke();
    } else if (id === "pistol") {
      ctx.beginPath();
      ctx.moveTo(-12, 0);
      ctx.lineTo(12, 0);
      ctx.moveTo(4, -6);
      ctx.lineTo(12, 0);
      ctx.lineTo(4, 6);
      ctx.stroke();
    } else if (id === "balloon") {
      ctx.beginPath();
      ctx.ellipse(0, -2, 10, 12, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-3, 10);
      ctx.lineTo(3, 10);
      ctx.stroke();
    } else if (id === "gear2") {
      ctx.beginPath();
      ctx.arc(0, 2, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-8, -8);
      ctx.lineTo(0, -14);
      ctx.lineTo(8, -8);
      ctx.stroke();
    } else if (id === "getsuga") {
      ctx.beginPath();
      ctx.arc(0, 0, 10, -0.9, 0.9);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-2, -8);
      ctx.lineTo(10, 0);
      ctx.lineTo(-2, 8);
      ctx.stroke();
    } else if (id === "flash") {
      ctx.beginPath();
      ctx.moveTo(-10, 6);
      ctx.lineTo(2, -10);
      ctx.lineTo(4, -2);
      ctx.lineTo(10, -8);
      ctx.lineTo(-2, 10);
      ctx.lineTo(-4, 2);
      ctx.closePath();
      ctx.stroke();
    } else if (id === "block") {
      ctx.beginPath();
      ctx.moveTo(-8, -10);
      ctx.lineTo(-8, 10);
      ctx.lineTo(8, 6);
      ctx.lineTo(8, -6);
      ctx.closePath();
      ctx.stroke();
    } else if (id === "bankai") {
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(8, 10);
      ctx.lineTo(0, 4);
      ctx.lineTo(-8, 10);
      ctx.closePath();
      ctx.stroke();
    } else if (id === "mugetsu") {
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-10, 0);
      ctx.lineTo(10, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawButton(x, y, w, h, f, id) {
    var sk = f.skills[id];
    var ready = sk.cd <= 0 && !koId && matchState === "fight";
    var p = f.palette;
    ctx.save();
    roundRect(x, y, w, h, 10);
    ctx.fillStyle = ready ? "rgba(8,10,16,0.82)" : "rgba(8,10,16,0.72)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = ready ? p.trim : "rgba(140,140,150,0.35)";
    ctx.stroke();

    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = ready ? p.glow : "rgba(180,180,190,0.45)";
    roundRect(x + 8, y + 8, 22, 18, 4);
    ctx.fillStyle = ready ? p.deep : "#1a1c22";
    ctx.fill();
    ctx.strokeStyle = ready ? p.trim : "rgba(140,140,150,0.3)";
    ctx.stroke();
    ctx.fillStyle = ready ? p.glow : "rgba(170,170,180,0.4)";
    ctx.fillText(sk.key, x + 13, y + 21);

    icon(id, x + w * 0.62, y + 30, ready ? p.glow : "rgba(160,160,170,0.35)");

    ctx.font = "bold 15px sans-serif";
    ctx.fillStyle = ready ? "#f2f6f8" : "rgba(200,200,208,0.4)";
    ctx.fillText(sk.name, x + 10, y + h - 22);
    ctx.font = "11px sans-serif";
    ctx.fillStyle = ready ? p.trim : "rgba(160,160,170,0.35)";
    ctx.fillText(sk.role, x + 10, y + h - 8);

    if (sk.cd > 0) {
      var ratio = sk.cd / sk.max;
      ctx.beginPath();
      roundRect(x, y, w, h, 10);
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y + h / 2);
      ctx.arc(x + w / 2, y + h / 2, 90, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2);
      ctx.closePath();
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fill();
      ctx.font = "bold 14px sans-serif";
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText(sk.cd.toFixed(1), x + w - 8, y + 22);
    }
    ctx.restore();
  }

  function addHit(x, y, w, h, fn, tag) {
    hudHits.push({ x: x, y: y, w: w, h: h, fn: fn, tag: tag || "" });
  }

  function drawPortrait(cx, cy, f) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 32, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(8,10,16,0.92)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = f.palette.glow;
    ctx.shadowColor = f.palette.glow;
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(cx, cy, 26, 0, Math.PI * 2);
    ctx.save();
    ctx.clip();
    var pimg = portraitImgs[f.kit];
    if (pimg && pimg.complete && pimg.naturalWidth > 0) {
      ctx.drawImage(pimg, cx - 26, cy - 26, 52, 52);
    } else {
      var g = ctx.createRadialGradient(cx - 6, cy - 8, 4, cx, cy, 26);
      g.addColorStop(0, f.palette.hot);
      g.addColorStop(0.55, f.palette.body);
      g.addColorStop(1, f.palette.deep);
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, 26, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  function drawResourceBars(x, y, w, f, fromRight) {
    var hx = fromRight ? x - w : x;
    var hh = 16;
    ctx.save();
    ctx.fillStyle = "rgba(10,6,8,0.82)";
    roundRect(hx - 2, y - 2, w + 4, hh + 4, 5);
    ctx.fill();
    ctx.fillStyle = "rgba(48, 10, 10, 0.95)";
    roundRect(hx, y, w, hh, 4);
    ctx.fill();
    var chipRatio = f.maxHp > 0 ? (f.hpChip != null ? f.hpChip : f.hp) / f.maxHp : 0;
    var ratio = f.maxHp > 0 ? f.hp / f.maxHp : 0;
    var cwChip = Math.max(0, w * chipRatio);
    var hw = Math.max(0, w * ratio);
    if (cwChip > hw + 0.5) {
      ctx.fillStyle = "#ffffff";
      if (fromRight) roundRect(hx + w - cwChip, y, cwChip, hh, 4);
      else roundRect(hx, y, cwChip, hh, 4);
      ctx.fill();
    }
    if (hw > 0) {
      var hg = ctx.createLinearGradient(0, y, 0, y + hh);
      hg.addColorStop(0, "#ff6b5a");
      hg.addColorStop(0.45, "#e0232a");
      hg.addColorStop(1, "#8a1018");
      ctx.fillStyle = hg;
      if (fromRight) roundRect(hx + w - hw, y, hw, hh, 4);
      else roundRect(hx, y, hw, hh, 4);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      if (fromRight) ctx.fillRect(hx + w - hw, y + 2, hw, 3);
      else ctx.fillRect(hx, y + 2, hw, 3);
    }
    if ((f.barDmgT || 0) > 0 && f.barDmg) {
      var a = Math.min(1, f.barDmgT / 0.35);
      ctx.globalAlpha = a;
      ctx.font = "bold 14px sans-serif";
      ctx.fillStyle = "#fff6e0";
      ctx.strokeStyle = "rgba(40,10,10,0.75)";
      ctx.lineWidth = 3;
      // pages21: number sits just past the white chip, inside the bar area (never off-screen).
      // Inside the bar, right at the red/white boundary, on the red side.
      var inner = hw > 34;
      ctx.textAlign = fromRight ? (inner ? "left" : "right") : (inner ? "right" : "left");
      var edge = fromRight ? hx + w - hw : hx + hw;
      var tx = fromRight ? (inner ? edge + 4 : edge - 4) : (inner ? edge - 4 : edge + 4);
      var ty = y + 13;
      ctx.strokeText("-" + f.barDmg, tx, ty);
      ctx.fillText("-" + f.barDmg, tx, ty);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = "rgba(255,220,180,0.35)";
    ctx.lineWidth = 1.5;
    roundRect(hx, y, w, hh, 4);
    ctx.stroke();
    var bw = Math.round(w * 0.82);
    var bx = fromRight ? x - bw : x;
    var by = y + 20;
    ctx.fillStyle = "rgba(6, 14, 28, 0.92)";
    roundRect(bx, by, bw, 8, 3);
    ctx.fill();
    var cRatio = f.maxChakra > 0 ? f.chakra / f.maxChakra : 0;
    var cw = Math.max(0, bw * cRatio);
    if (cw > 0) {
      var cg = ctx.createLinearGradient(0, by, 0, by + 8);
      if (f.chakraLock > 0) {
        cg.addColorStop(0, "#c8f0ff");
        cg.addColorStop(0.5, "#60d0ff");
        cg.addColorStop(1, "#2080ff");
      } else {
        cg.addColorStop(0, "#7ad0ff");
        cg.addColorStop(0.5, "#2f8fff");
        cg.addColorStop(1, "#1450c8");
      }
      ctx.fillStyle = cg;
      if (fromRight) roundRect(bx + bw - cw, by, cw, 8, 3);
      else roundRect(bx, by, cw, 8, 3);
      ctx.fill();
    }
    if (f.chakraLock > 0) {
      ctx.strokeStyle = "rgba(120,220,255,0.85)";
      ctx.lineWidth = 1.5;
      roundRect(bx, by, bw, 8, 3);
      ctx.stroke();
    }
    if (f.hyperArmor > 0) {
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "#ff9040";
      ctx.textAlign = fromRight ? "right" : "left";
      ctx.fillText("霸体 " + Math.ceil(f.hyperArmor) + "s", fromRight ? bx + bw : bx, by + 20);
    }
    if (isTanjiro(f) && f.fireForm) {
      ctx.fillStyle = "#ff6a3a";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = fromRight ? "right" : "left";
      ctx.fillText("火之形态", fromRight ? bx + bw : bx, by + ((f.hyperArmor || 0) > 0 ? 36 : 20));
    }
    if (isLuffy(f) && f.gear2) {
      ctx.fillStyle = "#ff8040";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = fromRight ? "right" : "left";
      ctx.fillText("二档", fromRight ? bx + bw : bx, by + ((f.hyperArmor || 0) > 0 ? 36 : 20));
    }
    if (isIchigo(f) && f.bankai) {
      ctx.fillStyle = "#ff5030";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = fromRight ? "right" : "left";
      ctx.fillText("天锁斩月", fromRight ? bx + bw : bx, by + ((f.hyperArmor || 0) > 0 ? 36 : 20));
    }
    if (isGojo(f) && (f.phase || 0) > 0) {
      ctx.fillStyle = "#a0c8ff";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = fromRight ? "right" : "left";
      ctx.fillText("无下限 " + f.phase.toFixed(1) + "s", fromRight ? bx + bw : bx, by + ((f.hyperArmor || 0) > 0 ? 36 : 20));
    } else if ((isGojo(f) || isFushiguro(f)) && (f.domainT || 0) > 0) {
      ctx.fillStyle = isFushiguro(f) ? "#5080ff" : "#c080ff";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = fromRight ? "right" : "left";
      ctx.fillText((isFushiguro(f) ? "嵌合庭 " : "领域 ") + f.domainT.toFixed(1) + "s", fromRight ? bx + bw : bx, by + ((f.hyperArmor || 0) > 0 ? 36 : 20));
    }
    if (isTanjiro(f) && (f.barrierT || 0) > 0 && !f.barrierUsed) {
      ctx.fillStyle = "#5ee0d0";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = fromRight ? "right" : "left";
      var byOff = 20 + ((f.hyperArmor || 0) > 0 ? 16 : 0) + (f.fireForm ? 16 : 0);
      ctx.fillText("水柱 " + f.barrierT.toFixed(1) + "s", fromRight ? bx + bw : bx, by + byOff);
    } else if (f.chakraLock > 0 && !(isLuffy(f) && f.gear2) && !(isIchigo(f) && f.bankai)) {
      // pages30w/y: 二档/天锁期间只显示形态名，不显示 chakraLock 回蓝倒计时
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = "#7ad0ff";
      ctx.textAlign = fromRight ? "right" : "left";
      ctx.fillText("回蓝 " + Math.ceil(f.chakraLock) + "s", fromRight ? bx + bw : bx, by + 20);
    }
    ctx.strokeStyle = "rgba(140,190,255,0.35)";
    ctx.lineWidth = 1;
    roundRect(bx, by, bw, 8, 3);
    ctx.stroke();
    ctx.restore();
  }

  function drawSkillOrb(cx, cy, f, id, rr) {
    var sk = f.skills[id];
    var r = rr || 26;
    var big = r > 30;
    var needFire = (id === "ult2" && isTanjiro(f) && !f.fireForm) || (id === "spear" && isLuffy(f) && !f.gear2) || (id === "mugetsu" && isIchigo(f) && !f.bankai);
    var ready = !paused && matchState === "fight" && sk.cd <= 0 && !needFire && !(id === "spike" && (f.shield > 0 || f.shieldWind > 0)) && (f.chakra || 0) >= (sk.cost || 0);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(6,8,12,0.55)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    var bg = ctx.createRadialGradient(cx - 4, cy - 6, 2, cx, cy, r);
    bg.addColorStop(0, ready ? "#3a2218" : "#1a1412");
    bg.addColorStop(1, "#0c0a0c");
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = ready ? f.palette.glow : "rgba(120,100,90,0.55)";
    if (ready) {
      ctx.shadowColor = f.palette.glow;
      ctx.shadowBlur = 10;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    if (sk.scroll && scrollImgs[sk.iconId || id]) {
      var simg = scrollImgs[sk.iconId || id];
      if (simg.complete && simg.naturalWidth > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy - 2, 18, 0, Math.PI * 2);
        ctx.clip();
        ctx.globalAlpha = ready ? 1 : 0.45;
        ctx.drawImage(simg, cx - 18, cy - 20, 36, 36);
        ctx.restore();
      } else {
        icon(id, cx, cy - 2, ready ? "#fff8ef" : "#7a7470");
      }
    } else {
      icon(id, cx, cy - 2, ready ? "#fff8ef" : "#7a7470");
    }
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = ready ? "#ffe7b0" : "rgba(200,180,150,0.45)";
    if (big) {
      ctx.font = "bold " + Math.round(r * 0.32) + "px sans-serif";
      ctx.fillText(sk.name, cx, cy + r * 0.72);
    } else ctx.fillText(sk.key, cx, cy + 20);
    if (sk.max > 0 && sk.cd > 0) {
      var ratio = sk.cd / sk.max;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2);
      ctx.closePath();
      ctx.fillStyle = "rgba(0,0,0,0.62)";
      ctx.fill();
      ctx.font = "bold 13px sans-serif";
      ctx.fillStyle = "#fff";
      ctx.fillText(sk.cd.toFixed(1), cx, cy + 4);
    }
    if (needFire) {
      // pages25: greyed V with an explicit reason
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fill();
      ctx.font = "bold 10px sans-serif";
      ctx.fillStyle = "#ffb070";
      if (id === "spear") {
        ctx.fillText("需二档", cx, cy + 4);
      } else if (id === "mugetsu") {
        ctx.fillText("需天锁", cx, cy + 4);
      } else {
        ctx.fillText("需火之", cx, cy - 2);
        ctx.fillText("形态", cx, cy + 10);
      }
    }
    if ((id === "space" || id === "dash") && voidSpace) {
      // pages25: 切空间 shows its remaining time on the icon; press again to leave early
      var vLeft = Math.max(0, (voidUntil - performance.now()) / 1000);
      ctx.beginPath();
      ctx.arc(cx, cy, r + 1, -Math.PI / 2, -Math.PI / 2 + (vLeft / VOID_DUR) * Math.PI * 2);
      ctx.strokeStyle = "#c9a6ff";
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.font = "bold 13px sans-serif";
      ctx.fillStyle = "#fff";
      ctx.fillText(vLeft.toFixed(1), cx, cy + 4);
    }
    ctx.restore();
    addHit(cx - r, cy - r, r * 2, r * 2, function () {
      if (!humanControls(f)) return;
      if (id === "spike") { shieldPressDown(f); f.shieldTouch = true; }
      else tryCast(f, id);
    }, "skill:" + f.id + ":" + id);
  }

  function drawPauseButton(cx, cy) {
    var r = 20;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = paused ? "#f0b429" : "#1a120e";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#e6c27a";
    ctx.stroke();
    ctx.fillStyle = paused ? "#3a2208" : "#f4efe6";
    ctx.fillRect(cx - 7, cy - 7, 4, 14);
    ctx.fillRect(cx + 3, cy - 7, 4, 14);
    addHit(cx - r, cy - r, r * 2, r * 2, function () {
      paused = !paused;
      if (paused) fightClockPause();
      else if (matchState === "fight") fightClockResume();
    });
    // pages30: while paused, show 「返回」 to leave combat immediately
    if (paused && (matchState === "fight" || matchState === "countdown" || matchState === "roundEnd")) {
      var mw = 88, mh = 34;
      var mx = cx - mw / 2, my = cy - r - mh - 10;
      if (my < 8) my = cy + r + 10;
      ctx.fillStyle = "rgba(20,14,10,0.88)";
      roundRect(mx, my, mw, mh, 6);
      ctx.fill();
      ctx.strokeStyle = "#e6c27a";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = "bold 16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#fff8f0";
      ctx.fillText("返回", mx + mw / 2, my + 23);
      addHit(mx, my, mw, mh, function () {
        paused = false;
        goMode();
      });
    }
  }

  function drawSpeedChip(x, y, sp) {
    var active = simSpeed === sp;
    var w = 30;
    var h = 22;
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    if (active) {
      ctx.fillStyle = "#f0b429";
      roundRect(x, y, w, h, 4);
      ctx.fill();
      ctx.fillStyle = "#3a2208";
    } else {
      ctx.fillStyle = "#f4efe6";
    }
    ctx.fillText("x" + sp, x + w / 2, y + 16);
    addHit(x, y, w, h, function () { simSpeed = sp; });
  }

  function drawTimer() {
    ctx.textAlign = "center";
    if (gameMode === "practice") {
      ctx.font = "bold 18px sans-serif";
      ctx.fillStyle = "#3ef0e0";
      ctx.fillText("练习模式", W / 2, 28);
      ctx.font = "bold 42px sans-serif";
      ctx.lineWidth = 7;
      ctx.strokeStyle = "rgba(48, 18, 12, 0.88)";
      ctx.strokeText("∞", W / 2, 88);
      ctx.fillStyle = "#fff8f0";
      ctx.fillText("∞", W / 2, 88);
      return;
    }
    var secs = 60;
    if (matchState === "fight" || matchState === "result" || matchState === "roundEnd") secs = Math.ceil(matchTime);
    if (secs < 0) secs = 0;
    ctx.font = "bold 16px sans-serif";
    ctx.fillStyle = "#e4453a";
    ctx.fillText(roundBannerText(), W / 2, 22);
    ctx.font = "bold 14px sans-serif";
    ctx.fillStyle = "#f4efe6";
    ctx.fillText(roundWinsL + " : " + roundWinsR, W / 2, 40);
    ctx.font = "bold 52px sans-serif";
    ctx.lineWidth = 7;
    ctx.strokeStyle = "rgba(48, 18, 12, 0.88)";
    ctx.strokeText(String(secs), W / 2, 92);
    ctx.fillStyle = (matchState === "fight" && secs <= 10) ? "#ffb067" : "#fff8f0";
    ctx.fillText(String(secs), W / 2, 92);
  }

  function practiceForceCast(skillId) {
    if (gameMode !== "practice" || matchState !== "fight") return false;
    var f = aiFighter();
    if (!f || f.hp <= 0 || !f.skills[skillId]) return false;
    var sk = f.skills[skillId];
    sk.cd = 0;
    if ((sk.cost || 0) > 0) f.chakra = Math.max(f.chakra, sk.cost);
    // Clear stun so the cast can start immediately for training.
    f.stun = 0;
    if (skillId === "spike") shieldPressDown(f);
    else tryCast(f, skillId);
    return true;
  }

  function drawPracticePanel() {
    if (gameMode !== "practice" || matchState !== "fight") return;
    var pw = 600, ph = 160;
    var bx = W / 2 - pw / 2;
    var by = H - 64 - ph;
    if (mobileMode && practicePanel) {
      // pages27: centered modal on phones; dim + swallow taps so stick/skills underneath are not hit
      hudHits = [];
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      addHit(0, 0, W, H, function () {}, "modalBlock");
      by = H / 2 - ph / 2;
      flowButton(W / 2 - 70, by + ph + 14, 140, 40, "关闭设置", true, function () { practicePanel = false; });
    } else

    flowButton(W / 2 - 70, H - 52, 140, 34, practicePanel ? "关闭设置" : "练习设置", true, function () {
      practicePanel = !practicePanel;
    });
    if (!practicePanel) return;
    // pages29: taller panel for enemy skill triggers
    ph = 188;
    if (mobileMode) by = H / 2 - ph / 2;
    else by = H - 64 - ph;
    panelBox(bx, by, pw, ph);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "bold 15px sans-serif";
    ctx.fillStyle = "#f4efe6";
    ctx.fillText("练习设置", bx + 16, by + 26);
    ctx.textBaseline = "alphabetic";
    flowButton(bx + 96, by + 12, 120, 28, practiceAutoAttack ? "自动打我：开" : "自动打我：关", practiceAutoAttack, function () {
      practiceAutoAttack = !practiceAutoAttack;
      practiceDummy = !practiceAutoAttack;
    });
    var curAi = (aiFighter() || right).kit;
    var curAiDef = KIT_DEFS[curAi];
    flowButton(bx + 224, by + 12, 148, 28, "对手：" + (curAiDef ? curAiDef.name : curAi) + " ▸", false, function () {
      // 轮换到下一个已解锁角色（跳过自己），立即重开练习
      var ids = unlockedKitIds(), me = selectedChar || (humanFighter() || left).kit, k, at = ids.indexOf(curAi), nx = null;
      for (k = 1; k <= ids.length; k++) {
        var c = ids[(at + k) % ids.length];
        if (c !== me) { nx = c; break; }
      }
      if (!nx) return;
      practiceAiPick = nx;
      window.__DUEL_AIKIT__ = null;
      practicePanel = false;
      beginMatch();
    });
    flowButton(bx + pw - 220, by + 12, 100, 28, "重选角色", false, function () {
      practicePanel = false;
      goCharSelect();
    });
    flowButton(bx + pw - 112, by + 12, 96, 28, "返回菜单", false, function () {
      practicePanel = false;
      goMode();
    });
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "13px sans-serif";
    ctx.fillStyle = "rgba(200,220,230,0.85)";
    ctx.fillText("敌方技能（点按或按键 → 右边立刻放招；方向键移敌方）", bx + 16, by + 52);
    ctx.textBaseline = "alphabetic";
    var fAi = aiFighter() || right;
    var order = rightOrder;
    var i, n = 0;
    var cols = 4, cw = 138, ch = 30, gx = 6;
    for (i = 0; i < order.length; i++) {
      var sid = order[i];
      var sk = fAi.skills[sid];
      if (!sk) continue;
      var x = bx + 16 + (n % cols) * (cw + gx);
      var y = by + 72 + Math.floor(n / cols) * (ch + 8);
      n++;
      flowButton(x, y, cw, ch, (sk.key || "?") + " " + sk.name, false, (function (id) {
        return function () { practiceForceCast(id); };
      })(sid));
    }
  }

  function panelBox(x, y, w, h) {
    ctx.save();
    roundRect(x, y, w, h, 16);
    ctx.fillStyle = "rgba(8,10,16,0.82)";
    ctx.fill();
    ctx.strokeStyle = "rgba(90,210,200,0.45)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function flowButton(x, y, w, h, label, primary, fn) {
    ctx.save();
    roundRect(x, y, w, h, 12);
    if (primary) {
      var g = ctx.createLinearGradient(x, y, x, y + h);
      g.addColorStop(0, "rgba(40,180,170,0.95)");
      g.addColorStop(1, "rgba(18,90,110,0.95)");
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = "rgba(18,22,30,0.92)";
    }
    ctx.fill();
    ctx.strokeStyle = primary ? "rgba(180,255,245,0.85)" : "rgba(160,180,200,0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();
    // Shrink the label until it fits inside the button (never overflow).
    var fpx = Math.min(22, Math.round(h * 0.62));
    ctx.font = "bold " + fpx + "px sans-serif";
    while (fpx > 9 && ctx.measureText(label).width > w - 12) {
      fpx -= 1;
      ctx.font = "bold " + fpx + "px sans-serif";
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = primary ? "#041018" : "#eef6ff";
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    ctx.textBaseline = "alphabetic";
    ctx.restore();
    addHit(x, y, w, h, fn, "btn:" + label);
  }

  function drawIntroScreen() {
    panelBox(W / 2 - 340, 100, 680, 460);
    ctx.textAlign = "center";
    ctx.font = "bold 54px sans-serif";
    ctx.fillStyle = "#f4fbff";
    ctx.fillText("青岚 · 烬戟", W / 2, 210);
    ctx.font = "18px sans-serif";
    ctx.fillStyle = "rgba(210,230,240,0.9)";
    var lines = [
      "三局两胜对决。带土虚化空间，佩恩天道黑棒气盾，炭治郎水之呼吸与火之形态。",
      "开局可选单人人机、双人对战，或联机并肩打两名人机。",
      "移动：P1 WASD / P2 方向键（或摇杆），技能点按图标或快捷键。",
      "受击会产生僵直，伤害越高停顿越久。"
    ];
    var i;
    for (i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], W / 2, 270 + i * 34);
    }
    ctx.font = "bold 20px sans-serif";
    ctx.fillStyle = "#3ef0e0";
    var pulse = 0.55 + Math.sin(time * 3.2) * 0.35;
    ctx.globalAlpha = pulse;
    ctx.fillText("按任意键 / 点击屏幕 进入", W / 2, 470);
    ctx.globalAlpha = 1;
    addHit(0, 0, W, H, function () { goMode(); });
  }

  function drawModeScreen() {
    if (mobileMode) { drawMobileModeScreen(); drawDeviceToggle(); return; }
    drawDeviceToggle();
    panelBox(W / 2 - 340, 120, 680, 420);
    ctx.textAlign = "center";
    ctx.font = "bold 36px sans-serif";
    ctx.fillStyle = "#f4fbff";
    ctx.fillText("选择对战模式", W / 2, 190);
    ctx.font = "15px sans-serif";
    ctx.fillStyle = "rgba(200,220,230,0.8)";
    ctx.fillText("单人挑战人机；双人对打；联机两人并肩对战两名人机", W / 2, 228);
    flowButton(W / 2 - 300, 270, 180, 70, "单人 · 人机", true, function () {
      gameMode = "ai";
      goCharSelect();
    });
    flowButton(W / 2 - 90, 270, 180, 70, "双人", true, function () {
      gameMode = "vs";
      playerSide = "L";
      goCharSelect();
    });
    flowButton(W / 2 + 120, 270, 180, 70, "联机模式", true, function () {
      gameMode = "coop";
      playerSide = "L";
      goCharSelect();
    });
    flowButton(W / 2 - 90, 360, 180, 56, "练习模式", true, function () {
      gameMode = "practice";
      playerSide = "L";
      practicePanel = false;
      goCharSelect();
    });
    ctx.font = "13px sans-serif";
    ctx.fillStyle = "rgba(180,210,220,0.75)";
    ctx.fillText("联机：P1 WASD + QERF… / P2 方向键 + UIO PJK… 并肩打两名随机人机", W / 2, 430);
    ctx.fillText("练习：左 WASD+技能 · 右方向键移动 · 设置里点敌方技能键放招 · 默认可关自动打我", W / 2, 452);
    flowButton(W / 2 - 90, 470, 180, 44, "返回介绍", false, function () { goIntro(); });
  }

  function drawMobileModeScreen() {
    panelBox(W / 2 - 300, 130, 600, 400);
    ctx.textAlign = "center";
    ctx.font = "bold 40px sans-serif";
    ctx.fillStyle = "#f4fbff";
    ctx.fillText("选择模式", W / 2, 200);
    flowButton(W / 2 - 250, 250, 240, 110, "单人 · 人机", true, function () { gameMode = "ai"; goCharSelect(); });
    flowButton(W / 2 + 10, 250, 240, 110, "练习模式", true, function () { gameMode = "practice"; playerSide = "L"; practicePanel = false; goCharSelect(); });
    flowButton(W / 2 - 100, 420, 200, 60, "返回介绍", false, function () { goIntro(); });
  }

  function rosterById(id) {
    var i;
    for (i = 0; i < charRoster.length; i++) if (charRoster[i].id === id) return charRoster[i];
    return null;
  }

  function drawPortraitCard(x, y, w, h, c, selected, dimmed) {
    ctx.save();
    roundRect(x, y, w, h, 14);
    if (!c.unlocked) ctx.fillStyle = "rgba(28,30,36,0.94)";
    else if (selected) ctx.fillStyle = "rgba(18,46,50,0.96)";
    else ctx.fillStyle = "rgba(245,247,250,0.96)";
    ctx.fill();
    ctx.lineWidth = selected ? 3.5 : 2;
    ctx.strokeStyle = !c.unlocked ? "rgba(90,90,100,0.45)" : (selected ? "#3ef0e0" : "rgba(40,50,70,0.35)");
    ctx.stroke();

    var img = cardImgs[c.id];
    var imgH = h - 58;
    var imgW = w - 20;
    var ix = x + 10;
    var iy = y + 10;
    if (img && img.complete && img.naturalWidth > 0) {
      var iw = img.naturalWidth;
      var ih = img.naturalHeight;
      var sc = Math.min(imgW / iw, imgH / ih);
      var dw = iw * sc;
      var dh = ih * sc;
      var dx = x + (w - dw) / 2;
      var dy = y + 10 + (imgH - dh);
      if (!c.unlocked || dimmed) ctx.globalAlpha = 0.35;
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.globalAlpha = 1;
    } else if (c.unlocked) {
      var pal = (KIT_DEFS[c.id] && KIT_DEFS[c.id].palette) || { body: "#444", glow: "#aaa" };
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h * 0.38, Math.min(w, h) * 0.16, 0, Math.PI * 2);
      ctx.fillStyle = pal.body;
      ctx.fill();
      ctx.strokeStyle = pal.glow;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    if (!c.unlocked) {
      ctx.fillStyle = "rgba(20,20,28,0.55)";
      roundRect(x + 4, y + 4, w - 8, h - 8, 12);
      ctx.fill();
      ctx.fillStyle = "rgba(200,200,210,0.85)";
      ctx.font = "bold 22px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(c.name, x + w / 2, y + h * 0.46);
      ctx.font = "bold 14px sans-serif";
      ctx.fillStyle = "rgba(180,180,190,0.8)";
      ctx.fillText("即将开放", x + w / 2, y + h * 0.58);
    } else {
      ctx.fillStyle = selected ? "#041018" : "#14202c";
      roundRect(x + 8, y + h - 42, w - 16, 30, 8);
      ctx.fill();
      ctx.font = "bold 16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = selected ? "#3ef0e0" : "#f4fbff";
      ctx.fillText(c.name, x + w / 2, y + h - 21);
    }
    ctx.restore();
  }

  function drawVsSlot(x, y, w, h, side, pickId) {
    var active = vsAssignSide === side;
    var c = pickId ? rosterById(pickId) : null;
    var scrollId = side === "L" ? selectedScrollL : selectedScrollR;
    var scrollDef = scrollId ? scrollById(scrollId) : null;
    ctx.save();
    roundRect(x, y, w, h, 16);
    ctx.fillStyle = active ? "rgba(20,48,52,0.96)" : "rgba(12,16,24,0.92)";
    ctx.fill();
    ctx.lineWidth = active ? 4 : 2;
    ctx.strokeStyle = active ? "#3ef0e0" : (c ? "rgba(160,200,190,0.55)" : "rgba(140,170,190,0.35)");
    ctx.stroke();
    if (active) {
      ctx.fillStyle = "#3ef0e0";
      ctx.beginPath();
      ctx.moveTo(x + w / 2 - 9, y - 1);
      ctx.lineTo(x + w / 2 + 9, y - 1);
      ctx.lineTo(x + w / 2, y + 9);
      ctx.closePath();
      ctx.fill();
    }
    ctx.textAlign = "center";
    ctx.font = "bold 17px sans-serif";
    ctx.fillStyle = "#f4fbff";
    ctx.fillText(side === "L" ? "左侧 · P1" : "右侧 · P2", x + w / 2, y + 26);
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "rgba(190,210,220,0.75)";
    ctx.fillText(side === "L" ? "WASD · 左摇杆" : "方向键 · 右摇杆", x + w / 2, y + 46);

    if (c) {
      var img = cardImgs[c.id];
      var boxY = y + 56;
      var boxH = h - 108;
      var boxW = w - 24;
      var boxX = x + 12;
      roundRect(boxX, boxY, boxW, boxH, 12);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "rgba(40,50,70,0.22)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (img && img.complete && img.naturalWidth > 0) {
        var sc = Math.min((boxW - 6) / img.naturalWidth, (boxH - 36) / img.naturalHeight);
        var dw = img.naturalWidth * sc;
        var dh = img.naturalHeight * sc;
        ctx.drawImage(img, boxX + (boxW - dw) / 2, boxY + boxH - 32 - dh, dw, dh);
      } else {
        var pal = (KIT_DEFS[c.id] && KIT_DEFS[c.id].palette) || { body: "#444", glow: "#aaa" };
        ctx.beginPath();
        ctx.arc(x + w / 2, boxY + boxH * 0.4, Math.min(boxW, boxH) * 0.2, 0, Math.PI * 2);
        ctx.fillStyle = pal.body;
        ctx.fill();
        ctx.strokeStyle = pal.glow;
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.font = "bold 20px sans-serif";
      ctx.fillStyle = "#14202c";
      ctx.fillText(c.name, x + w / 2, boxY + boxH - 12);
      if (scrollDef) {
        var simg = scrollImgs[scrollDef.id];
        var sx = x + w / 2;
        var sy = y + h - 24;
        ctx.beginPath();
        ctx.arc(sx, sy, 15, 0, Math.PI * 2);
        ctx.fillStyle = "#0c1018";
        ctx.fill();
        if (simg && simg.complete && simg.naturalWidth > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(sx, sy, 14, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(simg, sx - 14, sy - 14, 28, 28);
          ctx.restore();
        }
        ctx.strokeStyle = scrollDef.color || "#3ef0e0";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, 15, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      ctx.font = "bold 16px sans-serif";
      ctx.fillStyle = active ? "#3ef0e0" : "rgba(160,180,200,0.55)";
      ctx.fillText(active ? "下一名：点中央角色" : "等待选择", x + w / 2, y + h * 0.48);
      ctx.font = "12px sans-serif";
      ctx.fillStyle = "rgba(180,200,210,0.6)";
      ctx.fillText(side === "L" ? "第一次点击填这里" : "第二次点击填这里", x + w / 2, y + h * 0.58);
    }
    ctx.restore();
    addHit(x, y, w, h, (function (s) {
      return function () { vsAssignSide = s; };
    })(side));
  }

  function drawScrollPicker(y, mode) {
    // mode: "solo" | "vs" — pages30j: 通灵栏（密卷 + 熊猫 + 鲛鲨）
    var i;
    var iconR = 30;
    var gap = 16;
    var n = SCROLL_DEFS.length;
    var totalW = n * (iconR * 2) + (n - 1) * gap;
    var startX = (W - totalW) / 2 + iconR;
    ctx.textAlign = "center";
    ctx.font = "bold 16px sans-serif";
    ctx.fillStyle = "#f4fbff";
    ctx.fillText("通灵栏", W / 2, y - 34);
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "rgba(200,220,230,0.75)";
    if (mode === "vs") {
      ctx.fillText("通灵：霸体 / 回蓝 / 清CD / 驱散 / 熊猫 / 鲛鲨 · 先赋左再赋右", W / 2, y - 16);
    } else {
      ctx.fillText("通灵：密卷四选一，或熊猫/鲛鲨通灵（落下砸击）", W / 2, y - 16);
    }
    for (i = 0; i < n; i++) {
      var def = SCROLL_DEFS[i];
      var cx = startX + i * (iconR * 2 + gap);
      var cy = y + 28;
      var pickedSolo = mode === "solo" && selectedScroll === def.id;
      var pickedL = mode === "vs" && selectedScrollL === def.id;
      var pickedR = mode === "vs" && selectedScrollR === def.id;
      var picked = pickedSolo || pickedL || pickedR;
      ctx.beginPath();
      ctx.arc(cx, cy, iconR + 4, 0, Math.PI * 2);
      ctx.fillStyle = picked ? "rgba(62,240,224,0.25)" : "rgba(8,12,18,0.7)";
      ctx.fill();
      ctx.lineWidth = picked ? 3 : 2;
      ctx.strokeStyle = picked ? "#3ef0e0" : "rgba(160,180,200,0.35)";
      ctx.stroke();
      var img = scrollImgs[def.id];
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, iconR - 1, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, cx - iconR + 1, cy - iconR + 1, (iconR - 1) * 2, (iconR - 1) * 2);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(cx, cy, iconR - 4, 0, Math.PI * 2);
        ctx.fillStyle = def.color;
        ctx.fill();
      }
      ctx.font = "bold 12px sans-serif";
      ctx.fillStyle = picked ? "#3ef0e0" : "rgba(230,240,250,0.85)";
      ctx.fillText(def.name, cx, cy + iconR + 14);
      if (pickedL || pickedR) {
        ctx.font = "bold 11px sans-serif";
        ctx.fillStyle = "#3ef0e0";
        ctx.fillText(pickedL && pickedR ? "双" : (pickedL ? "左" : "右"), cx, cy + iconR + 28);
      }
      addHit(cx - iconR - 4, cy - iconR - 4, (iconR + 4) * 2, (iconR + 4) * 2 + 16, (function (sid) {
        return function () {
          if (mode === "solo") {
            selectedScroll = sid;
          } else {
            // Fill empty scroll slots left-then-right; if both filled, replace focused side
            if (!selectedScrollL) {
              if (selectedScrollR === sid) selectedScrollR = null;
              selectedScrollL = sid;
            } else if (!selectedScrollR) {
              if (selectedScrollL === sid) return;
              selectedScrollR = sid;
            } else if (vsAssignSide === "L") {
              if (selectedScrollR === sid) return;
              selectedScrollL = sid;
            } else {
              if (selectedScrollL === sid) return;
              selectedScrollR = sid;
            }
          }
        };
      })(def.id), "scroll:" + def.id);
    }
  }

  function vsScrollReady() {
    return !!(selectedScrollL && selectedScrollR);
  }

  function drawVsCharSelectScreen() {
    if (!coreAssetsReady()) {
      panelBox(50, 28, W - 100, H - 56);
      ctx.textAlign = "center";
      ctx.font = "bold 22px sans-serif";
      ctx.fillStyle = "#f4fbff";
      ctx.fillText("加载菜单素材…", W / 2, H / 2);
      var pr = groupProgress(["core"]);
      ctx.font = "14px sans-serif";
      ctx.fillStyle = "#aaa";
      ctx.fillText(pr.done + " / " + pr.tot, W / 2, H / 2 + 28);
      return;
    }
    panelBox(40, 28, W - 80, H - 56);
    ctx.textAlign = "center";
    ctx.font = "bold 28px sans-serif";
    ctx.fillStyle = "#f4fbff";
    ctx.fillText(gameMode === "coop" ? "联机选角 · 2v2" : "双人选角", W / 2, 62);
    ctx.font = "13px sans-serif";
    ctx.fillStyle = "rgba(200,220,230,0.85)";
    var stepHint = !selectedL
      ? "点击角色卡 → 自动填入左侧 P1"
      : (!selectedR ? "再点另一名角色 → 自动填入右侧 P2" : "两边已选；点左右框可改侧，再点卡可更换");
    if (gameMode === "coop") {
      stepHint = !selectedL
        ? "联机：点角色卡 → P1（WASD）"
        : (!selectedR ? "再点另一名 → P2（方向键）；对手为两名随机人机" : "已选两人；开始后并肩打两名人机");
    }
    ctx.fillText(stepHint, W / 2, 84);

    var slotW = 190;
    var slotH = 300;
    drawVsSlot(56, 100, slotW, slotH, "L", selectedL);
    drawVsSlot(W - 56 - slotW, 100, slotW, slotH, "R", selectedR);

    // pages31e: 4 列（7 角色两排），网格不压通灵栏
    var cols = Math.max(3, Math.ceil(charRoster.length / 2));
    var cardW = 124;
    var cardH = 160;
    var gapX = 14;
    var gapY = 8;
    var gridW = cols * cardW + (cols - 1) * gapX;
    var startX = (W - gridW) / 2;
    var startY = 98;
    var i;
    for (i = 0; i < charRoster.length; i++) {
      var c = charRoster[i];
      var col = i % cols;
      var row = Math.floor(i / cols);
      var x = startX + col * (cardW + gapX);
      var y = startY + row * (cardH + gapY);
      var taken = (selectedL === c.id) || (selectedR === c.id);
      drawPortraitCard(x, y, cardW, cardH, c, taken, false);
      if (taken) {
        ctx.save();
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "center";
        roundRect(x + 8, y + 8, cardW - 16, 22, 7);
        ctx.fillStyle = "#3ef0e0";
        ctx.fill();
        ctx.fillStyle = "#041018";
        ctx.fillText(selectedL === c.id ? "已选 · 左" : "已选 · 右", x + cardW / 2, y + 23);
        ctx.restore();
      }
      if (c.unlocked) {
        addHit(x, y, cardW, cardH, (function (cid) {
          return function () { pickVsCard(cid); };
        })(c.id), "card:" + c.id);
      }
    }

    drawScrollPicker(512, "vs");

    var can = vsCanConfirm() && vsScrollReady();
    ctx.font = "13px sans-serif";
    ctx.fillStyle = can ? "rgba(180,255,220,0.9)" : "rgba(255,180,140,0.9)";
    var tip = "请为左右各选不同角色与通灵";
    if (vsCanConfirm() && !vsScrollReady()) tip = "角色已选，请再为左右各选通灵";
    else if (can) tip = "可以开始对战";
    ctx.fillText(tip, W / 2, H - 78);

    flowButton(40, H - 58, 120, 38, "返回", false, function () { goMode(); });
    flowButton(W / 2 - 100, H - 64, 200, 46, gameMode === "coop" ? "开始联机" : "开始对战", can, function () {
      if (!vsCanConfirm() || !vsScrollReady()) return;
      beginMatch();
    });
  }

  function drawSoloCharSelectScreen() {
    if (!coreAssetsReady()) {
      panelBox(50, 28, W - 100, H - 56);
      ctx.textAlign = "center";
      ctx.font = "bold 22px sans-serif";
      ctx.fillStyle = "#f4fbff";
      ctx.fillText("加载菜单素材…", W / 2, H / 2);
      var pr = groupProgress(["core"]);
      ctx.font = "14px sans-serif";
      ctx.fillStyle = "#aaa";
      ctx.fillText(pr.done + " / " + pr.tot, W / 2, H / 2 + 28);
      return;
    }
    panelBox(50, 28, W - 100, H - 56);
    ctx.textAlign = "center";
    ctx.font = "bold 30px sans-serif";
    ctx.fillStyle = "#f4fbff";
    ctx.fillText("选择角色与通灵", W / 2, 68);
    ctx.font = "13px sans-serif";
    ctx.fillStyle = "rgba(200,220,230,0.8)";
    ctx.fillText("先点角色卡，再点底部通灵栏，然后开始。对手自动是另一位解锁角色。", W / 2, 92);

    // pages31e: 4 列（7 角色两排），网格不压通灵栏
    var cols = Math.max(3, Math.ceil(charRoster.length / 2));
    var cardW = 136;
    var cardH = 176;
    var gapX = 18;
    var gapY = 10;
    var gridW = cols * cardW + (cols - 1) * gapX;
    var startX = (W - gridW) / 2;
    var startY = 108;
    var i;
    for (i = 0; i < charRoster.length; i++) {
      var c = charRoster[i];
      var col = i % cols;
      var row = Math.floor(i / cols);
      var x = startX + col * (cardW + gapX);
      var y = startY + row * (cardH + gapY);
      var selected = c.unlocked && selectedChar === c.id;
      drawPortraitCard(x, y, cardW, cardH, c, selected, false);
      if (c.unlocked) {
        addHit(x, y, cardW, cardH, (function (cid) {
          return function () { applyPlayerPick(cid); };
        })(c.id), "card:" + c.id);
      }
    }

    drawScrollPicker(540, "solo");

    var can = !!(selectedChar && selectedScroll);
    ctx.font = "13px sans-serif";
    ctx.fillStyle = can ? "rgba(180,255,220,0.9)" : "rgba(255,180,140,0.9)";
    ctx.fillText(can ? "角色与通灵已选，可以开始" : "请选择角色和一项通灵", W / 2, H - 78);

    flowButton(40, H - 58, 120, 38, "返回", false, function () { goMode(); });
    flowButton(W / 2 - 100, H - 64, 200, 46, "开始对战", can, function () {
      if (!selectedChar || !selectedScroll) return;
      beginMatch();
    });
  }

  function drawCharSelectScreen() {
    if (gameMode === "vs" || gameMode === "coop") drawVsCharSelectScreen();
    else drawSoloCharSelectScreen();
  }

  function drawHud() {
    drawHudInner();
    if (isPortrait()) {
      hudHits = [];
      ctx.save();
      ctx.fillStyle = "rgba(4,6,10,0.94)";
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = "center";
      ctx.fillStyle = "#f4fbff";
      ctx.font = "bold 64px sans-serif";
      ctx.fillText("请横屏", W / 2, H / 2);
      ctx.font = "28px sans-serif";
      ctx.fillStyle = "rgba(200,220,230,0.8)";
      ctx.fillText("把手机横过来，体验更好", W / 2, H / 2 + 60);
      ctx.restore();
    }
  }
  function drawHudInner() {
    hudHits = [];

    if (matchState === "intro") {
      drawStage();
      drawIntroScreen();
      return;
    }
    if (matchState === "mode") {
      drawStage();
      drawModeScreen();
      return;
    }
    if (matchState === "charSelect") {
      drawStage();
      drawCharSelectScreen();
      return;
    }

    drawTimer();
    if (!hudHidden) {
      var i;
      if (isCoop()) {
        ctx.textAlign = "left";
        ctx.font = "bold 14px sans-serif";
        ctx.fillStyle = "#f4efe6";
        ctx.fillText("P1 · " + left.name, 16, 16);
        drawResourceBars(16, 22, 200, left, false);
        drawPortrait(236, 38, left);
        ctx.fillText("P2 · " + left2.name, 16, 92);
        drawResourceBars(16, 98, 200, left2, false);
        drawPortrait(236, 114, left2);
        for (i = 0; i < leftOrder.length; i++) drawSkillOrb(30 + i * 50, 160, left, leftOrder[i]);
        for (i = 0; i < left2Order.length; i++) drawSkillOrb(30 + i * 50, 214, left2, left2Order[i]);

        ctx.textAlign = "right";
        ctx.font = "bold 14px sans-serif";
        ctx.fillStyle = "#f4efe6";
        ctx.fillText("AI · " + right.name, W - 16, 16);
        drawResourceBars(W - 16, 22, 200, right, true);
        drawPortrait(W - 236, 38, right);
        ctx.fillText("AI · " + right2.name, W - 16, 92);
        drawResourceBars(W - 16, 98, 200, right2, true);
        drawPortrait(W - 236, 114, right2);
      } else {
        ctx.textAlign = "left";
        ctx.font = "bold 16px sans-serif";
        ctx.fillStyle = "#f4efe6";
        ctx.fillText(left.name + (((gameMode === "ai" || gameMode === "practice") && playerSide === "L") ? " · 你" : ((gameMode === "ai" || gameMode === "practice") ? " · AI" : "")), 16, 18);
        drawResourceBars(16, 26, 230, left, false);
        drawPortrait(278, 42, left);
        if (!(mobileMode && humanControls(left))) for (i = 0; i < leftOrder.length; i++) drawSkillOrb(30 + i * 56, 108, left, leftOrder[i]);

        drawPortrait(W - 278, 42, right);
        ctx.textAlign = "right";
        ctx.font = "bold 16px sans-serif";
        ctx.fillStyle = "#f4efe6";
        ctx.fillText((((gameMode === "ai" || gameMode === "practice") && playerSide === "R") ? "你 · " : ((gameMode === "ai" || gameMode === "practice") ? "AI · " : "")) + right.name, W - 16, 18);
        drawResourceBars(W - 16, 26, 230, right, true);
        if (!(mobileMode && humanControls(right))) for (i = 0; i < rightOrder.length; i++) drawSkillOrb(W - 30 - (rightOrder.length - 1 - i) * 56, 108, right, rightOrder[i]);
      }

      drawPauseButton(34, H - 36);
      var speeds = [1, 2, 4, 8];
      for (i = 0; i < speeds.length; i++) drawSpeedChip(66 + i * 36, H - 47, speeds[i]);
      ctx.fillStyle = "#f0b429";
      roundRect(214, H - 52, 118, 32, 6);
      ctx.fill();
      ctx.strokeStyle = "#8a5a10";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = "bold 16px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#3a2208";
      ctx.fillText("隐藏界面", 273, H - 31);
      addHit(214, H - 52, 118, 32, function () { hudHidden = true; });
    } else {
      ctx.fillStyle = "rgba(20,14,10,0.72)";
      roundRect(24, H - 52, 92, 30, 6);
      ctx.fill();
      ctx.font = "bold 14px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#f4efe6";
      ctx.fillText("显示界面", 70, H - 32);
      addHit(24, H - 52, 92, 30, function () { hudHidden = false; });
    }
    var modalPanel = mobileMode && gameMode === "practice" && practicePanel && matchState === "fight";
    if (gameMode === "practice" && !modalPanel) drawPracticePanel();
    if (matchState === "fight" || matchState === "countdown" || matchState === "roundEnd") { drawSticks(); if (mobileMode && !hudHidden) drawMobileSkillArc(); }
    if (modalPanel) drawPracticePanel();

    if (matchState === "countdown") {
      ctx.textAlign = "center";
      if (countdownPhase === "round") {
        ctx.font = "bold 72px sans-serif";
        ctx.fillStyle = "#f4fbff";
        ctx.strokeStyle = "rgba(20,12,10,0.65)";
        ctx.lineWidth = 8;
        var rb = roundBannerText();
        ctx.strokeText(rb, W / 2, H / 2);
        ctx.fillText(rb, W / 2, H / 2);
        if (gameMode !== "practice") {
          ctx.font = "bold 22px sans-serif";
          ctx.fillStyle = "#f4efe6";
          ctx.fillText(roundWinsL + " : " + roundWinsR, W / 2, H / 2 + 48);
        }
      } else {
        ctx.font = "bold 64px sans-serif";
        ctx.fillStyle = "#ffe7a0";
        ctx.strokeStyle = "rgba(20,12,10,0.65)";
        ctx.lineWidth = 8;
        ctx.strokeText("开始战斗", W / 2, H / 2 + 10);
        ctx.fillText("开始战斗", W / 2, H / 2 + 10);
      }
    }
    if (matchState === "roundEnd") {
      var rw = matchResult === "L" ? left : (matchResult === "R" ? right : null);
      var roundTitle = null;
      if (!rw) roundTitle = "本回平局";
      else if (isCoop()) roundTitle = (matchResult === "L" ? "联机队" : "人机队") + " 赢下本回";
      else roundTitle = rw.name + " 赢下本回";
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(W / 2 - 220, H / 2 - 78, 440, 130);
      ctx.textAlign = "center";
      ctx.font = "bold 42px sans-serif";
      if (!rw) {
        ctx.fillStyle = "#e8eef2";
        ctx.fillText(roundTitle, W / 2, H / 2 - 12);
      } else {
        ctx.fillStyle = rw.palette.glow;
        ctx.fillText(roundTitle, W / 2, H / 2 - 12);
      }
      ctx.font = "18px sans-serif";
      ctx.fillStyle = "#e8eef2";
      ctx.fillText("比分 " + roundWinsL + " : " + roundWinsR + "    下一回准备中", W / 2, H / 2 + 28);
    }
    if (matchState === "result") {
      var winner = matchResult === "L" ? left : (matchResult === "R" ? right : null);
      var winTitle = null;
      if (!winner) winTitle = "平局";
      else if (isCoop()) winTitle = (matchResult === "L" ? "联机队" : "人机队") + " 胜负已分";
      else winTitle = winner.name + " 胜负已分";
      panelBox(W / 2 - 260, H / 2 - 140, 520, 280);
      ctx.textAlign = "center";
      ctx.font = "bold 48px sans-serif";
      if (!winner) {
        ctx.fillStyle = "#e8eef2";
        ctx.fillText(winTitle, W / 2, H / 2 - 60);
      } else {
        ctx.fillStyle = winner.palette.glow;
        ctx.fillText(winTitle, W / 2, H / 2 - 60);
      }
      ctx.font = "18px sans-serif";
      ctx.fillStyle = "#e8eef2";
      ctx.fillText("三局两胜  " + roundWinsL + " : " + roundWinsR, W / 2, H / 2 - 18);
      flowButton(W / 2 - 210, H / 2 + 20, 180, 52, "再选模式", true, function () { goMode(); });
      flowButton(W / 2 + 30, H / 2 + 20, 180, 52, "返回标题", false, function () { goIntro(); });
      flowButton(W / 2 - 90, H / 2 + 90, 180, 44, "同配置再战", false, function () { beginMatch(); });
    }
    ctx.textAlign = "left";
  }

  var bootOverlayGone = false;
  function hideBootOverlay() {
    if (bootOverlayGone) return;
    bootOverlayGone = true;
    var el = document.getElementById("boot");
    if (el) el.parentNode.removeChild(el);
  }
  function render() {
    if (!bootOverlayGone) {
      var bo = document.getElementById("bootMsg");
      var cp = groupProgress(["core"]);
      if (bo) bo.textContent = "加载菜单素材 " + cp.done + " / " + cp.tot + (loadStatusLines()[0] ? " · " + loadStatusLines()[0] : "");
      if (coreAssetsReady()) hideBootOverlay();
    }
    var ox = 0;
    var oy = 0;
    if (shake > 0 && !isMenuState()) {
      ox = (Math.random() - 0.5) * shake;
      oy = (Math.random() - 0.5) * shake;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(1, 0, 0, 1, ox, oy);
    if (matchState === "loading") { drawLoading(); return; }
    if (matchState === "intro" || matchState === "mode" || matchState === "charSelect") {
      // Flow screens paint their own stage + UI inside drawHud.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawHud();
      return;
    }
    drawStage();
    drawSpikes();
    drawRings();
    drawWheels();
    var batch = [];
    var gi;
    var fightersDraw = activeFighters();
    for (gi = 0; gi < fightersDraw.length; gi++) {
      batch.push({ y: fightersDraw[gi].y, kind: "f", who: fightersDraw[gi] });
    }
    for (gi = 0; gi < ghosts.length; gi++) batch.push({ y: ghosts[gi].y, kind: "g", who: ghosts[gi] });
    for (gi = 0; gi < projectiles.length; gi++) batch.push({ y: projectiles[gi].y + 70, kind: "p", who: projectiles[gi] });
    for (gi = 0; gi < swords.length; gi++) batch.push({ y: swords[gi].y, kind: "b", who: swords[gi] });
    batch.sort(function (a, b) { return a.y - b.y; });
    // pages25: 吸引 vortex is painted behind the fighters so it no longer covers Pain's body
    for (gi = 0; gi < fightersDraw.length; gi++) drawPullStreams(fightersDraw[gi]);
    for (gi = 0; gi < batch.length; gi++) {
      if (batch[gi].kind === "f") drawFighter(batch[gi].who);
      else if (batch[gi].kind === "g") drawGhost(batch[gi].who);
      else if (batch[gi].kind === "b") drawEnergySword(batch[gi].who);
      else drawOneProjectile(batch[gi].who);
    }
    drawBursts();
    for (gi = 0; gi < fightersDraw.length; gi++) {
      if (fightersDraw[gi].shield > 0 && !fightersDraw[gi].repulseOn) drawAirShield(fightersDraw[gi]);
    }
    drawSparks();
    drawFloaters();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawHud();
  }

  var last = 0;
  function frame(now) {
    if (!last) last = now;
    var dt = (now - last) / 1000;
    last = now;
    var step = paused ? 0 : Math.min(dt, 0.05) * simSpeed;
    if (step > 0.22) step = 0.22;
    if (matchState === "fight" && phaseSlow > 0 && step > 0) {
      if (phaseSlow >= step) {
        phaseSlow -= step;
        step *= 0.5;
      } else {
        var rest = step - phaseSlow;
        step = phaseSlow * 0.5 + rest;
        phaseSlow = 0;
      }
    }
    if (matchState === "loading") {
      loadT += dt;
      if (sheetManifest) {
        for (var lk = 0; lk < loadKits.length; lk++) {
          if (!(ASSET_GROUPS[loadKits[lk]] || []).length) { registerKitSheets(loadKits[lk]); ensureGroups([loadKits[lk]], "match"); }
        }
      }
      var lp = groupProgress(loadKits.concat(["core"]));
      if (!sheetManifest) lp.tot = lp.done + 1;
      
      if (lp.done >= lp.tot && lp.err === 0) {
        loadMode = "idle";
        matchStall = false;
        beginCountdown();
      }
      render();
      requestAnimationFrame(frame);
      return;
    }
    if (matchState === "countdown") {
      if (step <= 0) {
        render();
        requestAnimationFrame(frame);
        return;
      }
      time += step;
      countLeft -= step;
      if (countLeft <= 0) {
        if (countdownPhase === "round") {
          countdownPhase = "fight";
          countLeft = 0.95;
        } else {
          matchState = "fight";
          if (gameMode === "practice") {
            matchTime = 99999;
            fightClockReset(99999);
          } else {
            fightClockReset(60);
            matchTime = 60;
          }
          if (!paused) fightClockResume();
          syncFlowHint();
        }
      }
    } else if (matchState === "roundEnd") {
      if (step > 0) {
        time += step;
        roundEndLeft -= step;
        if (roundEndLeft <= 0) {
          roundIndex += 1;
          beginCountdown();
        }
      }
    } else if (matchState === "fight") {
      if (step > 0) {
        updateAI(step);
        update(step);
      }
      if (matchState === "fight" && gameMode !== "practice") {
        // pages23: round timer = real seconds (ignores simSpeed and frame hitches).
        fightClockTick();
        matchTime = Math.max(0, fightClock.limit - fightClockElapsed());
        if (matchTime <= 0) {
          matchTime = 0;
          endByTime();
        }
      }
    } else {
      time += dt;
    }
    render();
    requestAnimationFrame(frame);
  }

  var controlMap = {
    q: ["L", "punch"],
    e: ["L", "phase"],
    r: ["L", "tele"],
    f: ["L", "breath"],
    u: ["R", "thrust"],
    i: ["R", "fire"],
    o: ["R", "swap"],
    p: ["R", "spike"],
    j: ["R", "pull"],
    c: ["L", "space"],
    k: ["R", "cleave"]
  };

  function mappedSkillRelease(k) {
    var m = controlMap[k];
    return m ? m[1] : null;
  }

  function isArrowKey(key) {
    return key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight";
  }

  window.addEventListener("keydown", function (e) {
    if (e.key === "Shift") {
      keysDown.shift = true;
      return;
    }
    if (e.code === "Space" || e.key === " ") e.preventDefault();
    if (matchState === "intro" && !e.repeat) {
      e.preventDefault();
      goMode();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (matchState === "result" && !e.repeat && !keysDown.enter) beginMatch();
      if (matchState === "mode" && !e.repeat) {
        gameMode = "ai";
        goCharSelect();
      }
      keysDown.enter = true;
      return;
    }
    if (matchState === "mode" || matchState === "charSelect" || matchState === "result" || matchState === "countdown" || matchState === "roundEnd") {
      if (isArrowKey(e.key)) e.preventDefault();
      return;
    }
    if (matchState !== "fight") {
      if (isArrowKey(e.key)) e.preventDefault();
      return;
    }
    if (isArrowKey(e.key)) {
      e.preventDefault();
      keysDown[e.key] = true;
      return;
    }
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === "w" || k === "a" || k === "s" || k === "d") {
      e.preventDefault();
      keysDown[k] = true;
      return;
    }
    var mapped = controlMap[k];
    if (!mapped) return;
    e.preventDefault();
    if (e.repeat || keysDown[k]) {
      keysDown[k] = true;
      return;
    }
    keysDown[k] = true;
    var caster = fighterByOwner(mapped[0]);
    if (!caster) return;
    // pages29 practice: U/I/O/P/J/K/L force-cast the right sparring partner (ignore humanControls)
    if (gameMode === "practice" && mapped[0] === "R" && caster === aiFighter()) {
      practiceForceCast(mapped[1]);
      return;
    }
    if (!humanControls(caster)) return;
    if (mapped[1] === "spike") shieldPressDown(caster);
    else tryCast(caster, mapped[1]);
  });

  window.addEventListener("keyup", function (e) {
    if (e.key === "Shift") {
      keysDown.shift = false;
      return;
    }
    if (isArrowKey(e.key)) {
      keysDown[e.key] = false;
      return;
    }
    if (e.key === "Enter") {
      keysDown.enter = false;
      return;
    }
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mappedSkillRelease(k) === "spike") {
      var rel = controlMap[k];
      if (rel) {
        var relF = fighterByOwner(rel[0]);
        if (relF) shieldPressUp(relF);
      }
    }
    keysDown[k] = false;
  });

  window.addEventListener("blur", function () {
    shieldPressUp(left);
    shieldPressUp(right);
    shieldPressUp(left2);
    shieldPressUp(right2);
    var key;
    for (key in keysDown) keysDown[key] = false;
    releaseStick(sticks[0].pid);
    releaseStick(sticks[1].pid);
  });

  var sticks = [
    { id: "L", cx: 86, cy: H - 176, r: 58, dx: 0, dy: 0, nx: 0, ny: 0, pid: null },
    { id: "R", cx: W - 86, cy: H - 176, r: 58, dx: 0, dy: 0, nx: 0, ny: 0, pid: null }
  ];

  function drawMobileSkillArc() {
    var f = humanFighter();
    var order = (f.id === "L") ? leftOrder : rightOrder;
    if (!order || !order.length) return;
    var ox = W - 92, oy = H - 92;
    var rest = order.slice(1);
    var inner = rest.slice(0, 3), outer = rest.slice(3);
    function ring(list, R, r) {
      var n = list.length, j;
      for (j = 0; j < n; j++) {
        var a = n === 1 ? Math.PI * 1.25 : Math.PI + 0.12 + (Math.PI / 2 - 0.24) * j / (n - 1);
        drawSkillOrb(ox + Math.cos(a) * R, oy + Math.sin(a) * R, f, list[j], r);
      }
    }
    ring(inner, 150, 38);
    ring(outer, 250, 38);
    drawSkillOrb(ox, oy, f, order[0], 56);
  }

  function layoutSticks() {
    if (mobileMode) { sticks[0].cx = 150; sticks[0].cy = H - 200; sticks[0].r = 84; }
    else { sticks[0].cx = 86; sticks[0].cy = H - 176; sticks[0].r = 58; }
  }

  function drawSticks() {
    var i;
    layoutSticks();
    for (i = 0; i < (mobileMode ? 1 : sticks.length); i++) {
      var s = sticks[i];
      ctx.beginPath();
      ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(16, 12, 10, 0.42)";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(230, 214, 180, 0.9)";
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(s.cx, s.cy, 16, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(230, 214, 180, 0.35)";
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(s.cx + s.dx, s.cy + s.dy, 22, 0, Math.PI * 2);
      ctx.fillStyle = s.pid !== null ? "rgba(240, 180, 70, 0.92)" : "rgba(244, 236, 220, 0.88)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#3a2414";
      ctx.stroke();
    }
  }

  function stickAt(x, y) {
    var i;
    if (mobileMode && practicePanel && gameMode === "practice" && matchState === "fight") return null;
    layoutSticks();
    for (i = 0; i < (mobileMode ? 1 : sticks.length); i++) {
      var s = sticks[i];
      if (planarDist(x, y, s.cx, s.cy) <= s.r) return s;
    }
    return null;
  }

  function aimStick(s, x, y) {
    var dx = x - s.cx;
    var dy = y - s.cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var max = s.r - 26;
    if (dist > max && dist > 0) {
      dx = dx / dist * max;
      dy = dy / dist * max;
      dist = max;
    }
    s.dx = dx;
    s.dy = dy;
    if (dist < 10) {
      s.nx = 0;
      s.ny = 0;
    } else {
      s.nx = dx / dist;
      s.ny = dy / dist;
    }
  }

  function releaseStick(pid) {
    var i;
    for (i = 0; i < sticks.length; i++) {
      if (sticks[i].pid === pid) {
        sticks[i].pid = null;
        sticks[i].dx = 0;
        sticks[i].dy = 0;
        sticks[i].nx = 0;
        sticks[i].ny = 0;
      }
    }
  }

  canvas.addEventListener("pointerdown", function (e) {
    if (isMenuState()) return;
    var pt = canvasPoint(e);
    if (!pt) return;
    var s = stickAt(pt.x, pt.y);
    if (!s || s.pid !== null) return;
    e.preventDefault();
    s.pid = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    aimStick(s, pt.x, pt.y);
  }, { passive: false });

  canvas.addEventListener("pointermove", function (e) {
    var i, s = null;
    for (i = 0; i < sticks.length; i++) {
      if (sticks[i].pid === e.pointerId) s = sticks[i];
    }
    if (!s) return;
    e.preventDefault();
    var pt = canvasPoint(e);
    if (!pt) return;
    aimStick(s, pt.x, pt.y);
  }, { passive: false });

  canvas.addEventListener("pointerup", function (e) {
    releaseStick(e.pointerId);
    var hf = (gameMode === "ai" || gameMode === "practice") ? humanFighter() : null;
    if (hf && hf.shieldTouch) { hf.shieldTouch = false; shieldPressUp(hf); }
  });
  canvas.addEventListener("pointercancel", function (e) { releaseStick(e.pointerId); });

  function canvasPoint(e) {
    var rect = canvas.getBoundingClientRect();
    var fit = Math.min(rect.width / W, rect.height / H);
    if (fit <= 0) return null;
    var ox = (rect.width - W * fit) / 2;
    var oy = (rect.height - H * fit) / 2;
    return {
      x: (e.clientX - rect.left - ox) / fit,
      y: (e.clientY - rect.top - oy) / fit
    };
  }

  // pages25: ONE pointerdown handler for every UI hit (menus + fight HUD + practice panel).
  // The old mousedown+pointerdown pair needed a 220ms latch and a 50ms "screen changed" guard
  // to avoid double-firing; those guards were what swallowed the first click on a new screen.
  canvas.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    var pt = canvasPoint(e);
    if (!pt) return;
    if (!isMenuState() && matchState !== "loading" && stickAt(pt.x, pt.y)) return;
    var hi;
    for (hi = hudHits.length - 1; hi >= 0; hi--) {
      var zone = hudHits[hi];
      if (pt.x >= zone.x && pt.x <= zone.x + zone.w && pt.y >= zone.y && pt.y <= zone.y + zone.h) {
        e.preventDefault();
        lastUiHit = { tag: zone.tag, t: performance.now(), state: matchState };
        zone.fn();
        return;
      }
    }
    var swordCandidates = activeFighters();
    var swordF = null;
    var si;
    for (si = 0; si < swordCandidates.length; si++) {
      var cand = swordCandidates[si];
      if (cand.kit === "pain" && cand.hp > 0 && humanControls(cand) && cand.armor > 0) {
        swordF = cand;
        break;
      }
    }
    if (!swordF || paused || matchState !== "fight" || koId) return;
    var mx = pt.x;
    var my = pt.y;
    var x0 = swordF.x;
    var y0 = swordF.y - 78;
    var dx = mx - x0;
    var dy = my - y0;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var speed = 1500;
    swords.push({
      x: x0,
      y: y0,
      vx: dx / len * speed,
      vy: dy / len * speed,
      life: 1.15,
      hit: false,
      owner: swordF.id
    });
  }, { passive: false });

  window.__DUEL_DEBUG__ = function () {
    return {
      matchState: matchState,
      mobileMode: mobileMode,
      gameMode: gameMode,
      countdownPhase: countdownPhase,
      countLeft: countLeft,
      roundIndex: roundIndex,
      roundBanner: roundBannerText(),
      matchTime: matchTime,
      practiceDummy: practiceDummy,
      practiceAutoAttack: practiceAutoAttack,
      practiceNoCdAll: practiceNoCdAll,
      selectedL: selectedL,
      selectedR: selectedR,
      selectedScrollL: selectedScrollL,
      selectedScrollR: selectedScrollR,
      fighters: activeFighters().map(function (f) {
        return { id: f.id, name: f.name, kit: f.kit, hp: f.hp, hpChip: f.hpChip, x: f.x, y: f.y, team: teamOf(f), airH: f.airH || 0, airborne: !!f.airborne, pullOn: !!f.pullOn, repulseOn: !!f.repulseOn, anim: f.anim, knockPhase: f.knockPhase, knockT: f.knockT || 0, moveSpeed: f.moveSpeed, fireForm: !!f.fireForm, barrierT: f.barrierT || 0, chakra: f.chakra, stun: +(f.stun || 0).toFixed(2), busy: +(f.busy || 0).toFixed(2), animT: +(f.animT || 0).toFixed(2), dashT: +(f.dashT || 0).toFixed(2), counterT: +(f.counterT || 0).toFixed(2), hyper: +(f.hyperArmor || 0).toFixed(2), phaseT: +(f.phase || 0).toFixed(2), invuln: +(f.invuln || 0).toFixed(2), facing: f.facing };
      }),
      roundWinsL: roundWinsL,
      roundWinsR: roundWinsR,
      koId: koId,
      voidSpace: voidSpace,
      selectedChar: selectedChar,
      selectedScroll: selectedScroll,
      voidT: voidT,
      practicePanel: practicePanel,
      leftKeys: leftOrder.map(function (id) { return left.skills[id] ? left.skills[id].key + ":" + id : "?"; }),
      rightKeys: rightOrder.map(function (id) { return right.skills[id] ? right.skills[id].key + ":" + id : "?"; }),
      facing: activeFighters().map(function (f) { return f.facing; }),
      phase: activeFighters().map(function (f) { return f.phase || 0; }),
      cds: activeFighters().map(function (f) { var o = {}, k; for (k in f.skills) o[k] = +(f.skills[k].cd || 0).toFixed(2); return o; }),
      assets: { core: groupProgress(["core"]), obito: groupProgress(["obito"]), pain: groupProgress(["pain"]), tanjiro: groupProgress(["tanjiro"]), errors: assetErrors.slice(0, 5) },
      loadMode: loadMode,
      matchStall: matchStall,
      sheetCount: sheetManifest ? Object.keys(sheetManifest.kits).length : 0,
      coreReady: coreReady,
      menuReady: coreAssetsReady(),
      sheetSizes: Object.keys(sheetImgs).map(function (k) { var b = sheetImgs[k]._bmp; return k + ":" + (b ? b.width + "x" + b.height : "-"); }),
      voidUntilLeft: voidSpace ? Math.max(0, (voidUntil - performance.now()) / 1000) : 0,
      fightElapsed: matchState === "fight" ? fightClockElapsed() : 0,
      assetV: ASSET_V,
      lastUiHit: lastUiHit,
      hits: hudHits.map(function (z) { return { t: z.tag, x: Math.round(z.x), y: Math.round(z.y), w: Math.round(z.w), h: Math.round(z.h) }; }),
      W: W, H: H
    };
  };
  window.__DUEL_GOTO_SELECT__ = function (mode) {
    gameMode = mode || "ai";
    matchState = "charSelect";
    syncFlowHint();
    return true;
  };
  window.__DUEL_ASSET_LIST__ = function () {
    var out = [], g, j;
    for (g in ASSET_GROUPS) for (j = 0; j < ASSET_GROUPS[g].length; j++) out.push([g, ASSET_GROUPS[g][j]._src]);
    return out;
  };
  window.__DUEL_PLACE__ = function (lx, rx) {
    left.x = lx; right.x = rx; left.y = right.y = 530;
    left.facing = 1; right.facing = -1;
    left.hitPushVx = right.hitPushVx = 0;
    left.stun = right.stun = 0; left.invuln = right.invuln = 0;
    return true;
  };
  window.__DUEL_START__ = function (mode, me, ai) {
    gameMode = mode || "ai";
    selectedChar = me || "obito";
    selectedScroll = SCROLL_DEFS[0].id;
    window.__DUEL_AIKIT__ = ai || null;
    practiceAutoAttack = false;
    practiceDummy = true;
    practiceNoCdAll = false;
    practiceNoCd = {};
    beginMatch();
    return matchState;
  };
  window.__DUEL_TEST_PULL__ = function (fid, lift) {
    var f = activeFighters().filter(function (x) { return x.id === fid; })[0];
    if (!f) return false;
    if (lift) { f.airH = lift; f.airV = 200; f.airborne = true; }
    castPull(f);
    return true;
  };
  window.__DUEL_FORCE_COOP__ = function () {
    gameMode = "coop";
    selectedL = "obito";
    selectedR = "pain";
    selectedScrollL = SCROLL_DEFS[0].id;
    selectedScrollR = SCROLL_DEFS[1].id;
    beginMatch();
  };
  window.__DUEL_FORCE_PRACTICE__ = function () {
    gameMode = "practice";
    selectedChar = "obito";
    selectedScroll = SCROLL_DEFS[0].id;
    practiceAutoAttack = false;
    practiceDummy = true;
    practiceNoCdAll = false;
    practiceNoCd = {};
    beginMatch();
  };
  window.__DUEL_FORCE_TANJIRO__ = function (opts) {
    opts = opts || {};
    gameMode = opts.mode || "practice";
    selectedChar = "tanjiro";
    selectedScroll = SCROLL_DEFS[0].id;
    practiceAutoAttack = !!opts.autoAttack;
    practiceDummy = !practiceAutoAttack;
    practiceNoCdAll = !!opts.noCd;
    practiceNoCd = {};
    beginMatch();
    if (matchState === "loading") return window.__DUEL_DEBUG__();
    // Skip countdown into fight
    matchState = "fight";
    countdownPhase = "fight";
    countLeft = 0;
    return window.__DUEL_DEBUG__();
  };
  window.__DUEL_CAST__ = function (fid, skillId) {
    var f = activeFighters().filter(function (x) { return x.id === fid; })[0];
    if (!f) return false;
    tryCast(f, skillId);
    return { anim: f.anim, fireForm: !!f.fireForm, busy: f.busy, chakra: f.chakra, kit: f.kit };
  };
  window.__DUEL_WAIT_FIGHT__ = function () {
    matchState = "fight";
    countdownPhase = "fight";
    countLeft = 0;
    return matchState;
  };
  window.__DUEL_FORCE_FIGHT__ = function () {
    gameMode = "ai";
    selectedChar = "obito";
    selectedScroll = SCROLL_DEFS[0].id;
    beginMatch();
  };
  window.__DUEL_HURT__ = function (fid, amount) {
    var f = activeFighters().filter(function (x) { return x.id === fid; })[0];
    if (!f) return false;
    f.invuln = 0; f.phase = 0; f.shield = 0; f.hyperArmor = 0;
    return hurt(f, amount, "#ffe7a0");
  };
  window.__DUEL_LAUNCH__ = function (fid) {
    var f = activeFighters().filter(function (x) { return x.id === fid; })[0];
    if (!f) return false;
    f.invuln = 0; f.phase = 0; f.shield = 0; f.hyperArmor = 0;
    return hurt(f, 30, "#ffe7a0"); // 20 after 2/3 >= LAUNCH_DMG 12
  };

  reset();
  syncFlowHint();

  // pages23: load atlas manifest, then core images. Kit sheets register on demand.
  (function bootAssets() {
    // Menu art first (cards + scroll icons were enqueued at registration); stage/portraits follow.
    ensureGroups(["core"], "core");
    function getManifest(attempt) {
      var fake = { _rel: "sheets/manifest.json", _mirror: attempt % MIRRORS.length };
      return withTimeout(fetch(mirrorUrl(fake, 0)).then(function (r) {
        if (!r.ok) throw new Error("manifest " + r.status); return r.json();
      }), 8000, "manifest").catch(function (e) {
        if (attempt < 12) return getManifest(attempt + 1);
        throw e;
      });
    }
    getManifest(0)
      .then(function (m) {
        sheetManifest = m;
        var t = setInterval(function () {
          var c = groupProgress(["core"]);
          if (c.done + c.err < c.tot) return;
          clearInterval(t);
          coreReady = true;
          if (loadMode === "match") return;
          ["obito", "pain", "tanjiro"].forEach(function (k) { registerKitSheets(k); });
          loadMode = "prefetch";
          ensureGroups(["obito", "pain", "tanjiro", "gojo", "luffy", "ichigo", "fushiguro"], "prefetch");
        }, 200);
      })
      .catch(function (e) { if (window.console) console.error("[manifest]", e); });
  })();

  requestAnimationFrame(frame);
})();

/* fireworks.js
   ------------------------------------------------------------
   Hyper-realistic(ish) canvas fireworks for the hero section,
   tuned for PERFORMANCE without sacrificing “realism”.

   Key upgrades (realism):
   1) Additive light blending for sparks/heads (proper glow feel)
   2) Bloom / halo (shadowBlur) scaled by device + particle size
   3) Flicker + twinkle modulation (non-uniform brightness)
   4) Burst variety: peony, ring, palm, crackle + glitter
   5) Secondary “break” (delayed mini-bursts) for depth
   6) Smoke haze puffs (sprite-based, cheap)
   7) Wind drift + per-burst drift variation
   8) Comet tails / streak rendering (prev-pos streaks, realistic motion blur)

   Key upgrades (performance):
   - NO trail arrays (no per-frame allocations); prev-pos streaks instead
   - Object pooling for rockets/particles/smoke (less GC stutter)
   - Aggressive DPR cap (biggest FPS win on high-DPI displays)
   - “Rect sparks” for tiny particles (fewer arc() calls)
   - Smoke update/draw parity under load while keeping the look
   - Hard caps + “room” checks for particles
   - Robust pause/resume for tab/app switching + BFCache

   API:
     window.fireworks.start({celebrate:true})
     window.fireworks.stop()
     window.fireworks.pause()
     window.fireworks.resume()
     window.fireworks.resize()
     window.fireworks.burst(x, y)
     window.fireworks.unlockSfx()
*/

(() => {
    // Always expose a safe API
    const noop = () => { };
    const api = {
        start: noop,
        stop: noop,
        pause: noop,
        resume: noop,
        resize: noop,
        burst: noop,
        unlockSfx: noop,
    };
    window.fireworks = api;

    const canvas = document.getElementById("fireworksCanvas");
    if (!canvas) return;

    // Respect reduced motion
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduceMotion) return;

    const hero = canvas.closest(".hero") || document.body;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    // -----------------------------
    // Config (Realism + Performance)
    // -----------------------------
    const LOWER_LINE_TARGET_FIREWORKS = 0.45;
    const UPPER_LINE_TARGET_FIREWORKS = 0.75;

    // Physics (px/s^2 etc)
    const gravity = 650;
    const airDrag = 0.0009; // quadratic

    // Big levers (base caps; actual caps adapt dynamically)
    const BASE_MAX_ROCKETS = 2;
    const BASE_MAX_PARTICLES = 50; // keep realistic but not insane
    const BASE_MAX_SMOKE = 28;

    // Click bleed protection
    const IGNORE_CLICKS_MS = 600;
    const RESUME_IGNORE_CLICKS_MS = 250;

    // Auto-launch pacing (base; adapts dynamically)
    const AUTO_BASE_DESKTOP = 1050;
    const AUTO_BASE_MOBILE = 1600;

    // Visual tuning
    const ADDITIVE_COMPOSITE = "lighter";
    const FADE_ALPHA_BASE = 0.26; // trails persistence (higher = clears more each frame)

    // Bloom tuning
    const BLOOM_BASE = 7; // overall glow strength
    const BLOOM_MOBILE_SCALE = 0.70;

    // Streak vs dot threshold
    const STREAK_SPEED_THRESHOLD = 240;

    // -----------------------------
    // Adaptive quality governor
    // -----------------------------
    const TARGET_FPS = 60;
    const MIN_QUALITY = 0.55;
    const MAX_QUALITY = 1.0;

    const FPS_EMA = 0.08;      // smoothing for FPS estimate
    const QUALITY_EMA = 0.045; // smoothing for quality adjustments
    const RESIZE_CHECK_MS = 1200;

    let fpsSmoothed = TARGET_FPS;
    let quality = 1.0;
    let lastQualityTs = 0;
    let lastResizeQualityCheck = 0;

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    function qualityFromFps(fps) {
        // Bias slightly toward higher quality to preserve aesthetics
        const ratio = clamp(fps / TARGET_FPS, 0, 1);
        const shaped = Math.pow(ratio, 0.78);
        return clamp(shaped, MIN_QUALITY, MAX_QUALITY);
    }

    function maxRocketsCap() {
        // Keep at least one rocket under all conditions
        const q = quality;
        const v = Math.round(BASE_MAX_ROCKETS * lerp(0.62, 1.0, q));
        return clamp(v, 1, BASE_MAX_ROCKETS);
    }

    function maxParticlesCap() {
        // Particle count is the biggest lever; preserve minimum density
        const q = quality;
        const v = Math.floor(BASE_MAX_PARTICLES * lerp(0.55, 1.0, q));
        return clamp(v, 22, BASE_MAX_PARTICLES);
    }

    function maxSmokeCap() {
        const q = quality;
        const v = Math.floor(BASE_MAX_SMOKE * lerp(0.55, 1.0, q));
        return clamp(v, 10, BASE_MAX_SMOKE);
    }

    function fadeAlpha() {
        // Under load, clear a bit more aggressively to reduce overdraw
        return clamp(FADE_ALPHA_BASE + (1 - quality) * 0.10, 0.22, 0.38);
    }

    function bloomAmount() {
        const mobile = w < 600;
        const base = BLOOM_BASE * (mobile ? BLOOM_MOBILE_SCALE : 1);
        // Shadow blur is expensive; reduce it smoothly under load
        return base * lerp(0.55, 1.0, quality);
    }

    function smokeParityEnabled() {
        // Smoke is subtle; drop to half-rate sooner under load
        return quality < 0.92;
    }

    function launchQualityFactor() {
        // Lower quality -> slower launches (less work) + more “natural” calmness
        return lerp(0.78, 1.0, quality);
    }

    // -----------------------------
    // State
    // -----------------------------
    let w = 0, h = 0, dpr = 1;
    let running = false;
    let inited = false;

    let stepRafId = null;
    let launchRafId = null;

    let lastTs = null;
    let lastLaunch = 0;
    let ignoreClicksUntil = 0;

    let smokeParity = 0;

    // Live entities
    const rockets = [];
    const particles = [];
    const smokePuffs = [];

    // Pools (performance: avoid GC)
    const rocketPool = [];
    const particlePool = [];
    const smokePool = [];

    // -----------------------------
    // Optional Pop SFX (unchanged)
    // -----------------------------
    const popUrls = ["./assets/sounds/pop1.wav"];

    const popPool = popUrls.flatMap((url) => {
        const a1 = new Audio(url);
        const a2 = new Audio(url);
        a1.preload = "auto";
        a2.preload = "auto";
        a1.volume = 0.25;
        a2.volume = 0.25;
        return [a1, a2];
    });

    let popIndex = 0;
    let audioUnlocked = false;
    let lastPopMs = 0;

    function unlockSfxOnce() {
        if (audioUnlocked) return;
        audioUnlocked = true;

        for (const a of popPool) {
            try {
                a.muted = true;
                a.play()
                    .then(() => {
                        a.pause();
                        a.currentTime = 0;
                        a.muted = false;
                    })
                    .catch(() => {
                        a.muted = false;
                    });
            } catch (_) { }
        }
    }

    function playPop() {
        if (!audioUnlocked || !window.sfxEnabled) return;

        const now = performance.now();
        if (now - lastPopMs < 120) return;
        lastPopMs = now;

        const a = popPool[popIndex];
        popIndex = (popIndex + 1) % popPool.length;

        try {
            a.pause();
            a.currentTime = 0;
            a.playbackRate = rand(0.92, 1.08);
            a.play().catch(() => { });
        } catch (_) { }
    }

    // -----------------------------
    // Helpers
    // -----------------------------
    function rand(min, max) {
        return Math.random() * (max - min) + min;
    }

    function clamp(n, lo, hi) {
        return Math.max(lo, Math.min(hi, n));
    }

    function nowMs() {
        return performance.now();
    }

    function randomHue() {
        return rand(0, 360);
    }

    function stopLoops() {
        if (stepRafId != null) cancelAnimationFrame(stepRafId);
        if (launchRafId != null) cancelAnimationFrame(launchRafId);
        stepRafId = null;
        launchRafId = null;
    }

    function startLoops() {
        // Restart cleanly (RAF can get weird after backgrounding)
        stopLoops();
        stepRafId = requestAnimationFrame(step);
        launchRafId = requestAnimationFrame(autoLaunch);
    }

    function safeHeroRect() {
        const rect = hero.getBoundingClientRect();
        const width = rect.width > 2 ? rect.width : window.innerWidth;
        const height = rect.height > 2 ? rect.height : window.innerHeight;
        return { width, height };
    }

    function computeDprCap(rectWidth) {
        // DPR is the silent FPS killer (especially 4K/retina).
        // Cap aggressively, but keep it crisp enough; adapt under load.
        const baseCap = rectWidth < 600 ? 1.10 : 1.35;
        const scaled = baseCap * lerp(0.74, 1.0, quality);
        return clamp(scaled, 1.0, baseCap);
    }

    function resize() {
        const rect = safeHeroRect();

        const nativeDpr = window.devicePixelRatio || 1;
        const dprCap = computeDprCap(rect.width);
        dpr = Math.min(dprCap, nativeDpr);

        w = Math.floor(rect.width);
        h = Math.floor(rect.height);

        canvas.style.width = w + "px";
        canvas.style.height = h + "px";
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function clearAll() {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
    }

    function qualityWind() {
        // Gentle wind, changes slowly per start/resume
        return rand(-16, 16);
    }

    // -----------------------------
    // Sprites (smoke uses a cheap sprite)
    // -----------------------------
    const smokeSprite = (() => {
        const c = document.createElement("canvas");
        c.width = 64;
        c.height = 64;
        const g = c.getContext("2d");
        if (!g) return null;

        const r = 32;
        const grad = g.createRadialGradient(r, r, 2, r, r, r);
        grad.addColorStop(0, "rgba(255,255,255,0.18)");
        grad.addColorStop(0.35, "rgba(255,255,255,0.10)");
        grad.addColorStop(1, "rgba(255,255,255,0.0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 64, 64);
        return c;
    })();

    // -----------------------------
    // Entity alloc/recycle (pools)
    // -----------------------------
    function allocRocket() {
        return rocketPool.pop() || {
            x: 0, y: 0, px: 0, py: 0,
            vx: 0, vy: 0,
            targetY: 0,
            hue: 0,
            wind: 0,
            kind: "peony",
            breakDelay: 0,
            broke: false,
        };
    }

    function freeRocket(r) {
        rocketPool.push(r);
    }

    function baseParticle() {
        return {
            x: 0, y: 0, px: 0, py: 0,
            vx: 0, vy: 0,
            life: 60, maxLife: 60,
            size: 1.6,
            hue: 0,
            kind: "spark",   // spark | ember | crackle | comet
            twPhase: 0,
            twAmp: 1.0,
            dragMul: 1.0,
            gravMul: 1.0,
            windMul: 1.0,
            crackleTimer: 0,
            heat: 1.0,
        };
    }

    function allocParticle() {
        return particlePool.pop() || baseParticle();
    }

    function freeParticle(p) {
        particlePool.push(p);
    }

    function allocSmoke() {
        return smokePool.pop() || {
            x: 0, y: 0,
            vx: 0, vy: 0,
            life: 60, maxLife: 60,
            r: 28,
            a: 0.12,
        };
    }

    function freeSmoke(s) {
        smokePool.push(s);
    }

    // -----------------------------
    // Rendering
    // -----------------------------
    function clearFrame() {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = `rgba(0,0,0,${fadeAlpha()})`;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
        ctx.globalCompositeOperation = "source-over";
    }

    function drawRocket(r) {
        const bloom = bloomAmount();

        // Streak
        ctx.globalCompositeOperation = ADDITIVE_COMPOSITE;

        if (quality >= 0.70) {
            ctx.shadowColor = `hsla(${r.hue} 100% 70% / 0.85)`;
            ctx.shadowBlur = bloom * 0.9;
        } else {
            ctx.shadowBlur = 0;
        }

        ctx.strokeStyle = `hsla(${r.hue} 95% 62% / 0.34)`;
        ctx.lineWidth = 2.1;
        ctx.lineCap = "round";

        ctx.beginPath();
        ctx.moveTo(r.px, r.py);
        ctx.lineTo(r.x, r.y);
        ctx.stroke();

        // Head
        ctx.fillStyle = `hsla(${r.hue} 100% 76% / 0.95)`;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 2.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.globalCompositeOperation = "source-over";

        r.px = r.x;
        r.py = r.y;
    }

    function particleAlpha(p, t) {
        // Twinkle/flicker (realistic combustion)
        const tw = 0.72 + 0.28 * Math.sin(p.twPhase + (1 - t) * 10.5);
        const base = t * tw * p.twAmp;

        if (p.kind === "ember") return base * 0.65;
        if (p.kind === "crackle") return base * 0.85;
        if (p.kind === "comet") return base * 0.95;
        return base;
    }

    function drawParticle(p) {
        const t = p.life / p.maxLife;
        if (t <= 0) return;

        const aHead = particleAlpha(p, t);
        if (aHead <= 0.01) return;

        const speed = Math.hypot(p.vx, p.vy);
        const bloom = bloomAmount();

        ctx.globalCompositeOperation = ADDITIVE_COMPOSITE;

        // Bloom only for brighter/larger sparks
        if (quality >= 0.72 && p.size >= 1.15) {
            ctx.shadowColor = `hsla(${p.hue} 100% 70% / 0.78)`;
            ctx.shadowBlur = bloom * (0.55 + 0.35 * (1 - t));
        } else {
            ctx.shadowBlur = 0;
        }

        if (speed > STREAK_SPEED_THRESHOLD || p.kind === "comet") {
            ctx.strokeStyle = `hsla(${p.hue} 95% 76% / ${aHead})`;
            ctx.lineWidth = Math.max(0.7, p.size * (p.kind === "comet" ? 1.25 : 1.0));
            ctx.lineCap = "round";

            ctx.beginPath();
            ctx.moveTo(p.px, p.py);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
        } else {
            // Tiny sparks: fillRect is much faster than arc()
            ctx.fillStyle = `hsla(${p.hue} 95% 76% / ${aHead})`;
            const s = Math.max(1, p.size);
            ctx.fillRect(p.x - s * 0.5, p.y - s * 0.5, s, s);
        }

        ctx.shadowBlur = 0;
        ctx.globalCompositeOperation = "source-over";

        p.px = p.x;
        p.py = p.y;
    }

    function drawSmoke(s) {
        if (!smokeSprite) return;
        const t = s.life / s.maxLife;
        if (t <= 0) return;

        // Very subtle haze that expands
        const a = s.a * t;
        if (a <= 0.002) return;

        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = a;
        const rr = s.r * (1.0 + (1 - t) * 0.9);
        ctx.drawImage(smokeSprite, s.x - rr, s.y - rr, rr * 2, rr * 2);
        ctx.restore();
    }

    // -----------------------------
    // Spawning
    // -----------------------------
    function chooseBurstKind() {
        // Weighted: peony most common
        const r = Math.random();
        if (r < 0.52) return "peony";
        if (r < 0.72) return "ring";
        if (r < 0.88) return "palm";
        return "crackle";
    }

    function spawnRocket(x) {
        if (rockets.length >= maxRocketsCap()) return;
        if (w < 10 || h < 10) return;

        const r = allocRocket();

        const hue = randomHue();
        const startX = (typeof x === "number") ? x : rand(w * 0.15, w * 0.85);
        const startY = h + 10;

        const speed = rand(900, 1200);
        const vx = rand(-80, 80);
        const vy = -speed;

        const targetY = rand(h * LOWER_LINE_TARGET_FIREWORKS, h * UPPER_LINE_TARGET_FIREWORKS);

        r.x = startX; r.y = startY;
        r.px = startX; r.py = startY;
        r.vx = vx; r.vy = vy;
        r.targetY = targetY;
        r.hue = hue;
        r.wind = currentWind;
        r.kind = chooseBurstKind();

        // Secondary break: makes bursts feel layered and “real”
        r.breakDelay = rand(0.06, 0.14); // seconds
        r.broke = false;

        rockets.push(r);
    }

    function roomForParticles() {
        return Math.max(0, maxParticlesCap() - particles.length);
    }

    function pushParticle(p) {
        if (particles.length >= maxParticlesCap()) {
            freeParticle(p);
            return;
        }
        particles.push(p);
    }

    function makeParticle(x, y, vx, vy, life, size, hue, kind) {
        const p = allocParticle();
        p.x = x; p.y = y;
        p.px = x; p.py = y;
        p.vx = vx; p.vy = vy;
        p.life = life;
        p.maxLife = life;
        p.size = size;
        p.hue = hue;
        p.kind = kind;

        p.twPhase = rand(0, Math.PI * 2);
        p.twAmp = rand(0.85, 1.15);

        p.dragMul = rand(0.92, 1.10);
        p.gravMul = rand(0.92, 1.08);
        p.windMul = rand(0.85, 1.15);

        p.crackleTimer = rand(0.02, 0.07);
        p.heat = rand(0.85, 1.15);

        return p;
    }

    function spawnSmoke(x, y) {
        if (!smokeSprite) return;
        if (smokePuffs.length >= maxSmokeCap()) return;

        const s = allocSmoke();
        s.x = x;
        s.y = y;
        s.vx = rand(-8, 8);
        s.vy = rand(-10, -2);
        s.life = rand(50, 80);
        s.maxLife = s.life;
        s.r = rand(22, 44);
        s.a = rand(0.06, 0.12);

        smokePuffs.push(s);
    }

    function explodePeony(x, y, hue) {
        const room = roomForParticles();
        if (room <= 0) return;

        // Primary sphere
        const count = Math.min(Math.floor(rand(110, 160)), room);
        for (let i = 0; i < count; i++) {
            const ang = rand(0, Math.PI * 2);
            const sp = rand(280, 700) * rand(0.85, 1.10);
            const vx = Math.cos(ang) * sp;
            const vy = Math.sin(ang) * sp;
            const life = rand(52, 92);
            const size = rand(1.0, 2.4);
            const hh = (hue + rand(-10, 10) + 360) % 360;
            const kind = Math.random() < 0.10 ? "comet" : "spark";
            pushParticle(makeParticle(x, y, vx, vy, life, size, hh, kind));
        }

        // Glitter / twinkles (cheap but great)
        const glitterRoom = roomForParticles();
        const glitterCount = Math.min(Math.floor(rand(26, 52)), glitterRoom);
        for (let i = 0; i < glitterCount; i++) {
            const ang = rand(0, Math.PI * 2);
            const sp = rand(120, 260);
            const vx = Math.cos(ang) * sp;
            const vy = Math.sin(ang) * sp;
            const life = rand(24, 55);
            const size = rand(0.9, 1.5);
            const hh = (hue + rand(-6, 6) + 360) % 360;
            pushParticle(makeParticle(x, y, vx, vy, life, size, hh, "spark"));
        }
    }

    function explodeRing(x, y, hue) {
        const room = roomForParticles();
        if (room <= 0) return;

        const count = Math.min(Math.floor(rand(90, 130)), room);
        const jitter = rand(0.08, 0.18);

        for (let i = 0; i < count; i++) {
            const t = i / count;
            const ang = t * Math.PI * 2 + rand(-jitter, jitter);
            const sp = rand(360, 640);
            const vx = Math.cos(ang) * sp;
            const vy = Math.sin(ang) * sp;
            const life = rand(45, 80);
            const size = rand(1.0, 2.1);
            const hh = (hue + rand(-8, 8) + 360) % 360;
            pushParticle(makeParticle(x, y, vx, vy, life, size, hh, "spark"));
        }

        // A faint core sparkle
        const coreRoom = roomForParticles();
        const coreCount = Math.min(Math.floor(rand(18, 34)), coreRoom);
        for (let i = 0; i < coreCount; i++) {
            const ang = rand(0, Math.PI * 2);
            const sp = rand(80, 180);
            pushParticle(makeParticle(
                x, y,
                Math.cos(ang) * sp,
                Math.sin(ang) * sp,
                rand(22, 42),
                rand(0.9, 1.4),
                hue,
                "spark"
            ));
        }
    }

    function explodePalm(x, y, hue) {
        const room = roomForParticles();
        if (room <= 0) return;

        const arms = Math.floor(rand(6, 10));
        const perArm = Math.max(10, Math.floor(rand(14, 20)));
        const total = Math.min(arms * perArm, room);

        let made = 0;
        for (let a = 0; a < arms && made < total; a++) {
            const armAng = rand(0, Math.PI * 2);
            const armHue = (hue + rand(-12, 12) + 360) % 360;

            for (let i = 0; i < perArm && made < total; i++) {
                const k = i / perArm;
                const ang = armAng + rand(-0.12, 0.12);
                const sp = rand(280, 680) * (0.8 + 0.4 * k);
                const vx = Math.cos(ang) * sp;
                const vy = Math.sin(ang) * sp;
                const life = rand(52, 88) + k * 10;
                const size = rand(1.1, 2.3);
                pushParticle(makeParticle(x, y, vx, vy, life, size, armHue, "comet"));
                made++;
            }
        }
    }

    function explodeCrackle(x, y, hue) {
        const room = roomForParticles();
        if (room <= 0) return;

        const count = Math.min(Math.floor(rand(90, 140)), room);

        for (let i = 0; i < count; i++) {
            const ang = rand(0, Math.PI * 2);
            const sp = rand(220, 620);
            const vx = Math.cos(ang) * sp;
            const vy = Math.sin(ang) * sp;
            const life = rand(40, 78);
            const size = rand(1.0, 2.0);
            const hh = (hue + rand(-10, 10) + 360) % 360;
            const p = makeParticle(x, y, vx, vy, life, size, hh, "crackle");
            p.crackleTimer = rand(0.02, 0.07);
            pushParticle(p);
        }
    }

    function explodeBurst(x, y, hue, kind) {
        playPop();

        // Smoke is subtle but adds realism. Keep it, but capped & sprite-based.
        const smokeChance = 0.85 * lerp(0.55, 1.0, quality);
        if (Math.random() < smokeChance) spawnSmoke(x, y);

        switch (kind) {
            case "ring":
                explodeRing(x, y, hue);
                break;
            case "palm":
                explodePalm(x, y, hue);
                break;
            case "crackle":
                explodeCrackle(x, y, hue);
                break;
            default:
                explodePeony(x, y, hue);
                break;
        }

        // Secondary “break” (delayed mini-burst) for depth
        const breakChance = 0.45 * lerp(0.55, 1.0, quality);
        if (Math.random() < breakChance && roomForParticles() > 24) {
            const dx = rand(-24, 24);
            const dy = rand(-18, 18);
            setTimeout(() => {
                if (!running) return;
                explodePeony(x + dx, y + dy, (hue + rand(-14, 14) + 360) % 360);
                if (Math.random() < 0.5 * lerp(0.55, 1.0, quality)) spawnSmoke(x + dx, y + dy);
            }, Math.floor(rand(70, 140)));
        }
    }

    function burst(x = w * 0.5, y = h * 0.6) {
        if (w < 10 || h < 10) return;
        const hue = randomHue();
        explodeBurst(x, y, hue, chooseBurstKind());
    }

    // -----------------------------
    // Main loop
    // -----------------------------
    let currentWind = qualityWind();

    function updateQuality(ts, deltaMs) {
        // Measure FPS from real delta (not the clamped simulation dt)
        const d = clamp(deltaMs, 6, 120);
        const fpsInstant = 1000 / d;
        fpsSmoothed += (fpsInstant - fpsSmoothed) * FPS_EMA;

        // Adjust quality at a controlled cadence to avoid oscillation
        if (ts - lastQualityTs > 220) {
            lastQualityTs = ts;

            // A small safety bias against prolonged jank
            const fpsForDecision = Math.min(fpsSmoothed, 62);
            const qTarget = qualityFromFps(fpsForDecision);
            quality += (qTarget - quality) * QUALITY_EMA;
            quality = clamp(quality, MIN_QUALITY, MAX_QUALITY);
        }

        // Periodically re-evaluate DPR cap under sustained load
        if (ts - lastResizeQualityCheck > RESIZE_CHECK_MS) {
            lastResizeQualityCheck = ts;

            // Only resize if we're running; avoid churn during background jitter
            if (running) resize();
        }
    }

    function step(ts) {
        if (!running) return;

        if (lastTs == null) lastTs = ts;
        const deltaMs = ts - lastTs;

        // Sim dt is clamped for stability; quality uses real delta
        const dt = clamp(deltaMs / 1000, 0, 0.033);
        lastTs = ts;

        updateQuality(ts, deltaMs);

        clearFrame();

        // Smoke parity toggle (adaptive)
        const smokeHalfRate = smokeParityEnabled();
        if (smokeHalfRate) smokeParity ^= 1;

        // --- Smoke update/draw (source-over) ---
        if (!smokeHalfRate || smokeParity === 0) {
            for (let i = smokePuffs.length - 1; i >= 0; i--) {
                const s = smokePuffs[i];

                s.x += (s.vx + currentWind * 0.12) * dt;
                s.y += s.vy * dt;

                s.life -= 60 * dt;

                drawSmoke(s);

                if (s.life <= 0 || s.x < -200 || s.x > w + 200 || s.y < -200 || s.y > h + 240) {
                    smokePuffs.splice(i, 1);
                    freeSmoke(s);
                }
            }
        }

        // --- Rockets update/draw ---
        for (let i = rockets.length - 1; i >= 0; i--) {
            const r = rockets[i];

            // Quadratic drag + gravity + gentle wind
            const ax = (-airDrag * r.vx * Math.abs(r.vx)) + r.wind * 0.10;
            const ay = (-airDrag * r.vy * Math.abs(r.vy)) + gravity;

            r.vx += ax * dt;
            r.vy += ay * dt;

            r.x += r.vx * dt;
            r.y += r.vy * dt;

            drawRocket(r);

            // Primary detonation condition
            const shouldExplode = (r.y <= r.targetY) || (r.vy >= 0);

            if (shouldExplode) {
                if (!r.broke) {
                    r.broke = true;
                    const ex = r.x, ey = r.y, hue = r.hue, kind = r.kind;

                    rockets.splice(i, 1);
                    freeRocket(r);

                    explodeBurst(ex, ey, hue, kind);
                    continue;
                }
            }

            // Offscreen cleanup
            if (r.x < -120 || r.x > w + 120 || r.y < -180) {
                rockets.splice(i, 1);
                freeRocket(r);
            }
        }

        // --- Particles update/draw ---
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];

            // Physics with per-particle multipliers (more organic)
            const drag = airDrag * p.dragMul;
            const ax = (-drag * p.vx * Math.abs(p.vx)) + currentWind * 0.08 * p.windMul;
            const ay = (-drag * p.vy * Math.abs(p.vy)) + gravity * p.gravMul;

            p.vx += ax * dt;
            p.vy += ay * dt;

            p.x += p.vx * dt;
            p.y += p.vy * dt;

            // Crackle: spawn micro-sparks during flight (realistic “crackling”)
            if (p.kind === "crackle") {
                p.crackleTimer -= dt;
                if (p.crackleTimer <= 0 && roomForParticles() > 6) {
                    p.crackleTimer = rand(0.02, 0.07);

                    // Under load, keep crackle but slightly reduce micro intensity
                    const microScale = lerp(0.55, 1.0, quality);
                    const microCount = Math.floor(rand(1, 3) * microScale);

                    for (let k = 0; k < microCount; k++) {
                        const ang = rand(0, Math.PI * 2);
                        const sp = rand(70, 170);
                        const vx = p.vx * 0.08 + Math.cos(ang) * sp;
                        const vy = p.vy * 0.08 + Math.sin(ang) * sp;
                        const hh = (p.hue + rand(-8, 8) + 360) % 360;

                        pushParticle(makeParticle(p.x, p.y, vx, vy, rand(16, 28), rand(0.9, 1.4), hh, "spark"));
                    }
                }
            }

            // Comets cool down (smaller + dimmer)
            if (p.kind === "comet") {
                p.heat = Math.max(0.35, p.heat - dt * 0.9);
                p.size *= (1 - dt * 0.15);
            }

            // Life in “frames-ish”
            p.life -= 60 * dt;

            drawParticle(p);

            if (
                p.life <= 0 ||
                p.x < -160 ||
                p.x > w + 160 ||
                p.y > h + 220
            ) {
                particles.splice(i, 1);
                freeParticle(p);
            }
        }

        stepRafId = requestAnimationFrame(step);
    }

    // Auto launch loop
    function autoLaunch(ts) {
        if (!running) return;

        const base = (w < 600) ? AUTO_BASE_MOBILE : AUTO_BASE_DESKTOP;

        // Under load: increase spacing between launches
        const qf = launchQualityFactor();
        const intervalBase = base / qf;
        const interval = intervalBase + Math.random() * intervalBase;

        if (ts - lastLaunch > interval) {
            lastLaunch = ts;

            spawnRocket();

            // Two rockets sometimes (more natural); scale chance under load
            const buddyChance = 0.55 * lerp(0.55, 1.0, quality);
            if (Math.random() < buddyChance) spawnRocket();
        }

        launchRafId = requestAnimationFrame(autoLaunch);
    }

    // -----------------------------
    // Pause / Resume (robust)
    // -----------------------------
    function pause() {
        if (!running) return;
        running = false;
        stopLoops();
        // leave the canvas tableau in place
    }

    function resetPerf() {
        fpsSmoothed = TARGET_FPS;
        quality = 1.0;
        lastQualityTs = 0;
        lastResizeQualityCheck = 0;
    }

    function resume() {
        running = true;

        // When coming back, browsers can have stale sizes
        resize();

        // Keep it lively but reset timers so dt doesn't jump
        lastTs = null;
        lastLaunch = nowMs();
        ignoreClicksUntil = nowMs() + RESUME_IGNORE_CLICKS_MS;

        // Refresh wind a bit after tab switch
        currentWind = currentWind * 0.6 + qualityWind() * 0.4;

        // Reset perf smoothing on resume to avoid “stuck” low estimates
        resetPerf();

        startLoops();
    }

    function start({ celebrate = true } = {}) {
        resize();
        running = true;

        ignoreClicksUntil = nowMs() + IGNORE_CLICKS_MS;

        // Clear once on fresh start (prevents stale frame)
        clearAll();

        lastTs = null;
        lastLaunch = nowMs();

        // Refresh wind each start for natural variance
        currentWind = qualityWind();

        resetPerf();

        startLoops();

        // Celebration burst
        if (celebrate) {
            setTimeout(() => burst(w * 0.50, h * 0.62), 90);
            setTimeout(() => burst(w * 0.38, h * 0.58), 170);
            setTimeout(() => burst(w * 0.62, h * 0.60), 240);
        }
    }

    function stop() {
        pause();
        // Clear entities
        while (rockets.length) freeRocket(rockets.pop());
        while (particles.length) freeParticle(particles.pop());
        while (smokePuffs.length) freeSmoke(smokePuffs.pop());
        resize();
        clearAll();
    }

    // -----------------------------
    // Init + event wiring
    // -----------------------------
    function initOnce() {
        if (inited) return;
        inited = true;

        resize();

        // Click-to-launch
        hero.addEventListener("click", (e) => {
            if (!running) return;
            if (nowMs() < ignoreClicksUntil) return;

            const rect = hero.getBoundingClientRect();
            const x = e.clientX - rect.left;

            // One rocket from click
            spawnRocket(x);

            // Occasionally a second “buddy rocket” for excitement
            const buddyChance = 0.30 * lerp(0.55, 1.0, quality);
            if (Math.random() < buddyChance) spawnRocket(x + rand(-40, 40));
        });

        // Resize
        window.addEventListener("resize", () => resize());

        // Visibility + focus lifecycle
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) pause();
            else resume();
        });

        window.addEventListener("blur", pause);
        window.addEventListener("focus", () => {
            if (!document.hidden) resume();
        });

        // BFCache / navigation
        window.addEventListener("pagehide", pause);
        window.addEventListener("pageshow", () => {
            if (!document.hidden) resume();
        });
    }

    // -----------------------------
    // Wire API
    // -----------------------------
    api.start = (opts) => {
        initOnce();
        start(opts);
    };
    api.stop = () => {
        initOnce();
        stop();
    };
    api.pause = () => {
        initOnce();
        pause();
    };
    api.resume = () => {
        initOnce();
        resume();
    };
    api.resize = () => {
        initOnce();
        resize();
    };
    api.burst = (x, y) => {
        initOnce();
        burst(x, y);
    };
    api.unlockSfx = () => {
        initOnce();
        unlockSfxOnce();
    };
})();

(() => {
  const canvas = document.getElementById('fx');
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1, sky = null, sky2 = null, sky3 = null, sky4 = null, skyMap = {};
  let bolts = [], sparks = [], arcs = [], flash = 0, nextBolt = 800, nextArc = 0, last = 0;
  const rand = (a, b) => a + Math.random() * (b - a);

  const MOTE = { storm: { c: '#7fd4ff', d: 0.4 }, ball: { c: '#ffbf3a', d: -1 }, lithium: { c: '#ff6a80', d: -1.2 }, zinc: { c: '#a5f3dc', d: -0.35 } };
  let motes = [];
  let hexes = [], hexPath = null, zflares = [], zstart = 0, nextZ = 800;
  function seedMotes() {
    motes = Array.from({ length: Math.round((W * H) / 24000) }, () => ({ x: rand(0, W), y: rand(0, H), r: rand(0.8, 2.2), v: rand(0.08, 0.3), ph: rand(0, 6.28) }));
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    sky = ctx.createRadialGradient(W / 2, -H * 0.2, 0, W / 2, H * 0.3, Math.max(W, H));
    sky.addColorStop(0, '#16224a'); sky.addColorStop(0.5, '#0b1330'); sky.addColorStop(1, '#060a1c');
    sky2 = ctx.createRadialGradient(W * 0.6, H * 0.35, 0, W * 0.5, H * 0.5, Math.max(W, H));
    sky2.addColorStop(0, '#2b1a06'); sky2.addColorStop(0.5, '#160e04'); sky2.addColorStop(1, '#0d0904');
    sky3 = ctx.createRadialGradient(W / 2, H * 1.1, 0, W / 2, H * 0.6, Math.max(W, H));
    sky3.addColorStop(0, '#3a0d1a'); sky3.addColorStop(0.5, '#1b0810'); sky3.addColorStop(1, '#12060a');
    sky4 = ctx.createLinearGradient(0, 0, W, H);
    sky4.addColorStop(0, '#0e1c21'); sky4.addColorStop(0.5, '#0a1316'); sky4.addColorStop(1, '#070d10');
    skyMap = { storm: sky, ball: sky2, lithium: sky3, zinc: sky4 };
    seedMotes(); seedHex();
  }
  window.addEventListener('resize', resize);
  resize();

  // молния: дробление отрезка со случайным смещением середины
  function path(x1, y1, x2, y2, offset, detail = 6) {
    let pts = [[x1, y1], [x2, y2]], off = offset;
    for (let i = 0; i < detail; i++) {
      const next = [pts[0]];
      for (let j = 0; j < pts.length - 1; j++) {
        const [ax, ay] = pts[j], [bx, by] = pts[j + 1];
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1, o = rand(-off, off);
        next.push([(ax + bx) / 2 + (-dy / len) * o, (ay + by) / 2 + (dx / len) * o], pts[j + 1]);
      }
      pts = next; off *= 0.55;
    }
    return pts;
  }

  function makeBolt(x1, y1, x2, y2, width, life, big) {
    const len = Math.hypot(x2 - x1, y2 - y1), main = path(x1, y1, x2, y2, len * 0.22), branches = [];
    for (let i = 0; i < (big ? 7 : 3); i++) {
      const p = main[Math.floor(rand(main.length * 0.15, main.length * 0.85))];
      const ang = Math.atan2(y2 - y1, x2 - x1) + rand(-0.9, 0.9), bl = len * rand(0.12, 0.3);
      branches.push(path(p[0], p[1], p[0] + Math.cos(ang) * bl, p[1] + Math.sin(ang) * bl, bl * 0.3, 5));
    }
    return { main, branches, width, life, max: life };
  }

  function strike(big = false) {
    const x1 = rand(W * 0.1, W * 0.9), x2 = x1 + rand(-W * 0.2, W * 0.2);
    const y2 = rand(H * (big ? 0.75 : 0.35), H * (big ? 1 : 0.8));
    bolts.push(makeBolt(x1, -10, x2, y2, big ? 3.2 : 2, big ? 34 : 22, big));
    if (big) flash = 0.3; else if (Math.random() < 0.4) flash = 0.1;
    for (let i = 0; i < (big ? 24 : 9); i++) sparks.push({ x: x2, y: y2, vx: rand(-3, 3), vy: rand(-4, 0.5), life: rand(14, 34) });
  }

  function line(pts, w, color, alpha) {
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.lineWidth = w; ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.stroke();
  }

  // свечение слоями вместо shadowBlur: так заметно быстрее
  function glow(pts, w, a) {
    line(pts, w * 7, 'rgb(40,140,255)', a * 0.12);
    line(pts, w * 3.2, 'rgb(90,200,255)', a * 0.35);
    line(pts, w, '#eaf8ff', a);
  }

  // ---------- стиль «Шаровая молния»: жёлтый шар и искрящий провод ----------
  let wsp = [], fil = [], nextFil = 0, link = 0, linkPts = null, nextLink = 1200;
  const tip = { x: 0, y: 0 };
  function glowY(pts, w, a) {
    line(pts, w * 7, 'rgb(255,140,20)', a * 0.12);
    line(pts, w * 3.2, 'rgb(255,200,60)', a * 0.38);
    line(pts, w, '#fffbe0', a);
  }
  function wireBurst(n) {
    for (let i = 0; i < n; i++) wsp.push({ x: tip.x, y: tip.y, vx: rand(-4.5, 4.5), vy: rand(-7, -1), life: rand(30, 70) });
  }
  function drawBall(t, k) {
    const R = Math.min(W, H) * 0.07;
    const bx = W * 0.6 + Math.sin(t / 2300) * W * 0.05, by = H * 0.36 + Math.sin(t / 1500) * H * 0.05;
    tip.x = W * 0.57 + Math.sin(t / 1100) * 6; tip.y = H * 0.83;
    const ty = tip.y - 10;

    // провод: обычная тёмная изоляция поверх фона
    ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-10, H * 0.1); ctx.quadraticCurveTo(W * 0.3, H * 0.7, tip.x, ty);
    ctx.lineWidth = 9; ctx.strokeStyle = '#16100a'; ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,190,90,.25)'; ctx.stroke();
    for (let i = -2; i <= 2; i++) { // оголённые медные жилы
      ctx.beginPath(); ctx.moveTo(tip.x + i, ty); ctx.lineTo(tip.x + i * 3.2, ty + 8 + (i & 1) * 5);
      ctx.lineWidth = 1.6; ctx.strokeStyle = '#d9863a'; ctx.stroke();
    }
    ctx.restore();

    // шар: мягкое гало, плазменные нити, раскалённое ядро
    let g = ctx.createRadialGradient(bx, by, 0, bx, by, R * 4.5);
    g.addColorStop(0, 'rgba(255,220,80,.55)'); g.addColorStop(0.35, 'rgba(255,170,30,.18)'); g.addColorStop(1, 'rgba(255,140,0,0)');
    ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(bx - R * 5, by - R * 5, R * 10, R * 10);
    if (t > nextFil) {
      fil = [];
      for (let i = 0; i < 9; i++) {
        const a = rand(0, Math.PI * 2), l = R * rand(1.4, 3.4);
        fil.push(path(bx + Math.cos(a) * R * 0.8, by + Math.sin(a) * R * 0.8, bx + Math.cos(a) * l, by + Math.sin(a) * l, l * 0.25, 4));
      }
      nextFil = t + rand(45, 95);
    }
    fil.forEach(p => glowY(p, 1.4, 0.8));
    const pulse = 1 + Math.sin(t / 180) * 0.06 + rand(-0.03, 0.03);
    g = ctx.createRadialGradient(bx, by, 0, bx, by, R * pulse);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, '#fff3a0'); g.addColorStop(0.75, '#ffd23a'); g.addColorStop(1, 'rgba(255,150,20,0)');
    ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(bx, by, R * pulse, 0, Math.PI * 2); ctx.fill();

    // свечение и мелкая дуга на конце провода
    g = ctx.createRadialGradient(tip.x, ty, 0, tip.x, ty, R * 0.9);
    g.addColorStop(0, 'rgba(255,210,100,.6)'); g.addColorStop(1, 'rgba(255,140,20,0)');
    ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(tip.x - R, ty - R, R * 2, R * 2);

    if (!reduce) {
      if (Math.random() < 0.55) line(path(tip.x, ty, tip.x + rand(-34, 34), ty + rand(-30, 14), 8, 3), 1.5, 'rgb(255,235,140)', Math.random() * 0.9);
      if (Math.random() < 0.2 * k) wireBurst(1 + Math.floor(Math.random() * 3));
      if (t > nextLink) { // шар «перескакивает» на провод
        linkPts = path(bx, by, tip.x, ty, Math.hypot(tip.x - bx, ty - by) * 0.2, 6);
        link = 10; nextLink = t + rand(1800, 4200); wireBurst(14);
      }
    }
    if (link > 0 && linkPts) { glowY(linkPts, 2.4, Math.min(1, link / 6)); link -= k; }

    // искры с отскоком от пола
    const floor = H - 6;
    wsp = wsp.filter(s => s.life > 0);
    wsp.forEach(s => {
      s.vy += 0.25 * k; s.x += s.vx * k; s.y += s.vy * k;
      if (s.y > floor) { s.y = floor; s.vy *= -0.4; s.vx *= 0.8; }
      s.life -= k;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * 1.6, s.y - s.vy * 1.6);
      ctx.lineWidth = 2; ctx.strokeStyle = '#ffd45a'; ctx.globalAlpha = Math.min(1, s.life / 20); ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  // ---------- стиль «Литий»: алая вспышка горящего металла ----------
  let flames = [], lsp = [], nextFlare = 1500;
  function lithFlare(x, big) {
    flames.push({ x, y: H + 10, r: big ? rand(110, 170) : rand(30, 70), vy: big ? rand(1.2, 2) : rand(0.5, 1.5), life: 1, dec: big ? 0.012 : rand(0.004, 0.008), ph: rand(0, 6.28) });
    for (let i = 0; i < (big ? 26 : 1); i++) lsp.push({ x: x + rand(-30, 30), y: H - rand(0, 30), vx: rand(-1.6, 1.6), vy: rand(-6, -2), life: rand(40, 90) });
  }
  function drawLithium(t, k) {
    const pulse = 0.3 + 0.08 * Math.sin(t / 420) + rand(-0.02, 0.02);
    let g = ctx.createRadialGradient(W / 2, H * 1.1, 0, W / 2, H * 1.1, H * 1.1);
    g.addColorStop(0, `rgba(255,70,100,${pulse})`); g.addColorStop(0.5, 'rgba(200,30,80,0.1)'); g.addColorStop(1, 'rgba(120,10,40,0)');
    ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (!reduce) {
      if (Math.random() < 0.22 * k) lithFlare(rand(W * 0.08, W * 0.92), false);
      if (t > nextFlare) { lithFlare(rand(W * 0.2, W * 0.8), true); nextFlare = t + rand(3200, 6500); }
    }
    flames = flames.filter(f => f.life > 0);
    flames.forEach(f => {
      f.y -= f.vy * k; f.x += Math.sin(t / 500 + f.ph) * 0.5 * k; f.life -= f.dec * k;
      const r = f.r * (0.5 + f.life * 0.6), a = Math.max(0, f.life);
      const gg = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
      gg.addColorStop(0, `rgba(255,225,230,${a * 0.55})`); gg.addColorStop(0.35, `rgba(255,90,120,${a * 0.28})`); gg.addColorStop(1, 'rgba(200,20,70,0)');
      ctx.globalAlpha = 1; ctx.fillStyle = gg; ctx.fillRect(f.x - r, f.y - r, r * 2, r * 2);
    });
    lsp = lsp.filter(s => s.life > 0);
    lsp.forEach(s => {
      s.x += s.vx * k; s.y += s.vy * k; s.vy += 0.07 * k; s.life -= k;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * 2, s.y - s.vy * 2);
      ctx.lineWidth = 2; ctx.strokeStyle = '#ff8a9c'; ctx.globalAlpha = Math.min(1, s.life / 25); ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  // ---------- стиль «Цинк»: кристаллы оцинковки и бело-зелёные блики ----------
  function seedHex() {
    const R = 46, w = Math.sqrt(3) * R;
    hexes = []; hexPath = new Path2D();
    for (let row = -1; row * R * 1.5 < H + R * 2; row++) {
      const y = row * R * 1.5;
      for (let x = (row & 1 ? w / 2 : 0) - w; x < W + w; x += w) {
        const pts = [];
        for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; pts.push([x + Math.cos(a) * R * 0.96, y + Math.sin(a) * R * 0.96]); }
        hexes.push({ x, y, pts, ph: rand(0, 6.28), base: rand(0.01, 0.045) });
        hexPath.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < 6; i++) hexPath.lineTo(pts[i][0], pts[i][1]);
        hexPath.closePath();
      }
    }
  }
  function zincFlare() { zflares.push({ x: rand(W * 0.1, W * 0.9), y: rand(H * 0.15, H * 0.85), life: 1 }); }
  function drawZinc(t, k) {
    const sweep = reduce ? -9999 : (t - zstart) * 0.55;   // диагональный блик пробегает по кристаллам
    ctx.globalAlpha = 1;
    hexes.forEach(h => {
      const boost = Math.max(0, 1 - Math.abs(h.x + h.y - sweep) / 220);
      const a = h.base * (0.6 + 0.4 * Math.sin(t / 2600 + h.ph)) + boost * 0.14;
      if (a < 0.004) return;
      ctx.fillStyle = `rgba(190,240,230,${a})`;
      ctx.beginPath(); ctx.moveTo(h.pts[0][0], h.pts[0][1]);
      for (let i = 1; i < 6; i++) ctx.lineTo(h.pts[i][0], h.pts[i][1]);
      ctx.closePath(); ctx.fill();
    });
    ctx.strokeStyle = 'rgba(170,235,225,0.07)'; ctx.lineWidth = 1; ctx.stroke(hexPath);
    if (!reduce) {
      if (t > nextZ) { zincFlare(); nextZ = t + rand(1400, 3200); }
      if (t - zstart > 7000) zstart = t;
    }
    zflares = zflares.filter(f => f.life > 0);
    zflares.forEach(f => {
      f.life -= 0.02 * k;
      const r = 40 + (1 - f.life) * 90, a = Math.max(0, f.life);
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
      g.addColorStop(0, `rgba(235,255,248,${a * 0.6})`); g.addColorStop(0.4, `rgba(110,235,200,${a * 0.2})`); g.addColorStop(1, 'rgba(60,200,170,0)');
      ctx.fillStyle = g; ctx.fillRect(f.x - r, f.y - r, r * 2, r * 2);
      ctx.strokeStyle = `rgba(220,255,245,${a * 0.8})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(f.x - r * 0.5, f.y); ctx.lineTo(f.x + r * 0.5, f.y); ctx.moveTo(f.x, f.y - r * 0.5); ctx.lineTo(f.x, f.y + r * 0.5); ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden) { last = t; return; }
    const k = Math.min(50, t - (last || t)) / 16.67; last = t;
    const theme = document.documentElement.dataset.theme || 'storm';
    const mote = MOTE[theme] || MOTE.storm;

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1; ctx.fillStyle = skyMap[theme] || sky; ctx.fillRect(0, 0, W, H);
    if (flash > 0.005) {
      ctx.fillStyle = `rgba(160,210,255,${flash})`; ctx.fillRect(0, 0, W, H);
      flash *= Math.pow(0.86, k);
    } else flash = 0;

    ctx.globalCompositeOperation = 'lighter';
    // плавающая пыль: холодные искорки в грозе, тёплые угольки вверх в стиле шара
    ctx.fillStyle = mote.c;
    motes.forEach(m => {
      if (!reduce) {
        m.y += mote.d * m.v * k; m.x += Math.sin(t / 1800 + m.ph) * 0.15 * k;
        if (m.y < -4) m.y = H + 4; else if (m.y > H + 4) m.y = -4;
      }
      ctx.globalAlpha = 0.22 + 0.2 * Math.sin(t / 700 + m.ph);
      ctx.fillRect(m.x, m.y, m.r, m.r);
    });
    ctx.globalAlpha = 1;
    if (!reduce && theme === 'storm') {
      if (t > nextBolt) {
        strike(false);
        if (Math.random() < 0.3) setTimeout(() => strike(false), rand(80, 160));
        nextBolt = t + rand(1400, 4200);
      }
      if (t > nextArc) {
        arcs = [0, 1].map(i => {
          const y = rand(H * 0.2, H * 0.8), x = i ? W : 0;
          return { pts: path(x, y, x + (i ? -1 : 1) * rand(40, 110), y + rand(-60, 60), 22, 4), a: Math.random() * 0.4 };
        });
        nextArc = t + rand(70, 170);
      }
      arcs.forEach(a => line(a.pts, 1.2, 'rgb(150,220,255)', a.a));
    }

    if (theme === 'ball') { drawBall(t, k); return; }
    if (theme === 'lithium') { drawLithium(t, k); return; }
    if (theme === 'zinc') { drawZinc(t, k); return; }

    bolts = bolts.filter(b => b.life > 0);
    bolts.forEach(b => {
      const a = Math.min(1, (b.life / b.max) * 1.6) * (Math.random() < 0.2 ? 0.5 : 1);
      glow(b.main, b.width, a);
      b.branches.forEach(p => glow(p, b.width * 0.5, a));
      b.life -= k;
    });

    sparks = sparks.filter(s => s.life > 0);
    sparks.forEach(s => {
      s.x += s.vx * k; s.y += s.vy * k; s.vy += 0.18 * k; s.life -= k;
      ctx.globalAlpha = Math.min(1, s.life / 14) * 0.3; ctx.fillStyle = '#5fdcff'; ctx.fillRect(s.x - 2, s.y - 2, 6, 6);
      ctx.globalAlpha = Math.min(1, s.life / 14); ctx.fillStyle = '#d8f4ff'; ctx.fillRect(s.x, s.y, 2, 2);
    });
  }

  window.addEventListener('electro:zap', () => {
    const th = document.documentElement.dataset.theme;
    if (th === 'ball') { wireBurst(40); link = 12; nextLink = 0; return; }
    if (th === 'lithium') { for (let i = 0; i < 3; i++) lithFlare(rand(W * 0.2, W * 0.8), true); return; }
    if (th === 'zinc') { zstart = performance.now(); for (let i = 0; i < 4; i++) zincFlare(); return; }
    strike(true); setTimeout(() => strike(true), 120);
  });
  requestAnimationFrame(frame);
})();

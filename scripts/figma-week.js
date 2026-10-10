// Figma апталық есеп генераторы — «ЕСЕП | DSGN» файлында use_figma арқылы орындалады.
// Қолдану: осы файлдың мәтінінің басына `const DATA = {...};` қосып, use_figma-ға береді.
//   DATA = { page: "4 ай 2 апта", reset: true|false, startIndex: 0, label, range, month, designers: [...] }
//   designers[i] — data.json-дағы элемент + liked[k].imageHash (upload_assets нәтижесі)
// Бір шақыруда 3–4 дизайнер (50 000 таңба шегі үшін). Бірінші шақыру reset:true — бетті тазалайды.
const F = (s) => ({ family: "JUZ40 FONTS", style: s });
await Promise.all(["Regular", "Medium", "Bold"].map((s) => figma.loadFontAsync(F(s))));
const tplPage = figma.root.children.find((p) => p.name === "ШАБЛОН · Апталық есеп");
if (!tplPage) throw new Error("«ШАБЛОН · Апталық есеп» беті табылмады");
await tplPage.loadAsync();
const tpl = Object.fromEntries(tplPage.children.map((f) => [f.name.slice(0, 2), f]));

let page = figma.root.children.find((p) => p.name === DATA.page);
if (!page) {
  page = figma.createPage(); page.name = DATA.page;
  const idx = figma.root.children.findIndex((p) => /^\d+ ай \d+ апта$/.test(p.name) && p !== page);
  figma.root.insertChild(Math.max(0, idx), page); // апталық беттердің қасына
}
await figma.setCurrentPageAsync(page);
// Тек осы генератор жасаған слайдтар өшіріледі; дизайнерлердің қолмен жасағаны орнында қалады
const OURS = /· (Титул|Атқарылған жұмыстар|ТОП-3 ұнаған жұмыс|Апта қорытындысы|Айлық мақсаттар|Айлық мақсат конверсиясы)$/;
if (DATA.reset) for (const c of [...page.children]) if (OURS.test(c.name)) c.remove();
const others = page.children.filter((c) => !OURS.test(c.name));
const baseY = others.length ? Math.max(...others.map((c) => c.y + c.height)) + 400 : 0;

const set = (root, name, value) => {
  for (const t of root.findAll((n) => n.type === "TEXT" && n.name === name)) t.characters = value === null || value === undefined || value === "" ? "—" : String(value);
};
const pct = (v) => (v === null || v === undefined ? "—" : `${v}%`);
const fmt = (v, p) => (v === null || v === undefined ? "—" : `${String(Math.round(v * 100) / 100).replace(".", ",")}${p ? "%" : ""}`);
const created = [];

DATA.designers.forEach((d, k) => {
  const row = (DATA.startIndex || 0) + k;
  const y = baseY + row * 1300;
  let x = 0;
  const place = (key) => {
    const f = tpl[key].clone(); page.appendChild(f); f.x = x; f.y = y; x += 2000;
    f.name = `${d.name} · ${tpl[key].name.slice(5)}`;
    set(f, "{label}", DATA.label); set(f, "{short}", d.name);
    created.push(f.id); return f;
  };
  // 1. Титул
  const t = place("01");
  set(t, "{label-big}", DATA.label.replace(" ", "\n")); set(t, "{fullName}", d.fullName); set(t, "{range}", `${DATA.range} · Дизайн бөлімі`);
  // 2. Жұмыстар
  const w = place("02");
  const total = Object.values(d.totals || {}).reduce((a, b) => a + b, 0);
  set(w, "{total}", total); set(w, "{tasks}", `${d.tasks} тапсырма YouGile-ден`);
  const half = Math.ceil(d.works.length / 2);
  const c1 = d.works.length > 8 ? d.works.slice(0, half) : d.works, c2 = d.works.length > 8 ? d.works.slice(half) : [];
  set(w, "{works-1}", c1.join("\n") || "Бұл аптада есептелген жұмыс жоқ"); set(w, "{works-2}", c2.join("\n") || " ");
  if (d.works.length > 20) for (const n of w.findAll((n) => n.type === "TEXT" && /works/.test(n.name))) n.fontSize = 24;
  // 3. ТОП-3
  const l = place("03");
  for (let i = 0; i < 3; i++) {
    const card = l.findOne((n) => n.name === `liked-${i + 1}`), it = d.liked?.[i];
    if (it?.imageHash) { card.fills = [{ type: "IMAGE", imageHash: it.imageHash, scaleMode: "FILL" }]; card.findOne((n) => n.name === "liked-placeholder")?.remove(); }
    else card.findOne((n) => n.name === "liked-placeholder").characters = "сурет жіберілмеген";
    set(l, `{liked-cap-${i + 1}}`, it?.caption || " ");
  }
  // 4. Апта қорытындысы
  const n = place("04");
  for (const key of ["problem", "solution", "achievement", "idea"]) set(n, `{${key}}`, d.notes?.[key]);
  // 5. Мақсаттар (9 жолдан, артығы келесі слайдқа)
  const goals = d.goals || [];
  for (let s = 0; s < Math.max(1, Math.ceil(goals.length / 9)); s++) {
    const g = place("05");
    set(g, "{month}", DATA.month);
    const list = g.findOne((n) => n.name === "goals"), proto = list.findOne((n) => n.name === "goal-row");
    const part = goals.slice(s * 9, s * 9 + 9);
    if (!part.length) { set(proto, "{g-title}", "Мақсаттар әлі енгізілмеген"); set(proto, "{g-val}", " "); set(proto, "{g-n}", " "); proto.findOne((n) => n.name === "g-bar").visible = false; proto.findOne((n) => n.name === "g-bar-bg").visible = false; }
    part.forEach((goal, i) => {
      const r = i === 0 ? proto : proto.clone();
      if (i > 0) list.appendChild(r);
      set(r, "{g-n}", String(goal.n).padStart(2, "0"));
      set(r, "{g-title}", goal.kind === "strat" ? `${goal.title}  · стратегиялық` : goal.title);
      set(r, "{g-val}", `${goal.conversion}%`);
      const bar = r.findOne((n) => n.name === "g-bar");
      bar.resize(Math.max(0.01, (220 * goal.conversion) / 100), 10);
      if (goal.conversion <= 0) bar.visible = false;
    });
  }
  // 6. Конверсия
  const c = place("06");
  const cv = d.conversion || {};
  set(c, "{conv}", pct(cv.total ? cv.overall : null)); set(c, "{op}", pct(cv.op)); set(c, "{strat}", pct(cv.strat));
  set(c, "{done}", cv.total ? `${cv.done}/${cv.total}` : null);
  const ring = c.findOne((n) => n.name === "ring");
  const p = Math.max(0.001, Math.min(1, (cv.total ? cv.overall : 0) / 100));
  ring.arcData = { startingAngle: -Math.PI / 2, endingAngle: -Math.PI / 2 + 2 * Math.PI * p, innerRadius: 0.78 };
});
return { page: page.id, created: created.length, ids: created };

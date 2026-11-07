const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");

initializeApp();

const key = defineSecret("ANTHROPIC_API_KEY");
const nytKey = defineSecret("NYT_API_KEY");

const STATUS = { lido: "lido", lendo: "lendo agora", quero: "quer ler" };
const norm = (t = "") => t.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function ask(text, tags, shelf) {
  const client = new Anthropic({ apiKey: key.value() });
  const lines = shelf.map((b) => `- ${b.title} (${b.author}): ${STATUS[b.status]}${b.rating ? `, nota ${b.rating}/5` : ""}`).join("\n");
  const request = {
    model: "claude-sonnet-5-5",
    max_tokens: 8000,
    // Sem critérios escritos (só estante) dá para dispensar o raciocínio: 6s em vez de ~15s.
    // Com critérios ("sem poderes"), o raciocínio é o que faz o modelo respeitá-los.
    ...(text || tags.length ? {} : { thinking: { type: "between_tools" } }),
    system:
      "Você recomenda livros e web novels que realmente existem e podem ser lidos ou comprados. " +
      "Nunca invente títulos. Cada livro deve atender a TODAS as características pedidas; " +
      "se uma exclui algo (ex.: 'sem poderes', 'sem sistema'), não sugira livros em que o protagonista tenha isso. " +
      "Só sugira obras cujo título e autor você conhece com certeza; se não tiver certeza do autor, não sugira. " +
      "Use só o título principal, sem tradução ou nome original entre parênteses. " +
      "Em 'why', diga em uma frase como o livro atende ao pedido ou ao gosto do leitor. " +
      "Não use aspas duplas dentro dos textos. " +
      "Responda SOMENTE com um array JSON de 5 itens: " +
      '[{"title":"","author":"","why":"uma frase em português"}].',
    messages: [{
      role: "user",
      content: `Pedido: ${text || "(nenhum; use o gosto da estante)"}\nCaracterísticas: ${tags.join(", ")}` +
        (shelf.length ? `\n\nEstante do leitor. Notas 4 e 5 indicam que gostou, 1 e 2 que não gostou. NÃO recomende livros desta lista:\n${lines}` : ""),
    }],
  };
  let lastErr;
  for (let tries = 0; tries < 2; tries++) { // o modelo às vezes devolve JSON malformado: tenta de novo uma vez
    try {
      const msg = await client.messages.create(request);
      const raw = msg.content.find((c) => c.type === "text")?.text ?? "";
      if (!raw.includes("[")) throw new Error(`sem JSON: stop=${msg.stop_reason} ${JSON.stringify(msg.content).slice(0, 400)}`);
      const have = new Set(shelf.map((b) => norm(b.title)));
      return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1)).filter((b) => !have.has(norm(b.title)));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Limite diário de recomendações: 30 por usuário logado, 5 por IP sem login (cada uma custa uma chamada ao Claude)
async function who(req) {
  const token = req.body?.idToken;
  if (token) {
    try { return { id: (await getAuth().verifyIdToken(token)).uid, limit: 30 }; } catch {}
  }
  const ip = (req.get("x-forwarded-for") || req.ip || "").split(",")[0].trim();
  return { id: "ip-" + crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16), limit: 5 };
}
async function underLimit({ id, limit }) {
  const db = getFirestore();
  const ref = db.doc(`usage/${id}_${new Date().toISOString().slice(0, 10)}`);
  return db.runTransaction(async (t) => {
    const n = (await t.get(ref)).data()?.n ?? 0;
    if (n >= limit) return false;
    t.set(ref, { n: n + 1 });
    return true;
  });
}

// Confere o título no Open Library; sem resultado => verified:false (ex.: web novels)
async function verify(b) {
  const q = new URLSearchParams({ title: b.title, author: b.author, limit: 1, fields: "key,cover_i" });
  const r = await fetch(`https://openlibrary.org/search.json?${q}`);
  const d = r.ok ? (await r.json()).docs?.[0] : null;
  if (!d) return { ...b, verified: false };
  return {
    ...b,
    verified: true,
    cover: d.cover_i && `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`,
    link: `https://openlibrary.org${d.key}`,
  };
}

exports.recommend = onRequest({ secrets: [key], cors: true }, async (req, res) => {
  const text = String(req.body?.text || "").slice(0, 500);
  const tags = (req.body?.tags || []).slice(0, 10).map(String);
  const shelf = (Array.isArray(req.body?.shelf) ? req.body.shelf : []).slice(0, 40).map((b) => ({
    title: String(b.title || "").slice(0, 100), author: String(b.author || "").slice(0, 100),
    status: STATUS[b.status] ? b.status : "lido", rating: Math.min(5, Math.max(0, Number(b.rating) || 0)),
  }));
  if (!text && !tags.length && !shelf.length) return res.status(400).json({ error: "Descreva o que procura." });
  try {
    if (!(await underLimit(await who(req)))) {
      return res.status(429).json({ error: "Você atingiu o limite de recomendações de hoje. Volte amanhã" + (req.body?.idToken ? "." : " ou entre na sua conta para ter mais.") });
    }
    res.json(await Promise.all((await ask(text, tags, shelf)).map(verify)));
  } catch (e) {
    console.error("recommend failed", e.status, e.name, e.message, e.cause?.message);
    res.status(500).json({ error: "Não consegui recomendar agora. Tente de novo." });
  }
});

const NYT_LISTS = {
  "combined-print-and-e-book-fiction": "Ficção",
  "trade-fiction-paperback": "Ficção em brochura",
  "combined-print-and-e-book-nonfiction": "Não ficção",
  "young-adult-hardcover": "Jovem adulto",
  "graphic-books-and-manga": "Quadrinhos e mangá",
  "business-books": "Negócios",
};
const SMALL = new Set(["of", "the", "a", "an", "and", "in", "on", "to", "for", "at", "by"]);
// O NYT manda os títulos em caixa-alta
const toTitle = (t) => t.toLowerCase().replace(/[^\s-]+/g, (w, i) => (i > 0 && SMALL.has(w) ? w : w.replace(/^\W*[a-z]/, (c) => c.toUpperCase())));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nytList(id) {
  for (let tries = 0; tries < 3; tries++) {
    const r = await fetch(`https://api.nytimes.com/svc/books/v3/lists/current/${id}.json?api-key=${nytKey.value()}`);
    if (r.status === 429) { await sleep(30000); continue; }
    if (!r.ok) throw new Error(`${id}: ${r.status}`);
    return (await r.json()).results.books.slice(0, 10).map((b) => ({
      title: toTitle(b.title), author: b.author, cover: b.book_image, link: b.amazon_product_url,
      weeks: Number(b.weeks_on_list), desc: b.description,
    }));
  }
  throw new Error(`${id}: 429`);
}

const GENRES = [
  { name: "Fantasia", q: 'subject:"fantasy fiction" OR subject:"epic fantasy"' },
  { name: "Romance", q: 'subject:romance -subject:fantasy -subject:"young adult"' },
  { name: "Ficção científica", q: 'subject:"science fiction" -subject:fantasy -subject:"young adult" -subject:romance -subject:horror' },
  { name: "Mistério", q: 'subject:"detective and mystery stories" -subject:"juvenile fiction" -subject:fantasy -subject:romance' },
  { name: "Terror", q: 'subject:horror -subject:fantasy -subject:"young adult" -subject:romance' },
];

const OL_HEADERS = { "User-Agent": "Estante-bookshelf-app" };

// Open Library ordenado por quantas pessoas guardaram o livro (readinglog)
async function olGenre(g) {
  const qs = new URLSearchParams({ q: g.q, sort: "readinglog", language: "eng", limit: 40, fields: "key,title,author_name,cover_i" });
  const r = await fetch(`https://openlibrary.org/search.json?${qs}`, { headers: OL_HEADERS });
  if (!r.ok) throw new Error(`ol ${g.name}: ${r.status}`);
  const perAuthor = {};
  const books = (await r.json()).docs.map((d) => ({
    key: d.key, title: d.title, author: d.author_name?.[0] || "Autor desconhecido",
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : "", link: `https://openlibrary.org${d.key}`,
  })).filter((b) => (perAuthor[b.author] = (perAuthor[b.author] || 0) + 1) <= 2).slice(0, 10); // até 2 livros por autor
  for (const b of books) { // um por vez, com nova tentativa: pedidos em paralelo falhavam em silêncio
    for (let tries = 0; tries < 3 && b.desc === undefined; tries++) {
      try {
        const r = await fetch(`https://openlibrary.org${b.key}.json`, { headers: OL_HEADERS });
        if (!r.ok) throw new Error(r.status);
        const w = await r.json();
        b.desc = (typeof w.description === "string" ? w.description : w.description?.value || "").split(/\n\n|-{5,}/)[0];
      } catch (e) {
        if (tries === 2) console.error("ol descrição", b.title, e.message);
        else await sleep(1000);
      }
    }
    delete b.key;
  }
  return { name: g.name, books };
}

const clean = (t = "") => t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_]/g, "").trim();
const short = (t = "") => ((t = clean(t)).length <= 600 ? t : t.slice(0, 600).replace(/[^.!?]*$/, "") || t.slice(0, 600));

// Traduz as descrições em lotes; troca `desc` (inglês) por `synopsis` (português)
async function translateSynopses(lists) {
  const books = lists.flatMap((l) => l.books);
  const todo = books.filter((b) => b.desc && b.desc.trim());
  const client = new Anthropic({ apiKey: key.value() });
  for (let i = 0; i < todo.length; i += 15) {
    const chunk = todo.slice(i, i + 15);
    try {
      const msg = await client.messages.create({
        model: "claude-haiku-5-5",
        max_tokens: 16000,
        system:
          "Traduza para português do Brasil sinopses de livros. Mantenha nomes próprios e títulos de obras no original. " +
          'Receberá um objeto JSON {"0":"texto",...}. Responda SOMENTE com um objeto JSON com as mesmas chaves e as traduções.',
        messages: [{ role: "user", content: JSON.stringify(Object.fromEntries(chunk.map((b, j) => [j, short(b.desc)]))) }],
      });
      const raw = msg.content.find((c) => c.type === "text")?.text ?? "";
      const out = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      chunk.forEach((b, j) => { if (out[j]) b.synopsis = String(out[j]); else console.error("translate: faltou", b.title); });
    } catch (e) {
      console.error("translate lote", i, e.message);
    }
  }
  books.forEach((b) => delete b.desc);
}

// Título da edição brasileira, só quando o modelo tem certeza de que ela existe (senão fica sem: a busca usa o título original)
async function addPtTitles(lists) {
  const books = lists.flatMap((l) => l.books);
  const client = new Anthropic({ apiKey: key.value() });
  for (let i = 0; i < books.length; i += 30) {
    const chunk = books.slice(i, i + 30);
    try {
      const msg = await client.messages.create({
        model: "claude-sonnet-5-5",
        max_tokens: 16000,
        system:
          "Para cada livro, informe o título da edição publicada no Brasil em português, se você tiver CERTEZA de que ela existe com esse título. " +
          "Se não houver edição brasileira ou você não tiver certeza, use null. Nunca invente títulos. " +
          'Receberá {"0":"Título - Autor",...}. Responda SOMENTE com um objeto JSON com as mesmas chaves e o título em português ou null.',
        messages: [{ role: "user", content: JSON.stringify(Object.fromEntries(chunk.map((b, j) => [j, `${b.title} - ${b.author}`]))) }],
      });
      const raw = msg.content.find((c) => c.type === "text")?.text ?? "";
      const out = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      chunk.forEach((b, j) => { if (typeof out[j] === "string" && out[j].trim() && out[j] !== b.title) b.titlePt = out[j].trim(); });
    } catch (e) {
      console.error("titulos pt lote", i, e.message);
    }
  }
}

// Uma vez por dia: o NYT limita a 5 pedidos por minuto, então espaça as 6 listas; guarda tudo no Firestore
exports.refreshBestsellers = onSchedule(
  { schedule: "every day 06:00", timeZone: "America/Sao_Paulo", secrets: [nytKey, key], timeoutSeconds: 540 },
  async () => {
    const lists = [];
    for (const [id, name] of Object.entries(NYT_LISTS)) {
      if (lists.length) await sleep(12500);
      try { lists.push({ name, books: await nytList(id) }); } catch (e) { console.error("nyt", e.message); }
    }
    const genres = (await Promise.allSettled(GENRES.map(olGenre))).filter((r) => r.status === "fulfilled").map((r) => r.value);
    await translateSynopses([...lists, ...genres]);
    await addPtTitles([...lists, ...genres]);
    if (lists.length || genres.length) await getFirestore().doc("public/bestsellers").set({ updatedAt: new Date(), lists, genres });
  }
);

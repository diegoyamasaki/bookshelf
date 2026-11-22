import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, updateProfile, GoogleAuthProvider, signInWithPopup, sendPasswordResetEmail }
  from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, getCountFromServer, query, where, orderBy, limit, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, arrayUnion, arrayRemove }
  from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

// Chave web do Firebase: pública por design; o acesso é protegido por firestore.rules
const app = initializeApp({
  apiKey: "AIzaSyDu2lswJqWM4OWF_jeLIR2hHOIVTooyvdo",
  authDomain: "bookshelf-diego-2611.firebaseapp.com",
  projectId: "bookshelf-diego-2611",
  appId: "1:1027024406136:web:c1aa3f0d723e37e3b48f8d",
});
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https:\/\//.test(u || "") ? esc(u) : "");
// Letras e números de qualquer alfabeto (títulos em japonês, cirílico etc. não podem colidir).
// Usa o título original, para o mesmo livro ter o mesmo id (e os mesmos comentários) em qualquer idioma.
const bookId = (b) => ((b.originalTitle || b.title) + " " + b.author).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 120);
// Nos rankings o título vem em inglês com `titlePt` ao lado; na estante e nas recomendações já vem traduzido
const titleOf = (b) => b.titlePt || b.title;
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const SPINE = ["#7a2e2a", "#1f2a4a", "#2f4a3a", "#a8742a", "#4a5466", "#5a3550", "#2d5b63", "#8c4a2f", "#3a3a32", "#6b5a2a"];
const colorOf = (b) => SPINE[hash(bookId(b)) % SPINE.length];
const STATUS = { quero: "Quero ler", lendo: "Lendo", lido: "Lido" };
const NEXT = { quero: "lendo", lendo: "lido", lido: "quero" };
const statusOf = (b) => b.status || "lido"; // livros antigos não têm status

let user = null;
let shelf = [];
let pending = null; // ação de quem clicou antes de entrar, repetida depois do login
let unsub = null, pUnsub = null, fUnsub = null, rUnsub = null, cUnsub = null;

// ======================= navegação =======================
const TABS = ["recomendar", "estante", "mais-lidos", "leitores"];
function showTab(name, keep) {
  for (const s of TABS) $(s).hidden = s !== name;
  document.querySelectorAll("nav button[data-tab]").forEach((b) =>
    b.dataset.tab === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  // uma entrada de histórico por tela: o botão voltar do navegador volta à tela anterior
  if (location.hash !== "#" + name) history[keep ? "replaceState" : "pushState"](null, "", "#" + name);
  if (name === "mais-lidos") loadTop();
  if (name === "estante") renderShelf();
  if (name === "leitores") { readersCache = null; renderReaders(); }
  if (!keep) scrollTo(0, 0);
}
const tabFromHash = () => {
  const h = location.hash.slice(1);
  if (h === "top") return "mais-lidos"; // endereço antigo
  return TABS.includes(h) ? h : "recomendar";
};
document.querySelectorAll("nav button[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
$("logo").onclick = () => showTab("recomendar");
addEventListener("popstate", () => showTab(tabFromHash(), true));

// ======================= conta =======================
function openAuth() {
  $("auth-err").textContent = "";
  $("auth-err").classList.remove("ok");
  $("auth-dlg").showModal();
  $("email").focus();
}
// Guarda a ação de quem ainda não entrou (pedir recomendação, salvar livro) e a repete depois do login
function requireLogin(fn) {
  if (user) return true;
  pending = fn;
  openAuth();
  return false;
}
const AUTH_ERR = {
  "auth/invalid-credential": "E-mail ou senha incorretos.",
  "auth/email-already-in-use": "Já existe uma conta com esse e-mail. Use Entrar.",
  "auth/weak-password": "A senha precisa ter pelo menos 6 caracteres.",
  "auth/invalid-email": "Esse e-mail não parece válido.",
  "auth/too-many-requests": "Muitas tentativas. Espere um pouco e tente de novo.",
};
async function doAuth(fn) {
  const err = $("auth-err");
  err.classList.remove("ok");
  err.textContent = "";
  try {
    await fn(auth, $("email").value, $("pass").value);
    $("auth-dlg").close();
    $("auth-form").reset();
  } catch (e) {
    err.textContent = AUTH_ERR[e.code] || "Não foi possível entrar. Tente de novo.";
  }
}
$("auth-form").onsubmit = (e) => { e.preventDefault(); doAuth(signInWithEmailAndPassword); };
$("auth-signup").onclick = () => {
  if (!$("auth-form").reportValidity()) return;
  doAuth(createUserWithEmailAndPassword);
};
$("auth-close").onclick = () => { pending = null; $("auth-dlg").close(); };
$("auth-reset").onclick = async () => {
  const err = $("auth-err");
  err.classList.remove("ok");
  if (!$("email").value.trim()) { err.textContent = "Digite seu e-mail acima e toque em Esqueci a senha."; return; }
  try { await sendPasswordResetEmail(auth, $("email").value.trim()); } catch (e) { if (e.code === "auth/invalid-email") { err.textContent = AUTH_ERR[e.code]; return; } }
  err.classList.add("ok"); // mesma resposta exista a conta ou não
  err.textContent = "Se existir uma conta com esse e-mail, enviamos um link para redefinir a senha.";
};
// Ligue depois de ativar o Google em Authentication > Sign-in method no console do Firebase
const GOOGLE_LOGIN = true;
$("google-btn").hidden = !GOOGLE_LOGIN;
$("google-btn").onclick = async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
    $("auth-dlg").close();
  } catch (e) {
    if (e.code !== "auth/popup-closed-by-user") $("auth-err").textContent = "Não foi possível entrar com o Google. Tente de novo.";
  }
};
// Clicar fora de um modal fecha
for (const d of document.querySelectorAll("dialog")) {
  d.onclick = (e) => { if (e.target === d) { pending = null; d.close(); } };
}

$("account").onclick = () => {
  if (!user) { pending = null; return openAuth(); }
  $("p-name").value = myProfile?.name ?? user.displayName ?? "";
  $("p-public").checked = !!myProfile?.shelfPublic;
  $("p-msg").textContent = "";
  $("p-msg").classList.remove("ok");
  $("profile-dlg").showModal();
};
$("profile-close").onclick = () => $("profile-dlg").close();
$("signout").onclick = () => { $("profile-dlg").close(); signOut(auth); };
$("profile-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("p-name").value.trim();
  const pub = $("p-public").checked;
  const msg = $("p-msg");
  msg.classList.remove("ok");
  if (pub && !name) { msg.textContent = "Escreva um nome para tornar sua estante pública."; return; }
  try {
    await setDoc(doc(db, "profiles", user.uid), { name, shelfPublic: pub });
    if (name && name !== user.displayName) await updateProfile(user, { displayName: name });
    msg.classList.add("ok");
    msg.textContent = "Perfil salvo.";
    setTimeout(() => $("profile-dlg").close(), 1200);
  } catch {
    msg.textContent = "Não foi possível salvar. Tente de novo.";
  }
};

onAuthStateChanged(auth, (u) => {
  user = u;
  [unsub, pUnsub, fUnsub, rUnsub, cUnsub].forEach((f) => f?.());
  unsub = pUnsub = fUnsub = rUnsub = cUnsub = null;
  shelf = [];
  myProfile = null;
  following = new Set();
  readersCache = null;
  readerView = null;
  openC = null;
  if (u) {
    unsub = onSnapshot(collection(db, "users", u.uid, "books"), (snap) => {
      shelf = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.addedAt?.seconds ?? 1e12) - (b.addedAt?.seconds ?? 1e12));
      renderShelf();
      renderRec();
      renderTop();
    });
    pUnsub = onSnapshot(doc(db, "profiles", u.uid), (d) => {
      myProfile = d.data() ?? null;
      setAccountName();
      if (!$("leitores").hidden && !readerView) renderReaders();
    });
    fUnsub = onSnapshot(collection(db, "users", u.uid, "following"), (snap) => {
      following = new Set(snap.docs.map((d) => d.id));
      if (!$("leitores").hidden) renderReaders();
    });
  }
  setAccountName();
  charsFoot();
  renderShelf();
  renderRec();
  renderTop();
  renderReaders();
  if (u && pending) { const p = pending; pending = null; p(); }
});
const setAccountName = () => {
  $("account").textContent = user ? (myProfile?.name || user.displayName || "Minha conta") : "Entrar";
};

// ======================= capas e lombadas =======================
// Sem capa no Open Library (web novels, edições raras): bloco na cor da lombada, com título e autor
const coverBlock = (b) => safeUrl(b.cover)
  ? `<img class="cover-block" src="${safeUrl(b.cover)}" alt="Capa de ${esc(titleOf(b))}" loading="lazy">`
  : `<div class="cover-block ph" style="background:${colorOf(b)}" role="img"
       aria-label="Sem capa: ${esc(titleOf(b))}, de ${esc(b.author)}"><b>${esc(titleOf(b))}</b><span>${esc(b.author)}</span></div>`;

// Uma lombada. `opts`: n (número do ranking), sel, mark ("saved"|"reading"), status, base/varia a altura.
function spineHtml(b, i, o = {}) {
  const h = hash(bookId(b));
  const w = 50 + (h % 17);
  const base = o.base ?? 300;
  const height = base + (h % 45) + (o.sel ? 24 : 0);
  const mark = o.mark ? `<span class="mark ${o.mark}"></span>` : "";
  return `<button class="spine" data-i="${i}" ${o.status ? `data-status="${o.status}"` : ""}
    aria-pressed="${!!o.sel}" title="${esc(titleOf(b))}"
    style="flex:${w} 0 ${w}px;height:${height}px;background:${o.color ?? colorOf(b)}">
    ${o.n ? `<span class="n">${o.n}</span>` : ""}<span class="t">${esc(titleOf(b))}</span>${mark}</button>`;
}

// Capa pequena do ranking: sem imagem, vira um bloco na cor da lombada
const rankCover = (b) => safeUrl(b.cover)
  ? `<img class="rank-cover" src="${safeUrl(b.cover)}" alt="Capa de ${esc(titleOf(b))}" loading="lazy">`
  : `<span class="rank-cover ph" style="background:${colorOf(b)}" role="img" aria-label="Sem capa de ${esc(titleOf(b))}"></span>`;

// Links de compra: busca pelo título em português quando conhecido
function storeLinks(b, cls = "") {
  const q = encodeURIComponent(`${titleOf(b)} ${b.author}`);
  return `<a class="${cls}" href="https://www.amazon.com.br/s?k=${q}&i=stripbooks" target="_blank" rel="noopener">Amazon →</a>
    <a class="${cls}" href="https://www.estantevirtual.com.br/busca?q=${q}" target="_blank" rel="noopener">Estante Virtual →</a>`;
}

// ======================= Recomendar =======================
const CHARS = [
  ["Gênero", ["Fantasia", "Ficção científica", "Romance", "Suspense", "Terror", "Lit. brasileira", "Não ficção"]],
  ["Clima", ["Leve", "Sombrio", "Emocionante", "Engraçado", "Reflexivo"]],
  ["Tamanho", ["Curto", "Médio", "Longo", "Série"]],
  ["Formato", ["Livro", "Web novel"]],
];
$("chars-groups").innerHTML = CHARS.map(([g, opts]) => `<div class="chars-row">
  <span class="lbl">${esc(g)}</span>
  <div class="chars-opts">${opts.map((o) => `<label class="opt">
    <input type="checkbox" value="${esc(g)}: ${esc(o)}"><span class="box"></span><span>${esc(o)}</span></label>`).join("")}</div>
</div>`).join("");

const checked = () => [...document.querySelectorAll("#chars-groups input:checked")];
const charsFoot = () => {
  $("chars-foot").textContent = user
    ? "A IA lê só o seu pedido, nunca seu e-mail ou nome."
    : "Entre na sua conta para pedir.";
};
function syncClear() {
  const n = checked().length;
  $("chars-clear").hidden = !n;
  $("chars-clear").textContent = `Limpar (${n})`;
}
$("chars").onchange = syncClear;
$("chars-clear").onclick = () => { checked().forEach((i) => (i.checked = false)); syncClear(); };
$("chars").onsubmit = (e) => e.preventDefault();

let lastRecs = [];
let recIdx = 0;
let phase = "idle"; // idle | loading | results | fail
let failMsg = "";
let openRec = false; // comentários abertos no livro em foco
const commentCounts = {};

function renderRec() {
  const box = $("rec-state");
  if (phase === "idle") { box.innerHTML = ""; return; }
  if (phase === "loading") { box.innerHTML = `<p class="loading">Procurando nas prateleiras…</p>`; return; }
  if (phase === "fail") { box.innerHTML = `<p class="fail">${esc(failMsg)}</p>`; return; }
  if (!lastRecs.length) { box.innerHTML = `<p class="fail">Nenhuma sugestão desta vez. Tente outras características.</p>`; return; }

  const have = new Set(shelf.map((b) => b.id));
  const b = lastRecs[recIdx];
  const id = bookId(b);
  const saved = have.has(id);
  const n = commentCounts[id];
  box.innerHTML = `<div class="res">
    <div class="res-head">
      <h2>Sua prateleira</h2>
      <div class="res-head-r"><span>Clique numa lombada</span><button id="again">Pedir outras dez</button></div>
    </div>
    <div class="shelf-row" id="rec-shelf">${lastRecs.map((x, i) =>
      spineHtml(x, i, { n: i + 1, sel: i === recIdx, color: SPINE[i % SPINE.length], mark: have.has(bookId(x)) ? "saved" : "" })).join("")}</div>
    <div class="detail">
      <div class="detail-l"><span class="d-rank">${recIdx + 1}</span>${coverBlock(b)}</div>
      <div class="detail-r">
        <p class="meta">Livro · ${esc(b.author)}</p>
        <h3 class="d-title">${esc(titleOf(b))}</h3>
        <p class="d-syn">${esc(b.why)}</p>
        <div class="acts">
          <button class="btn-mini ${saved ? "on" : ""}" id="rec-save" ${saved ? "disabled" : ""}>${saved ? "✓ Na estante" : "+ Quero ler"}</button>
          <div class="store">
            ${b.verified && safeUrl(b.link) ? `<a href="${safeUrl(b.link)}" target="_blank" rel="noopener">Open Library →</a>` : ""}
            ${storeLinks(b)}
          </div>
        </div>
        ${b.verified ? "" : `<p class="said small">Não encontrado no Open Library: web novels e edições raras costumam ficar de fora.</p>`}
        ${n ? `<button class="c-link" id="rec-c">${openRec ? "Ocultar comentários" : `${n} ${n === 1 ? "comentário" : "comentários"}`}</button>` : ""}
        ${openRec ? `<div class="cpanel" id="rec-cpanel"><p class="said small">Carregando comentários…</p></div>` : ""}
        <div class="pager">
          <button id="rec-prev">← Anterior</button>
          <button id="rec-next">Próximo →</button>
        </div>
      </div>
    </div>
  </div>`;

  $("again").onclick = () => recommend(lastUseShelf);
  $("rec-shelf").onclick = (e) => {
    const s = e.target.closest(".spine");
    if (!s) return;
    recIdx = Number(s.dataset.i);
    openRec = false;
    renderRec();
  };
  if (!saved) $("rec-save").onclick = () => addBook(b);
  $("rec-prev").onclick = () => { recIdx = (recIdx + lastRecs.length - 1) % lastRecs.length; openRec = false; renderRec(); };
  $("rec-next").onclick = () => { recIdx = (recIdx + 1) % lastRecs.length; openRec = false; renderRec(); };
  if ($("rec-c")) $("rec-c").onclick = () => { openRec = !openRec; renderRec(); };

  cUnsub?.(); cUnsub = null;
  if (openRec) watchComments(id, $("rec-cpanel"), false);
  if (user) countComments(id);
}

// Conta os comentários do livro em foco: a regra só deixa comentar quem tem o livro na estante,
// então aqui o painel é de leitura e o link só aparece quando já existe comentário.
async function countComments(id) {
  if (commentCounts[id] !== undefined) return;
  try {
    commentCounts[id] = (await getCountFromServer(collection(db, "books", id, "comments"))).data().count;
    if (commentCounts[id] && phase === "results" && bookId(lastRecs[recIdx]) === id) renderRec();
  } catch {}
}

let lastUseShelf = false;
async function recommend(useShelf) {
  if (!requireLogin(() => recommend(useShelf))) return;
  const tags = checked().map((i) => i.value);
  const text = $("text").value.trim();
  if (!useShelf && !text && !tags.length) {
    phase = "fail";
    failMsg = "Escreva o que procura ou escolha uma característica.";
    return renderRec();
  }
  lastUseShelf = useShelf;
  phase = "loading";
  openRec = false;
  recIdx = 0;
  renderRec();
  $("go").disabled = $("go-shelf").disabled = true;
  $("go").textContent = "Procurando…";
  if (useShelf) showTab("recomendar");
  try {
    const body = { text, tags, idToken: await user.getIdToken(), exclude: shelf.map((b) => b.title) };
    if (useShelf) body.shelf = shelf.slice(-40).map(({ title, author, status, rating }) => ({ title, author, status: status || "lido", rating: rating || 0 }));
    const r = await fetch("/api/recommend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    lastRecs = data;
    phase = "results";
  } catch (e) {
    phase = "fail";
    failMsg = e.message || "Não foi possível pedir agora. Tente de novo.";
  } finally {
    $("go").disabled = $("go-shelf").disabled = false;
    $("go").textContent = "Recomendar →";
    renderRec();
  }
}
$("go").onclick = () => recommend(false);
$("go-shelf").onclick = () => recommend(true);

async function addBook(b, status = "quero") {
  if (!requireLogin(() => addBook(b, status))) return;
  await setDoc(doc(db, "users", user.uid, "books", bookId(b)), {
    title: titleOf(b), originalTitle: b.originalTitle || (b.titlePt ? b.title : ""),
    author: b.author, cover: b.cover || "", link: b.link || "",
    status, rating: 0, addedAt: serverTimestamp(),
  });
}

// ======================= Minha estante =======================
let filter = "todos";
let openC = null; // id do livro com o painel de comentários aberto

const ratingHtml = (r, editable) => `<div class="rating" role="group" aria-label="${editable ? "Sua nota" : `Nota ${r || 0} de 5`}">${
  [1, 2, 3, 4, 5].map((n) => `<button class="${n <= (r || 0) ? "on" : ""}" ${editable ? `data-r="${n}"` : "disabled"}
    aria-pressed="${n <= (r || 0)}" aria-label="${n} de 5"></button>`).join("")}</div>`;

function rowHtml(b, mine) {
  const st = statusOf(b);
  const n = commentCounts[b.id];
  return `<div class="row" data-id="${esc(b.id)}">
    <div class="row-id">
      <span class="row-bar" style="background:${colorOf(b)}"></span>
      <div><h3 class="row-title">${esc(b.title)}</h3><div class="row-author">${esc(b.author)}</div></div>
    </div>
    <div class="row-acts">
      <button class="status-btn" data-s="${st}" ${mine ? "" : "disabled"}
        ${mine ? `aria-label="Status: ${STATUS[st]}. Mudar para ${STATUS[NEXT[st]]}"` : ""}>${STATUS[st]}</button>
      ${ratingHtml(b.rating, mine)}
      <button class="c-link" data-c>${openC === b.id ? "Fechar" : n ? `${n} ${n === 1 ? "comentário" : "comentários"}` : mine ? "Comentar" : "Comentários"}</button>
    </div>
    ${openC === b.id ? cpanelHtml(b, mine) : ""}
  </div>`;
}

function cpanelHtml(b, mine) {
  return `<div class="cpanel">
    <div class="store">
      ${safeUrl(b.link) ? `<a href="${safeUrl(b.link)}" target="_blank" rel="noopener">Open Library →</a>` : ""}
      ${storeLinks(b)}
    </div>
    ${mine ? `${user.displayName ? "" : `<input class="c-name" maxlength="40" placeholder="Seu nome" aria-label="Seu nome">`}
      <textarea class="c-text" maxlength="500" placeholder="O que você achou deste livro?" aria-label="Seu comentário"></textarea>
      <div class="crow">
        <button class="btn-mini c-save">Publicar</button>
        <button class="c-link c-del" hidden>Excluir meu comentário</button>
        <button class="c-link c-remove">Remover da estante</button>
        <span class="err c-err" role="alert"></span>
      </div>` : ""}
    <div class="c-list"><p class="said small">Carregando comentários…</p></div>
  </div>`;
}

function renderShelf() {
  if ($("estante").hidden) return; // não mexe nos comentários abertos em outra tela
  const area = $("shelf-area");
  $("go-shelf").hidden = !(user && shelf.length);
  if (!user) {
    cUnsub?.(); cUnsub = null;
    $("shelf-sum").textContent = "";
    area.innerHTML = `<p class="empty">Entre para montar sua estante e guardar os livros que você já leu.</p>`;
    return;
  }
  const by = (k) => shelf.filter((b) => statusOf(b) === k).length;
  $("shelf-sum").textContent = shelf.length
    ? `${by("lido")} ${by("lido") === 1 ? "lido" : "lidos"}, ${by("lendo")} lendo e ${by("quero")} na fila.`
    : "";
  if (!shelf.length) {
    cUnsub?.(); cUnsub = null;
    area.innerHTML = `<p class="empty">Sua estante está vazia. Peça uma recomendação, ou veja os mais lidos, e use “+ Quero ler”.</p>`;
    return;
  }
  const draft = area.querySelector(".c-text")?.value;
  const shown = shelf.filter((b) => filter === "todos" || statusOf(b) === filter);
  area.innerHTML = `
    <div class="shelf-row mini">${shelf.map((b, i) => spineHtml(b, i, {
      base: 170, status: statusOf(b), mark: statusOf(b) === "lendo" ? "reading" : "",
    })).join("")}</div>
    <div class="tabs">${["todos", "quero", "lendo", "lido"].map((k) =>
      `<button data-f="${k}" aria-pressed="${filter === k}">${k === "todos" ? "Todos" : STATUS[k]} (${k === "todos" ? shelf.length : by(k)})</button>`).join("")}</div>
    <div class="rows">${shown.length
      ? shown.map((b) => rowHtml(b, true)).join("")
      : `<p class="empty" style="padding:28px 0">Nenhum livro com esse status.</p>`}</div>`;

  area.querySelector(".shelf-row").onclick = (e) => {
    const s = e.target.closest(".spine");
    if (!s) return;
    const b = shelf[Number(s.dataset.i)];
    filter = "todos";
    openC = openC === b.id ? null : b.id;
    renderShelf();
    area.querySelector(`.row[data-id="${CSS.escape(b.id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  area.querySelectorAll("[data-f]").forEach((t) => (t.onclick = () => { filter = t.dataset.f; renderShelf(); }));
  wireRows(area, shelf, true);
  if (draft && area.querySelector(".c-text")) area.querySelector(".c-text").value = draft;
  shown.slice(0, 20).forEach((b) => countRowComments(b.id));
}

// Liga os controles das linhas (status, nota, comentários) da minha estante ou da de outro leitor
function wireRows(area, books, mine) {
  const find = (el) => books.find((b) => b.id === el.closest(".row").dataset.id);
  area.querySelectorAll(".row .status-btn").forEach((btn) => {
    if (!mine) return;
    btn.onclick = () => {
      const b = find(btn);
      updateDoc(doc(db, "users", user.uid, "books", b.id), { status: NEXT[statusOf(b)] });
    };
  });
  area.querySelectorAll(".row [data-r]").forEach((btn) => {
    if (!mine) return;
    btn.onclick = () => {
      const b = find(btn);
      const n = Number(btn.dataset.r);
      updateDoc(doc(db, "users", user.uid, "books", b.id), { rating: n === (b.rating || 0) ? 0 : n }); // clicar na mesma nota limpa
    };
  });
  area.querySelectorAll(".row [data-c]").forEach((btn) => (btn.onclick = () => {
    const b = find(btn);
    openC = openC === b.id ? null : b.id;
    mine ? renderShelf() : renderReaders();
  }));
  const panel = area.querySelector(".cpanel");
  if (!panel) { cUnsub?.(); cUnsub = null; return; }
  const b = books.find((x) => x.id === openC);
  if (!b) return;
  if (mine) {
    panel.querySelector(".c-save").onclick = () => saveComment(panel, b);
    panel.querySelector(".c-del").onclick = () => deleteDoc(doc(db, "books", b.id, "comments", user.uid));
    panel.querySelector(".c-remove").onclick = async () => { openC = null; await deleteDoc(doc(db, "users", user.uid, "books", b.id)); };
  }
  watchComments(b.id, panel.querySelector(".c-list"), mine, panel);
}

// ======================= comentários =======================
let myComment = null;

function commentsHtml(list) {
  const n = (c) => new Set(c.likes).size;
  list.sort((a, b) => n(b) - n(a) || (a.createdAt?.seconds ?? 1e12) - (b.createdAt?.seconds ?? 1e12));
  return list.length ? list.map((c) => {
    const liked = user ? c.likes.includes(user.uid) : false;
    return `<div class="c"><b>${esc(c.name)}</b><p>${esc(c.text)}</p>
      <button class="like" data-uid="${esc(c.uid)}" aria-pressed="${liked}"
        aria-label="${liked ? "Descurtir" : "Curtir"} comentário de ${esc(c.name)}">♥ ${n(c)}</button></div>`;
  }).join("") : `<p class="said small">Ninguém comentou este livro ainda.</p>`;
}

function watchComments(id, box, mine, panel) {
  if (!box) return;
  cUnsub?.();
  cUnsub = onSnapshot(collection(db, "books", id, "comments"), (snap) => {
    const list = snap.docs.map((d) => d.data());
    commentCounts[id] = list.length;
    if (mine && panel) {
      myComment = list.find((c) => c.uid === user.uid) || null;
      const t = panel.querySelector(".c-text");
      if (myComment && !t.value) t.value = myComment.text;
      panel.querySelector(".c-save").textContent = myComment ? "Atualizar" : "Publicar";
      panel.querySelector(".c-del").hidden = !myComment;
    }
    box.innerHTML = commentsHtml(list);
    box.onclick = (e) => {
      const btn = e.target.closest(".like");
      if (!btn || !user) return;
      updateDoc(doc(db, "books", id, "comments", btn.dataset.uid),
        { likes: btn.getAttribute("aria-pressed") === "true" ? arrayRemove(user.uid) : arrayUnion(user.uid) });
    };
  }, () => { box.innerHTML = `<p class="said small">Não foi possível carregar os comentários.</p>`; });
}

async function saveComment(panel, b) {
  const text = panel.querySelector(".c-text").value.trim();
  const name = user.displayName || panel.querySelector(".c-name")?.value.trim();
  const err = panel.querySelector(".c-err");
  err.textContent = "";
  if (!text) { err.textContent = "Escreva um comentário antes de publicar."; return; }
  if (!name) { err.textContent = "Diga seu nome para aparecer nos comentários."; return; }
  try {
    if (!user.displayName) await updateProfile(user, { displayName: name });
    const ref = doc(db, "books", b.id, "comments", user.uid);
    if (myComment) await updateDoc(ref, { text, name });
    else await setDoc(ref, { uid: user.uid, name, text, likes: [], createdAt: serverTimestamp() });
  } catch {
    err.textContent = "Não foi possível publicar. Tente de novo.";
  }
}

// Conta os comentários das linhas visíveis, no máximo 20 por abertura da tela
async function countRowComments(id) {
  if (commentCounts[id] !== undefined) return;
  try {
    commentCounts[id] = (await getCountFromServer(collection(db, "books", id, "comments"))).data().count;
    if (!commentCounts[id]) return;
    const row = document.querySelector(`.row[data-id="${CSS.escape(id)}"] [data-c]`);
    if (row && row.textContent === "Comentar") row.textContent = `${commentCounts[id]} ${commentCounts[id] === 1 ? "comentário" : "comentários"}`;
  } catch {}
}

// ======================= Mais lidos =======================
let topData = null, nytData = null, topLoading = false;
let src = "nyt";
const listIdx = { nyt: 0, ol: 0 };
let updatedNote = "";

async function loadTop() {
  if (topData || topLoading) return;
  topLoading = true;
  $("top-area").innerHTML = `<p class="loading" style="margin-top:0;padding:80px 0">Carregando os rankings…</p>`;
  try {
    const d = (await getDoc(doc(db, "public", "bestsellers"))).data();
    nytData = d?.lists ?? [];
    topData = d?.genres ?? [];
    const at = d?.updatedAt?.toDate();
    const stale = at && Date.now() - at > 3 * 864e5;
    updatedNote = at ? `${stale ? "Pode estar desatualizado. " : ""}Atualizado em ${at.toLocaleDateString("pt-BR")}` : "";
  } catch {
    nytData = [];
    topData = [];
  }
  topLoading = false;
  renderTop();
}

function renderTop() {
  if (!topData) return;
  const lists = src === "nyt" ? nytData : topData;
  document.querySelectorAll("#src-seg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.src === src));
  if (!lists.length) {
    $("top-tabs").innerHTML = "";
    $("top-area").innerHTML = `<p class="empty">Não foi possível carregar os rankings. Recarregue a página.</p>`;
    $("top-note").textContent = "";
    return;
  }
  const li = Math.min(listIdx[src], lists.length - 1);
  const have = new Set(shelf.map((b) => b.id));
  $("top-tabs").innerHTML = lists.map((l, i) =>
    `<button data-t="${i}" aria-pressed="${i === li}">${esc(l.name)}</button>`).join("");
  $("top-area").innerHTML = `<ol class="rank-list">${lists[li].books.map((b, i) => {
    const saved = have.has(bookId(b));
    return `<li class="rank-item">
      <span class="rank-n">${i + 1}</span>
      ${rankCover(b)}
      <div>
        <h3 class="rank-title">${esc(titleOf(b))}</h3>
        <p class="rank-meta">${esc(b.author)}${b.weeks > 1 ? ` · ${b.weeks} semanas na lista` : ""}${b.titlePt ? ` · ${esc(b.title)}` : ""}</p>
      </div>
      <button class="btn-mini ${saved ? "on" : ""}" data-i="${i}" ${saved ? "disabled" : ""}>${saved ? "✓ Na estante" : "+ Quero ler"}</button>
      <p class="rank-buy">${storeLinks(b)}</p>
    </li>`;
  }).join("")}</ol>`;
  $("top-note").textContent = src === "nyt"
    ? `Listas da semana nos EUA, do New York Times${updatedNote ? " · " + updatedNote : ""}`
    : `Open Library, por quantas pessoas guardaram o livro${updatedNote ? " · " + updatedNote : ""}`;
  $("top-area").onclick = (e) => {
    const btn = e.target.closest("[data-i]");
    if (btn) addBook(lists[li].books[Number(btn.dataset.i)]);
  };
  $("top-tabs").onclick = (e) => {
    const t = e.target.closest("[data-t]");
    if (t) { listIdx[src] = Number(t.dataset.t); renderTop(); }
  };
}
$("src-seg").onclick = (e) => {
  const b = e.target.closest("[data-src]");
  if (b) { src = b.dataset.src; renderTop(); }
};

// ======================= Leitores =======================
let myProfile = null;
let following = new Set();
let readersCache = null;
let readersTab = "todos";
let readerView = null; // leitor aberto
let readerBooks = [];
const readerInfo = {}; // uid -> { count, books }

function renderReaders() {
  if ($("leitores").hidden) return;
  const area = $("readers-area");
  if (!user) {
    area.innerHTML = `<p class="empty">Entre para ver outros leitores e as estantes públicas deles.</p>`;
    return;
  }
  if (readerView) return renderReader(area);
  area.innerHTML = `
    ${myProfile?.shelfPublic ? "" : `<p class="said" style="margin-top:20px">Sua estante está privada: você vê os outros, mas ninguém vê a sua. Mude isso em <b>${esc(myProfile?.name || user.displayName || "Minha conta")}</b>, no topo.</p>`}
    <div class="tabs">${["todos", "seguindo"].map((k) =>
      `<button data-rt="${k}" aria-pressed="${readersTab === k}">${k === "todos" ? "Todos" : "Seguindo"}</button>`).join("")}</div>
    <div id="readers-list"><p class="loading" style="margin-top:0;padding:60px 0">Carregando leitores…</p></div>`;
  area.querySelectorAll("[data-rt]").forEach((t) => (t.onclick = () => { readersTab = t.dataset.rt; renderReaders(); }));
  loadReadersList();
}

async function loadReadersList() {
  const box = $("readers-list");
  try {
    readersCache ??= (await getDocs(query(collection(db, "profiles"), where("shelfPublic", "==", true), limit(100))))
      .docs.map((d) => ({ uid: d.id, ...d.data() })).filter((r) => r.uid !== user.uid);
  } catch {
    box.innerHTML = `<p class="empty">Não foi possível carregar os leitores. Recarregue a página.</p>`;
    return;
  }
  const list = readersCache.filter((r) => readersTab === "todos" || following.has(r.uid));
  if (!list.length) {
    box.innerHTML = `<p class="empty" style="padding:28px 0">${readersTab === "seguindo"
      ? "Você ainda não segue ninguém." : "Ainda não há outros leitores com estante pública."}</p>`;
    $("activity")?.remove();
    return;
  }
  box.innerHTML = `<div class="readers">${list.map((r) => {
    const info = readerInfo[r.uid];
    const now = info?.books.find((b) => statusOf(b) === "lendo");
    return `<div class="reader-card" data-uid="${esc(r.uid)}">
      <div class="mini-shelf">${(info?.books ?? []).slice(0, 12).map((b) => {
        const h = hash(bookId(b));
        return `<i style="width:${7 + (h % 7)}px;height:${44 + (h % 28)}px;background:${colorOf(b)}"></i>`;
      }).join("")}</div>
      <button class="reader-name" data-view>${esc(r.name)}</button>
      <p class="reader-meta">${info ? `${info.count} ${info.count === 1 ? "livro" : "livros"}` : "…"}</p>
      ${now ? `<p class="reader-now">Lendo agora: ${esc(now.title)}</p>` : ""}
      <button class="btn-mini ${following.has(r.uid) ? "on" : ""}" data-follow>${following.has(r.uid) ? "Seguindo" : "Seguir"}</button>
    </div>`;
  }).join("")}</div>`;
  box.onclick = (e) => {
    const card = e.target.closest("[data-uid]");
    if (!card) return;
    const r = readersCache.find((x) => x.uid === card.dataset.uid);
    if (e.target.closest("[data-follow]")) return toggleFollow(r.uid);
    if (e.target.closest("[data-view]")) return openReader(r);
  };
  list.forEach((r) => loadReaderInfo(r.uid));
  if (readersTab === "seguindo") loadActivity(list); else $("activity")?.remove();
}

// Capa da estante de cada leitor: contagem, cores das lombadas e o que está lendo agora.
// Pinta o cartão já desenhado em vez de redesenhar a lista a cada leitor que chega.
async function loadReaderInfo(uid) {
  if (readerInfo[uid]) return paintReaderCard(uid);
  try {
    const [count, snap] = await Promise.all([
      getCountFromServer(collection(db, "users", uid, "books")),
      getDocs(query(collection(db, "users", uid, "books"), orderBy("addedAt", "desc"), limit(12))),
    ]);
    readerInfo[uid] = { count: count.data().count, books: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
    paintReaderCard(uid);
  } catch {}
}

function paintReaderCard(uid) {
  const card = document.querySelector(`.reader-card[data-uid="${CSS.escape(uid)}"]`);
  const info = readerInfo[uid];
  if (!card || !info) return;
  card.querySelector(".mini-shelf").innerHTML = info.books.slice(0, 12).map((b) => {
    const h = hash(bookId(b));
    return `<i style="width:${7 + (h % 7)}px;height:${44 + (h % 28)}px;background:${colorOf(b)}"></i>`;
  }).join("");
  card.querySelector(".reader-meta").textContent = `${info.count} ${info.count === 1 ? "livro" : "livros"}`;
  const now = info.books.find((b) => statusOf(b) === "lendo");
  const line = card.querySelector(".reader-now");
  if (now && !line) card.querySelector(".reader-meta").insertAdjacentHTML("afterend", `<p class="reader-now">Lendo agora: ${esc(now.title)}</p>`);
  else if (now) line.textContent = `Lendo agora: ${now.title}`;
  else line?.remove();
}

// Últimos livros adicionados por quem você segue (só estantes públicas respondem)
async function loadActivity(list) {
  const rows = (await Promise.all(list.slice(0, 15).map(async (r) => {
    try {
      const snap = await getDocs(query(collection(db, "users", r.uid, "books"), orderBy("addedAt", "desc"), limit(3)));
      return snap.docs.map((d) => ({ name: r.name, ...d.data() }));
    } catch { return []; }
  }))).flat().sort((a, b) => (b.addedAt?.seconds ?? 0) - (a.addedAt?.seconds ?? 0)).slice(0, 10);
  if (readersTab !== "seguindo" || !$("readers-list")) return;
  $("activity")?.remove();
  $("readers-list").insertAdjacentHTML("afterend", `<div class="activity" id="activity">
    <h2>Atividade recente</h2>
    ${rows.length ? `<ul>${rows.map((a) => `<li><b>${esc(a.name)}</b> guardou <em>${esc(a.title)}</em> — ${STATUS[a.status || "lido"]}</li>`).join("")}</ul>`
      : `<p class="empty">Ninguém que você segue guardou livros ainda.</p>`}</div>`);
}

const toggleFollow = (uid) => following.has(uid)
  ? deleteDoc(doc(db, "users", user.uid, "following", uid))
  : setDoc(doc(db, "users", user.uid, "following", uid), { at: serverTimestamp() });

function openReader(r) {
  rUnsub?.();
  readerView = r;
  readerBooks = [];
  openC = null;
  rUnsub = onSnapshot(collection(db, "users", r.uid, "books"), (snap) => {
    readerBooks = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.addedAt?.seconds ?? 1e12) - (b.addedAt?.seconds ?? 1e12));
    renderReaders();
  }, () => { readerBooks = null; renderReaders(); }); // sem permissão: a pessoa fechou a estante
  renderReaders();
}

function renderReader(area) {
  const r = readerView;
  area.innerHTML = `
    <button class="back" id="r-back">← Todos os leitores</button>
    <div class="page-head" style="margin-top:20px">
      <div><h1 style="font-size:clamp(36px,5vw,56px)">${esc(r.name)}</h1></div>
      <button class="btn-mini ${following.has(r.uid) ? "on" : ""}" id="r-follow">${following.has(r.uid) ? "Seguindo" : "Seguir"}</button>
    </div>
    <div id="reader-shelf"></div>`;
  $("r-back").onclick = () => { rUnsub?.(); rUnsub = null; cUnsub?.(); cUnsub = null; readerView = null; openC = null; renderReaders(); };
  $("r-follow").onclick = () => toggleFollow(r.uid);
  const box = $("reader-shelf");
  if (readerBooks === null) { box.innerHTML = `<p class="empty">Esta estante não está mais pública.</p>`; return; }
  if (!readerBooks.length) { box.innerHTML = `<p class="empty">Esta estante ainda está vazia.</p>`; return; }
  box.innerHTML = `
    <div class="shelf-row mini">${readerBooks.map((b, i) => spineHtml(b, i, {
      base: 170, status: statusOf(b), mark: statusOf(b) === "lendo" ? "reading" : "",
    })).join("")}</div>
    <div class="rows">${readerBooks.map((b) => rowHtml(b, false)).join("")}</div>`;
  box.querySelector(".shelf-row").onclick = (e) => {
    const s = e.target.closest(".spine");
    if (!s) return;
    const b = readerBooks[Number(s.dataset.i)];
    openC = openC === b.id ? null : b.id;
    renderReaders();
  };
  wireRows(box, readerBooks, false);
}

// ======================= privacidade e exclusão de conta =======================
$("privacy-btn").onclick = () => {
  $("delete-box").hidden = !user;
  $("delete-confirm-box").hidden = true;
  $("delete-confirm").value = "";
  $("delete-btn").disabled = true;
  $("delete-err").textContent = "";
  $("privacy-dlg").showModal();
};
$("privacy-close").onclick = () => $("privacy-dlg").close();
$("delete-start").onclick = () => { $("delete-confirm-box").hidden = false; $("delete-confirm").focus(); };
$("delete-confirm").oninput = () => { $("delete-btn").disabled = $("delete-confirm").value.trim() !== "EXCLUIR"; };
$("delete-btn").onclick = async () => {
  $("delete-btn").disabled = true;
  try {
    const r = await fetch("/api/delete-account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: await user.getIdToken() }) });
    if (!r.ok) throw new Error((await r.json()).error);
    $("privacy-dlg").close();
    await signOut(auth);
    phase = "fail";
    failMsg = "Sua conta e seus dados foram excluídos.";
    renderRec();
    showTab("recomendar");
  } catch (e) {
    $("delete-err").textContent = e.message || "Não foi possível excluir agora. Tente de novo.";
    $("delete-btn").disabled = false;
  }
};

syncClear();
charsFoot();
showTab(tabFromHash(), true);

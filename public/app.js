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

let user = null;
let shelf = []; // livros da estante do usuário
let unsub = null;
let selected = null;
let lastRecs = [];
let cUnsub = null; // listener dos comentários do livro aberto
let myComment = null;
let pending = null; // ação de quem clicou antes de entrar, executada depois do login

// --- abas
const TABS = ["recomendar", "estante", "top", "leitores"];
function showTab(name, keep) {
  for (const s of TABS) $(s).hidden = s !== name;
  document.querySelectorAll("nav button").forEach((b) =>
    b.dataset.tab === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  // uma entrada de histórico por aba: o botão voltar do navegador volta à aba anterior
  if (location.hash !== "#" + name) history[keep ? "replaceState" : "pushState"](null, "", "#" + name);
  if (name === "top") loadTop();
  if (name === "estante") renderShelf();
  if (name === "leitores") { readersCache = null; renderReaders(); }
}
document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
const tabFromHash = () => (TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "recomendar");
addEventListener("popstate", () => showTab(tabFromHash(), true));

// --- login
let signingUp = false;
function authMode(up) {
  signingUp = up;
  $("auth-title").textContent = up ? "Criar conta" : "Entrar";
  $("auth-submit").textContent = up ? "Criar conta" : "Entrar";
  $("auth-switch").textContent = up ? "Já tenho conta" : "Criar conta";
  $("pass").autocomplete = up ? "new-password" : "current-password";
  $("auth-reset").hidden = up;
  $("auth-err").textContent = "";
  $("auth-err").classList.remove("ok");
}
function openAuth() { authMode(false); $("auth-dlg").showModal(); $("email").focus(); }
// Guarda a ação de quem ainda não entrou (pedir recomendação, adicionar livro) e a repete depois do login
function requireLogin(fn) {
  if (user) return true;
  pending = fn;
  openAuth();
  return false;
}
$("auth-btn").onclick = () => { if (user) return signOut(auth); pending = null; openAuth(); };
$("auth-switch").onclick = () => authMode(!signingUp);
$("auth-close").onclick = () => { pending = null; $("auth-dlg").close(); };
$("auth-reset").onclick = async () => {
  const err = $("auth-err");
  err.classList.remove("ok");
  if (!$("email").value.trim()) { err.textContent = "Digite seu e-mail acima e toque em Esqueci a senha."; return; }
  try { await sendPasswordResetEmail(auth, $("email").value.trim()); } catch (e) { if (e.code === "auth/invalid-email") { err.textContent = AUTH_ERR[e.code]; return; } }
  err.classList.add("ok"); // mesma resposta exista a conta ou não
  err.textContent = "Se existir uma conta com esse e-mail, enviamos um link para redefinir a senha.";
};
const AUTH_ERR = {
  "auth/invalid-credential": "E-mail ou senha incorretos.",
  "auth/email-already-in-use": "Já existe uma conta com esse e-mail. Use Entrar.",
  "auth/weak-password": "A senha precisa ter pelo menos 6 caracteres.",
  "auth/invalid-email": "Esse e-mail não parece válido.",
  "auth/too-many-requests": "Muitas tentativas. Espere um pouco e tente de novo.",
};
$("auth-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const fn = signingUp ? createUserWithEmailAndPassword : signInWithEmailAndPassword;
    await fn(auth, $("email").value, $("pass").value);
    $("auth-dlg").close();
    $("auth-form").reset();
  } catch (err) {
    $("auth-err").textContent = AUTH_ERR[err.code] || "Não foi possível entrar. Tente de novo.";
  }
};

let pUnsub = null;
let fUnsub = null;
// Ligue depois de ativar o Google em Authentication > Sign-in method no console do Firebase
const GOOGLE_LOGIN = true;
$("google-btn").hidden = $("auth-or").hidden = !GOOGLE_LOGIN;
$("google-btn").onclick = async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
    $("auth-dlg").close();
  } catch (err) {
    if (err.code !== "auth/popup-closed-by-user") $("auth-err").textContent = "Não foi possível entrar com o Google. Tente de novo.";
  }
};

onAuthStateChanged(auth, (u) => {
  user = u;
  $("auth-btn").textContent = u ? "Sair" : "Entrar";
  $("profile-btn").hidden = !u;
  [unsub, pUnsub, fUnsub, rUnsub].forEach((f) => f?.());
  shelf = [];
  selected = null;
  myProfile = null;
  following = new Set();
  readersCache = null;
  readerView = null;
  if (u) {
    unsub = onSnapshot(collection(db, "users", u.uid, "books"), (snap) => {
      shelf = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.addedAt?.seconds ?? 1e12) - (b.addedAt?.seconds ?? 1e12));
      syncShelfBtn();
      renderShelf();
      renderRecs();
      renderTop();
    });
    pUnsub = onSnapshot(doc(db, "profiles", u.uid), (d) => {
      myProfile = d.data() ?? null;
      if (!$("leitores").hidden && !readerView) renderReaders();
    });
    fUnsub = onSnapshot(collection(db, "users", u.uid, "following"), (snap) => {
      following = new Set(snap.docs.map((d) => d.id));
      if ($("leitores").hidden) return;
      if (readerView) renderReaders(); else if ($("readers-list")) loadReadersList();
    });
  }
  syncShelfBtn();
  renderShelf();
  renderRecs();
  renderTop();
  renderPreview();
  renderReaders();
  if (u && pending) { const p = pending; pending = null; p(); }
});

// --- estante
const COLORS = ["#8c3b3b", "#2f5d62", "#6b5b95", "#a87631", "#3d6b4f", "#a24f78"];
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
// Sem capa no Open Library (web novels, edições raras): capa gerada com o título, na cor da lombada
const coverHtml = (b) => safeUrl(b.cover)
  ? `<img class="cover" src="${safeUrl(b.cover)}" alt="Capa de ${esc(titleOf(b))}" loading="lazy">`
  : `<div class="cover ph" style="background:${COLORS[hash(bookId(b)) % COLORS.length]}" role="img"
       aria-label="Sem capa: ${esc(titleOf(b))}, de ${esc(b.author)}"><b>${esc(titleOf(b))}</b><span>${esc(b.author)}</span></div>`;

const STATUS = { lido: "Lido", lendo: "Lendo", quero: "Quero ler" };
const statusOf = (b) => b.status || "lido"; // livros antigos não têm status
let filter = "todos";

const stars = (rating, editable) => [1, 2, 3, 4, 5].map((n) =>
  `<button ${editable ? `data-r="${n}"` : "disabled"} aria-pressed="${n <= rating}" aria-label="${n} de 5">★</button>`).join("");

function shelfHtml(books, sel) {
  const count = (k) => books.filter((b) => k === "todos" || statusOf(b) === k).length;
  const chips = ["todos", "lido", "lendo", "quero"].map((k) =>
    `<button class="chip" data-f="${k}" aria-pressed="${filter === k}">${k === "todos" ? "Todos" : STATUS[k]} (${count(k)})</button>`).join("");
  const shown = books.filter((b) => filter === "todos" || statusOf(b) === filter);
  const spines = shown.map((b) => {
    const h = hash(b.id);
    return `<div class="shelf-item"><button class="spine" data-id="${esc(b.id)}" data-status="${statusOf(b)}" aria-expanded="${sel === b.id}"
      title="${esc(b.title)}" style="background:${COLORS[h % COLORS.length]};height:${150 + (h % 60)}px;width:${38 + (h % 14)}px">${esc(b.title)}</button></div>`;
  }).join("");
  return `<div class="filters">${chips}</div>${shown.length ? `<div class="shelf">${spines}</div>` : `<p class="empty" style="margin-top:24px">Nenhum livro com esse status.</p>`}<div class="detail" hidden></div>`;
}

function detailHtml(b, mine) {
  const status = statusOf(b);
  const controls = mine
    ? `<div class="seg" role="group" aria-label="Status">${Object.entries(STATUS).map(([k, v]) => `<button data-s="${k}" aria-pressed="${status === k}">${v}</button>`).join("")}</div>
       <div class="stars" role="group" aria-label="Sua nota">${stars(b.rating || 0, true)}</div>
       ${b.rating ? `<p class="hint">Toque na mesma estrela para limpar a nota.</p>` : ""}`
    : `<div class="note" style="margin:8px 0 0">${STATUS[status]}</div><div class="stars" role="img" aria-label="Nota ${b.rating || 0} de 5">${stars(b.rating || 0, false)}</div>`;
  return `${coverHtml(b)}
    <div><h3>${esc(b.title)}</h3><div class="by">${esc(b.author)}</div>
      ${controls}
      <p style="margin:12px 0;display:flex;gap:16px;align-items:center">
        ${safeUrl(b.link) ? `<a href="${safeUrl(b.link)}" target="_blank" rel="noopener">Ver livro</a>` : ""}
        ${mine ? `<button class="btn remove">Remover da estante</button>` : ""}</p></div>
    <div class="comments">
      <h4>Comentários</h4>
      ${mine ? `${user.displayName ? "" : `<input class="c-name" maxlength="40" placeholder="Seu nome" aria-label="Seu nome" style="margin-bottom:8px">`}
        <textarea class="c-text" maxlength="500" placeholder="O que você achou deste livro?" aria-label="Seu comentário"></textarea>
        <div class="row"><button class="btn main c-save">Publicar comentário</button>
          <button class="link c-del" hidden>Excluir meu comentário</button><span class="err c-err" role="alert"></span></div>` : ""}
      <div class="c-list"></div>
    </div>`;
}

// Desenha uma estante (a minha, editável, ou a de outro leitor, só leitura) e liga os comentários do livro aberto
function drawShelf(area, books, sel, onSel, mine) {
  cUnsub?.();
  cUnsub = null;
  const draft = area.dataset.sel === sel ? area.querySelector(".c-text")?.value : ""; // não perder o rascunho ao mudar status/nota
  area.dataset.sel = sel ?? "";
  area.innerHTML = shelfHtml(books, sel);
  area.querySelectorAll(".chip").forEach((c) => (c.onclick = () => { filter = c.dataset.f; onSel(null); }));
  area.querySelectorAll(".spine").forEach((s) => (s.onclick = () => onSel(sel === s.dataset.id ? null : s.dataset.id)));
  const b = books.find((x) => x.id === sel);
  const d = area.querySelector(".detail");
  if (!b || !d) return;
  d.hidden = false;
  d.innerHTML = detailHtml(b, mine);
  if (mine) {
    const ref = doc(db, "users", user.uid, "books", b.id);
    d.querySelector(".remove").onclick = async () => { onSel(null); await deleteDoc(ref); };
    d.querySelectorAll("[data-s]").forEach((x) => (x.onclick = () => updateDoc(ref, { status: x.dataset.s })));
    d.querySelectorAll("[data-r]").forEach((x) => (x.onclick = () => {
      const n = Number(x.dataset.r);
      updateDoc(ref, { rating: n === (b.rating || 0) ? 0 : n }); // tocar na mesma nota limpa
    }));
    d.querySelector(".c-save").onclick = () => saveComment(d, b);
    d.querySelector(".c-del").onclick = () => deleteDoc(doc(db, "books", b.id, "comments", user.uid));
    if (draft) d.querySelector(".c-text").value = draft;
  }
  d.querySelector(".c-list").onclick = (e) => {
    const btn = e.target.closest(".like");
    if (btn) updateDoc(doc(db, "books", b.id, "comments", btn.dataset.uid),
      { likes: btn.getAttribute("aria-pressed") === "true" ? arrayRemove(user.uid) : arrayUnion(user.uid) });
  };
  cUnsub = onSnapshot(collection(db, "books", b.id, "comments"), (snap) => renderComments(d, snap.docs.map((x) => x.data()), mine));
}

function renderShelf() {
  if ($("estante").hidden) return; // evita mexer nos comentários abertos em outra aba
  const area = $("shelf-area");
  if (!user) {
    cUnsub?.();
    area.innerHTML = `<p class="empty">Entre para montar sua estante e guardar os livros que você já leu.</p><button class="btn main" id="shelf-login">Entrar</button>`;
    $("shelf-login").onclick = openAuth;
    return;
  }
  if (!shelf.length) {
    cUnsub?.();
    area.innerHTML = `<p class="empty">Sua estante está vazia. Peça uma recomendação, ou veja os mais lidos, e use Adicionar à estante.</p>`;
    return;
  }
  drawShelf(area, shelf, selected, (id) => { selected = id; renderShelf(); }, true);
}

// --- comentários
function commentsHtml(list) {
  const n = (c) => new Set(c.likes).size;
  list.sort((a, b) => n(b) - n(a) || (a.createdAt?.seconds ?? 1e12) - (b.createdAt?.seconds ?? 1e12));
  return list.length ? list.map((c) => {
    const liked = c.likes.includes(user.uid);
    return `<div class="c"><b>${esc(c.name)}</b><p>${esc(c.text)}</p>
      <button class="like" data-uid="${esc(c.uid)}" aria-pressed="${liked}" aria-label="${liked ? "Descurtir" : "Curtir"} comentário de ${esc(c.name)}">♥ ${n(c)}</button></div>`;
  }).join("") : `<p class="note">Ninguém comentou este livro ainda.</p>`;
}

function renderComments(d, list, mine) {
  if (mine) {
    myComment = list.find((c) => c.uid === user.uid) || null;
    const text = d.querySelector(".c-text");
    if (myComment && !text.value) text.value = myComment.text;
    d.querySelector(".c-save").textContent = myComment ? "Atualizar comentário" : "Publicar comentário";
    d.querySelector(".c-del").hidden = !myComment;
  }
  d.querySelector(".c-list").innerHTML = commentsHtml(list);
}

async function saveComment(d, b) {
  const text = d.querySelector(".c-text").value.trim();
  const name = user.displayName || d.querySelector(".c-name")?.value.trim();
  const err = d.querySelector(".c-err");
  err.textContent = "";
  if (!text) { err.textContent = "Escreva um comentário antes de publicar."; return; }
  if (!name) { err.textContent = "Diga seu nome para aparecer nos comentários."; return; }
  try {
    if (!user.displayName) await updateProfile(user, { displayName: name });
    const ref = doc(db, "books", b.id, "comments", user.uid);
    if (myComment) await updateDoc(ref, { text, name });
    else await setDoc(ref, { uid: user.uid, name, text, likes: [], createdAt: serverTimestamp() });
  } catch (e) {
    err.textContent = "Não foi possível publicar. Tente de novo.";
  }
}

// --- leitores: perfil público, seguir e ver a estante dos outros
let myProfile = null;
let following = new Set();
let readersCache = null;
let readersTab = "todos";
let readerView = null; // { uid, name } do leitor aberto
let readerBooks = [];
let rSel = null;
let rUnsub = null;

function renderReaders() {
  if ($("leitores").hidden) return;
  const area = $("readers-area");
  if (!user) {
    area.innerHTML = `<p class="empty">Entre para ver outros leitores e as estantes públicas deles.</p><button class="btn main" id="readers-login">Entrar</button>`;
    $("readers-login").onclick = openAuth;
    return;
  }
  if (readerView) return renderReader(area);
  area.innerHTML = `${myProfile?.shelfPublic ? "" : `<p class="note tight">Sua estante está privada: você vê os outros, mas ninguém vê a sua. Abra <b>Meu perfil</b> para mudar isso.</p>`}
    <div class="filters">${["todos", "seguindo"].map((k) =>
      `<button class="chip" data-rt="${k}" aria-pressed="${readersTab === k}">${k === "todos" ? "Todos" : "Seguindo"}</button>`).join("")}</div>
    <div id="readers-list"><p class="note">Carregando.</p></div>`;
  area.querySelectorAll("[data-rt]").forEach((c) => (c.onclick = () => { readersTab = c.dataset.rt; renderReaders(); }));
  loadReadersList();
}

// --- perfil: nome público e estante pública, no botão Meu perfil do cabeçalho
$("profile-btn").onclick = () => {
  $("p-name").value = myProfile?.name ?? user?.displayName ?? "";
  $("p-public").checked = !!myProfile?.shelfPublic;
  $("p-msg").textContent = "";
  $("p-msg").classList.remove("ok");
  $("profile-dlg").showModal();
};
$("profile-close").onclick = () => $("profile-dlg").close();
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

async function loadReadersList() {
  const box = $("readers-list");
  try {
    readersCache ??= (await getDocs(query(collection(db, "profiles"), where("shelfPublic", "==", true), limit(100))))
      .docs.map((d) => ({ uid: d.id, ...d.data() })).filter((r) => r.uid !== user.uid);
  } catch {
    box.innerHTML = `<p class="note">Não foi possível carregar os leitores. Recarregue a página.</p>`;
    return;
  }
  const list = readersCache.filter((r) => readersTab === "todos" || following.has(r.uid));
  box.innerHTML = list.length ? list.map((r) => `<div class="reader"><strong>${esc(r.name)}</strong>
      <span class="note rcount" data-count="${esc(r.uid)}"></span>
      <button class="link" data-view="${esc(r.uid)}">Ver estante</button>
      <button class="btn" data-follow="${esc(r.uid)}">${following.has(r.uid) ? "Seguindo" : "Seguir"}</button></div>`).join("")
    : `<p class="note">${readersTab === "seguindo" ? "Você ainda não segue ninguém." : "Ainda não há outros leitores com estante pública."}</p>`;
  list.forEach((r) => countBooks(r.uid));
  if (readersTab === "seguindo") loadActivity(list); else $("activity")?.remove();
  box.onclick = (e) => {
    const v = e.target.closest("[data-view]");
    const f = e.target.closest("[data-follow]");
    if (v) openReader(readersCache.find((r) => r.uid === v.dataset.view));
    if (f) toggleFollow(f.dataset.follow);
  };
}

const counts = {};
async function countBooks(uid) {
  try {
    counts[uid] ??= (await getCountFromServer(collection(db, "users", uid, "books"))).data().count;
    const el = document.querySelector(`[data-count="${CSS.escape(uid)}"]`);
    if (el) el.textContent = `${counts[uid]} ${counts[uid] === 1 ? "livro" : "livros"}`;
  } catch {}
}

// Últimos livros adicionados por quem você segue (só estantes públicas respondem)
async function loadActivity(list) {
  if (!list.length) { $("activity")?.remove(); return; }
  const rows = (await Promise.all(list.slice(0, 15).map(async (r) => {
    try {
      const snap = await getDocs(query(collection(db, "users", r.uid, "books"), orderBy("addedAt", "desc"), limit(3)));
      return snap.docs.map((d) => ({ name: r.name, ...d.data() }));
    } catch { return []; }
  }))).flat().sort((a, b) => (b.addedAt?.seconds ?? 0) - (a.addedAt?.seconds ?? 0)).slice(0, 10);
  if (readersTab !== "seguindo" || !$("readers-list")) return;
  $("activity")?.remove();
  $("readers-list").insertAdjacentHTML("afterend", `<div class="activity" id="activity"><h3>Atividade recente</h3>${rows.length
    ? `<ul>${rows.map((a) => `<li><b>${esc(a.name)}</b> adicionou <i>${esc(a.title)}</i> (${STATUS[a.status || "lido"]})</li>`).join("")}</ul>`
    : `<p class="note">Ninguém que você segue adicionou livros ainda.</p>`}</div>`);
}

const toggleFollow = (uid) => following.has(uid)
  ? deleteDoc(doc(db, "users", user.uid, "following", uid))
  : setDoc(doc(db, "users", user.uid, "following", uid), { at: serverTimestamp() });

function openReader(r) {
  rUnsub?.();
  readerView = r;
  rSel = null;
  readerBooks = [];
  rUnsub = onSnapshot(collection(db, "users", r.uid, "books"), (snap) => {
    readerBooks = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.addedAt?.seconds ?? 1e12) - (b.addedAt?.seconds ?? 1e12));
    renderReaders();
  }, () => { readerBooks = null; renderReaders(); }); // sem permissão: a pessoa deixou a estante privada
  renderReaders();
}

function renderReader(area) {
  area.innerHTML = `<button class="link" id="r-back">Voltar para leitores</button>
    <h3 style="margin:16px 0 8px;font-size:1.5rem">${esc(readerView.name)}</h3>
    <button class="btn" id="r-follow">${following.has(readerView.uid) ? "Seguindo" : "Seguir"}</button>
    <div id="reader-shelf" style="margin-top:8px"></div>`;
  $("r-back").onclick = () => { rUnsub?.(); rUnsub = null; cUnsub?.(); cUnsub = null; readerView = null; renderReaders(); };
  $("r-follow").onclick = () => toggleFollow(readerView.uid);
  const box = $("reader-shelf");
  if (readerBooks === null) box.innerHTML = `<p class="empty">Esta estante não está mais pública.</p>`;
  else if (!readerBooks.length) box.innerHTML = `<p class="empty">Esta estante ainda está vazia.</p>`;
  else drawShelf(box, readerBooks, rSel, (id) => { rSel = id; renderReaders(); }, false);
}

// --- mais lidos (carregados do Firestore, atualizados 1x por dia pela função refreshBestsellers)
let topData = null;
let nytData = null;
let topLoading = false;

async function loadTop() {
  if (topData || topLoading) return;
  topLoading = true;
  $("top-area").innerHTML = `<p class="note">Carregando os rankings.</p>`;
  $("nyt-area").innerHTML = "";
  try {
    const d = (await getDoc(doc(db, "public", "bestsellers"))).data();
    nytData = d?.lists ?? [];
    topData = d?.genres ?? [];
    const at = d?.updatedAt?.toDate();
    const stale = at && Date.now() - at > 3 * 864e5;
    $("top-updated").textContent = at ? `${stale ? "Os rankings podem estar desatualizados. " : ""}Atualizado em ${at.toLocaleDateString("pt-BR")}.` : "";
  } catch {
    nytData = [];
    topData = [];
  }
  topLoading = false;
  renderTop();
  renderPreview();
}

// Busca pelo título em português (quando conhecido) e autor: o link direto do NYT leva à Amazon dos EUA
function buyLinks(b) {
  const q = encodeURIComponent(`${titleOf(b)} ${b.author}`);
  return `<a href="https://www.amazon.com.br/s?k=${q}&i=stripbooks" target="_blank" rel="noopener">Amazon Brasil</a>
    <a href="https://www.google.com/search?tbm=shop&q=${q}" target="_blank" rel="noopener">Google Shopping</a>`;
}

// Uma linha do ranking. `have` nulo = prévia de quem não entrou: sem botões de estante.
const topRow = (b, i, attr, li, have) => `<li>
  <span class="rank">${i + 1}</span>
  ${coverHtml(b)}
  <div>
    <h3>${esc(titleOf(b))}</h3>
    ${b.titlePt ? `<span class="orig">Título original: ${esc(b.title)}</span>` : ""}
    <span class="by">${esc(b.author)}${b.weeks > 1 ? `, ${b.weeks} semanas na lista` : ""}</span>
    ${b.synopsis ? `<p class="syn">${esc(b.synopsis)}</p>` : ""}
    ${have ? `<div class="acts">${have.has(bookId(b))
      ? `<button class="btn" disabled>Na estante</button><button class="link" data-goshelf>Ver na estante</button>`
      : `<button class="btn" data-${attr}="${li}" data-i="${i}">Adicionar à estante</button>
         <button class="link" data-${attr}="${li}" data-i="${i}" data-read="1">Já li este</button>`}</div>` : ""}
    <p class="buy">Comprar: ${buyLinks(b)}</p>
  </div></li>`;

let nytTab = 0;
let genreTab = 0;

function renderTop() {
  if (!topData) return;
  const have = new Set(shelf.map((b) => b.id));
  // uma lista por vez: 11 listas de 10 livros com sinopse não cabem numa página
  const section = (lists, tabs, area, tab, attr, empty) => {
    if (!lists.length) { $(tabs).innerHTML = ""; $(area).innerHTML = `<p class="note">${empty}</p>`; return; }
    const li = Math.min(tab, lists.length - 1);
    $(tabs).innerHTML = lists.map((l, i) =>
      `<button class="chip" data-t="${i}" aria-pressed="${i === li}">${esc(l.name)}</button>`).join("");
    $(area).innerHTML = `<ol class="top-list">${lists[li].books.map((b, i) => topRow(b, i, attr, li, have)).join("")}</ol>`;
  };
  section(nytData, "nyt-tabs", "nyt-area", nytTab, "n", "Não foi possível carregar os best-sellers. Recarregue a página.");
  section(topData, "top-tabs", "top-area", genreTab, "g", "Não foi possível carregar os rankings. Recarregue a página.");
}

const topClick = (e, data, attr) => {
  if (e.target.closest("[data-goshelf]")) return showTab("estante");
  const b = e.target.closest(`[data-${attr}]`);
  if (b) addBook(data[b.dataset[attr]].books[b.dataset.i], b.dataset.read ? "lido" : "quero");
};
$("nyt-area").onclick = (e) => topClick(e, nytData, "n");
$("top-area").onclick = (e) => topClick(e, topData, "g");
$("nyt-tabs").onclick = (e) => { const c = e.target.closest("[data-t]"); if (c) { nytTab = Number(c.dataset.t); renderTop(); } };
$("top-tabs").onclick = (e) => { const c = e.target.closest("[data-t]"); if (c) { genreTab = Number(c.dataset.t); renderTop(); } };

// Quem chega sem conta vê livros de verdade na primeira tela, não só o formulário
function renderPreview() {
  const box = $("preview");
  if (user) { box.hidden = true; box.innerHTML = ""; return; }
  if (!topData) return loadTop();
  const l = nytData?.[0] || topData[0];
  if (!l) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<h2>Enquanto isso, os mais lidos da semana</h2>
    <p class="note tight">${esc(l.name)}, pela lista do New York Times.</p>
    <ol class="top-list">${l.books.slice(0, 3).map((b, i) => topRow(b, i, null, 0, null)).join("")}</ol>
    <button class="btn" id="preview-all">Ver todos os mais lidos</button>`;
  $("preview-all").onclick = () => showTab("top");
}

// --- privacidade e exclusão de conta
$("privacy-btn").onclick = () => {
  $("delete-box").hidden = !user;
  $("privacy-only-close").hidden = !!user;
  $("delete-confirm").value = "";
  $("delete-btn").disabled = true;
  $("delete-err").textContent = "";
  $("privacy-dlg").showModal();
};
$("privacy-close").onclick = $("privacy-close2").onclick = () => $("privacy-dlg").close();
$("delete-confirm").oninput = () => { $("delete-btn").disabled = $("delete-confirm").value.trim() !== "EXCLUIR"; };
$("delete-btn").onclick = async () => {
  $("delete-btn").disabled = true;
  try {
    const r = await fetch("/api/delete-account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: await user.getIdToken() }) });
    if (!r.ok) throw new Error((await r.json()).error);
    $("privacy-dlg").close();
    await signOut(auth);
    $("out").innerHTML = `<p class="note">Sua conta e seus dados foram excluídos.</p>`;
    showTab("recomendar");
  } catch (e) {
    $("delete-err").textContent = e.message || "Não foi possível excluir agora. Tente de novo.";
    $("delete-btn").disabled = false;
  }
};

// --- recomendações
const TAGS = ["segunda chance", "sem poderes", "sem sistema", "reencarnação", "fantasia", "romance", "ficção científica", "mistério"];
$("tags").innerHTML = TAGS.map((t) => `<label><input type="checkbox" value="${t}">${t}</label>`).join("");

const openRecs = new Set(); // livros recomendados com comentários abertos
const recUnsubs = new Map();

function watchRec(id) {
  recUnsubs.get(id)?.();
  const box = $("out").querySelector(`[data-rc="${id}"]`);
  if (!box) return;
  recUnsubs.set(id, onSnapshot(collection(db, "books", id, "comments"),
    (snap) => { box.hidden = false; box.innerHTML = commentsHtml(snap.docs.map((d) => d.data())); },
    () => { box.hidden = false; box.innerHTML = `<p class="note">Não foi possível carregar os comentários.</p>`; }));
}

function toggleRecComments(b) {
  if (!requireLogin(() => toggleRecComments(b))) return;
  const id = bookId(b);
  if (openRecs.delete(id)) { renderRecs(); return; }
  openRecs.add(id);
  renderRecs();
}

$("out").onclick = (e) => {
  if (e.target.closest("[data-goshelf]")) return showTab("estante");
  const btn = e.target.closest(".like");
  if (btn && user) updateDoc(doc(db, "books", btn.closest("[data-rc]").dataset.rc, "comments", btn.dataset.uid),
    { likes: btn.getAttribute("aria-pressed") === "true" ? arrayRemove(user.uid) : arrayUnion(user.uid) });
};

function renderRecs() {
  recUnsubs.forEach((u) => u());
  recUnsubs.clear();
  if (!lastRecs.length) return;
  const have = new Set(shelf.map((b) => b.id));
  $("out").innerHTML = lastRecs.map((b, i) => `
    <article class="rec">
      ${coverHtml(b)}
      <div>
        <h3>${esc(b.title)}</h3><div class="by">${esc(b.author)}</div>
        <p>${esc(b.why)}</p>
        <div class="actions">
          ${have.has(bookId(b))
            ? `<button class="btn" disabled>Na estante</button><button class="link" data-goshelf>Ver na estante</button>`
            : `<button class="btn" data-add="${i}">Adicionar à estante</button>`}
          ${b.verified && safeUrl(b.link) ? `<a href="${safeUrl(b.link)}" target="_blank" rel="noopener">Ver livro</a>` : `<span class="unverified">Não encontrado no Open Library (web novels e edições raras costumam ficar de fora).</span>`}
          <button class="link" data-cm="${i}" hidden>Ver comentários</button>
        </div>
        <p class="buy">Comprar: ${buyLinks(b)}</p>
        <div class="rc" data-rc="${bookId(b)}" hidden></div>
      </div>
    </article>`).join("");
  $("out").querySelectorAll("[data-add]").forEach((btn) => (btn.onclick = () => addBook(lastRecs[btn.dataset.add])));
  $("out").querySelectorAll("[data-cm]").forEach((btn) => (btn.onclick = () => toggleRecComments(lastRecs[btn.dataset.cm])));
  if (user) { openRecs.forEach((id) => watchRec(id)); showCommentCounts(); } else openRecs.clear();
}

// O botão de comentários só aparece nos livros que já têm algum: na recomendação ninguém pode
// comentar (a regra exige o livro na estante), então "Ver comentários (0)" seria um botão morto.
const recCounts = {};
function showCommentCounts() {
  lastRecs.forEach(async (b, i) => {
    const id = bookId(b);
    try {
      recCounts[id] ??= (await getCountFromServer(collection(db, "books", id, "comments"))).data().count;
      const btn = $("out").querySelector(`[data-cm="${i}"]`);
      if (!btn || !recCounts[id]) return;
      btn.hidden = false;
      btn.textContent = openRecs.has(id) ? "Ocultar comentários" : `Ver comentários (${recCounts[id]})`;
    } catch {}
  });
}

async function addBook(b, status = "quero") {
  if (!requireLogin(() => addBook(b, status))) return;
  await setDoc(doc(db, "users", user.uid, "books", bookId(b)), {
    title: titleOf(b), originalTitle: b.originalTitle || (b.titlePt ? b.title : ""),
    author: b.author, cover: b.cover || "", link: b.link || "",
    status, rating: 0, addedAt: serverTimestamp(),
  });
}

const syncShelfBtn = () => {
  $("go-shelf").hidden = !(user && shelf.length);
  $("login-hint").hidden = !!user;
};

const cut = (s) => (s.length > 80 ? s.slice(0, 80) + "…" : s);
const SKELETON = (what) => `<p class="note">Procurando ${esc(what)}. Isso leva até 30 segundos.</p>`
  + `<article class="rec skel"><div class="cover"></div><div><i></i><i></i><i></i></div></article>`.repeat(3);

async function recommend(useShelf) {
  if (!requireLogin(() => recommend(useShelf))) { $("out").innerHTML = `<p class="note">Entre na sua conta para pedir recomendações.</p>`; return; }
  const tags = [...document.querySelectorAll("#tags input:checked")].map((i) => i.value);
  if (!useShelf && !$("text").value.trim() && !tags.length) { $("out").innerHTML = `<p class="note">Escreva o que procura ou escolha uma característica.</p>`; return; }
  $("go").disabled = $("go-shelf").disabled = true;
  $("out").innerHTML = SKELETON(useShelf
    ? "livros parecidos com os da sua estante"
    : cut([$("text").value.trim(), ...tags].filter(Boolean).join(", ")));
  try {
    const body = { text: $("text").value, tags, idToken: await user.getIdToken(), exclude: shelf.map((b) => b.title) };
    if (useShelf) body.shelf = shelf.slice(-40).map(({ title, author, status, rating }) => ({ title, author, status: status || "lido", rating: rating || 0 }));
    const r = await fetch("/api/recommend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    lastRecs = data;
    renderRecs();
  } catch (e) {
    $("out").innerHTML = `<p class="note">${esc(e.message)}</p>`;
  } finally {
    $("go").disabled = $("go-shelf").disabled = false;
  }
}
$("go").onclick = () => recommend(false);
$("go-shelf").onclick = () => recommend(true);

showTab(tabFromHash(), true);

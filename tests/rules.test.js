// Testa firestore.rules no emulador: npm test
const { test, before, after } = require("node:test");
const { readFileSync } = require("node:fs");
const { initializeTestEnvironment, assertSucceeds, assertFails } = require("@firebase/rules-unit-testing");
const { doc, getDoc, setDoc, updateDoc, deleteDoc, arrayUnion, arrayRemove, serverTimestamp } = require("firebase/firestore");

let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-bookshelf", firestore: { rules: readFileSync("firestore.rules", "utf8") } });
});
after(() => env.cleanup());

const as = (uid) => env.authenticatedContext(uid).firestore();
const book = { title: "Norwegian Wood", author: "Haruki Murakami", cover: "https://covers.openlibrary.org/b/id/1-M.jpg", link: "https://openlibrary.org/works/1", status: "lido", rating: 4 };
const comment = (uid) => ({ uid, name: "Ana", text: "Ótimo", likes: [], createdAt: serverTimestamp() });

test("estante: dono grava, outro usuário não lê enquanto o perfil é privado", async () => {
  await assertSucceeds(setDoc(doc(as("ana"), "users/ana/books/b1"), { ...book, addedAt: serverTimestamp() }));
  await assertFails(getDoc(doc(as("bia"), "users/ana/books/b1")));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "users/ana/books/b1")));
});

test("estante: perfil público libera a leitura, mas não a escrita", async () => {
  await assertSucceeds(setDoc(doc(as("ana"), "profiles/ana"), { name: "Ana", shelfPublic: true }));
  await assertSucceeds(getDoc(doc(as("bia"), "users/ana/books/b1")));
  await assertFails(setDoc(doc(as("bia"), "users/ana/books/b2"), book));
});

test("estante: capa de host desconhecido, nota fora de 0 a 5 e status inválido são recusados", async () => {
  const ref = doc(as("ana"), "users/ana/books/b3");
  await assertFails(setDoc(ref, { ...book, cover: "https://evil.example.com/x.gif" }));
  await assertFails(setDoc(ref, { ...book, rating: 6 }));
  await assertFails(setDoc(ref, { ...book, status: "abandonado" }));
  await assertSucceeds(setDoc(ref, { ...book, cover: "" }));
});

test("perfil: público exige nome e só o dono escreve", async () => {
  await assertFails(setDoc(doc(as("bia"), "profiles/bia"), { name: "", shelfPublic: true }));
  await assertSucceeds(setDoc(doc(as("bia"), "profiles/bia"), { name: "Bia", shelfPublic: false }));
  await assertFails(setDoc(doc(as("ana"), "profiles/bia"), { name: "X", shelfPublic: false }));
  await assertFails(getDoc(doc(as("ana"), "profiles/bia"))); // perfil privado
  await assertSucceeds(getDoc(doc(as("bia"), "profiles/bia")));
});

test("comentário: só quem tem o livro na estante comenta, uma vez por usuário", async () => {
  await assertSucceeds(setDoc(doc(as("ana"), "books/b1/comments/ana"), comment("ana")));
  await assertFails(setDoc(doc(as("bia"), "books/b1/comments/bia"), comment("bia"))); // não tem o livro
  await assertFails(setDoc(doc(as("ana"), "books/b1/comments/bia"), comment("ana"))); // id de outro
});

test("comentário: curtir só adiciona e remove o próprio uid; texto alheio não muda", async () => {
  const ref = (uid) => doc(as(uid), "books/b1/comments/ana");
  await assertSucceeds(updateDoc(ref("bia"), { likes: arrayUnion("bia") }));
  await assertFails(updateDoc(ref("bia"), { likes: arrayUnion("carla") })); // curtir por outro
  await assertFails(updateDoc(ref("bia"), { text: "editado" }));
  await assertFails(updateDoc(ref("carla"), { likes: [] })); // carla apagando a curtida da bia
  await assertSucceeds(updateDoc(ref("bia"), { likes: arrayRemove("bia") }));
  await assertSucceeds(updateDoc(ref("ana"), { text: "Muito bom" }));
  await assertFails(deleteDoc(ref("bia")));
  await assertSucceeds(deleteDoc(ref("ana")));
});

test("uso diário e seguidos: fechados para o cliente", async () => {
  await assertFails(setDoc(doc(as("ana"), "usage/ana_2026-01-01"), { n: 0 }));
  await assertSucceeds(setDoc(doc(as("ana"), "users/ana/following/bia"), { at: serverTimestamp() }));
  await assertFails(getDoc(doc(as("bia"), "users/ana/following/bia")));
});

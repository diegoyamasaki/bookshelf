# Estante

Site para recomendar livros com IA e montar uma estante pessoal.

- **Recomendar:** descreva o que procura (ou use a própria estante) e o Claude sugere livros, conferidos no Open Library.
- **Minha estante:** lombadas com status (lido, lendo, quero ler), nota e comentários públicos com curtidas.
- **Mais lidos:** best-sellers do NYT e ranking por gênero do Open Library, com sinopses traduzidas, atualizados 1x por dia.
- **Leitores:** perfil público opcional, ver a estante de outros e seguir.

## Stack

Firebase (Hosting, Auth, Firestore, Cloud Functions Node 22) e a API do Claude.

- `public/index.html`: o site inteiro (HTML, CSS e JS).
- `functions/index.js`: `recommend` (recomendação) e `refreshBestsellers` (agendada, 6h).
- `firestore.rules`: regras de acesso.

## Rodar e publicar

```
cd functions && npm install && cd ..
npx firebase-tools functions:secrets:set ANTHROPIC_API_KEY
npx firebase-tools functions:secrets:set NYT_API_KEY
npx firebase-tools deploy
```

Exige o plano Blaze do Firebase. A chave web em `public/index.html` é pública por design; o acesso é protegido por `firestore.rules`.

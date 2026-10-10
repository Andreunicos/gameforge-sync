// Config pública do Firebase (vai no app mesmo; quem protege os dados são as regras do Firebase).
// Console do Firebase → ⚙ Configurações do projeto → Seus apps → app Web.
export const firebaseConfig = {
  apiKey: "AIzaSyBuFsgekAZdraWUeAx0zpEJQwGi5AGRnks",
  authDomain: "gameforge-sync.firebaseapp.com",
  databaseURL: "https://gameforge-sync-default-rtdb.firebaseio.com",
  projectId: "gameforge-sync",
  storageBucket: "gameforge-sync.firebasestorage.app",
  messagingSenderId: "763579522878",
  appId: "1:763579522878:web:6dca74b5cc9235ccfa566f",
};

// Contas que podem usar o app. Quem barra de verdade são as regras do Firebase
// (firebase/firestore.rules e database.rules.json); aqui é só para mostrar um aviso claro.
export const ALLOWED_EMAILS = ["andreluizvillanova123@gmail.com", "kaue.bimok@gmail.com", "jonatas3dmodel@gmail.com", "adriwolf@hotmail.com"];

export const APP_VERSION: string = __APP_VERSION__;

export const firebaseReady = !firebaseConfig.apiKey.startsWith("COLE");


// Grava no Firebase depois de X ms sem digitar.
export const SAVE_DEBOUNCE_MS = 2000;

// Limite grátis de gravações por dia no Firestore (plano Spark).
export const DAILY_WRITE_LIMIT = 20_000;

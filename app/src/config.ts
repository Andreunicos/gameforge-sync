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

// Cliente OAuth do tipo "App para computador" (Google Cloud → APIs e serviços → Credenciais).
// Usado pelo login no app de PC e pelo gfs. Para apps instalados o Google não trata o
// "secret" como segredo de verdade, então ele pode ficar no código.
export const googleDesktopClient = {
  clientId: "",
  clientSecret: "",
};

// Contas que podem usar o app. Quem barra de verdade são as regras do Firebase
// (firebase/firestore.rules e database.rules.json); aqui é só para mostrar um aviso claro.
export const ALLOWED_EMAILS = ["andreluizvillanova123@gmail.com", "kaue.bimok@gmail.com", "jonatas3dmodel@gmail.com"];

export const APP_VERSION: string = __APP_VERSION__;

export const firebaseReady = !firebaseConfig.apiKey.startsWith("COLE");

// Tamanho máximo de um arquivo de código (o Firestore aceita 1 MB por documento).
export const MAX_FILE_BYTES = 900_000;

// Grava no Firebase depois de X ms sem digitar.
export const SAVE_DEBOUNCE_MS = 2000;

// Limite grátis de gravações por dia no Firestore (plano Spark).
export const DAILY_WRITE_LIMIT = 20_000;

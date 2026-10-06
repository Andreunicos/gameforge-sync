import { Brand } from "./Brand";

export function SetupScreen() {
  return (
    <div className="center-screen">
      <div className="card">
        <Brand />
        <div className="note-box">
          Falta a configuração do Firebase. Cole o <code>firebaseConfig</code> do console em <code>src/config.ts</code>.
        </div>
      </div>
    </div>
  );
}

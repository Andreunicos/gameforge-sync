import { APP_VERSION } from "../config";

export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <div className="brand">
      <div className="brand-logo">GF</div>
      <div>
        <h1>GameForge Sync</h1>
        <p>{subtitle ?? `Jogos HTML5 feitos a várias mãos (e vários Claudes) · v${APP_VERSION}`}</p>
      </div>
    </div>
  );
}

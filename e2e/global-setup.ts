import fs from "fs";
import path from "path";

const E2E_SESSION_ID = "e2e-test-session-00000000-0000-0000-0000-000000000001";

export default async function globalSetup() {
  const storageState = {
    cookies: [
      {
        name: "session",
        value: E2E_SESSION_ID,
        domain: ".uni-scrm.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
        expires: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      },
    ],
    origins: [],
  };

  fs.writeFileSync(
    path.join(__dirname, "storage-state.json"),
    JSON.stringify(storageState, null, 2)
  );
}

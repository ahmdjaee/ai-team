/**
 * Hook PreToolUse `agy` untuk bot AI Team. agy menjalankannya (`sh -c`, cwd = folder hooks.json) di
 * setiap tool call dengan payload JSON di stdin, lalu membaca keputusan JSON dari stdout.
 *
 * Skrip ini hanya kurir: keputusan dibuat server AI Team. Apa pun yang salah — env tidak ada, server
 * mati, jawaban aneh — berakhir dengan `deny`, karena tool yang lolos tanpa dinilai lebih buruk
 * daripada tool yang gagal.
 */

export {};

type Answer = { decision?: unknown; reason?: unknown; pending?: unknown };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function finish(decision: "allow" | "deny", reason?: string): never {
  process.stdout.write(JSON.stringify(reason ? { decision, reason } : { decision }));
  process.exit(0);
}

const url = process.env.AI_TEAM_HOOK_URL;
const token = process.env.AI_TEAM_HOOK_TOKEN;
if (!url || !token) finish("deny", "Sesi agy ini tidak dijalankan oleh AI Team — tool ditolak.");

let payload: unknown;
try {
  payload = JSON.parse(await readStdin());
} catch {
  finish("deny", "Payload hook tidak bisa dibaca — tool ditolak.");
}

async function post(path: string, body: unknown): Promise<Answer> {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Answer;
}

try {
  let answer = await post("", payload);
  while (typeof answer.pending === "string") answer = await post("/wait", { id: answer.pending });
  const reason = typeof answer.reason === "string" ? answer.reason : undefined;
  if (answer.decision === "allow") finish("allow");
  finish("deny", reason ?? "Ditolak AI Team.");
} catch (error) {
  finish("deny", `Pagar AI Team tidak bisa dihubungi (${(error as Error).message}) — tool ditolak.`);
}

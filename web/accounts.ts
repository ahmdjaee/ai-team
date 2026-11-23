import { useMemo } from "react";
import { accountReady as libraryAccountReady, createAccountsStore, useAccounts as useStoredAccounts } from "ai-agent-auth/react";
import { api, type AccountView, type EngineId, type EngineInfo, type ProviderId } from "./api.ts";
import { subscribe } from "./realtime.ts";

/**
 * Akun AI milik app, dibagi seluruh aplikasi: kartu di Pengaturan, banner tanpa akun, daftar mini
 * di sidebar, dan pemilih mesin. Server mengirim `accounts_changed` di topik `global` setiap kali
 * akun atau status login berubah, jadi tidak ada polling.
 */
export const accountsStore = createAccountsStore<AccountView>({
  load: async () => (await api.accounts()).accounts,
  subscribe: (reload) =>
    subscribe<{ type: string }>(
      "global",
      (event) => {
        if (event.type === "accounts_changed") reload();
      },
      { onReady: reload },
    ),
});

export function reloadAccounts(): void {
  accountsStore.reload();
}

/** Simpan hasil aksi akun (login, Periksa, Keluar) tanpa menunggu event berikutnya. */
export function putAccount(account: AccountView): void {
  accountsStore.put(account);
}

export function useAccounts(): AccountView[] | undefined {
  return useStoredAccounts(accountsStore);
}

export function useAccount(provider: ProviderId): AccountView | undefined {
  return useAccounts()?.find((account) => account.provider === provider);
}

/** Akun bisa dipakai menjalankan bot? `error` (mis. jaringan saat diperiksa) tidak memblokir. */
export function accountReady(account?: AccountView): boolean {
  return libraryAccountReady(account);
}

/** Kalimat singkat kenapa mesin akun ini belum bisa dipakai. */
export function accountBlocker(account?: AccountView): string | undefined {
  if (!account) return "Memeriksa akun…";
  if (accountReady(account)) return undefined;
  if (account.state === "none") return `Tambahkan akun ${account.label} dulu di Pengaturan → Akun AI`;
  if (account.state === "expired") return `Akun ${account.label} perlu login ulang di Pengaturan → Akun AI`;
  return `${account.label} belum tersedia: ${account.reason ?? "tidak bisa dipakai di mesin ini"}`;
}

export function accountForEngine(list: AccountView[] | undefined, engine: EngineId): AccountView | undefined {
  return list?.find((account) => account.engine === engine);
}

/** Mesin agen menurut akun: tersedia hanya kalau akun penyedianya siap. */
export function useEngines(): { engines?: EngineInfo[]; checking: boolean } {
  const list = useAccounts();
  const engines = useMemo(
    () =>
      list?.map((account) => ({
        id: account.engine,
        label: account.label,
        available: accountReady(account),
        reason: accountBlocker(account),
        models: account.models,
        defaultModel: account.defaultModel,
        checkedAt: account.checkedAt,
      })),
    [list],
  );
  return { engines, checking: !list };
}

/** Mesin yang dipakai: pilihan bawaan kalau siap, kalau tidak mesin lain yang siap. */
export function usableEngine(preferred: EngineId, engines?: EngineInfo[]): EngineId {
  if (!engines || engines.find((engine) => engine.id === preferred)?.available) return preferred;
  return engines.find((engine) => engine.available)?.id ?? preferred;
}

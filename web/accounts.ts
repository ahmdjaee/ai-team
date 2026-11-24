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

/**
 * Akun yang benar-benar menjalankan mesin. Untuk Claude dengan gateway aktif, status, model, dan waktu
 * periksa diambil dari gateway. Cermin `effectiveAccount` di `server/accounts/index.ts`.
 */
export function engineAccount(account: AccountView): AccountView {
  if (account.provider !== "claude" || account.claudeSource !== "gateway" || !account.gateway) return account;
  const { gateway } = account;
  return {
    ...account,
    state: gateway.state,
    email: gateway.host,
    plan: "Gateway",
    reason: gateway.reason,
    models: gateway.models,
    defaultModel: undefined,
    checkedAt: gateway.checkedAt,
    addedAt: gateway.addedAt,
    login: undefined,
  };
}

/** Akun bisa dipakai menjalankan bot? `error` (mis. jaringan saat diperiksa) tidak memblokir. */
export function accountReady(account?: AccountView): boolean {
  return libraryAccountReady(account ? engineAccount(account) : undefined);
}

/** Kalimat singkat kenapa mesin akun ini belum bisa dipakai. */
export function accountBlocker(raw?: AccountView): string | undefined {
  if (!raw) return "Memeriksa akun…";
  if (accountReady(raw)) return undefined;
  const account = engineAccount(raw);
  if (account !== raw && account.state === "expired") return "Gateway Claude menolak tokennya. Perbarui di Pengaturan → Akun AI";
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
      list?.map((raw) => {
        // Claude dengan gateway aktif: model dan status milik gateway.
        const account = engineAccount(raw);
        return {
          id: account.engine,
          label: account.label,
          available: accountReady(raw),
          reason: accountBlocker(raw),
          models: account.models,
          defaultModel: account.defaultModel,
          checkedAt: account.checkedAt,
        };
      }),
    [list],
  );
  return { engines, checking: !list };
}

/** Mesin yang dipakai: pilihan bawaan kalau siap, kalau tidak mesin lain yang siap. */
export function usableEngine(preferred: EngineId, engines?: EngineInfo[]): EngineId {
  if (!engines || engines.find((engine) => engine.id === preferred)?.available) return preferred;
  return engines.find((engine) => engine.available)?.id ?? preferred;
}

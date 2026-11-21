/**
 * Pengganti `lowlight` khusus untuk `@git-diff-view/lowlight` (dialihkan di vite.config.ts).
 *
 * Paket itu memanggil `createLowlight(all)`, jadi ~190 bahasa highlight.js (±850 kB) ikut ke chunk diff. Di sini
 * `all` hanyalah set `common` lowlight (37 bahasa: TS/JS, PHP, Python, Go, Bash, YAML, SQL, CSS, …) plus beberapa
 * bahasa yang sering muncul di workspace DevOps. Berkas berbahasa lain tetap tampil: pustakanya jatuh ke
 * `highlightAuto` di antara bahasa yang terdaftar.
 */
import dockerfile from "highlight.js/lib/languages/dockerfile";
import nginx from "highlight.js/lib/languages/nginx";
import phpTemplate from "highlight.js/lib/languages/php-template";
import powershell from "highlight.js/lib/languages/powershell";
import { common, createLowlight } from "lowlight";

export { common, createLowlight };

export const all = { ...common, dockerfile, nginx, "php-template": phpTemplate, powershell };

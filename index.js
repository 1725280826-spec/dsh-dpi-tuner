/**
 * @fileoverview Host half of `dsh-dpi-tuner`.
 *
 * The plugin is a presentation-only feature: interface scaling is applied in
 * the browser (a CSS `zoom` on the document root plus a geometry shim) and the
 * conversation font size is written through the official Client theme service,
 * which already persists in the durable `ui-theme` settings scope. The Host
 * half therefore owns no service, no tool, and no persistence of its own.
 * It exists because every Loader row needs an activatable module, and because
 * the bundle manifest resolves the Client artifact through this package entry.
 *
 * Keeping it empty is deliberate: a per-browser preference must not leak
 * into the Host, and a row with no resources has nothing to clean up on
 * unload.
 *
 * @returns {void}
 */
export function apply() {}

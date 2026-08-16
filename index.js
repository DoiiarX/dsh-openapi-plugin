/**
 * Failure-isolating Loader entry for the OpenAPI bridge plugin.
 *
 * Keep this file dependency-free: the root Cordis Loader imports only this
 * supervisor. The implementation and all of its package/native dependencies
 * are imported inside apply(), where failures become diagnostics instead of
 * rejecting the Loader entry and taking down the DSH profile.
 */
export const name = 'dsh-openapi-supervisor'
export const inject = ['tools', 'fs']

function diagnostic(scope, error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return `[dsh-openapi] ${scope} unavailable: ${detail}`
}

function report(ctx, scope, error) {
  const message = diagnostic(scope, error)
  const logger = ctx.root?.logger?.('dsh-openapi')
  if (logger?.error) logger.error('%s', message)
  console.error(message)
}

export async function applyIsolated(ctx, config = {}, importer = () => import('./implementation.js')) {
  try {
    const implementation = await importer()
    implementation.applyOneApi(ctx, config, (scope, error) => { report(ctx, scope, error) })
  } catch (error) {
    report(ctx, 'implementation', error)
  }
}

export function apply(ctx, config = {}) {
  return applyIsolated(ctx, config)
}

import type { IncomingMessage } from 'node:http'

function browserOrigin(request: IncomingMessage, method: string | undefined): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  const mutating = method === 'POST' || method === 'PUT' || method === 'DELETE'
  if (mutating && origin === undefined) return false
  if (origin !== undefined) {
    if (host === undefined) return false
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return request.headers.forwarded === undefined
    && request.headers['x-forwarded-for'] === undefined
    && request.headers['x-real-ip'] === undefined
}

export function sameOrigin(request: IncomingMessage, method: string | undefined): boolean {
  if (request.headers['sec-fetch-site'] !== undefined
    && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) return false
  if (browserOrigin(request, method)) return true
  // DSH Desktop's forwardWebRequest removes Origin and Sec-Fetch-Site.
  // Require a non-simple client header instead: foreign browser pages cannot
  // send it without a CORS preflight, which these routes do not allow.
  // Never override an explicit bad Origin or accept proxy headers.
  if (request.headers.origin !== undefined || !browserOrigin(request, 'GET')
    || request.headers['x-novel-reader-request'] !== '1') return false
  if (request.headers.referer === undefined) return true
  try {
    const referer = new URL(request.headers.referer)
    return referer.origin === `http://${request.headers.host}`
      || (referer.protocol === 'dsh-app:' && referer.host === 'app' && !referer.username && !referer.password)
  } catch { return false }
}

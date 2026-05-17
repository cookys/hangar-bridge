import { Hono } from 'hono'
import type { Deps } from './deps.ts'
import { messagesRoute } from './routes/messages.ts'
import { streamRoute } from './routes/stream.ts'
import { presenceRoute } from './routes/presence.ts'
import { peersRoute } from './routes/peers.ts'
import { metricsRoute } from './routes/metrics.ts'
import { permissionRoute } from './routes/permission.ts'
import { healthRoute } from './routes/health.ts'
import { accessLog } from './middleware/access-log.ts'

export function buildApp(deps: Deps) {
  const app = new Hono()
  app.use('*', accessLog)
  // /health is wired BEFORE any auth-bearing route module so it stays public.
  // Routes below (messages, stream, presence, peers, permission) install
  // bearerAuth in their own sub-app, so they cannot leak through here.
  app.route('/health', healthRoute())
  app.route('/metrics', metricsRoute(deps))
  app.route('/v1/messages', messagesRoute(deps))
  app.route('/v1/stream', streamRoute(deps))
  app.route('/v1/presence', presenceRoute(deps))
  app.route('/v1/peers', peersRoute(deps))
  app.route('/v1/permission', permissionRoute(deps))
  return app
}

import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { operationSchema, operations } from '@jian/contracts';
import Fastify, { LogController } from 'fastify';
import { registerApplicationRoutes } from './applications/routes.js';
import { registerApprovalRoutes } from './approvals/routes.js';
import { registerChannelRoutes } from './channels/routes.js';
import type { Channels } from './channels/service.js';
import type { WhatsAppConnections } from './channels/whatsapp/connections.js';
import { registerCoordinationRoutes } from './coordination/routes.js';
import { Coordination } from './coordination/service.js';
import { registerDecisionRoutes } from './decisions/routes.js';
import { registerDrawRoutes } from './draw/routes.js';
import { registerDrawingRoutes } from './drawings/routes.js';
import { registerEpicRoutes } from './epics/routes.js';
import { registerEventRoutes } from './http/events.js';
import { registerMetaRoutes } from './http/meta.js';
import { configureSecurity } from './http/security.js';
import { registerGatewayUi } from './http/ui.js';
import { registerMediaRoutes } from './media/routes.js';
import { registerMemoryRoutes } from './memories/routes.js';
import { registerPautaRoutes } from './pautas/routes.js';
import { registerPriorityRoutes } from './priorities/routes.js';
import { registerProfileRoutes } from './profiles/routes.js';
import { registerPrototypeRoutes } from './prototypes/routes.js';
import type { CodexLogin } from './providers/codex/login.js';
import type { ProviderModels } from './providers/discovery.js';
import { registerProviderRoutes } from './providers/routes.js';
import { registerQualityRoutes } from './quality/routes.js';
import { registerReleaseRoutes } from './releases/routes.js';
import { registerRunRoutes } from './runs/routes.js';
import { registerScheduleRoutes } from './schedules/routes.js';
import { registerSecurityRoutes } from './security/routes.js';
import type { Services } from './services.js';
import { registerSessionRoutes } from './sessions/routes.js';
import { registerSettingsRoutes } from './settings/routes.js';
import { registerSkillRoutes } from './skills/routes.js';
import type { Skills } from './skills/service.js';
import { registerSshRoutes } from './ssh/routes.js';
import { registerStatsRoutes } from './stats/routes.js';
import { registerStickerRoutes } from './stickers/routes.js';
import type { Store } from './storage/database.js';
import { registerWorkRoutes } from './tasks/routes.js';
import { registerWebRoutes } from './web/routes.js';

export function createApp(
  options: Services & {
    store: Store;
    token: string;
    logger?: boolean;
    codexLogin?: CodexLogin;
    providerModels?: ProviderModels;
    skills?: Skills;
    channels?: Channels;
    whatsapp?: WhatsAppConnections;
    maxStreams?: number;
    uiRoot?: string;
    /** The drawing board's public address (`JIAN_DRAW_URL`), when one runs beside the gateway. */
    drawUrl?: string;
    /**
     * The guarded client every outbound call of the gateway goes through, with the private
     * origins the operator allowed. Absent, a request made from a route allows none.
     */
    fetcher?: typeof globalThis.fetch;
    onCancel?: (runId: string) => void;
  },
) {
  if (options.token.length < 32) {
    throw new Error('JIAN_API_TOKEN must have at least 32 characters');
  }

  const coordination = new Coordination(options);

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body',
              'res.headers.set-cookie',
            ],
          },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true } },
    requestTimeout: 30000,
    connectionTimeout: 30000,
    bodyLimit: 256 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
  });

  void app.register(helmet, {
    // A PDF attachment opens in the browser's reader from a local blob address.
    contentSecurityPolicy: {
      directives: { mediaSrc: ["'self'", 'data:'], frameSrc: ["'self'", 'blob:'] },
    },
  });
  void app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header(
      'X-Robots-Tag',
      'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate',
    );
    return payload;
  });

  // Installed before any registrar runs, so every route below gets the contract's schema.
  app.addHook('onRoute', (route) => {
    const operation = operations.find(
      (item) => item.path === route.url && item.method === route.method,
    );

    if (operation) {
      route.schema = operationSchema(operation);
    }
  });

  configureSecurity(app, options);

  registerProviderRoutes(app, options);
  registerMetaRoutes(app);
  registerSecurityRoutes(app, options);
  registerSshRoutes(app, options);
  registerSkillRoutes(app, options);
  registerProfileRoutes(app, options);
  registerSessionRoutes(app, { ...options, coordination });
  registerMemoryRoutes(app, options);
  registerStickerRoutes(app, options);
  registerStatsRoutes(app, options);
  registerScheduleRoutes(app, options);
  registerApprovalRoutes(app, options);
  registerApplicationRoutes(app, options);
  registerDrawRoutes(app, options);
  registerDrawingRoutes(app, options);
  registerEpicRoutes(app, options);
  registerPrototypeRoutes(app, options);
  registerPautaRoutes(app, options);
  registerPriorityRoutes(app, options);
  registerQualityRoutes(app, options);
  registerWorkRoutes(app, options);
  registerSettingsRoutes(app, options);
  registerMediaRoutes(app, options);
  registerRunRoutes(app, options);
  registerCoordinationRoutes(app, { coordination });
  registerChannelRoutes(app, options);
  registerWebRoutes(app, options);
  registerReleaseRoutes(app, options);
  registerDecisionRoutes(app, options);

  registerEventRoutes(app, options);

  registerGatewayUi(app, options.uiRoot);

  return app;
}

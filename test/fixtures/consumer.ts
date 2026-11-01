import {
  getRum,
  init,
  initRum,
  molesignalRum,
  type AddErrorOptions,
  type DurationVitalReference,
  type RumClient,
  type RumEvent,
  type RumInitConfiguration,
  type RumTransportRequest,
  type RumViewEvent,
} from '@molesignal/browser-rum';

const clientToken =
  'mspat-0123456789abcdefghjkmnpqrstvwxyz0123';

const configuration: RumInitConfiguration = {
  applicationId: 'type-test',
  clientToken,
  site: 'https://rum.example.test',
  sessionReplay: {
    blockSelector: '[data-private]',
    checkoutInterval: 120_000,
  },
  sessionCookieDomain: '.example.test',
  trackBfcacheViews: true,
  account: { id: 'acme' },
  beforeSend(event, { kind }) {
    // Events are the contract's: narrow on `type` to reach the type-specific object.
    if (event.type === 'view') {
      const revision: number = event.view.revision;
      void revision;
    } else if (event.type === 'resource') {
      const url: string = event.resource.url;
      void url;
    } else if (event.type === 'error') {
      const frames = event.error.frames ?? [];
      void frames;
      // The SDK sets no fingerprint: this is how to group an error it collected itself.
      const fingerprint: string | undefined = event.error.fingerprint;
      void fingerprint;
      if (event.error.resource?.url) {
        const { pathname } = new URL(event.error.resource.url);
        event.error.fingerprint = `${event.error.resource.method} ${pathname.replace(/\d+/g, ':id')}`;
      }
    }
    event.context = { ...event.context, kind_seen_by_consumer: kind };
    return event.type === 'view' ? undefined : true;
  },
  transport: {
    async send(request: RumTransportRequest) {
      return {
        ok: request.body.length > 0 && request.kind === 'events',
        status: 200,
        body: '{"accepted":1,"rejected":[]}',
      };
    },
  },
};

const rum: RumClient = initRum(configuration);
const sameThing: RumClient = init(configuration);
const maybe: RumClient | undefined = getRum();
void sameThing;
void maybe;

rum.setTrackingConsent('granted');
rum.setUser({ id: 'user-1', plan: 'pro' });
rum.setUserProperty('team', 'blue');
rum.removeUserProperty('team');
rum.setAccount({ id: 'acme', name: 'Acme' });
rum.clearAccount();
rum.setGlobalContext({ region: 'eu' });
rum.setGlobalContextProperty('flag', true);
rum.clearGlobalContext();
rum.addAction('typed action', { cart_size: 2 });
rum.addError(new Error('typed'), { component: 'x' });
const groupedAs: AddErrorOptions = { fingerprint: 'checkout-declined' };
rum.addError(new Error('typed'), { component: 'x' }, groupedAs);
rum.addError('a string is accepted too', undefined, { fingerprint: 'string-errors' });
rum.addTiming('hero', performance.now());
rum.addFeatureFlagEvaluation('new_checkout', true);
rum.startView('Cart', { step: 1 });
rum.startView({ name: 'Pay', service: 'payments', version: '2.0.0', context: { gateway: 'x' } });
rum.setViewName('Pay (3DS)');
rum.setViewContext({ flow: 'a' });
rum.setViewContextProperty('flow', 'b');
const vital: DurationVitalReference | undefined = rum.startDurationVital('form', {
  description: 'checkout form',
});
if (vital) rum.stopDurationVital(vital, { context: { ok: true } });
rum.stopDurationVital('form');
rum.addDurationVital('manual', { startTime: Date.now() - 100, duration: 100 });
rum.startSessionReplayRecording();
rum.stopSessionReplayRecording();
rum.getTransportStats().queued;
rum.getInternalContext().view?.id;
rum.onReady(() => undefined);
void rum.flush();
void rum.stop();

molesignalRum.init(configuration);
molesignalRum.setUser({ email: 'ada@example.com' });
molesignalRum.stopSession();
molesignalRum.version.length;

declare const event: RumEvent;
declare const viewEvent: RumViewEvent;
void event;
void viewEvent.view.performance?.lcp?.sub_parts?.load_delay;

// The API added after 0.2.
export const replayLink: string | undefined = rum.getSessionReplayLink();
rum.setViewLoadingTime();
rum.logger.warn('a warning', { step: 1 }, new Error('why'));
rum.createLogger({ name: 'payments', level: 'info' }).info('paid');

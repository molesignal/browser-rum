import {
  initRum,
  type RumInitConfiguration,
  type RumTransportRequest,
} from '@molesignal/browser-rum';

const clientToken =
  'msrum_0123456789ABCDEF_0123456789ABCDEF0123456789ABCDEF';

const configuration: RumInitConfiguration = {
  applicationId: 'type-test',
  clientToken,
  site: 'https://rum.example.test',
  sessionReplay: {
    blockSelector: '[data-private]',
    checkoutInterval: 120_000,
  },
  beforeSend(event, { kind }) {
    event.kind_seen_by_consumer = kind;
  },
  transport: {
    async send(request: RumTransportRequest) {
      return {
        ok: request.body.length > 0,
        status: 200,
      };
    },
  },
};

const rum = initRum(configuration);
rum.setTrackingConsent('granted');
rum.setUser({ id: 'user-1', plan: 'pro' });
rum.addAction('typed action', { cart_size: 2 });
rum.getTransportStats().queued;
void rum.flush();

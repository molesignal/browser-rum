/**
 * TypeScript shapes of the events this SDK sends to `POST /api/v1/rum/events`.
 * They follow the MoleSignal RUM event contract (`v1.schema.json`): `date` is
 * epoch milliseconds, and every duration or time relative to the start of a
 * view is an integer number of nanoseconds.
 *
 * Unknown fields are accepted by the server, so every event keeps an index
 * signature for `beforeSend` callbacks that attach their own attributes.
 */

export type RumContext = Record<string, unknown>;

export type RumEventType =
  | 'view'
  | 'action'
  | 'error'
  | 'resource'
  | 'long_task'
  | 'vital'
  | 'log';

export interface RumCount {
  count: number;
}

export interface RumEventUser {
  id?: string;
  name?: string;
  email?: string;
  anonymous_id?: string;
  [key: string]: unknown;
}

export interface RumEventAccount {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface RumConnectivity {
  status?: 'connected' | 'not_connected' | 'maybe';
  interfaces?: Array<
    | 'bluetooth'
    | 'cellular'
    | 'ethernet'
    | 'wifi'
    | 'wimax'
    | 'mixed'
    | 'other'
    | 'unknown'
    | 'none'
  >;
  effective_type?: 'slow-2g' | '2g' | '3g' | '4g';
}

export interface RumViewReference {
  id: string;
  url: string;
  name?: string;
  referrer?: string;
  in_foreground?: boolean;
}

export type RumViewLoadingType =
  | 'initial_load'
  | 'route_change'
  | 'bf_cache'
  | 'session_renewal';

export interface RumLargestContentfulPaint {
  timestamp: number;
  target_selector?: string;
  resource_url?: string;
  sub_parts?: {
    load_delay?: number;
    load_time?: number;
    render_delay?: number;
  };
}

export interface RumViewPerformance {
  fcp?: { timestamp: number };
  lcp?: RumLargestContentfulPaint;
  fid?: { duration: number; timestamp?: number; target_selector?: string };
  inp?: {
    duration: number;
    timestamp?: number;
    target_selector?: string;
    sub_parts?: {
      input_delay?: number;
      processing_duration?: number;
      presentation_delay?: number;
    };
  };
  cls?: { score: number; timestamp?: number; target_selector?: string };
}

export interface RumViewBody extends RumViewReference {
  /** Grows by one each time the view is reported again; the server keeps the highest. */
  revision: number;
  is_active?: boolean;
  loading_type?: RumViewLoadingType;
  loading_time?: number;
  time_spent: number;
  first_byte?: number;
  dom_interactive?: number;
  dom_content_loaded?: number;
  dom_complete?: number;
  load_event?: number;
  network_settled_time?: number;
  interaction_to_next_view_time?: number;
  /** How far down the page the view went, in CSS pixels. */
  scroll?: {
    max_depth?: number;
    max_depth_scroll_top?: number;
    max_scroll_height?: number;
    max_scroll_height_time?: number;
  };
  performance?: RumViewPerformance;
  custom_timings?: Record<string, number>;
  action?: RumCount;
  error?: RumCount;
  resource?: RumCount;
  long_task?: RumCount;
  frustration?: RumCount;
}

export interface RumActionBody {
  id: string;
  type: 'custom' | 'click';
  loading_time?: number;
  target?: {
    name?: string;
    selector?: string;
    /** Where the element stands in the page, by tags and places only. */
    path?: string;
    width?: number;
    height?: number;
    /** Where in the element the click landed. */
    offset?: { x: number; y: number };
  };
  /** Where in the window the click landed. */
  position?: { x: number; y: number };
  /** Where on the page the click landed, wherever it was scrolled to. */
  page_position?: { x: number; y: number };
  name_source?:
    | 'custom_attribute'
    | 'mask_placeholder'
    | 'standard_attribute'
    | 'text_content'
    | 'mask_disallowed'
    | 'blank';
  frustration?: { type: Array<'rage_click' | 'dead_click' | 'error_click'> };
  error?: RumCount;
  long_task?: RumCount;
  resource?: RumCount;
}

export type RumErrorSource =
  | 'network'
  | 'source'
  | 'console'
  | 'custom'
  | 'report';

export interface RumErrorFrame {
  file?: string;
  function?: string;
  line?: number;
  column?: number;
  debug_id?: string;
}

export interface RumErrorBody {
  id: string;
  message: string;
  source: RumErrorSource;
  type?: string;
  /** The stack as text, for display and search. */
  stack?: string;
  /** The stack as frames, in the order of `stack`, for symbolication. */
  frames?: RumErrorFrame[];
  /**
   * Chosen by the developer, up to 128 characters. The SDK sets none: the server
   * groups errors itself, and a fingerprint overrides that grouping.
   */
  fingerprint?: string;
  handling?: 'handled' | 'unhandled';
  handling_stack?: string;
  causes?: Array<{
    message?: string;
    type?: string;
    stack?: string;
    source?: RumErrorSource;
  }>;
  source_type?: 'browser';
  /** The request that failed, on a network error. */
  resource?: {
    method?: string;
    status_code?: number;
    url?: string;
  };
  csp?: { disposition?: 'enforce' | 'report' };
  was_truncated?: boolean;
}

export interface RumResourcePhase {
  /** Offset from the start of the request. */
  start: number;
  duration: number;
}

export type RumResourceType =
  | 'document'
  | 'xhr'
  | 'beacon'
  | 'fetch'
  | 'css'
  | 'js'
  | 'image'
  | 'font'
  | 'media'
  | 'other';

export interface RumResourceBody {
  id?: string;
  type: RumResourceType;
  method?: string;
  url: string;
  status_code?: number;
  duration?: number;
  size?: number;
  encoded_body_size?: number;
  decoded_body_size?: number;
  transfer_size?: number;
  render_blocking_status?: 'blocking' | 'non-blocking';
  protocol?: string;
  delivery_type?: 'cache' | 'navigational-prefetch' | 'other';
  worker?: RumResourcePhase;
  redirect?: RumResourcePhase;
  dns?: RumResourcePhase;
  connect?: RumResourcePhase;
  ssl?: RumResourcePhase;
  first_byte?: RumResourcePhase;
  download?: RumResourcePhase;
  trace_id?: string;
  span_id?: string;
  request?: { headers?: Record<string, string> };
  response?: { headers?: Record<string, string> };
}

export interface RumLongTaskScript {
  duration?: number;
  pause_duration?: number;
  forced_style_and_layout_duration?: number;
  start_time?: number;
  execution_start?: number;
  source_url?: string;
  source_function_name?: string;
  source_char_position?: number;
  invoker?: string;
  invoker_type?:
    | 'user-callback'
    | 'event-listener'
    | 'resolve-promise'
    | 'reject-promise'
    | 'classic-script'
    | 'module-script';
  window_attribution?: string;
}

export interface RumLongTaskBody {
  id?: string;
  duration: number;
  entry_type?: 'long-task' | 'long-animation-frame';
  start_time?: number;
  blocking_duration?: number;
  render_start?: number;
  style_and_layout_start?: number;
  first_ui_event_timestamp?: number;
  scripts?: RumLongTaskScript[];
}

export interface RumVitalBody {
  id: string;
  type: 'duration';
  name: string;
  description?: string;
  duration: number;
}

export type RumLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RumLogBody {
  id: string;
  /** The name of the logger that wrote it. */
  logger?: string;
  origin?: 'logger' | 'console' | 'report' | 'sdk';
  error_type?: string;
  stack?: string;
}

export interface RumEventBase {
  date: number;
  application: { id: string };
  service?: string;
  env?: string;
  version?: string;
  source: 'browser';
  session: {
    id: string;
    /** `user` unless a test drives the page. */
    type: 'user' | 'synthetics' | 'ci_test';
    start?: number;
    has_replay?: boolean;
  };
  /** The check that drives the page, on a session of type `synthetics`. */
  synthetics?: { test_id?: string; result_id?: string; location_id?: string };
  /** The test run that drives the page, on a session of type `ci_test`. */
  ci_test?: { test_execution_id?: string };
  view: RumViewReference;
  /** On an event that is not an action: the action during which it happened. */
  action?: { id: string };
  usr?: RumEventUser;
  account?: RumEventAccount;
  tab?: { id: string };
  connectivity?: RumConnectivity;
  display?: { viewport?: { width: number; height: number } };
  device?: { locale?: string; time_zone?: string };
  sdk: {
    name: string;
    version: string;
    session_sample_rate: number;
    replay_sample_rate: number;
  };
  context?: RumContext;
  feature_flags?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RumViewEvent extends RumEventBase {
  type: 'view';
  view: RumViewBody;
}

export interface RumActionEvent extends RumEventBase {
  type: 'action';
  action: RumActionBody;
}

export interface RumErrorEvent extends RumEventBase {
  type: 'error';
  error: RumErrorBody;
}

export interface RumResourceEvent extends RumEventBase {
  type: 'resource';
  resource: RumResourceBody;
}

export interface RumLongTaskEvent extends RumEventBase {
  type: 'long_task';
  long_task: RumLongTaskBody;
}

export interface RumVitalEvent extends RumEventBase {
  type: 'vital';
  vital: RumVitalBody;
}

export interface RumLogEvent extends RumEventBase {
  type: 'log';
  level: RumLogLevel;
  message: string;
  log: RumLogBody;
}

export type RumEvent =
  | RumViewEvent
  | RumActionEvent
  | RumErrorEvent
  | RumResourceEvent
  | RumLongTaskEvent
  | RumVitalEvent
  | RumLogEvent;

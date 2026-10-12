const $ = (id) => document.getElementById(id);
const labels = {
  pending: 'Pending',
  processing: 'Processing',
  retrying: 'Retrying',
  delivered: 'Delivered',
  dead: 'Dead letter',
};
const state = {
  key: '',
  authenticated: false,
  demoMode: false,
  events: [],
  selectedId: null,
  detail: null,
  timer: null,
  refreshing: false,
  busy: false,
  epoch: 0,
  detailSequence: 0,
  tableSignature: '',
  detailSignature: '',
};
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function readableDate(value, includeDate = false) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '—';
  return (includeDate ? dateFormat : timeFormat).format(date);
}

function demoIds(result) {
  if (Array.isArray(result.ids)) return result.ids;
  if (result.ids && typeof result.ids === 'object') return Object.values(result.ids);
  return [];
}

function badge(status) {
  const safeStatus = Object.hasOwn(labels, status) ? status : 'pending';
  const element = node('span', `status-badge ${safeStatus}`);
  const dot = node('span', `status-dot ${safeStatus}`);
  dot.setAttribute('aria-hidden', 'true');
  element.append(dot, document.createTextNode(labels[safeStatus]));
  return element;
}

function announce(message) {
  $('action-status').textContent = message;
}

function showError(message) {
  $('error-text').textContent = message;
  $('error-notice').hidden = !message;
}

function clearTimer() {
  if (state.timer !== null) window.clearInterval(state.timer);
  state.timer = null;
}

function updateConnection() {
  $('connection-panel').hidden = state.authenticated;
  $('session-bar').hidden = !state.authenticated;
  $('connection-state').classList.toggle('connected', state.authenticated);
  $('connection-label').textContent = state.authenticated ? 'Connected' : 'Not connected';
  $('environment').textContent = state.demoMode ? 'Demo environment' : 'Local operations';
  $('refresh-button').disabled = !state.authenticated || state.refreshing;
  $('demo-panel').hidden = !state.authenticated || !state.demoMode;
  $('live-indicator').hidden = !state.authenticated;
  $('demo-button').disabled = state.busy;
}

function resetSession(message = '') {
  clearTimer();
  state.epoch += 1;
  state.detailSequence += 1;
  state.key = '';
  state.authenticated = false;
  state.demoMode = false;
  state.events = [];
  state.selectedId = null;
  state.detail = null;
  state.refreshing = false;
  state.busy = false;
  state.tableSignature = '';
  state.detailSignature = '';
  $('admin-key').value = '';
  for (const status of ['total', ...Object.keys(labels)]) $('count-' + status).textContent = '—';
  $('sync-time').textContent = 'Live data after connection';
  $('detail-content').hidden = true;
  $('detail-empty').hidden = false;
  $('detail-empty').querySelector('h3').textContent = 'A clear trail for every event.';
  $('detail-empty').querySelector('p').textContent =
    'Select a delivery to see attempts, response codes, and the next recovery action.';
  $('connect-button').disabled = false;
  $('connect-button').textContent = 'Connect';
  updateConnection();
  renderEvents();
  showError(message);
}

async function api(path, options = {}) {
  const headers = { 'x-api-key': state.key, ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, {
    ...options,
    headers,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function handleFailure(error, fallback) {
  if (error.status === 401 || error.status === 403) {
    resetSession('The admin key was rejected. Enter a valid key to reconnect.');
    announce('Connection closed. Automatic refresh has stopped.');
    $('admin-key').focus();
    return;
  }
  showError(`${fallback} ${error.message || 'Check the server and try again.'}`);
}

function renderEvents() {
  const filter = $('status-filter').value;
  const query = $('event-search').value.trim().toLowerCase();
  const events = state.events.filter(
    (event) =>
      (filter === 'all' || event.status === filter) &&
      `${event.type} ${event.id} ${event.deliveryId}`.toLowerCase().includes(query),
  );
  $('event-count').textContent = state.events.length;
  $('table-summary').textContent = state.authenticated
    ? `${events.length} of ${state.events.length} ${state.events.length === 1 ? 'delivery' : 'deliveries'}`
    : 'No delivery data loaded';
  const signature = JSON.stringify([events, state.selectedId, state.authenticated]);
  if (signature === state.tableSignature) return;
  state.tableSignature = signature;
  const focusedId = document.activeElement?.dataset.eventId;
  const rows = document.createDocumentFragment();
  for (const event of events) {
    const row = node('tr', event.id === state.selectedId ? 'selected' : '');
    const nameCell = node('td');
    const button = node('button', 'event-button');
    button.type = 'button';
    button.dataset.eventId = event.id;
    button.setAttribute('aria-label', `Inspect ${event.type}, event ${event.id}`);
    button.setAttribute('aria-pressed', String(event.id === state.selectedId));
    button.append(node('span', 'event-type', event.type), node('span', 'event-id mono', event.id));
    button.addEventListener('click', () => selectEvent(event.id));
    nameCell.append(button);
    const statusCell = node('td');
    statusCell.append(badge(event.status));
    const attemptCell = node('td');
    const fraction = node('span', 'attempt-fraction', event.attempts);
    fraction.append(node('span', '', ` / ${event.maxAttempts}`));
    attemptCell.append(fraction);
    const updatedCell = node('td', '', readableDate(event.updatedAt));
    updatedCell.title = String(event.updatedAt);
    row.append(nameCell, statusCell, attemptCell, updatedCell);
    rows.append(row);
  }
  $('events-body').replaceChildren(rows);
  if (focusedId) {
    const match = [...$('events-body').querySelectorAll('button')].find(
      (item) => item.dataset.eventId === focusedId,
    );
    match?.focus({ preventScroll: true });
  }
  $('queue-empty').hidden = events.length > 0;
  $('empty-title').textContent = !state.authenticated
    ? 'Your queue is waiting.'
    : state.events.length
      ? 'No matching deliveries.'
      : 'The queue is clear.';
  $('empty-description').textContent = !state.authenticated
    ? 'Connect with an admin key to inspect live deliveries.'
    : state.events.length
      ? 'Try a different status or search term.'
      : state.demoMode
        ? 'Run the demo scenario to follow three events through the delivery lifecycle.'
        : 'New events will appear here after a signed webhook is accepted.';
}

function updateRecoveryButtons() {
  const dead = state.detail?.status === 'dead';
  $('recovery-actions').hidden = !dead;
  $('recover-button').hidden = !dead || !state.demoMode;
  $('recover-button').disabled = state.busy;
  $('replay-button').disabled = state.busy;
}

function renderDetail(detail) {
  state.detail = detail;
  const signature = JSON.stringify(detail);
  updateRecoveryButtons();
  if (signature === state.detailSignature) return;
  state.detailSignature = signature;
  $('detail-empty').hidden = true;
  $('detail-content').hidden = false;
  $('detail-type').textContent = detail.type;
  $('detail-status').replaceChildren(badge(detail.status));
  $('detail-id').textContent = detail.id;
  $('detail-id').title = `Delivery ID: ${detail.deliveryId}`;
  $('detail-attempts').textContent = `${detail.attempts} of ${detail.maxAttempts}`;
  $('detail-generation').textContent = String(detail.generation);
  $('detail-created').textContent = readableDate(detail.createdAt, true);
  $('detail-created').title = detail.createdAt;
  $('detail-next').textContent = detail.nextAttemptAt
    ? readableDate(detail.nextAttemptAt, true)
    : 'Not scheduled';
  $('detail-next').title = detail.nextAttemptAt || '';
  $('detail-error').hidden = !detail.lastError;
  $('detail-error-text').textContent = detail.lastError || '';
  const history = [...(detail.history || [])].sort(
    (a, b) => a.generation - b.generation || a.number - b.number,
  );
  $('attempt-count').textContent =
    `${history.length} ${history.length === 1 ? 'attempt' : 'attempts'}`;
  $('history-empty').hidden = history.length > 0;
  const list = document.createDocumentFragment();
  for (const attempt of history) {
    const item = node('li');
    const safeResult = ['delivered', 'failed', 'abandoned', 'in-flight'].includes(attempt.result)
      ? attempt.result
      : 'failed';
    const dot = node('span', `timeline-dot ${safeResult}`);
    dot.setAttribute('aria-hidden', 'true');
    const heading = node('div', 'attempt-heading');
    const result = {
      delivered: 'Delivered',
      failed: 'Failed',
      abandoned: 'Lease expired',
      'in-flight': 'In flight',
    }[safeResult];
    const time = node('time', '', readableDate(attempt.startedAt));
    time.dateTime = attempt.startedAt;
    time.title = attempt.startedAt;
    heading.append(node('strong', '', `Attempt ${attempt.number} · ${result}`), time);
    const description =
      attempt.error ||
      (safeResult === 'delivered'
        ? 'Receiver accepted the event.'
        : safeResult === 'in-flight'
          ? 'Waiting for the receiver response.'
          : safeResult === 'abandoned'
            ? 'Worker claim expired before completion.'
            : 'Receiver did not accept the event.');
    const meta = [`Cycle ${attempt.generation}`];
    if (attempt.statusCode !== null && attempt.statusCode !== undefined)
      meta.push(`HTTP ${attempt.statusCode}`);
    if (attempt.durationMs !== null && attempt.durationMs !== undefined)
      meta.push(`${attempt.durationMs} ms`);
    item.append(
      dot,
      heading,
      node('p', 'attempt-description', description),
      node('p', 'attempt-meta', meta.join(' · ')),
    );
    list.append(item);
  }
  $('attempt-history').replaceChildren(list);
  $('event-payload').textContent = JSON.stringify(detail.event, null, 2);
}

async function loadDetail(id, epoch = state.epoch) {
  const sequence = ++state.detailSequence;
  try {
    const data = await api(`/api/events/${encodeURIComponent(id)}`);
    if (epoch !== state.epoch || id !== state.selectedId || sequence !== state.detailSequence)
      return;
    renderDetail(data.delivery);
  } catch (error) {
    if (epoch !== state.epoch || sequence !== state.detailSequence) return;
    handleFailure(error, 'Could not load this delivery.');
  }
}

async function selectEvent(id) {
  state.selectedId = id;
  state.detail = null;
  state.detailSignature = '';
  $('detail-content').hidden = true;
  $('detail-empty').hidden = false;
  $('detail-empty').querySelector('h3').textContent = 'Loading delivery…';
  $('detail-empty').querySelector('p').textContent =
    'Fetching its event payload and attempt history.';
  renderEvents();
  await loadDetail(id);
}

async function refresh({ initial = false, manual = false } = {}) {
  if (state.refreshing || (!state.authenticated && !initial)) return;
  const epoch = state.epoch;
  state.refreshing = true;
  updateConnection();
  try {
    const results = await Promise.all([
      api('/api/overview'),
      api('/api/events'),
      ...(initial ? [api('/api/config')] : []),
    ]);
    if (epoch !== state.epoch) return;
    const [overview, collection, config] = results;
    if (initial) {
      state.authenticated = true;
      state.demoMode = Boolean(config.demoMode);
    }
    state.events = collection.events;
    $('count-total').textContent = overview.total;
    for (const status of Object.keys(labels))
      $('count-' + status).textContent = overview.counts[status];
    $('sync-time').textContent = `Updated ${readableDate(new Date().toISOString())}`;
    showError('');
    renderEvents();
    if (state.selectedId && state.events.some((event) => event.id === state.selectedId))
      await loadDetail(state.selectedId, epoch);
    if (initial) announce('Connected. Delivery data refreshes every two seconds.');
    if (manual) announce('Delivery queue refreshed.');
  } catch (error) {
    if (epoch !== state.epoch) return;
    handleFailure(error, initial ? 'Could not connect.' : 'Could not refresh the queue.');
    if (initial && state.key) state.key = '';
  } finally {
    if (epoch === state.epoch) {
      state.refreshing = false;
      updateConnection();
    }
  }
}

$('connection-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = $('admin-key').value.trim();
  if (!key) return;
  clearTimer();
  state.epoch += 1;
  state.key = key;
  $('admin-key').value = '';
  $('connect-button').disabled = true;
  $('connect-button').textContent = 'Connecting…';
  announce('Connecting to your delivery queue…');
  await refresh({ initial: true });
  $('connect-button').disabled = false;
  $('connect-button').textContent = 'Connect';
  if (state.authenticated) state.timer = window.setInterval(() => refresh(), 2000);
  else announce('Connection was not established. Check the key and try again.');
});
$('disconnect-button').addEventListener('click', () => {
  resetSession();
  announce('Disconnected. The admin key has been removed from memory.');
  $('admin-key').focus();
});
$('refresh-button').addEventListener('click', () => refresh({ manual: true }));
$('event-search').addEventListener('input', renderEvents);
$('status-filter').addEventListener('change', renderEvents);

async function runAction(path, busyMessage, successMessage) {
  if (!state.authenticated || state.busy) return;
  const epoch = state.epoch;
  state.busy = true;
  updateConnection();
  updateRecoveryButtons();
  showError('');
  announce(busyMessage);
  try {
    const result = await api(path, { method: 'POST', body: '{}' });
    if (epoch !== state.epoch) return;
    announce(typeof successMessage === 'function' ? successMessage(result) : successMessage);
    await refresh();
    const ids = demoIds(result);
    if (ids.length) await selectEvent(ids[0]);
  } catch (error) {
    if (epoch !== state.epoch) return;
    handleFailure(error, 'Action could not be completed.');
    announce('Action failed. Review the error before trying again.');
  } finally {
    if (epoch === state.epoch) {
      state.busy = false;
      updateConnection();
      updateRecoveryButtons();
    }
  }
}
$('demo-button').addEventListener('click', () =>
  runAction(
    '/api/demo/run',
    'Submitting the demo events…',
    (result) =>
      `${demoIds(result).length} demo events submitted.${result.duplicateSuppressed ? ' Duplicate suppressed.' : ''} Watch the queue as the worker delivers and retries.`,
  ),
);
$('replay-button').addEventListener('click', () => {
  if (state.detail?.status !== 'dead') return;
  runAction(
    `/api/events/${encodeURIComponent(state.selectedId)}/replay`,
    'Starting a new delivery cycle…',
    'Delivery replayed. Its previous attempt history is preserved.',
  );
});
$('recover-button').addEventListener('click', () => {
  if (state.detail?.status !== 'dead' || !state.demoMode) return;
  runAction(
    `/api/demo/recover/${encodeURIComponent(state.selectedId)}`,
    'Repairing the demo receiver and replaying…',
    'Demo receiver repaired. Delivery replayed in a new cycle.',
  );
});
window.addEventListener('pagehide', () => {
  resetSession();
});
renderEvents();

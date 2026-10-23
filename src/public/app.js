const form = document.querySelector('#selection');
const byId = (id) => document.getElementById(id);
let catalog = [];
let lastAssessment = null;
let lastLoad = null;
let busy = false;
let poll;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function bytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not reported';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${value.toLocaleString()} bytes`;
}

function selection() {
  const fields = form.elements;
  return { languageModel: fields.namedItem('languageModel').value, embedding: fields.namedItem('embedding').checked, speech: fields.namedItem('speech').checked, contextTokens: Number(fields.namedItem('contextTokens').value), backend: fields.namedItem('backend').value, execution: fields.namedItem('execution').value };
}

function selectedModels() {
  const value = selection();
  return catalog.filter((entry) => entry.id === value.languageModel || (entry.role === 'embedding' && value.embedding) || (entry.role === 'speech' && value.speech));
}

function sameSelection() { return lastAssessment && JSON.stringify(lastAssessment.selection) === JSON.stringify(selection()); }

function updateControls() {
  byId('assess').disabled = busy;
  for (const control of form.elements) control.disabled = busy;
  const same = sameSelection();
  byId('stale').hidden = !lastAssessment || same;
  byId('load').disabled = busy || !same || lastAssessment.assessment.verdict === 'likely-too-large' || !byId('confirm-load').checked;
  byId('confirm-load').disabled = busy || !same || lastAssessment?.assessment.verdict === 'likely-too-large';
  const size = selectedModels().reduce((total, model) => total + model.diskBytes, 0);
  byId('disk-total').replaceChildren(element('strong', bytes(size)), document.createTextNode(' of model files if all need downloading. Disk size, not a RAM estimate.'));
  const primary = selectedModels().find((model) => model.role === 'language');
  byId('model-file-size').textContent = primary ? `${bytes(primary.diskBytes)} model file` : 'Catalog file size will appear here.';
  byId('selected-model-name').textContent = primary?.label ?? 'Loading catalog';
  byId('selected-model-file').textContent = primary ? bytes(primary.diskBytes) : '';
  byId('selected-accessories').replaceChildren(...selectedModels().filter((model) => model.role !== 'language').map((model) => {
    const row = element('div', undefined, 'selected-accessory');
    row.append(element('span', model.role === 'embedding' ? 'Text search' : 'Speech recognition'), element('span', bytes(model.diskBytes), 'measure'));
    return row;
  }));
}

async function api(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}

function error(message) {
  byId('error').textContent = message;
  byId('error').hidden = !message;
}

function list(target, items) {
  target.replaceChildren(...(items ?? []).map((item) => element('li', item)));
}

function description(target, values) {
  const dl = element('dl');
  for (const [label, value] of values) {
    if (value === undefined || value === null) continue;
    dl.append(element('dt', label), element('dd', value));
  }
  target.append(dl);
}

function verdictLabel(verdict) {
  return { 'likely-fits': 'Likely fits', 'likely-too-large': 'Likely too large', unknown: 'Unknown', fit: 'Engine probe: fit', 'does-not-fit': 'Engine probe: does not fit' }[verdict] ?? verdict;
}

function verdictClass(verdict) { return ['likely-fits', 'fit'].includes(verdict) ? 'good' : ['likely-too-large', 'does-not-fit'].includes(verdict) ? 'bad' : 'unknown'; }

function renderAssessment(data) {
  lastAssessment = data;
  const result = data.assessment;
  byId('awaiting-result').hidden = true;
  byId('results').hidden = false;
  byId('load-section').hidden = false;
  byId('result-time').textContent = `Sampled ${new Date(data.assessedAt).toLocaleString()}. Memory can change after this check.`;
  byId('verdict').textContent = verdictLabel(result.verdict);
  byId('verdict').className = `verdict ${verdictClass(result.verdict)}`;
  const evidenceText = result.evidence === 'native-fit' ? "The engine's own fitter supplied the evidence." : result.evidence === 'computed-only' ? 'Only a computed memory floor is available. It can rule out a load, but cannot confirm a fit.' : 'There is not enough reported evidence to judge this lineup.';
  byId('evidence').textContent = `${evidenceText} Budget basis: ${result.basis ?? 'not reported'}.`;
  byId('budget').replaceChildren();
  if (result.budget) description(byId('budget'), [
    ['Total memory under this basis', bytes(result.budget.totalBytes)],
    ['Memory in use at sample time', bytes(result.budget.usedBytes)],
    ['Available before reserve', bytes(result.budget.availableBytes)],
    ['SDK reserve', bytes(result.budget.reservedBytes)],
    ['Budget after reserve', bytes(result.budget.availableAfterReserveBytes)]
  ]);
  if (result.floorBytes !== undefined) byId('budget').append(element('p', `Combined computed floor: ${bytes(result.floorBytes)}. True memory demand can be higher.`));
  list(byId('reasons'), result.reasons);
  list(byId('assumptions'), result.assumptions);
  byId('models').replaceChildren();
  for (let index = 0; index < result.models.length; index += 1) {
    const model = result.models[index];
    const article = element('article', undefined, 'model');
    article.append(element('h3', model.name), element('p', verdictLabel(model.verdict), verdictClass(model.verdict)));
    description(article, [
      ['Evidence', model.evidence ?? 'None reported'],
      ['Resolved execution device', model.device ?? 'Not reported'],
      ['Model file size on disk', bytes(data.artifacts[index]?.diskBytes)],
      ['Computed memory floor', model.floorBytes !== undefined ? bytes(model.floorBytes) : undefined],
      ['Estimator', model.estimatorVersion]
    ]);
    const reasons = element('ul');
    list(reasons, model.reasons);
    article.append(reasons);
    byId('models').append(article);
  }
  byId('confirm-load').checked = false;
  updateControls();
}

function renderProjection(target, probe) {
  if (!probe) { target.append(element('p', 'The SDK did not return a fit probe for this load.')); return; }
  target.append(element('p', verdictLabel(probe.verdict), verdictClass(probe.verdict)));
  description(target, [['Probe reason', probe.reason], ['Detail', probe.message], ['Engine', probe.engine]]);
  if (probe.plan) description(target, [['Resolved context', probe.plan.nCtx], ['GPU layers', probe.plan.nGpuLayers], ['GPU devices', probe.plan.nGpuDevices]]);
  const projection = probe.projection;
  if (!projection) return;
  description(target, [
    ['Projected device', projection.deviceName],
    ['Projected device peak', projection.deviceBytes !== undefined ? bytes(projection.deviceBytes) : undefined],
    ['Projected host RAM peak', projection.hostBytes !== undefined ? bytes(projection.hostBytes) : undefined]
  ]);
  if (projection.devices?.length) {
    const table = element('table');
    const caption = element('caption', 'Memory placement reported by the engine');
    const header = element('tr');
    for (const text of ['Device', 'Total', 'Free', 'Weights', 'Context', 'Compute']) { const th = element('th', text); th.scope = 'col'; header.append(th); }
    const head = element('thead'); head.append(header);
    const body = element('tbody');
    for (const device of projection.devices) {
      const row = element('tr');
      for (const value of [device.name, bytes(device.totalBytes), bytes(device.freeBytes), bytes(device.weightsBytes), bytes(device.contextBytes), bytes(device.computeBytes)]) row.append(element('td', value));
      body.append(row);
    }
    table.append(caption, head, body);
    target.append(table);
  }
  if (projection.report) { const details = element('details'); details.append(element('summary', 'Engine memory report'), element('pre', projection.report)); target.append(details); }
}

function renderLoad(data) {
  lastLoad = data;
  byId('load-result').replaceChildren();
  const title = data.cancelled ? 'Load test cancelled' : data.ok ? 'Load test complete' : 'Load test did not complete';
  byId('load-result').append(element('h3', title), element('p', `${data.releasedModels} loaded model(s) released. Cached files remain on disk.`));
  for (const check of data.checks) {
    const article = element('article', undefined, 'model');
    article.append(element('h3', check.label));
    renderProjection(article, check.fitProbe);
    byId('load-result').append(article);
  }
  for (const item of data.failure ?? []) byId('load-result').append(element('p', `${item.name}: ${item.message}`, 'bad'));
  if (data.cleanupErrors.length) byId('load-result').append(element('p', 'Some models could not be released. Restart this local app to close the worker before testing again.', 'bad'));
}

async function pollStatus() {
  try {
    const data = await api('status');
    if (data.active) {
      busy = true;
      let text = data.active.stage;
      const progress = data.active.progress;
      if (progress) text += `: ${typeof progress.percentage === 'number' ? `${progress.percentage.toFixed(1)}%. ` : ''}${bytes(progress.downloaded)} of ${bytes(progress.total)}. Last progress ${new Date(progress.at).toLocaleTimeString()}.`;
      byId('activity').textContent = text;
      byId('cancel').hidden = data.active.kind !== 'load';
    }
    updateControls();
  } catch (issue) { byId('activity').textContent = `Waiting for the local app: ${issue.message}`; }
}

async function run(kind, payload) {
  error('');
  busy = true;
  byId('activity').textContent = kind === 'assess' ? 'Checking current memory and model metadata. The first check may need the registry.' : 'Starting explicit download and load test.';
  byId('cancel').hidden = kind !== 'load';
  updateControls();
  poll = setInterval(pollStatus, 1500);
  try {
    const data = await api(kind, payload);
    if (kind === 'assess') renderAssessment(data);
    else renderLoad(data);
    byId('activity').textContent = kind === 'assess' ? 'Memory assessment complete.' : 'Load test finished.';
  } catch (issue) { error(`${issue.message} No new fit claim has been made.`); byId('activity').textContent = ''; }
  finally { clearInterval(poll); busy = false; byId('cancel').hidden = true; updateControls(); }
}

form.addEventListener('submit', (event) => { event.preventDefault(); if (form.reportValidity()) run('assess', selection()); });
form.addEventListener('input', () => { byId('confirm-load').checked = false; updateControls(); });
byId('confirm-load').addEventListener('change', updateControls);
byId('load').addEventListener('click', () => run('load', { selection: selection(), confirmDownloadAndLoad: true }));
byId('cancel').addEventListener('click', async () => {
  try { await api('cancel', {}); byId('activity').textContent = 'Cancellation requested. Waiting for resource cleanup.'; }
  catch (issue) { error(issue.message); }
});
byId('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ app: 'ModelGarage', sdkVersion: '0.22.0', assessment: lastAssessment, load: lastLoad }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = element('a'); link.href = url; link.download = `modelgarage-${Date.now()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function init() {
  try {
    const data = await api('status');
    catalog = data.catalog;
    byId('language-model').replaceChildren();
    for (const entry of catalog.filter((model) => model.role === 'language')) {
      const option = element('option', entry.label); option.value = entry.id; byId('language-model').append(option);
    }
    byId('embedding-size').textContent = bytes(catalog.find((model) => model.role === 'embedding')?.diskBytes);
    byId('speech-size').textContent = bytes(catalog.find((model) => model.role === 'speech')?.diskBytes);
    if (data.lastAssessment) {
      for (const [name, value] of Object.entries(data.lastAssessment.selection)) {
        const control = form.elements.namedItem(name);
        if (control.type === 'checkbox') control.checked = value;
        else control.value = value;
      }
      renderAssessment(data.lastAssessment);
    }
    if (data.lastLoad) renderLoad(data.lastLoad);
    if (data.active) { busy = true; poll = setInterval(async () => { await pollStatus(); const state = await api('status'); if (!state.active) { clearInterval(poll); busy = false; byId('cancel').hidden = true; if (state.lastAssessment) renderAssessment(state.lastAssessment); if (state.lastLoad) renderLoad(state.lastLoad); byId('activity').textContent = 'Check finished.'; updateControls(); } }, 1500); }
    updateControls();
  } catch (issue) { error(`Cannot reach ModelGarage. ${issue.message}`); byId('assess').disabled = true; }
}

init();

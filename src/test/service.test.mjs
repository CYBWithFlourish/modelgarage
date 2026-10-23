import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, createMatchmaker, buildCandidates, validateSelection } from '../service.mjs';

function fakeSdk(verdict = 'likely-fits') {
  const calls = { assess: [], load: [], info: [], unload: [], cancel: [] };
  const sdk = {
    ...Object.fromEntries(CATALOG.map((entry) => [entry.exportName, { src: `registry://test/${entry.id}`, sha256Checksum: entry.id, name: entry.exportName, expectedSize: entry.diskBytes }])),
    async assessModelFit(input) {
      calls.assess.push(input);
      return { verdict, basis: 'system-memory', execution: input.execution, evidence: verdict === 'unknown' ? 'computed-only' : 'native-fit', floorBytes: verdict === 'unknown' ? 500 : undefined, models: input.models.map((model) => ({ name: model.modelSrc.name, verdict, reasons: verdict === 'unknown' ? ['No native verdict'] : [], device: 'gpu' })), reasons: verdict === 'unknown' ? ['A computed floor cannot confirm a fit'] : [], assumptions: ['Test memory budget'] };
    },
    loadModel(input) { calls.load.push(input); const result = Promise.resolve(`loaded-${calls.load.length}`); result.requestId = `request-${calls.load.length}`; return result; },
    async getLoadedModelInfo(input) { calls.info.push(input); return { modelType: 'test', handlers: [], fitProbe: { verdict: 'fit', reason: 'projected', projection: { devices: [{ name: 'GPU', totalBytes: 100, freeBytes: 90, weightsBytes: 10, contextBytes: 5, computeBytes: 2 }] } } }; },
    async unloadModel(input) { calls.unload.push(input); },
    async cancel(input) { calls.cancel.push(input); }
  };
  return { sdk, calls };
}

test('status is local metadata and never initializes or loads the SDK', () => {
  let initialized = 0;
  const app = createMatchmaker({ getSdk: async () => { initialized += 1; throw new Error('Should not import'); } });
  assert.equal(app.status().catalog.length, 6);
  assert.equal(app.status().lastAssessment, null);
  assert.equal(initialized, 0);
});

test('invalid contexts, unlisted models, configs, and backend injection reject', () => {
  for (const contextTokens of [0, -1, 511, 32769, 512.5, '2048', null, NaN, Infinity]) assert.throws(() => validateSelection({ contextTokens }), { status: 400 });
  for (const input of [{ languageModel: '/tmp/model.gguf' }, { backend: 'cpu;curl bad' }, { modelConfig: { ctx_size: 2 } }, { execution: 'unload-between' }, { embedding: 'yes' }, []]) assert.throws(() => validateSelection(input), { status: 400 });
  assert.equal(validateSelection({ contextTokens: 32768 }).contextTokens, 32768);
});

test('combination assessment passes only verified candidates and valid configs', async () => {
  const { sdk, calls } = fakeSdk();
  const app = createMatchmaker({ getSdk: async () => sdk });
  const result = await app.assess({ languageModel: 'qwen3-4b', embedding: true, speech: true, backend: 'cuda', contextTokens: 8192, execution: 'concurrent' });
  assert.equal(result.assessment.verdict, 'likely-fits');
  assert.equal(calls.assess.length, 1);
  assert.equal(calls.load.length, 0);
  assert.equal(calls.assess[0].models.length, 3);
  assert.deepEqual(calls.assess[0].models[0].modelConfig, { ctx_size: 8192, backend: ['cuda'] });
  assert.deepEqual(calls.assess[0].models[1].modelConfig, { backend: ['cuda'] });
  assert.deepEqual(calls.assess[0].models[2].modelConfig, { duration_ms: 30000, contextParams: { use_gpu: false } });
  assert.equal(calls.assess[0].execution, 'concurrent');
  assert.equal(calls.assess[0].policy, 'interactive-v1');
});

test('CPU is a device selection and never an invalid GPU backend value', () => {
  const { sdk } = fakeSdk();
  const candidates = buildCandidates(sdk, validateSelection({ embedding: true, backend: 'cpu' }));
  assert.equal(candidates[0].modelConfig.device, 'cpu');
  assert.equal(candidates[1].modelConfig.device, 'cpu');
  assert.equal(candidates[0].modelConfig.backend, undefined);
});

test('cached descriptors retain catalog checksum and names for SDK assessment and load', async () => {
  const { sdk, calls } = fakeSdk();
  const resolutions = [];
  const app = createMatchmaker({
    getSdk: async () => sdk,
    resolveModel: async (descriptor) => {
      resolutions.push(descriptor);
      return `/verified/cache/${descriptor.name}.gguf`;
    }
  });
  const selection = { embedding: true, speech: true, contextTokens: 4096, backend: 'metal', execution: 'concurrent' };
  const result = await app.assess(selection);
  const expected = buildCandidates(sdk, validateSelection(selection));
  assert.equal(calls.load.length, 0);
  for (let index = 0; index < expected.length; index += 1) {
    assert.deepEqual(calls.assess[0].models[index].modelSrc, { ...expected[index].modelSrc, src: `/verified/cache/${expected[index].modelSrc.name}.gguf` });
    assert.equal(calls.assess[0].models[index].modelSrc.sha256Checksum, expected[index].modelSrc.sha256Checksum);
    assert.equal(calls.assess[0].models[index].modelSrc.name, expected[index].modelSrc.name);
    assert.equal(calls.assess[0].models[index].modelType, expected[index].modelType);
    assert.deepEqual(calls.assess[0].models[index].modelConfig, expected[index].modelConfig);
    assert.equal(result.artifacts[index].name, expected[index].modelSrc.name);
    assert.equal(result.artifacts[index].diskBytes, expected[index].modelSrc.expectedSize);
  }
  await app.load({ selection, confirmDownloadAndLoad: true });
  for (let index = 0; index < expected.length; index += 1) {
    assert.deepEqual(calls.load[index].modelSrc, { ...expected[index].modelSrc, src: `/verified/cache/${expected[index].modelSrc.name}.gguf` });
    assert.equal(calls.load[index].modelType, expected[index].modelType);
    assert.deepEqual(calls.load[index].modelConfig, expected[index].modelConfig);
    assert.equal(calls.load[index].modelFitPolicy, 'refuse');
  }
  assert.equal(resolutions.length, 6);
  assert.equal(sdk.QWEN3_600M_INST_Q4.src, 'registry://test/qwen3-600m');
});

test('an uncached model keeps the exact catalog descriptor for assessment', async () => {
  const { sdk, calls } = fakeSdk();
  const app = createMatchmaker({ getSdk: async () => sdk, resolveModel: async (descriptor) => descriptor });
  await app.assess({ embedding: true });
  assert.equal(calls.assess[0].models[0].modelSrc, sdk.QWEN3_600M_INST_Q4);
  assert.equal(calls.assess[0].models[1].modelSrc, sdk.EMBEDDINGGEMMA_300M_Q4_0);
});

test('a failed cache verification prevents the SDK assessment', async () => {
  const { sdk, calls } = fakeSdk();
  const app = createMatchmaker({ getSdk: async () => sdk, resolveModel: async () => { throw new Error('Cached model failed its checksum'); } });
  await assert.rejects(app.assess({}), /failed its checksum/);
  assert.equal(calls.assess.length, 0);
  assert.equal(calls.load.length, 0);
  assert.equal(app.status().active, null);
});

test('SDK unknown evidence stays unknown with its original reasons and without invented estimates', async () => {
  const { sdk, calls } = fakeSdk('unknown');
  const app = createMatchmaker({ getSdk: async () => sdk });
  const result = await app.assess({});
  assert.equal(result.assessment.verdict, 'unknown');
  assert.equal(result.assessment.evidence, 'computed-only');
  assert.equal(result.assessment.budget, undefined);
  assert.deepEqual(result.assessment.reasons, ['A computed floor cannot confirm a fit']);
  assert.equal(calls.load.length, 0);
});

test('SDK failure does not fabricate an unknown assessment', async () => {
  const { sdk } = fakeSdk();
  sdk.assessModelFit = async () => { throw new Error('Worker unavailable'); };
  const app = createMatchmaker({ getSdk: async () => sdk });
  await assert.rejects(app.assess({}), /Worker unavailable/);
  assert.equal(app.status().lastAssessment, null);
  assert.equal(app.status().active, null);
});

test('incomplete SDK combination results reject rather than claiming a fit', async () => {
  const { sdk } = fakeSdk();
  sdk.assessModelFit = async () => ({ verdict: 'likely-fits', models: [] });
  const app = createMatchmaker({ getSdk: async () => sdk });
  await assert.rejects(app.assess({ embedding: true }), { status: 502 });
});

test('load requires explicit acknowledgement and a matching prior assessment', async () => {
  const { sdk, calls } = fakeSdk();
  const app = createMatchmaker({ getSdk: async () => sdk });
  await assert.rejects(app.load({ selection: {} }), { status: 400 });
  await assert.rejects(app.load({ selection: {}, confirmDownloadAndLoad: true }), { status: 409 });
  await app.assess({});
  await assert.rejects(app.load({ selection: { contextTokens: 4096 }, confirmDownloadAndLoad: true }), { status: 409 });
  assert.equal(calls.load.length, 0);
});

test('likely-too-large combination cannot be sent to the optional load test', async () => {
  const { sdk, calls } = fakeSdk('likely-too-large');
  const app = createMatchmaker({ getSdk: async () => sdk });
  await app.assess({});
  await assert.rejects(app.load({ selection: {}, confirmDownloadAndLoad: true }), { status: 409 });
  assert.equal(calls.load.length, 0);
});

test('explicit load applies refusal, preserves actual per device projection, then unloads in reverse', async () => {
  const { sdk, calls } = fakeSdk();
  const app = createMatchmaker({ getSdk: async () => sdk });
  const selection = { embedding: true, speech: true };
  await app.assess(selection);
  const result = await app.load({ selection, confirmDownloadAndLoad: true });
  assert.equal(result.ok, true);
  assert.equal(result.releasedModels, 3);
  assert.equal(calls.load.length, 3);
  assert.ok(calls.load.every((load) => load.modelFitPolicy === 'refuse'));
  assert.deepEqual(calls.unload.map((call) => call.modelId), ['loaded-3', 'loaded-2', 'loaded-1']);
  assert.equal(result.checks[0].fitProbe.projection.devices[0].name, 'GPU');
});

test('a later refusal releases earlier models and reports the original error', async () => {
  const { sdk, calls } = fakeSdk();
  const original = sdk.loadModel;
  sdk.loadModel = (input) => {
    if (calls.load.length === 1) { calls.load.push(input); return Promise.reject(Object.assign(new Error('Projected load refused'), { code: 99 })); }
    return original(input);
  };
  const app = createMatchmaker({ getSdk: async () => sdk });
  await app.assess({ embedding: true });
  const result = await app.load({ selection: { embedding: true }, confirmDownloadAndLoad: true });
  assert.equal(result.ok, false);
  assert.equal(result.releasedModels, 1);
  assert.equal(result.failure[0].message, 'Projected load refused');
  assert.deepEqual(calls.unload, [{ modelId: 'loaded-1' }]);
});

test('cleanup failure is visible and never reported as a successful release', async () => {
  const { sdk } = fakeSdk();
  sdk.unloadModel = async () => { throw new Error('Cleanup failed'); };
  const app = createMatchmaker({ getSdk: async () => sdk });
  await app.assess({});
  const result = await app.load({ selection: {}, confirmDownloadAndLoad: true });
  assert.equal(result.ok, false);
  assert.equal(result.releasedModels, 0);
  assert.equal(result.cleanupErrors.length, 1);
});

test('overlapping native checks reject and cancellation targets the active request', async () => {
  const { sdk, calls } = fakeSdk();
  let rejectLoad;
  sdk.loadModel = (input) => { calls.load.push(input); const result = new Promise((resolve, reject) => { rejectLoad = reject; }); result.requestId = 'active-request'; return result; };
  const app = createMatchmaker({ getSdk: async () => sdk });
  await app.assess({});
  const pending = app.load({ selection: {}, confirmDownloadAndLoad: true });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(app.assess({}), { status: 409 });
  await app.cancel();
  assert.deepEqual(calls.cancel, [{ requestId: 'active-request' }]);
  rejectLoad(new Error('Cancelled'));
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.ok, false);
  assert.equal(app.status().active, null);
});

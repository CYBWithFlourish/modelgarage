import { HttpError } from '../shared/http.mjs';
import { resolveCachedModel } from '../shared/qvac.mjs';

export const CATALOG = Object.freeze([
  { id: 'qwen3-600m', label: 'Qwen3 600M Q4', exportName: 'QWEN3_600M_INST_Q4', role: 'language', modelType: 'llamacpp-completion', diskBytes: 382156480 },
  { id: 'qwen3-1.7b', label: 'Qwen3 1.7B Q4', exportName: 'QWEN3_1_7B_INST_Q4', role: 'language', modelType: 'llamacpp-completion', diskBytes: 1056782912 },
  { id: 'qwen3-4b', label: 'Qwen3 4B Q4 K M', exportName: 'QWEN3_4B_INST_Q4_K_M', role: 'language', modelType: 'llamacpp-completion', diskBytes: 2497280256 },
  { id: 'qwen3-8b', label: 'Qwen3 8B Q4 K M', exportName: 'QWEN3_8B_INST_Q4_K_M', role: 'language', modelType: 'llamacpp-completion', diskBytes: 5027783488 },
  { id: 'embeddinggemma-300m', label: 'EmbeddingGemma 300M Q4', exportName: 'EMBEDDINGGEMMA_300M_Q4_0', role: 'embedding', modelType: 'llamacpp-embedding', diskBytes: 277852192 },
  { id: 'whisper-tiny-en', label: 'Whisper Tiny English Q8', exportName: 'WHISPER_EN_TINY_Q8_0', role: 'speech', modelType: 'whispercpp-transcription', diskBytes: 43550795 }
].map(Object.freeze));

export const BACKENDS = Object.freeze(['default', 'cpu', 'cuda', 'metal', 'vulkan', 'opencl']);
const selectionKeys = new Set(['languageModel', 'embedding', 'speech', 'contextTokens', 'backend', 'execution']);

export function validateSelection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Choose a model combination.');
  for (const key of Object.keys(input)) {
    if (!selectionKeys.has(key)) throw new HttpError(400, `Unsupported setting: ${key}.`);
    if (input[key] === null) throw new HttpError(400, `Choose a value for ${key}.`);
  }
  const selection = {
    languageModel: input.languageModel ?? 'qwen3-600m',
    embedding: input.embedding ?? false,
    speech: input.speech ?? false,
    contextTokens: input.contextTokens ?? 2048,
    backend: input.backend ?? 'default',
    execution: input.execution ?? 'sequential'
  };
  if (!CATALOG.some((model) => model.id === selection.languageModel && model.role === 'language')) throw new HttpError(400, 'Choose a language model from the catalog.');
  if (typeof selection.embedding !== 'boolean' || typeof selection.speech !== 'boolean') throw new HttpError(400, 'Embedding and speech settings must be true or false.');
  if (!Number.isInteger(selection.contextTokens) || selection.contextTokens < 512 || selection.contextTokens > 32768) throw new HttpError(400, 'Context must be a whole number from 512 to 32768 tokens.');
  if (!BACKENDS.includes(selection.backend)) throw new HttpError(400, 'Choose an available backend preference.');
  if (!['sequential', 'concurrent'].includes(selection.execution)) throw new HttpError(400, 'Execution must be sequential or concurrent.');
  return selection;
}

export function selectedEntries(selection) {
  return CATALOG.filter((entry) => entry.id === selection.languageModel || (entry.role === 'embedding' && selection.embedding) || (entry.role === 'speech' && selection.speech));
}

export function buildCandidates(sdk, selection) {
  return selectedEntries(selection).map((entry) => {
    const modelSrc = sdk[entry.exportName];
    if (!modelSrc?.src || !modelSrc?.sha256Checksum) throw new HttpError(503, `SDK catalog entry ${entry.exportName} is unavailable. Install @qvac/sdk 0.22.0 in this project folder.`);
    let modelConfig;
    if (entry.role === 'speech') {
      modelConfig = { duration_ms: 30000, contextParams: { use_gpu: false } };
    } else {
      modelConfig = entry.role === 'language' ? { ctx_size: selection.contextTokens } : {};
      if (selection.backend === 'cpu') modelConfig.device = 'cpu';
      else if (selection.backend !== 'default') modelConfig.backend = [selection.backend];
    }
    return { modelSrc, modelType: entry.modelType, modelConfig };
  });
}

function describeError(error) {
  const chain = [];
  let current = error;
  for (let index = 0; current && index < 4; index += 1) {
    chain.push({ name: String(current.name ?? 'Error'), message: String(current.message ?? current), ...(current.code !== undefined ? { code: current.code } : {}) });
    current = current.cause;
  }
  return chain;
}

export function createMatchmaker({ getSdk, resolveModel = resolveCachedModel }) {
  let active = null;
  let lastAssessment = null;
  let lastLoad = null;
  let currentRequestId = null;
  let cancellationRequested = false;
  let sdkInstance;

  async function resolveCandidates(candidates) {
    return Promise.all(candidates.map(async (candidate) => {
      const resolved = await resolveModel(candidate.modelSrc);
      return { ...candidate, modelSrc: typeof resolved === 'string' ? { ...candidate.modelSrc, src: resolved } : resolved };
    }));
  }

  function status() {
    return { app: 'ModelGarage', sdkVersion: '0.22.0', catalog: CATALOG, backends: BACKENDS, active, lastAssessment, lastLoad };
  }

  function begin(kind, selection) {
    if (active) throw new HttpError(409, 'A model check is already running. Wait for it to finish or cancel the load test.');
    active = { kind, selection, startedAt: new Date().toISOString(), stage: 'Starting', progress: null };
    cancellationRequested = false;
  }

  async function assess(input) {
    const selection = validateSelection(input);
    begin('assessment', selection);
    try {
      active.stage = 'Reading the current memory budget and model metadata';
      const sdk = sdkInstance = await getSdk();
      const candidates = buildCandidates(sdk, selection);
      const resolvedCandidates = await resolveCandidates(candidates);
      const assessment = await sdk.assessModelFit({ models: resolvedCandidates, execution: selection.execution, policy: 'interactive-v1' });
      if (!['likely-fits', 'likely-too-large', 'unknown'].includes(assessment?.verdict) || !Array.isArray(assessment.models) || assessment.models.length !== candidates.length) throw new HttpError(502, 'The SDK returned an incomplete assessment. No fit claim has been made.');
      lastAssessment = {
        assessedAt: new Date().toISOString(), selection, assessment,
        artifacts: candidates.map((candidate, index) => ({ id: selectedEntries(selection)[index].id, name: candidate.modelSrc.name, diskBytes: candidate.modelSrc.expectedSize ?? null }))
      };
      return lastAssessment;
    } finally { active = null; }
  }

  async function load(input) {
    if (!input || typeof input !== 'object' || input.confirmDownloadAndLoad !== true) throw new HttpError(400, 'Confirm that this test may download model weights and allocate memory.');
    if (Object.keys(input).some((key) => !['selection', 'confirmDownloadAndLoad'].includes(key))) throw new HttpError(400, 'Unsupported load test setting.');
    const selection = validateSelection(input.selection);
    if (!lastAssessment || JSON.stringify(lastAssessment.selection) !== JSON.stringify(selection)) throw new HttpError(409, 'Assess this exact combination before testing its load.');
    if (lastAssessment.assessment.verdict === 'likely-too-large') throw new HttpError(409, 'This combination is likely too large. Choose a smaller combination before testing its load.');
    begin('load', selection);
    const loaded = [];
    const checks = [];
    const cleanupErrors = [];
    let failure;
    try {
      const sdk = sdkInstance = await getSdk();
      const candidates = buildCandidates(sdk, selection);
      const resolvedCandidates = await resolveCandidates(candidates);
      for (let index = 0; index < candidates.length; index += 1) {
        if (cancellationRequested) throw new Error('The load test was cancelled.');
        const entry = selectedEntries(selection)[index];
        active.stage = `Loading ${entry.label} with refusal enabled`;
        active.currentModel = entry.id;
        active.progress = null;
        const operation = sdk.loadModel({
          ...resolvedCandidates[index], modelFitPolicy: 'refuse',
          onProgress: (progress) => {
            if (active) active.progress = { percentage: progress.percentage, downloaded: progress.downloaded, total: progress.total, at: new Date().toISOString() };
          }
        });
        currentRequestId = operation.requestId ?? null;
        const modelId = await operation;
        currentRequestId = null;
        loaded.push(modelId);
        const info = await sdk.getLoadedModelInfo({ modelId });
        checks.push({ id: entry.id, label: entry.label, fitProbe: info.fitProbe ?? null, modelType: info.modelType, handlers: info.handlers });
      }
    } catch (error) {
      failure = describeError(error);
    } finally {
      currentRequestId = null;
      if (active) active.stage = 'Releasing models';
      for (const modelId of loaded.reverse()) {
        try { await sdkInstance.unloadModel({ modelId }); }
        catch (error) { cleanupErrors.push(describeError(error)); }
      }
      lastLoad = { finishedAt: new Date().toISOString(), selection, ok: !failure && !cleanupErrors.length && !cancellationRequested, cancelled: cancellationRequested, checks, failure: failure ?? null, cleanupErrors, releasedModels: loaded.length - cleanupErrors.length };
      active = null;
    }
    return lastLoad;
  }

  async function cancel() {
    if (!active || active.kind !== 'load') throw new HttpError(409, 'There is no active load test to cancel.');
    cancellationRequested = true;
    if (currentRequestId) await sdkInstance.cancel({ requestId: currentRequestId });
    return { cancellationRequested: true };
  }

  return { status, assess, load, cancel };
}

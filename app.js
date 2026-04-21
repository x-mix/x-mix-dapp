import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}

const DEFAULT_RPC =
  'https://solana-mainnet.core.chainstack.com/2cd2b649ac769bded1318e8af2508268';
const DEFAULT_PROGRAM_ID = 'XmixQ4DB8MtKcEFhyjWs1gZtdaF3YDuF4ieGLJ3xotv';
const DEFAULT_RELAYER_API = 'https://api.xmix.dev';
const DEFAULT_RELAYER_EXECUTOR = 'xxxXGCRExgFF2EEWKU1QDDDYBL6Ma2X299ynEgEVff5';
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const ASSET_TYPE_SOL = 0;
const ASSET_TYPE_SPL = 1;
const SCAN_LIMIT = 220;
const RELAYER_FEE_LAMPORTS = '0';
// User-paid execution subsidy (A -> relayer) to cover relayer tx fee and nullifier rent.
const RELAYER_EXECUTION_FEE_LAMPORTS = 1_230_960n;
const REQUEST_RETRY_ATTEMPTS = 12;
const REQUEST_RETRY_WAIT_MS = 2000;
const REQUEST_RETRY_MAX_WAIT_MS = 20_000;
const MIN_SOL_DEPOSIT_LAMPORTS = 50_000_000n;
const MIN_SOL_DEPOSIT_TEXT = '0.05';
const MIN_USDC_DEPOSIT_BASE_UNITS = 10_000_000n;
const MIN_USDC_DEPOSIT_TEXT = '10';
const MAX_RECIPIENTS_PER_DEPOSIT_TX = 7;
const MAX_RECIPIENTS_PER_INPUT = 5;
const RECIPIENT_LIMIT_WARN_THROTTLE_MS = 2000;
const NOTE_DRAFT_STORAGE_KEY = 'xmix_note_draft_v1';
const POOL_SCAN_TX_CONCURRENCY = 12;
const RELAYER_STATE_STALE_SLOT_GAP = 300;
const POOL_COMMITMENTS_CACHE_PREFIX = 'xmix_pool_commitments_cache_v2:';
const CHUNK_RELOAD_GUARD_KEY = 'xmix_chunk_reload_guard_v1';
const CHUNK_RELOAD_GUARD_MS = 5 * 60 * 1000;
const CHAIN_SCAN_PAGE_SIZE = 1000;
const CHAIN_SCAN_MAX_SIGNATURES = 10_000;
const SPL_TOKEN_ACCOUNT_LEN = 165;
const ASSET_CONFIGS = {
  sol: {
    key: 'sol',
    label: 'SOL',
    symbol: 'SOL',
    mint: WRAPPED_SOL_MINT,
    assetType: ASSET_TYPE_SOL,
    decimals: 9,
    minBaseUnits: MIN_SOL_DEPOSIT_LAMPORTS,
    minAmountText: MIN_SOL_DEPOSIT_TEXT,
    defaultAmountText: '0.1',
    relayerExecutionSubsidyLamports: RELAYER_EXECUTION_FEE_LAMPORTS,
  },
  usdc: {
    key: 'usdc',
    label: 'USDC',
    symbol: 'USDC',
    mint: MAINNET_USDC_MINT,
    assetType: ASSET_TYPE_SPL,
    decimals: 6,
    minBaseUnits: MIN_USDC_DEPOSIT_BASE_UNITS,
    minAmountText: MIN_USDC_DEPOSIT_TEXT,
    defaultAmountText: '10',
    relayerExecutionSubsidyLamports: RELAYER_EXECUTION_FEE_LAMPORTS,
  },
};

const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);

const DEPOSIT_DISCRIMINATOR = Uint8Array.from([
  242, 35, 198, 137, 82, 225, 242, 182,
]);
const SNARK_FIELD_SIZE = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);
const TREE_LEVELS = 20;

const els = {
  walletStatus: document.getElementById('walletStatus'),
  connectBtn: document.getElementById('connectBtn'),
  recipient: document.getElementById('recipient'),
  assetSelect: document.getElementById('assetSelect'),
  amountLabel: document.getElementById('amountLabel'),
  amountSol: document.getElementById('amountSol'),
  sendBtn: document.getElementById('sendBtn'),
  txLink: document.getElementById('txLink'),
  requestId: document.getElementById('requestId'),
  note: document.getElementById('note'),
  copyNoteBtn: document.getElementById('copyNoteBtn'),
  downloadNoteBtn: document.getElementById('downloadNoteBtn'),
  logBox: document.getElementById('logBox'),
  stepDeposit: document.getElementById('stepDeposit'),
  stepRequest: document.getElementById('stepRequest'),
  stepDone: document.getElementById('stepDone'),
};

let provider = null;
let poseidonPromise = null;
let zeroTreePromise = null;
let latestNote = null;
let busy = false;
let recipientLimitWarnAt = 0;

boot();

function boot() {
  provider = resolveWalletProvider();
  installChunkLoadRecovery();

  els.connectBtn.addEventListener('click', onConnectWallet);
  els.sendBtn.addEventListener('click', onSend);
  els.recipient.addEventListener('input', onRecipientInput);
  els.assetSelect.addEventListener('change', onAssetChange);
  els.amountSol.addEventListener('input', syncSendButtonState);
  els.copyNoteBtn.addEventListener('click', onCopyNote);
  els.downloadNoteBtn.addEventListener('click', onDownloadNote);

  if (!provider) {
    log('未检测到 Phantom 钱包扩展。', 'warn');
  }

  resetProgress();
  applyAssetUi(currentAssetConfig(), { resetAmount: false });
  syncSendButtonState();
  restoreLatestNoteFromStorage();
  log('准备就绪。');
}

function getSelectedAssetConfig() {
  const key = els.assetSelect?.value ?? 'sol';
  return ASSET_CONFIGS[key] ?? ASSET_CONFIGS.sol;
}

function currentAssetConfig() {
  return getSelectedAssetConfig();
}

function applyAssetUi(asset, { resetAmount }) {
  els.amountLabel.textContent = `默认转账金额 (${asset.symbol})`;
  if (resetAmount || !els.amountSol.value.trim()) {
    els.amountSol.value = asset.defaultAmountText;
  }
}

function onAssetChange() {
  const asset = currentAssetConfig();
  applyAssetUi(asset, { resetAmount: true });
  syncSendButtonState();
  log(`当前资产已切换为 ${asset.label}`);
}

function trimRecipientInputToLimit(raw) {
  const lines = String(raw ?? '').replace(/\r/g, '').split('\n');
  const kept = [];
  let nonEmptyCount = 0;
  let truncated = false;

  for (const line of lines) {
    const nonEmpty = line.trim().length > 0;
    if (nonEmpty) {
      if (nonEmptyCount >= MAX_RECIPIENTS_PER_INPUT) {
        truncated = true;
        continue;
      }
      nonEmptyCount += 1;
    }
    kept.push(line);
  }

  return { value: kept.join('\n'), truncated };
}

function onRecipientInput() {
  const { value, truncated } = trimRecipientInputToLimit(els.recipient.value);
  if (truncated) {
    const cursor = els.recipient.selectionStart ?? value.length;
    els.recipient.value = value;
    const nextCursor = Math.min(cursor, value.length);
    try {
      els.recipient.setSelectionRange(nextCursor, nextCursor);
    } catch {
      // ignore cursor restore failure
    }

    const now = Date.now();
    if (now - recipientLimitWarnAt >= RECIPIENT_LIMIT_WARN_THROTTLE_MS) {
      recipientLimitWarnAt = now;
      log(`最多仅可输入 ${MAX_RECIPIENTS_PER_INPUT} 个收币地址，超出部分已自动忽略。`, 'warn');
    }
  }
  syncSendButtonState();
}

function shouldAutoReloadAfterChunkError() {
  try {
    const last = Number(sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY) || '0');
    const now = Date.now();
    if (now - last < CHUNK_RELOAD_GUARD_MS) {
      return false;
    }
    sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

function isDynamicImportChunkError(message) {
  if (typeof message !== 'string') return false;
  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Importing a module script failed')
  );
}

function installChunkLoadRecovery() {
  const handle = (reason) => {
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : String(reason);

    if (!isDynamicImportChunkError(message)) {
      return false;
    }

    if (shouldAutoReloadAfterChunkError()) {
      log('检测到前端资源版本已更新，正在自动刷新页面...', 'warn');
      setTimeout(() => window.location.reload(), 150);
    } else {
      log('前端资源加载失败，请手动强制刷新页面（Ctrl+F5）。', 'error');
    }
    return true;
  };

  window.addEventListener('error', (event) => {
    handle(event?.error ?? event?.message);
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (handle(event.reason)) {
      event.preventDefault();
    }
  });

  // Vite-specific chunk preload failure hook.
  window.addEventListener('vite:preloadError', (event) => {
    if (handle(event?.payload ?? event?.error ?? event?.message)) {
      event.preventDefault();
    }
  });
}

function getWalletProvider() {
  if (window?.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window?.solana?.isPhantom) return window.solana;
  return null;
}

function resolveWalletProvider() {
  provider = getWalletProvider();
  return provider;
}

function getConnection() {
  return new Connection(DEFAULT_RPC, 'confirmed');
}

function getProgramId() {
  return new PublicKey(DEFAULT_PROGRAM_ID);
}

function log(message, level = 'info') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const prefix = level === 'error' ? '[ERR]' : level === 'warn' ? '[WARN]' : '[INFO]';
  els.logBox.textContent = `${prefix} ${ts} ${message}\n${els.logBox.textContent}`;
}

function persistLatestNote() {
  try {
    if (!latestNote) return;
    localStorage.setItem(NOTE_DRAFT_STORAGE_KEY, JSON.stringify(latestNote));
  } catch {
    // ignore
  }
}

function clearLatestNoteDraftStorage() {
  try {
    localStorage.removeItem(NOTE_DRAFT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function hasValidRequestId(value) {
  return typeof value === 'string' && value.trim() !== '' && value !== '-';
}

function isCompletedNoteDraft(note) {
  if (!note || typeof note !== 'object') return false;
  if (note.mode === 'batch' && Array.isArray(note.entries)) {
    return note.entries.length > 0 && note.entries.every((entry) => hasValidRequestId(entry?.requestId));
  }
  return hasValidRequestId(note.requestId);
}

function syncNoteView() {
  if (!latestNote) return;
  els.note.value = JSON.stringify(latestNote, null, 2);
  persistLatestNote();
}

function restoreLatestNoteFromStorage() {
  try {
    const raw = localStorage.getItem(NOTE_DRAFT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    if (isCompletedNoteDraft(parsed)) {
      clearLatestNoteDraftStorage();
      return;
    }
    latestNote = parsed;
    syncNoteView();
    log('已恢复上次流程的 Note 草稿。');
  } catch {
    // ignore
  }
}

function setBusy(nextBusy) {
  busy = Boolean(nextBusy);
  els.connectBtn.disabled = busy;
  els.copyNoteBtn.disabled = busy;
  els.downloadNoteBtn.disabled = busy;
  syncSendButtonState();
}

function resetProgress() {
  for (const item of [els.stepDeposit, els.stepRequest, els.stepDone]) {
    item.classList.remove('running', 'done', 'error');
  }
}

function setProgress(stepEl, state) {
  stepEl.classList.remove('running', 'done', 'error');
  if (state) {
    stepEl.classList.add(state);
  }
}

async function onConnectWallet() {
  try {
    const currentProvider = resolveWalletProvider();
    if (!currentProvider) throw new Error('未检测到 Phantom');

    await currentProvider.connect();

    const address = currentProvider.publicKey.toBase58();
    const connection = getConnection();
    const bal = await connection.getBalance(currentProvider.publicKey, 'confirmed');
    const sol = Number(bal) / LAMPORTS_PER_SOL;

    els.walletStatus.textContent = `${address} | ${sol.toFixed(4)} SOL`;

    log(`钱包已连接: ${address}`);
  } catch (error) {
    log(error.message ?? String(error), 'error');
  }
}

function parseUiAmountToBaseUnits(raw, decimals) {
  const value = String(raw ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error('金额格式错误');
  }

  const [whole, fracRaw = ''] = value.split('.');
  if (fracRaw.length > decimals) {
    throw new Error(`金额最多支持 ${decimals} 位小数`);
  }
  const scale = 10n ** BigInt(decimals);
  const fracPadded = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
  const frac = fracPadded.length > 0 ? BigInt(fracPadded) : 0n;
  const baseUnits = BigInt(whole) * scale + frac;
  if (baseUnits <= 0n) {
    throw new Error('金额必须大于 0');
  }
  return baseUnits;
}

function isAmountSendable(raw, asset) {
  try {
    const baseUnits = parseUiAmountToBaseUnits(raw, asset.decimals);
    return baseUnits >= asset.minBaseUnits;
  } catch {
    return false;
  }
}

function formatBaseUnitsToUi(baseUnits, decimals) {
  const scale = 10n ** BigInt(decimals);
  const whole = baseUnits / scale;
  const frac = (baseUnits % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

function formatLamportsToSol(lamports) {
  return formatBaseUnitsToUi(lamports, 9);
}

function syncSendButtonState() {
  const asset = currentAssetConfig();
  const hasRecipient = Boolean(els.recipient.value.trim());
  const amountOk = isAmountSendable(els.amountSol.value, asset);
  const canSend = hasRecipient && amountOk;
  els.sendBtn.disabled = busy || !canSend;

  if (!hasRecipient) {
    els.sendBtn.title = '请填写收币地址';
    return;
  }
  els.sendBtn.title = amountOk ? '' : `最低发送金额 ${asset.minAmountText} ${asset.symbol}`;
}

function parseRecipientTargets(rawRecipients, defaultAmountText, asset) {
  const lines = rawRecipients
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error('请填写收币地址。');
  }
  if (lines.length > MAX_RECIPIENTS_PER_INPUT) {
    throw new Error(`单次最多支持 ${MAX_RECIPIENTS_PER_INPUT} 个收币地址，请分批操作。`);
  }

  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replaceAll('，', ',');
    let recipient = '';
    let amountText = defaultAmountText.trim();

    if (line.includes(',')) {
      const parts = line.split(',').map((v) => v.trim()).filter(Boolean);
      if (parts.length < 1 || parts.length > 2) {
        throw new Error(`第 ${i + 1} 行格式错误，示例：地址 或 地址,金额`);
      }
      recipient = parts[0];
      if (parts[1]) {
        amountText = parts[1];
      }
    } else {
      const parts = line.split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        recipient = parts[0];
      } else if (parts.length === 2 && /^\d+(\.\d+)?$/.test(parts[1])) {
        recipient = parts[0];
        amountText = parts[1];
      } else {
        throw new Error(`第 ${i + 1} 行格式错误，示例：地址 或 地址,金额`);
      }
    }

    let recipientPk;
    try {
      recipientPk = new PublicKey(recipient);
    } catch {
      throw new Error(`第 ${i + 1} 行收币地址格式错误`);
    }

    const amountBaseUnits = parseUiAmountToBaseUnits(amountText, asset.decimals);
    if (amountBaseUnits < asset.minBaseUnits) {
      throw new Error(`第 ${i + 1} 行金额低于最低 ${asset.minAmountText} ${asset.symbol}`);
    }

    out.push({
      recipient: recipientPk.toBase58(),
      amountBaseUnits,
    });
  }

  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('invalid 32-byte hex');
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function getPoolCommitmentsCacheKey(poolAddress) {
  return `${POOL_COMMITMENTS_CACHE_PREFIX}${poolAddress}`;
}

function readPoolCommitmentsCache(poolAddress) {
  try {
    const raw = localStorage.getItem(getPoolCommitmentsCacheKey(poolAddress));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.commitmentsHex)) return null;
    if (typeof parsed.versionStamp !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePoolCommitmentsCache(poolAddress, versionStamp, commitmentsHex) {
  try {
    localStorage.setItem(
      getPoolCommitmentsCacheKey(poolAddress),
      JSON.stringify({
        versionStamp,
        commitmentsHex,
        updatedAt: new Date().toISOString(),
      })
    );
  } catch {
    // ignore
  }
}

function random32Bytes() {
  const out = new Uint8Array(32);
  crypto.getRandomValues(out);
  return out;
}

function bytesToBigInt(bytes) {
  let result = 0n;
  for (const b of bytes) {
    result = (result << 8n) | BigInt(b);
  }
  return result;
}

function bigIntToBytes(value) {
  const out = new Uint8Array(32);
  let temp = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return out;
}

async function getPoseidon() {
  if (!poseidonPromise) {
    poseidonPromise = import('circomlibjs').then((m) => m.buildPoseidon());
  }
  return poseidonPromise;
}

async function poseidonHash(inputs) {
  const poseidon = await getPoseidon();
  const fieldInputs = inputs.map((bytes) => bytesToBigInt(bytes) % SNARK_FIELD_SIZE);
  const hash = poseidon(fieldInputs);
  const asBigInt = BigInt(poseidon.F.toObject(hash));
  return bigIntToBytes(asBigInt);
}

async function poseidonPair(left, right) {
  return poseidonHash([left, right]);
}

async function generateCommitment(secret, nullifier, amountLamports, poolPk) {
  const amountBytes = bigIntToBytes(amountLamports);
  return poseidonHash([secret, nullifier, amountBytes, poolPk.toBytes()]);
}

async function buildZeroTree() {
  if (!zeroTreePromise) {
    zeroTreePromise = (async () => {
      const zeros = [new Uint8Array(32)];
      for (let i = 1; i <= TREE_LEVELS; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        zeros[i] = await poseidonPair(zeros[i - 1], zeros[i - 1]);
      }
      return zeros;
    })();
  }
  return zeroTreePromise;
}

async function computeMerkleRoot(commitments) {
  const zeros = await buildZeroTree();
  if (commitments.length === 0) {
    return zeros[TREE_LEVELS];
  }

  let level = [...commitments];
  for (let i = 0; i < TREE_LEVELS; i += 1) {
    const next = [];
    for (let j = 0; j < level.length; j += 2) {
      const left = level[j];
      const right = j + 1 < level.length ? level[j + 1] : zeros[i];
      // eslint-disable-next-line no-await-in-loop
      next.push(await poseidonPair(left, right));
    }
    level = next;
  }

  return level[0];
}

function parseDepositCommitment(ix) {
  if (!('data' in ix)) return null;

  let raw;
  try {
    raw = bs58.decode(ix.data);
  } catch {
    return null;
  }

  if (raw.length < 80) return null;
  for (let i = 0; i < 8; i += 1) {
    if (raw[i] !== DEPOSIT_DISCRIMINATOR[i]) {
      return null;
    }
  }

  return raw.slice(16, 48);
}

async function fetchPoolCommitments(connection, programId, poolPk, scanLimit) {
  const fromRelayer = await fetchPoolCommitmentsFromRelayer(connection, poolPk, scanLimit);
  if (fromRelayer) {
    log(`已从 relayer 读取 ${fromRelayer.length} 条历史 commitment（跳过链上全量扫描）`);
    return fromRelayer;
  }

  const signatures = [];
  let before;
  while (true) {
    const page = await connection.getSignaturesForAddress(
      programId,
      { limit: CHAIN_SCAN_PAGE_SIZE, before },
      'confirmed'
    );
    if (page.length === 0) {
      break;
    }
    signatures.push(...page);
    if (page.length < CHAIN_SCAN_PAGE_SIZE) {
      break;
    }
    before = page[page.length - 1].signature;
    if (signatures.length >= CHAIN_SCAN_MAX_SIGNATURES) {
      throw new Error(
        `链上回退扫描达到上限 ${CHAIN_SCAN_MAX_SIGNATURES} 笔签名，无法安全计算 newRoot；请等待 relayer 同步后重试。`
      );
    }
  }

  signatures.sort((a, b) => a.slot - b.slot);

  const commitments = [];
  const poolAddress = poolPk.toBase58();
  const txs = await mapWithConcurrency(
    signatures,
    POOL_SCAN_TX_CONCURRENCY,
    async (sig) => {
      try {
        return await connection.getParsedTransaction(sig.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
      } catch {
        return null;
      }
    }
  );

  for (const tx of txs) {
    if (!tx || tx.meta?.err) continue;

    const logs = tx.meta?.logMessages ?? [];
    if (!logs.some((line) => line.includes('Instruction: Deposit'))) {
      continue;
    }

    for (const ix of tx.transaction.message.instructions) {
      if (!('programId' in ix) || !ix.programId.equals(programId)) continue;
      if (!('accounts' in ix) || ix.accounts.length < 2) continue;
      if (ix.accounts[1].toBase58() !== poolAddress) continue;

      const commitment = parseDepositCommitment(ix);
      if (commitment) {
        commitments.push(commitment);
      }
    }
  }

  return commitments;
}

async function fetchPoolCommitmentsFromRelayer(connection, poolPk, scanLimit) {
  const pool = poolPk.toBase58();
  const cached = readPoolCommitmentsCache(pool);
  try {
    const fetchCommitments = async (limit) => {
      const url = `${DEFAULT_RELAYER_API}/api/pool/${pool}/commitments?limit=${limit}`;
      const response = await fetch(url, { method: 'GET' });
      if (!response.ok) return null;
      const payload = await response.json();
      if (!payload?.ok || !payload?.result) return null;
      return payload.result;
    };

    const baseResult = await fetchCommitments(scanLimit);
    if (!baseResult) return null;

    const lastSeenSlot = Number(baseResult.lastSeenSlot ?? NaN);
    if (Number.isFinite(lastSeenSlot)) {
      const currentSlot = await connection.getSlot('confirmed');
      if (currentSlot - lastSeenSlot > RELAYER_STATE_STALE_SLOT_GAP) {
        log(
          `Relayer 索引落后 ${currentSlot - lastSeenSlot} slots，回退链上全量分页扫描以保证 newRoot 准确性。`,
          'warn'
        );
        return null;
      }
    }

    if (baseResult.rootMatches === false) {
      throw new Error(
        'Relayer Merkle 快照与链上不一致（rootMatches=false），已中止本次流程以避免产生无法提现的请求。请先修复 relayer 索引后再重试。'
      );
    }

    const commitmentCount = Number(baseResult.commitmentCount ?? 0);
    const baseCommitmentsHex = Array.isArray(baseResult.commitmentsHex)
      ? baseResult.commitmentsHex
      : [];
    let commitmentsHex = baseCommitmentsHex;

    if (
      Number.isInteger(commitmentCount) &&
      commitmentCount > 0 &&
      commitmentCount > baseCommitmentsHex.length
    ) {
      const fullResult = await fetchCommitments(commitmentCount);
      if (fullResult?.rootMatches === false) {
        throw new Error(
          'Relayer Merkle 快照与链上不一致（rootMatches=false），已中止本次流程以避免产生无法提现的请求。请先修复 relayer 索引后再重试。'
        );
      }
      const fullCommitmentsHex = Array.isArray(fullResult?.commitmentsHex)
        ? fullResult.commitmentsHex
        : [];
      if (fullCommitmentsHex.length === commitmentCount) {
        commitmentsHex = fullCommitmentsHex;
      }
    }

    const versionStamp = `${String(baseResult.stateUpdatedAt || '')}:${String(
      commitmentCount || commitmentsHex.length
    )}`;
    if (
      cached &&
      cached.versionStamp === versionStamp &&
      Array.isArray(cached.commitmentsHex)
    ) {
      return cached.commitmentsHex.map((hex) => hexToBytes(hex));
    }

    writePoolCommitmentsCache(pool, versionStamp, commitmentsHex);
    return commitmentsHex.map((hex) => hexToBytes(hex));
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    return null;
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      // eslint-disable-next-line no-await-in-loop
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
}

async function fetchDepositInstructionIndexMap(connection, signature, programId, poolPk) {
  const tx = await connection.getParsedTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (!tx || tx.meta?.err) {
    throw new Error(`无法读取已确认交易用于解析 Deposit 指令: ${signature}`);
  }

  const indexMap = new Map();

  for (let i = 0; i < tx.transaction.message.instructions.length; i += 1) {
    const ix = tx.transaction.message.instructions[i];
    if (!('programId' in ix) || !ix.programId.equals(programId)) continue;
    if (!('accounts' in ix) || ix.accounts.length < 2) continue;
    if (ix.accounts[1].toBase58() !== poolPk.toBase58()) continue;

    const commitment = parseDepositCommitment(ix);
    if (!commitment) continue;
    indexMap.set(bytesToHex(commitment), i);
  }

  return indexMap;
}

async function ensureSplDepositPrerequisites({
  connection,
  programId,
  mintPk,
  poolPk,
  vaultPk,
  depositorTokenAccount,
  vaultTokenAccount,
  totalAmountBaseUnits,
  asset,
}) {
  const [poolInfo, vaultInfo, depositorTokenInfo] = await Promise.all([
    connection.getAccountInfo(poolPk, 'confirmed'),
    connection.getAccountInfo(vaultTokenAccount, 'confirmed'),
    connection.getAccountInfo(depositorTokenAccount, 'confirmed'),
  ]);

  if (!poolInfo || !poolInfo.owner.equals(programId)) {
    throw new Error(
      `${asset.symbol} 池未初始化（pool=${poolPk.toBase58()}）。请先由管理员初始化 ${asset.symbol} 池后再存入。`
    );
  }

  if (!vaultInfo) {
    throw new Error(
      `${asset.symbol} 池 vault ATA 不存在（vault ATA=${vaultTokenAccount.toBase58()}）。请先初始化池子。`
    );
  }

  if (!depositorTokenInfo) {
    throw new Error(
      `当前钱包没有 ${asset.symbol} ATA（wallet ATA=${depositorTokenAccount.toBase58()}）。请先在钱包创建 ATA 并转入 ${asset.symbol}。`
    );
  }

  let balance;
  try {
    const tokenBal = await connection.getTokenAccountBalance(
      depositorTokenAccount,
      'confirmed'
    );
    balance = BigInt(tokenBal?.value?.amount ?? '0');
  } catch {
    balance = 0n;
  }

  if (balance < totalAmountBaseUnits) {
    const need = formatBaseUnitsToUi(totalAmountBaseUnits, asset.decimals);
    const have = formatBaseUnitsToUi(balance, asset.decimals);
    throw new Error(
      `${asset.symbol} 余额不足：当前 ${have} ${asset.symbol}，需要 ${need} ${asset.symbol}。`
    );
  }

  // sanity check for wrong mint wiring
  if (asset.mint !== mintPk.toBase58()) {
    throw new Error(
      `资产 mint 不一致：asset=${asset.mint} tx=${mintPk.toBase58()}`
    );
  }
  if (!vaultPk) {
    throw new Error('vault 账户缺失');
  }
}

async function applyOnchainDepositInstructionIndexes({
  connection,
  signature,
  programId,
  poolPk,
  items,
}) {
  const indexMap = await fetchDepositInstructionIndexMap(
    connection,
    signature,
    programId,
    poolPk
  );

  for (const item of items) {
    const actualIx = indexMap.get(item.note.commitmentHex);
    if (actualIx === undefined) {
      throw new Error(
        `未在链上交易中定位到 Deposit 指令: ${signature} (commitment=${item.note.commitmentHex.slice(0, 16)}...)`
      );
    }
    item.note.depositSignature = signature;
    item.note.depositInstructionIndex = actualIx;
  }
}

function derivePoolAndVault(programId, mintPk, assetTypeByte) {
  const [pool] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode('pool'),
      mintPk.toBytes(),
      Uint8Array.from([assetTypeByte]),
    ],
    programId
  );

  const [vault] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('vault'), pool.toBytes()],
    programId
  );

  return { pool, vault };
}

function encodeDepositData(amountBaseUnits, commitment, newRoot) {
  const data = new Uint8Array(80);
  data.set(DEPOSIT_DISCRIMINATOR, 0);

  let temp = amountBaseUnits;
  for (let i = 0; i < 8; i += 1) {
    data[8 + i] = Number(temp & 0xffn);
    temp >>= 8n;
  }

  data.set(commitment, 16);
  data.set(newRoot, 48);
  return data;
}

function findAssociatedTokenAddress(owner, mint) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

function createDepositTx({
  walletPubkey,
  amountBaseUnits,
  relayerExecutionSubsidyLamports,
  commitment,
  newRoot,
  asset,
  mintPk,
  poolPk,
  vaultPk,
  depositorTokenAccount,
  vaultTokenAccount,
}) {
  const programId = getProgramId();
  const relayerExecutor = new PublicKey(DEFAULT_RELAYER_EXECUTOR);

  const ixData = encodeDepositData(amountBaseUnits, commitment, newRoot);
  const usingTokenAccounts = asset.assetType === ASSET_TYPE_SPL;
  const resolvedDepositorTokenAccount = usingTokenAccounts
    ? depositorTokenAccount
    : programId;
  const resolvedVaultTokenAccount = usingTokenAccounts ? vaultTokenAccount : programId;

  const keys = [
    { pubkey: walletPubkey, isSigner: true, isWritable: true },
    { pubkey: poolPk, isSigner: false, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: true },
    { pubkey: vaultPk, isSigner: false, isWritable: true },
    { pubkey: resolvedDepositorTokenAccount, isSigner: false, isWritable: true },
    { pubkey: resolvedVaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: relayerExecutor, isSigner: false, isWritable: true },
  ];

  const ix = new TransactionInstruction({
    programId,
    keys,
    data: ixData,
  });

  if (!relayerExecutionSubsidyLamports) {
    return new Transaction().add(ix);
  }

  const relayerExecutionFeeIx = SystemProgram.transfer({
    fromPubkey: walletPubkey,
    toPubkey: relayerExecutor,
    lamports: Number(relayerExecutionSubsidyLamports),
  });

  return new Transaction().add(relayerExecutionFeeIx, ix);
}

async function sendDepositTransactions({ connection, walletPubkey, txs }) {
  if (txs.length === 0) {
    return [];
  }

  const sendSequentially = async () => {
    const signatures = [];
    for (const tx of txs) {
      const latest = await connection.getLatestBlockhash('confirmed');
      tx.feePayer = walletPubkey;
      tx.recentBlockhash = latest.blockhash;

      let signature;
      if (typeof provider.signAndSendTransaction === 'function') {
        // eslint-disable-next-line no-await-in-loop
        const res = await provider.signAndSendTransaction(tx);
        signature = typeof res === 'string' ? res : res.signature;
      } else if (typeof provider.signTransaction === 'function') {
        // eslint-disable-next-line no-await-in-loop
        const signed = await provider.signTransaction(tx);
        // eslint-disable-next-line no-await-in-loop
        signature = await connection.sendRawTransaction(signed.serialize());
      } else {
        throw new Error('钱包不支持 signAndSendTransaction/signTransaction');
      }

      if (!signature) {
        throw new Error('未获取到交易签名');
      }

      // eslint-disable-next-line no-await-in-loop
      await connection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        'confirmed'
      );

      signatures.push(signature);
    }
    return signatures;
  };

  if (txs.length > 1 && typeof provider.signAllTransactions === 'function') {
    try {
      const latest = await connection.getLatestBlockhash('confirmed');
      for (const tx of txs) {
        tx.feePayer = walletPubkey;
        tx.recentBlockhash = latest.blockhash;
      }

      const signedTxs = await provider.signAllTransactions(txs);
      const signatures = [];

      for (const signedTx of signedTxs) {
        // eslint-disable-next-line no-await-in-loop
        const signature = await connection.sendRawTransaction(signedTx.serialize());
        if (!signature) {
          throw new Error('未获取到交易签名');
        }
        signatures.push(signature);
      }

      for (const signature of signatures) {
        // eslint-disable-next-line no-await-in-loop
        await connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          'confirmed'
        );
      }

      return signatures;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`钱包拦截批量签名，回退为逐笔签名: ${message}`, 'warn');
      return sendSequentially();
    }
  }

  return sendSequentially();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeRetryDelayMs(attempt) {
  const exp = Math.max(0, attempt - 1);
  const base = REQUEST_RETRY_WAIT_MS * 2 ** exp;
  const capped = Math.min(REQUEST_RETRY_MAX_WAIT_MS, base);
  const jitter = Math.floor(Math.random() * 400);
  return capped + jitter;
}

async function buildWithdrawRequest(note, recipient) {
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= REQUEST_RETRY_ATTEMPTS; attempt += 1) {
    let res;
    const requestBody = {
      note,
      recipient,
      relayerFeeLamports: RELAYER_FEE_LAMPORTS,
      mint: note?.mint,
      pool: note?.pool,
      vault: note?.vault,
      vaultTokenAccount: note?.vaultTokenAccount,
      recipientTokenAccount: note?.recipientTokenAccount,
      feeCollectorTokenAccount: note?.feeCollectorTokenAccount,
    };
    try {
      res = await fetch(`${DEFAULT_RELAYER_API}/api/relay-request/build`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      lastError =
        error instanceof Error
          ? `Relayer API fetch failed: ${error.message}`
          : `Relayer API fetch failed: ${String(error)}`;
      if (attempt >= REQUEST_RETRY_ATTEMPTS) {
        throw new Error(lastError);
      }
      const delayMs = computeRetryDelayMs(attempt);
      log(
        `Relayer API 网络异常，${Math.round(delayMs / 1000)}s 后重试 (${attempt}/${REQUEST_RETRY_ATTEMPTS})...`,
        'warn'
      );
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
      continue;
    }

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      // ignore
    }

    if (res.ok && payload?.ok) {
      return payload.result;
    }

    lastError = payload?.error || `HTTP ${res.status}`;
    const retryable =
      res.status === 429 ||
      lastError.includes('Deposit not found in relayer state') ||
      lastError.includes('missing decoded deposit payload');

    if (!retryable || attempt >= REQUEST_RETRY_ATTEMPTS) {
      throw new Error(lastError);
    }

    const delayMs = computeRetryDelayMs(attempt);
    if (res.status === 429) {
      log(
        `Relayer API 限流 (HTTP 429)，${Math.round(delayMs / 1000)}s 后重试 (${attempt}/${REQUEST_RETRY_ATTEMPTS})...`,
        'warn'
      );
    } else {
      log(
        `Relayer 尚未索引到该 Deposit，${Math.round(delayMs / 1000)}s 后重试 (${attempt}/${REQUEST_RETRY_ATTEMPTS})...`,
        'warn'
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(delayMs);
  }

  throw new Error(lastError);
}

async function onSend() {
  if (!provider?.publicKey) {
    log('请先连接钱包。', 'warn');
    return;
  }

  const asset = currentAssetConfig();
  let targets;
  try {
    targets = parseRecipientTargets(els.recipient.value, els.amountSol.value, asset);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error), 'warn');
    return;
  }

  try {
    setBusy(true);
    resetProgress();
    els.requestId.textContent = '-';
    els.txLink.href = '#';
    els.txLink.textContent = '等待交易';

    if (targets.length > 1) {
      const batchCount = Math.ceil(targets.length / MAX_RECIPIENTS_PER_DEPOSIT_TX);
      if (batchCount === 1) {
        log(`检测到批量目标 ${targets.length} 个，将优先尝试单笔交易一次签名。`);
      } else {
        log(
          `检测到批量目标 ${targets.length} 个，超过单笔上限，将自动拆分为 ${batchCount} 批（每批最多 ${MAX_RECIPIENTS_PER_DEPOSIT_TX} 个地址）。`
        );
      }
    }

    const connection = getConnection();
    const programId = getProgramId();
    const mintPk = new PublicKey(asset.mint);
    const { pool, vault } = derivePoolAndVault(programId, mintPk, asset.assetType);
    const pendingDeposits = [];
    const requestIds = [];
    const usingTokenAccounts = asset.assetType === ASSET_TYPE_SPL;
    const depositorTokenAccount = usingTokenAccounts
      ? findAssociatedTokenAddress(provider.publicKey, mintPk)
      : null;
    const vaultTokenAccount = usingTokenAccounts
      ? findAssociatedTokenAddress(vault, mintPk)
      : null;
    const flowNoteCreatedAt = new Date().toISOString();
    const syncCurrentFlowNote = () => {
      const entries = pendingDeposits.map((item) => ({ ...item.note }));
      if (entries.length === 0) return;
      if (entries.length === 1) {
        latestNote = entries[0];
      } else {
        latestNote = {
          version: 1,
          mode: 'batch',
          createdAt: flowNoteCreatedAt,
          count: entries.length,
          entries,
        };
      }
      syncNoteView();
    };

    setProgress(els.stepDeposit, 'running');
    log('扫描历史 Deposit，重建最新 Merkle Root...');
    const historicalCommitments = await fetchPoolCommitments(
      connection,
      programId,
      pool,
      SCAN_LIMIT
    );
    const commitmentsForBatch = [...historicalCommitments];
    if (usingTokenAccounts) {
      const totalAmountBaseUnits = targets.reduce(
        (sum, item) => sum + item.amountBaseUnits,
        0n
      );
      await ensureSplDepositPrerequisites({
        connection,
        programId,
        mintPk,
        poolPk: pool,
        vaultPk: vault,
        depositorTokenAccount,
        vaultTokenAccount,
        totalAmountBaseUnits,
        asset,
      });
    }
    if (usingTokenAccounts) {
      log(
        `当前 ${asset.symbol} 资产账户: wallet ATA=${depositorTokenAccount.toBase58()}, vault ATA=${vaultTokenAccount.toBase58()}`
      );
    }
    const recipientAtaRentLamports = usingTokenAccounts
      ? BigInt(
          await connection.getMinimumBalanceForRentExemption(
            SPL_TOKEN_ACCOUNT_LEN,
            'confirmed'
          )
        )
      : 0n;

    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      const prefix = targets.length > 1 ? `[${i + 1}/${targets.length}] ` : '';

      log(`${prefix}开始构建 Deposit...`);

      const secret = random32Bytes();
      const nullifier = random32Bytes();
      const commitment = await generateCommitment(
        secret,
        nullifier,
        target.amountBaseUnits,
        pool
      );
      const newRoot = await computeMerkleRoot([...commitmentsForBatch, commitment]);
      commitmentsForBatch.push(commitment);

      const recipientPk = new PublicKey(target.recipient);
      const recipientTokenAccount = usingTokenAccounts
        ? findAssociatedTokenAddress(recipientPk, mintPk)
        : null;
      const recipientAtaMissing = usingTokenAccounts
        ? !(await connection.getAccountInfo(recipientTokenAccount, 'confirmed'))
        : false;
      const recipientAtaSubsidyLamports = recipientAtaMissing ? recipientAtaRentLamports : 0n;
      const relayerExecutionSubsidyLamports =
        asset.relayerExecutionSubsidyLamports + recipientAtaSubsidyLamports;

      const amountUi = formatBaseUnitsToUi(target.amountBaseUnits, asset.decimals);
      const executionFeeSol = formatLamportsToSol(relayerExecutionSubsidyLamports);
      const totalUserOutflowLamports =
        asset.key === 'sol'
          ? target.amountBaseUnits + relayerExecutionSubsidyLamports
          : relayerExecutionSubsidyLamports;
      if (relayerExecutionSubsidyLamports > 0n) {
        const ataHint =
          recipientAtaSubsidyLamports > 0n
            ? `（含收款ATA建账资助 ${formatLamportsToSol(recipientAtaSubsidyLamports)} SOL）`
            : '';
        log(
          `${prefix}构建链上 Deposit 交易（存款 ${amountUi} ${asset.symbol} + 中继资助费 ${executionFeeSol} SOL${ataHint}）...`
        );
      } else {
        log(`${prefix}构建链上 Deposit 交易（存款 ${amountUi} ${asset.symbol}）...`);
      }

      const tx = createDepositTx({
        walletPubkey: provider.publicKey,
        amountBaseUnits: target.amountBaseUnits,
        relayerExecutionSubsidyLamports,
        commitment,
        newRoot,
        asset,
        mintPk,
        poolPk: pool,
        vaultPk: vault,
        depositorTokenAccount,
        vaultTokenAccount,
      });
      const note = {
        version: 1,
        createdAt: new Date().toISOString(),
        rpcUrl: DEFAULT_RPC,
        programId: programId.toBase58(),
        pool: pool.toBase58(),
        vault: vault.toBase58(),
        mint: mintPk.toBase58(),
        assetType: asset.key,
        assetSymbol: asset.symbol,
        assetDecimals: asset.decimals,
        recipient: target.recipient,
        amountLamports: target.amountBaseUnits.toString(),
        amountUi,
        relayerExecutionFeeLamports: relayerExecutionSubsidyLamports.toString(),
        relayerExecutionFeeUi: executionFeeSol,
        relayerExecutionFeeSol: executionFeeSol,
        recipientAtaSubsidyLamports: recipientAtaSubsidyLamports.toString(),
        recipientAtaSubsidySol: formatLamportsToSol(recipientAtaSubsidyLamports),
        totalUserOutflowLamports: totalUserOutflowLamports.toString(),
        totalUserOutflowUi:
          asset.key === 'sol'
            ? formatLamportsToSol(totalUserOutflowLamports)
            : `${amountUi} ${asset.symbol} + ${executionFeeSol} SOL`,
        vaultTokenAccount: vaultTokenAccount?.toBase58(),
        recipientTokenAccount: recipientTokenAccount?.toBase58(),
        relayerExecutor: DEFAULT_RELAYER_EXECUTOR,
        commitmentHex: bytesToHex(commitment),
        newRootHex: bytesToHex(newRoot),
        secretHex: bytesToHex(secret),
        nullifierHex: bytesToHex(nullifier),
        depositSignature: '',
        depositInstructionIndex: 1,
      };
      if (asset.key === 'sol') {
        note.amountSol = amountUi;
        note.totalUserOutflowSol = formatLamportsToSol(totalUserOutflowLamports);
      }

      pendingDeposits.push({
        prefix,
        target,
        note,
        tx,
      });
    }

    if (pendingDeposits.length > 1) {
      const depositBatches = [];
      for (
        let start = 0;
        start < pendingDeposits.length;
        start += MAX_RECIPIENTS_PER_DEPOSIT_TX
      ) {
        const items = pendingDeposits.slice(start, start + MAX_RECIPIENTS_PER_DEPOSIT_TX);
        const tx = new Transaction();
        for (const item of items) {
          const depositInstructionIndex = tx.instructions.length + 1;
          item.note.depositInstructionIndex = depositInstructionIndex;
          for (const ix of item.tx.instructions) {
            tx.add(ix);
          }
        }
        depositBatches.push({ tx, items });
      }

      try {
        log(
          depositBatches.length === 1
            ? '提交单笔批量 Deposit 交易到链上...'
            : `提交 ${depositBatches.length} 笔批量 Deposit 交易到链上...`
        );
        const batchSignatures = await sendDepositTransactions({
          connection,
          walletPubkey: provider.publicKey,
          txs: depositBatches.map((batch) => batch.tx),
        });

        for (let batchIdx = 0; batchIdx < depositBatches.length; batchIdx += 1) {
          const signature = batchSignatures[batchIdx];
          const batch = depositBatches[batchIdx];
          // Resolve actual on-chain instruction indexes because wallet may inject
          // extra instructions (e.g. compute budget), shifting planned indexes.
          // eslint-disable-next-line no-await-in-loop
          await applyOnchainDepositInstructionIndexes({
            connection,
            signature,
            programId,
            poolPk: pool,
            items: batch.items,
          });
          for (const item of batch.items) {
            els.txLink.href = `https://solscan.io/tx/${signature}`;
            els.txLink.textContent = signature;
            log(
              `${item.prefix}Deposit 成功: ${signature} (ix=${item.note.depositInstructionIndex})`
            );
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log(`单笔批量交易失败，回退为多笔发送: ${reason}`, 'warn');

        for (const item of pendingDeposits) {
          item.note.depositInstructionIndex = 1;
        }

        const depositSignatures = await sendDepositTransactions({
          connection,
          walletPubkey: provider.publicKey,
          txs: pendingDeposits.map((item) => item.tx),
        });

        for (let i = 0; i < pendingDeposits.length; i += 1) {
          const signature = depositSignatures[i];
          const item = pendingDeposits[i];
          // eslint-disable-next-line no-await-in-loop
          await applyOnchainDepositInstructionIndexes({
            connection,
            signature,
            programId,
            poolPk: pool,
            items: [item],
          });

          els.txLink.href = `https://solscan.io/tx/${signature}`;
          els.txLink.textContent = signature;
          log(`${item.prefix}Deposit 成功: ${signature} (ix=${item.note.depositInstructionIndex})`);
        }
      }
    } else {
      log('提交 Deposit 交易到链上...');
      const [signature] = await sendDepositTransactions({
        connection,
        walletPubkey: provider.publicKey,
        txs: [pendingDeposits[0].tx],
      });

      const item = pendingDeposits[0];
      await applyOnchainDepositInstructionIndexes({
        connection,
        signature,
        programId,
        poolPk: pool,
        items: [item],
      });
      els.txLink.href = `https://solscan.io/tx/${signature}`;
      els.txLink.textContent = signature;
      log(`${item.prefix}Deposit 成功: ${signature} (ix=${item.note.depositInstructionIndex})`);
    }

    setProgress(els.stepDeposit, 'done');
    syncCurrentFlowNote();
    log('Deposit 已完成，Note 已生成，请立即复制或下载保存。', 'warn');
    setProgress(els.stepRequest, 'running');

    for (const item of pendingDeposits) {
      log(`${item.prefix}提交 Withdraw 请求到 relayer...`);
    }

    let firstRequestError = null;
    for (let i = 0; i < pendingDeposits.length; i += 1) {
      const item = pendingDeposits[i];
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await buildWithdrawRequest(item.note, item.target.recipient);
        const requestId = result?.requestId ?? '-';
        requestIds.push(requestId);
        item.note.requestId = requestId;
        log(`${item.prefix}请求已入队: ${requestId}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!firstRequestError) {
          firstRequestError = message;
        }
        log(`${item.prefix}提交 Withdraw 请求失败: ${message}`, 'error');
      }
    }

    syncCurrentFlowNote();
    if (firstRequestError) {
      throw new Error(firstRequestError);
    }

    setProgress(els.stepRequest, 'done');
    setProgress(els.stepDone, 'done');
    els.requestId.textContent =
      requestIds.length === 1 ? requestIds[0] : `${requestIds.length} requests`;
    syncCurrentFlowNote();
    clearLatestNoteDraftStorage();

    log('流程完成。请等待 relayer 执行 transfer。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!els.stepDeposit.classList.contains('done')) {
      setProgress(els.stepDeposit, 'error');
    } else {
      setProgress(els.stepRequest, 'error');
      setProgress(els.stepDone, 'error');
    }
    log(message, 'error');
  } finally {
    setBusy(false);
  }
}

async function onCopyNote() {
  try {
    if (!els.note.value.trim()) {
      throw new Error('当前没有可复制的 Note');
    }
    await navigator.clipboard.writeText(els.note.value);
    log('Note 已复制到剪贴板。');
  } catch (error) {
    log(error.message ?? String(error), 'error');
  }
}

function onDownloadNote() {
  try {
    if (!latestNote) {
      throw new Error('当前没有可下载的 Note');
    }

    const file = new Blob([JSON.stringify(latestNote, null, 2)], {
      type: 'application/json;charset=utf-8',
    });

    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    const suffix = latestNote.depositSignature
      ? latestNote.depositSignature.slice(0, 10)
      : latestNote.mode === 'batch' && Array.isArray(latestNote.entries)
        ? `batch-${latestNote.entries.length}`
        : 'export';
    a.download = `x-mix-note-${suffix}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    log('Note 文件已下载。');
  } catch (error) {
    log(error.message ?? String(error), 'error');
  }
}

window.addEventListener('load', async () => {
  try {
    resolveWalletProvider();
    if (provider?.isConnected && provider?.publicKey) {
      const connection = getConnection();
      const bal = await connection.getBalance(provider.publicKey, 'confirmed');
      const sol = Number(bal) / LAMPORTS_PER_SOL;
      els.walletStatus.textContent = `${provider.publicKey.toBase58()} | ${sol.toFixed(4)} SOL`;
    }
  } catch {
    // ignore
  }
});

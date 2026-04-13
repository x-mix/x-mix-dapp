import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';

const DEFAULT_RPC =
  'https://solana-mainnet.core.chainstack.com/2cd2b649ac769bded1318e8af2508268';
const DEFAULT_PROGRAM_ID = 'XmixQ4DB8MtKcEFhyjWs1gZtdaF3YDuF4ieGLJ3xotv';
const DEFAULT_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_RELAYER_API = 'https://api.xmix.dev';

const ASSET_TYPE_SOL = 0;
const SCAN_LIMIT = 220;
const RELAYER_FEE_LAMPORTS = '0';
const REQUEST_RETRY_ATTEMPTS = 8;
const REQUEST_RETRY_WAIT_MS = 4000;

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
let latestNote = null;

boot();

function boot() {
  provider = resolveWalletProvider();

  els.connectBtn.addEventListener('click', onConnectWallet);
  els.sendBtn.addEventListener('click', onSend);
  els.copyNoteBtn.addEventListener('click', onCopyNote);
  els.downloadNoteBtn.addEventListener('click', onDownloadNote);

  if (!provider) {
    log('未检测到 Phantom 钱包扩展。', 'warn');
  }

  resetProgress();
  log('准备就绪。');
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

function setBusy(isBusy) {
  els.connectBtn.disabled = isBusy;
  els.sendBtn.disabled = isBusy;
  els.copyNoteBtn.disabled = isBusy;
  els.downloadNoteBtn.disabled = isBusy;
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

function parseSolToLamports(raw) {
  const value = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error('金额格式错误');
  }

  const [whole, fracRaw = ''] = value.split('.');
  const frac = (fracRaw + '000000000').slice(0, 9);
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt(frac);
  if (lamports <= 0n) {
    throw new Error('金额必须大于 0');
  }
  return lamports;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
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
  const zeros = [new Uint8Array(32)];
  for (let i = 1; i <= TREE_LEVELS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    zeros[i] = await poseidonPair(zeros[i - 1], zeros[i - 1]);
  }
  return zeros;
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
  const signatures = await connection.getSignaturesForAddress(
    programId,
    { limit: scanLimit },
    'confirmed'
  );

  signatures.sort((a, b) => a.slot - b.slot);

  const commitments = [];

  for (const sig of signatures) {
    // eslint-disable-next-line no-await-in-loop
    const tx = await connection.getParsedTransaction(sig.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || tx.meta?.err) continue;

    const logs = tx.meta?.logMessages ?? [];
    if (!logs.some((line) => line.includes('Instruction: Deposit'))) {
      continue;
    }

    for (const ix of tx.transaction.message.instructions) {
      if (!('programId' in ix) || !ix.programId.equals(programId)) continue;
      if (!('accounts' in ix) || ix.accounts.length < 2) continue;
      if (ix.accounts[1].toBase58() !== poolPk.toBase58()) continue;

      const commitment = parseDepositCommitment(ix);
      if (commitment) {
        commitments.push(commitment);
      }
    }
  }

  return commitments;
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

function encodeDepositData(amountLamports, commitment, newRoot) {
  const data = new Uint8Array(80);
  data.set(DEPOSIT_DISCRIMINATOR, 0);

  let temp = amountLamports;
  for (let i = 0; i < 8; i += 1) {
    data[8 + i] = Number(temp & 0xffn);
    temp >>= 8n;
  }

  data.set(commitment, 16);
  data.set(newRoot, 48);
  return data;
}

async function sendDepositTx({ connection, walletPubkey, amountLamports, commitment, newRoot, poolPk, vaultPk }) {
  const programId = getProgramId();
  const mintPk = new PublicKey(DEFAULT_MINT);

  const ixData = encodeDepositData(amountLamports, commitment, newRoot);

  const placeholder = programId;
  const keys = [
    { pubkey: walletPubkey, isSigner: true, isWritable: true },
    { pubkey: poolPk, isSigner: false, isWritable: true },
    { pubkey: mintPk, isSigner: false, isWritable: true },
    { pubkey: vaultPk, isSigner: false, isWritable: true },
    { pubkey: placeholder, isSigner: false, isWritable: true },
    { pubkey: placeholder, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    programId,
    keys,
    data: ixData,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = walletPubkey;

  const latest = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latest.blockhash;

  let signature;
  if (typeof provider.signAndSendTransaction === 'function') {
    const res = await provider.signAndSendTransaction(tx);
    signature = typeof res === 'string' ? res : res.signature;
  } else if (typeof provider.signTransaction === 'function') {
    const signed = await provider.signTransaction(tx);
    signature = await connection.sendRawTransaction(signed.serialize());
  } else {
    throw new Error('钱包不支持 signAndSendTransaction/signTransaction');
  }

  if (!signature) {
    throw new Error('未获取到交易签名');
  }

  await connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    'confirmed'
  );

  return signature;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildWithdrawRequest(note, recipient) {
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= REQUEST_RETRY_ATTEMPTS; attempt += 1) {
    const res = await fetch(`${DEFAULT_RELAYER_API}/api/relay-request/build`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        note,
        recipient,
        relayerFeeLamports: RELAYER_FEE_LAMPORTS,
      }),
    });

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
      lastError.includes('Deposit not found in relayer state') ||
      lastError.includes('missing decoded deposit payload');

    if (!retryable || attempt >= REQUEST_RETRY_ATTEMPTS) {
      throw new Error(lastError);
    }

    log(`Relayer 尚未索引到该 Deposit，${REQUEST_RETRY_WAIT_MS / 1000}s 后重试 (${attempt}/${REQUEST_RETRY_ATTEMPTS})...`, 'warn');
    // eslint-disable-next-line no-await-in-loop
    await sleep(REQUEST_RETRY_WAIT_MS);
  }

  throw new Error(lastError);
}

async function onSend() {
  if (!provider?.publicKey) {
    log('请先连接钱包。', 'warn');
    return;
  }

  try {
    setBusy(true);
    resetProgress();
    els.requestId.textContent = '-';
    els.txLink.href = '#';
    els.txLink.textContent = '等待交易';

    const recipient = els.recipient.value.trim();
    if (!recipient) {
      throw new Error('请填写收币地址');
    }
    new PublicKey(recipient);

    const amountLamports = parseSolToLamports(els.amountSol.value);

    const connection = getConnection();
    const programId = getProgramId();
    const mintPk = new PublicKey(DEFAULT_MINT);
    const { pool, vault } = derivePoolAndVault(programId, mintPk, ASSET_TYPE_SOL);

    setProgress(els.stepDeposit, 'running');
    log('开始构建 Deposit...');

    const secret = random32Bytes();
    const nullifier = random32Bytes();
    const commitment = await generateCommitment(secret, nullifier, amountLamports, pool);

    log('扫描历史 Deposit，重建最新 Merkle Root...');
    const oldCommitments = await fetchPoolCommitments(connection, programId, pool, SCAN_LIMIT);
    const newRoot = await computeMerkleRoot([...oldCommitments, commitment]);

    log('发送链上 Deposit 交易...');
    const signature = await sendDepositTx({
      connection,
      walletPubkey: provider.publicKey,
      amountLamports,
      commitment,
      newRoot,
      poolPk: pool,
      vaultPk: vault,
    });

    setProgress(els.stepDeposit, 'done');
    els.txLink.href = `https://solscan.io/tx/${signature}`;
    els.txLink.textContent = signature;
    log(`Deposit 成功: ${signature}`);

    const note = {
      version: 1,
      createdAt: new Date().toISOString(),
      rpcUrl: DEFAULT_RPC,
      programId: programId.toBase58(),
      pool: pool.toBase58(),
      vault: vault.toBase58(),
      mint: mintPk.toBase58(),
      assetType: 'sol',
      amountLamports: amountLamports.toString(),
      amountSol: (Number(amountLamports) / LAMPORTS_PER_SOL).toString(),
      commitmentHex: bytesToHex(commitment),
      newRootHex: bytesToHex(newRoot),
      secretHex: bytesToHex(secret),
      nullifierHex: bytesToHex(nullifier),
      depositSignature: signature,
    };

    latestNote = note;
    els.note.value = JSON.stringify(note, null, 2);

    setProgress(els.stepRequest, 'running');
    log('提交 Withdraw 请求到 relayer...');
    const req = await buildWithdrawRequest(note, recipient);

    setProgress(els.stepRequest, 'done');
    setProgress(els.stepDone, 'done');
    els.requestId.textContent = req.requestId ?? '-';

    log(`请求已入队: ${req.requestId}`);
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
    a.download = `x-mix-note-${latestNote.depositSignature.slice(0, 10)}.json`;
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

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
const DEFAULT_MINT = 'So11111111111111111111111111111111111111112';
const DEFAULT_RELAYER_API = 'https://api.xmix.dev';
const DEFAULT_RELAYER_EXECUTOR = 'xxxXGCRExgFF2EEWKU1QDDDYBL6Ma2X299ynEgEVff5';

const ASSET_TYPE_SOL = 0;
const SCAN_LIMIT = 220;
const RELAYER_FEE_LAMPORTS = '0';
// User-paid execution subsidy (A -> relayer) to cover relayer tx fee and nullifier rent.
const RELAYER_EXECUTION_FEE_LAMPORTS = 1_230_960n;
const REQUEST_RETRY_ATTEMPTS = 8;
const REQUEST_RETRY_WAIT_MS = 4000;
const MIN_SOL_DEPOSIT_LAMPORTS = 50_000_000n;
const MIN_SOL_DEPOSIT_TEXT = '0.05';
const MAX_RECIPIENTS_PER_DEPOSIT_TX = 7;

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
let busy = false;

boot();

function boot() {
  provider = resolveWalletProvider();

  els.connectBtn.addEventListener('click', onConnectWallet);
  els.sendBtn.addEventListener('click', onSend);
  els.recipient.addEventListener('input', syncSendButtonState);
  els.amountSol.addEventListener('input', syncSendButtonState);
  els.copyNoteBtn.addEventListener('click', onCopyNote);
  els.downloadNoteBtn.addEventListener('click', onDownloadNote);

  if (!provider) {
    log('未检测到 Phantom 钱包扩展。', 'warn');
  }

  resetProgress();
  syncSendButtonState();
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

function parseSolToLamports(raw) {
  const value = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error("金额格式错误");
  }

  const [whole, fracRaw = ""] = value.split(".");
  const frac = (fracRaw + "000000000").slice(0, 9);
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt(frac);
  if (lamports <= 0n) {
    throw new Error("金额必须大于 0");
  }
  return lamports;
}

function isAmountSendable(raw) {
  const value = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return false;
  }

  const [whole, fracRaw = ""] = value.split(".");
  const frac = (fracRaw + "000000000").slice(0, 9);
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt(frac);
  return lamports >= MIN_SOL_DEPOSIT_LAMPORTS;
}

function syncSendButtonState() {
  const hasRecipient = Boolean(els.recipient.value.trim());
  const amountOk = isAmountSendable(els.amountSol.value);
  const canSend = hasRecipient && amountOk;
  els.sendBtn.disabled = busy || !canSend;

  if (!hasRecipient) {
    els.sendBtn.title = '请填写收币地址';
    return;
  }
  els.sendBtn.title = amountOk ? '' : '最低发送金额 ' + MIN_SOL_DEPOSIT_TEXT + ' SOL';
}

function parseRecipientTargets(rawRecipients, defaultAmountText) {
  const lines = rawRecipients
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error('请填写收币地址。');
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

    const amountLamports = parseSolToLamports(amountText);
    if (amountLamports < MIN_SOL_DEPOSIT_LAMPORTS) {
      throw new Error(`第 ${i + 1} 行金额低于最低 ${MIN_SOL_DEPOSIT_TEXT} SOL`);
    }

    out.push({
      recipient: recipientPk.toBase58(),
      amountLamports,
    });
  }

  return out;
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

function createDepositTx({
  walletPubkey,
  amountLamports,
  commitment,
  newRoot,
  poolPk,
  vaultPk,
}) {
  const programId = getProgramId();
  const mintPk = new PublicKey(DEFAULT_MINT);
  const relayerExecutor = new PublicKey(DEFAULT_RELAYER_EXECUTOR);

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

  const relayerExecutionFeeIx = SystemProgram.transfer({
    fromPubkey: walletPubkey,
    toPubkey: relayerExecutor,
    lamports: Number(RELAYER_EXECUTION_FEE_LAMPORTS),
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

  let targets;
  try {
    targets = parseRecipientTargets(els.recipient.value, els.amountSol.value);
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
    const mintPk = new PublicKey(DEFAULT_MINT);
    const { pool, vault } = derivePoolAndVault(programId, mintPk, ASSET_TYPE_SOL);
    const pendingDeposits = [];
    const noteEntries = [];
    const requestIds = [];

    setProgress(els.stepDeposit, 'running');
    log('扫描历史 Deposit，重建最新 Merkle Root...');
    const historicalCommitments = await fetchPoolCommitments(
      connection,
      programId,
      pool,
      SCAN_LIMIT
    );
    const commitmentsForBatch = [...historicalCommitments];

    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      const prefix = targets.length > 1 ? `[${i + 1}/${targets.length}] ` : '';

      log(`${prefix}开始构建 Deposit...`);

      const secret = random32Bytes();
      const nullifier = random32Bytes();
      const commitment = await generateCommitment(secret, nullifier, target.amountLamports, pool);
      const newRoot = await computeMerkleRoot([...commitmentsForBatch, commitment]);
      commitmentsForBatch.push(commitment);

      const totalUserOutflowLamports =
        target.amountLamports + RELAYER_EXECUTION_FEE_LAMPORTS;
      log(
        `${prefix}构建链上 Deposit 交易（存款 ${(
          Number(target.amountLamports) / LAMPORTS_PER_SOL
        ).toFixed(9)} SOL + 中继执行费 ${(
          Number(RELAYER_EXECUTION_FEE_LAMPORTS) / LAMPORTS_PER_SOL
        ).toFixed(9)} SOL）...`
      );

      const tx = createDepositTx({
        walletPubkey: provider.publicKey,
        amountLamports: target.amountLamports,
        commitment,
        newRoot,
        poolPk: pool,
        vaultPk: vault,
      });

      const note = {
        version: 1,
        createdAt: new Date().toISOString(),
        rpcUrl: DEFAULT_RPC,
        programId: programId.toBase58(),
        pool: pool.toBase58(),
        vault: vault.toBase58(),
        mint: mintPk.toBase58(),
        assetType: 'sol',
        recipient: target.recipient,
        amountLamports: target.amountLamports.toString(),
        amountSol: (Number(target.amountLamports) / LAMPORTS_PER_SOL).toString(),
        relayerExecutionFeeLamports: RELAYER_EXECUTION_FEE_LAMPORTS.toString(),
        relayerExecutionFeeSol: (
          Number(RELAYER_EXECUTION_FEE_LAMPORTS) / LAMPORTS_PER_SOL
        ).toString(),
        totalUserOutflowLamports: totalUserOutflowLamports.toString(),
        totalUserOutflowSol: (
          Number(totalUserOutflowLamports) / LAMPORTS_PER_SOL
        ).toString(),
        relayerExecutor: DEFAULT_RELAYER_EXECUTOR,
        commitmentHex: bytesToHex(commitment),
        newRootHex: bytesToHex(newRoot),
        secretHex: bytesToHex(secret),
        nullifierHex: bytesToHex(nullifier),
        depositSignature: '',
        depositInstructionIndex: 1,
      };

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
          for (const item of batch.items) {
            item.note.depositSignature = signature;
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
          item.note.depositSignature = signature;

          els.txLink.href = `https://solscan.io/tx/${signature}`;
          els.txLink.textContent = signature;
          log(`${item.prefix}Deposit 成功: ${signature} (ix=1)`);
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
      item.note.depositSignature = signature;
      item.note.depositInstructionIndex = 1;
      els.txLink.href = `https://solscan.io/tx/${signature}`;
      els.txLink.textContent = signature;
      log(`${item.prefix}Deposit 成功: ${signature} (ix=1)`);
    }

    setProgress(els.stepDeposit, 'done');
    setProgress(els.stepRequest, 'running');

    for (const item of pendingDeposits) {
      log(`${item.prefix}提交 Withdraw 请求到 relayer...`);
      // eslint-disable-next-line no-await-in-loop
      const req = await buildWithdrawRequest(item.note, item.target.recipient);

      const requestId = req.requestId ?? '-';
      requestIds.push(requestId);
      noteEntries.push({ ...item.note, requestId });
      log(`${item.prefix}请求已入队: ${requestId}`);
    }

    setProgress(els.stepRequest, 'done');
    setProgress(els.stepDone, 'done');
    els.requestId.textContent =
      requestIds.length === 1 ? requestIds[0] : `${requestIds.length} requests`;

    if (noteEntries.length === 1) {
      latestNote = noteEntries[0];
      els.note.value = JSON.stringify(noteEntries[0], null, 2);
    } else {
      latestNote = {
        version: 1,
        mode: 'batch',
        createdAt: new Date().toISOString(),
        count: noteEntries.length,
        entries: noteEntries,
      };
      els.note.value = JSON.stringify(latestNote, null, 2);
    }

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
